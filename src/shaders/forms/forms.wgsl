// Forms compute shader
// Evaluates SDF forms with painterly edge irregularity, interior tonal variation,
// stroke texture, K-M color bleeding, and directional light response

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct FormData {
  type_id: f32,   // 0=circle, 1=box, 2=line
  x: f32,
  y: f32,
  size_x: f32,
  size_y: f32,
  rotation: f32,
  softness: f32,
  depth: f32,
  color_r: f32,
  color_g: f32,
  color_b: f32,
  opacity: f32,
  stroke_dir_x: f32,
  stroke_dir_y: f32,
  edge_seed: f32,
  _pad: f32,
};

struct FormsParams {
  form_count: u32,
  sun_angle: f32,
  key_value: f32,
  value_range: f32,
  contrast: f32,
  velvet: f32,
  tonal_sort: f32,
  tonal_enabled: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: FormsParams;
@group(1) @binding(1) var<storage, read> forms: array<FormData>;
@group(2) @binding(0) var depth_tex: texture_2d<f32>;
@group(2) @binding(1) var dissolution_tex: texture_2d<f32>;
@group(2) @binding(2) var density_tex: texture_2d<f32>;
@group(2) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;

// --- Inline simplex noise (same as depth-field.wgsl) ---
fn mod289v3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v2(x: vec2f) -> vec2f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permuteV3(x: vec3f) -> vec3f { return mod289v3((x * 34.0 + 10.0) * x); }

fn snoise2d(v: vec2f) -> f32 {
  let C = vec4f(0.211324865405187, 0.366025403784439,
                -0.577350269189626, 0.024390243902439);
  var i = floor(v + dot(v, C.yy));
  let x0 = v - i + dot(i, C.xx);
  var i1: vec2f;
  if (x0.x > x0.y) { i1 = vec2f(1.0, 0.0); } else { i1 = vec2f(0.0, 1.0); }
  var x12 = vec4f(x0.x + C.x, x0.y + C.x, x0.x + C.z, x0.y + C.z);
  x12 = vec4f(x12.xy - i1, x12.zw);
  i = mod289v2(i);
  let p = permuteV3(permuteV3(vec3f(i.y, i.y + i1.y, i.y + 1.0)) +
                     vec3f(i.x, i.x + i1.x, i.x + 1.0));
  var m = max(vec3f(0.5) - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
  m = m * m; m = m * m;
  let x = 2.0 * fract(p * C.www) - 1.0;
  let h = abs(x) - 0.5;
  let ox = floor(x + 0.5);
  let a0 = x - ox;
  m *= vec3f(1.79284291400159) - 0.85373472095314 * (a0 * a0 + h * h);
  return 130.0 * dot(m, vec3f(a0.x * x0.x + h.x * x0.y,
                               a0.y * x12.x + h.y * x12.y,
                               a0.z * x12.z + h.z * x12.w));
}

#include "../common/kubelka-munk.wgsl"

// --- SDF primitives ---
fn sdf_circle(p: vec2f, center: vec2f, radius: f32) -> f32 {
  return length(p - center) - radius;
}

fn sdf_box(p: vec2f, center: vec2f, half_size: vec2f, rot: f32) -> f32 {
  let c = cos(rot); let s = sin(rot);
  let d = p - center;
  let r = vec2f(d.x * c + d.y * s, -d.x * s + d.y * c);
  let q = abs(r) - half_size;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

fn sdf_line_seg(p: vec2f, a: vec2f, b: vec2f, thickness: f32) -> f32 {
  let pa = p - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - thickness;
}

fn smooth_union(d1: f32, d2: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}

fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, vec3f(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
  return fract((p3.x + p3.y) * p3.z);
}

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// Tonal hierarchy: depth → S-curve → value
fn tonal_value(depth: f32, key: f32, range: f32, contrast: f32) -> f32 {
  let v = mix(key - range * 0.5, key + range * 0.5, 1.0 - depth);
  let t = (v - 0.5) * contrast * 2.0;
  return 0.5 + 0.5 * sign(t) * (1.0 - exp(-abs(t)));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let pixel = vec2f(f32(gid.x), f32(gid.y));
  let uv = pixel / vec2f(f32(dims.x), f32(dims.y));
  let aspect = f32(dims.x) / f32(dims.y);

  // Aspect-corrected coordinates
  let p = vec2f(uv.x * aspect, uv.y);

  let depth = textureLoad(depth_tex, vec2i(gid.xy), 0).r;
  let dissolution_mask = textureLoad(dissolution_tex, vec2i(gid.xy), 0).r;
  let atmo = textureLoad(density_tex, vec2i(gid.xy), 0);

  // Sun direction for interior tonal variation and light response
  let sun_dir = vec2f(cos(params.sun_angle), sin(params.sun_angle));

  // Evaluate all forms, compositing front to back
  var result_color = vec3f(0.0);
  var result_alpha = 0.0;

  let edge_noise = hash2(pixel + vec2f(globals.time * 3.7));

  for (var i = 0u; i < params.form_count; i++) {
    let f = forms[i];
    let center = vec2f(f.x * aspect, f.y);

    var d: f32;
    if (f.type_id < 0.5) {
      d = sdf_circle(p, center, f.size_x);
    } else if (f.type_id < 1.5) {
      d = sdf_box(p, center, vec2f(f.size_x, f.size_y), f.rotation);
    } else {
      let end = center + vec2f(cos(f.rotation), sin(f.rotation)) * f.size_x;
      d = sdf_line_seg(p, center, end, f.size_y);
    }

    // Early-out: skip noise evaluation for pixels far from this form
    let max_soft = f.softness * 3.0;
    if (d > max_soft) { continue; }

    // --- A2: Edge irregularity via FBM noise displacing the SDF ---
    let edge_uv = (p - center) * 12.0 + vec2f(f.edge_seed * 100.0);
    let edge_fbm = snoise2d(edge_uv) * 0.6 + snoise2d(edge_uv * 2.3) * 0.3;
    let irregularity = edge_fbm * f.softness * 0.15;
    d += irregularity;

    // Perceptual edge dissolution
    var form_color = vec3f(f.color_r, f.color_g, f.color_b);
    let bg_color = result_color;

    let lum_contrast = abs(lum(form_color) - lum(bg_color));
    let hold = clamp(lum_contrast * 3.0, 0.0, 1.0);

    let depth_diss = f.depth * f.depth * 2.0;
    let eff_soft = f.softness
      * (1.0 + depth_diss)
      * (1.0 - hold * 0.7)
      * (1.0 + dissolution_mask * 3.0)
      + edge_noise * 0.01;

    let edge = 1.0 - smoothstep(0.0, max(eff_soft, 0.001), d);
    let alpha = edge * f.opacity;

    // --- A3: Interior tonal variation based on sun direction ---
    let to_center = center - p;
    let tc_len = length(to_center);
    let to_center_n = select(vec2f(0.0), to_center / tc_len, tc_len > 0.001);
    let sun_facing = dot(to_center_n, sun_dir) * 0.5 + 0.5;
    let tonal_shift = mix(0.85, 1.15, sun_facing);
    form_color *= tonal_shift;

    // --- A4: Stroke direction texture ---
    let stroke_len = length(vec2f(f.stroke_dir_x, f.stroke_dir_y));
    if (stroke_len > 0.01) {
      let sdir = vec2f(f.stroke_dir_x, f.stroke_dir_y) / stroke_len;
      let perp = vec2f(-sdir.y, sdir.x);
      // Anisotropic UV: 3:1 aspect ratio creates elongated brush marks
      let stroke_uv = vec2f(dot(p - center, sdir) * 8.0, dot(p - center, perp) * 24.0);
      let stroke_tex = snoise2d(stroke_uv + vec2f(f.edge_seed * 50.0)) * 0.08;
      form_color *= (1.0 + stroke_tex);
    }

    // --- C1: Directional light response ---
    let light_response = sun_facing * (1.0 - f.depth * 0.5);
    let highlight = max(0.0, light_response - 0.5) * 0.2;
    form_color += vec3f(highlight * 1.1, highlight * 0.9, highlight * 0.7);

    // Tonal hierarchy: constrain luminance to depth-derived value
    if (params.tonal_enabled > 0.5) {
      let target_value = tonal_value(depth, params.key_value, params.value_range, params.contrast);
      let form_lum = lum(form_color);
      let lum_ratio = target_value / max(form_lum, 0.001);
      form_color = form_color * clamp(lum_ratio, 0.3, 3.0);
    }

    // --- B2: K-M color bleeding at edges ---
    let edge_zone = smoothstep(0.0, 0.3, alpha) * smoothstep(1.0, 0.7, alpha);
    if (edge_zone > 0.01 && result_alpha > 0.01) {
      let km_blended = km_mix(result_color / result_alpha, form_color, alpha);
      form_color = mix(form_color, km_blended, edge_zone);
    }

    // K-M subtractive front-to-back composite
    if (result_alpha < 0.999) {
      let contrib = alpha * (1.0 - result_alpha);
      let velvet_contrib = pow(contrib, mix(2.0, 0.5, params.velvet));
      let t = velvet_contrib / max(velvet_contrib + result_alpha, 0.001);
      result_color = km_mix(result_color, form_color, t);
      result_alpha += contrib;
    }
  }

  textureStore(output_tex, vec2i(gid.xy), vec4f(result_color, result_alpha));
}
