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
  taper: f32,      // end/start radius ratio for type=3 tapered capsule
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
  _pad0: f32,
  gravity: f32,    // downward dissolution amount
  _pad2: f32,
  _pad3: f32,
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

fn sdf_tapered_capsule(p: vec2f, a: vec2f, b: vec2f, ra: f32, rb: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let l2 = dot(ba, ba);
  if (l2 < 0.00001) { return length(pa) - ra; }
  let h = clamp(dot(pa, ba) / l2, 0.0, 1.0);
  let r = mix(ra, rb, h);
  return length(pa - ba * h) - r;
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

// Evaluate raw SDF distance for a single form (no effects)
fn eval_sdf(f: FormData, p: vec2f, aspect: f32) -> f32 {
  let center = vec2f(f.x * aspect, f.y);
  var d: f32;
  if (f.type_id < 0.5) {
    d = sdf_circle(p, center, f.size_x);
  } else if (f.type_id < 1.5) {
    d = sdf_box(p, center, vec2f(f.size_x, f.size_y), f.rotation);
  } else if (f.type_id < 2.5) {
    let end = center + vec2f(cos(f.rotation), sin(f.rotation)) * f.size_x;
    d = sdf_line_seg(p, center, end, f.size_y);
  } else {
    // type=3: tapered capsule (form brush)
    let end = center + vec2f(cos(f.rotation), sin(f.rotation)) * f.size_x;
    let end_r = f.size_y * f.taper;
    d = sdf_tapered_capsule(p, center, end, f.size_y, end_r);
  }
  return d;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let pixel = vec2f(f32(gid.x), f32(gid.y));
  let uv = pixel / vec2f(f32(dims.x), f32(dims.y));
  let aspect = f32(dims.x) / f32(dims.y);
  let p = vec2f(uv.x * aspect, uv.y);

  let depth = textureLoad(depth_tex, vec2i(gid.xy), 0).r;
  let dissolution_mask = textureLoad(dissolution_tex, vec2i(gid.xy), 0).r;
  let atmo = textureLoad(density_tex, vec2i(gid.xy), 0);
  let sun_dir = vec2f(cos(params.sun_angle), sin(params.sun_angle));

  var result_color = vec3f(0.0);
  var result_alpha = 0.0;

  if (params.form_count > 0u) {
    // Union SDF: all forms as a single smooth shape — no internal ridges
    var union_d = 999.0;
    var nearest_d = 999.0;
    var nearest_i = 0u;
    let blend_k = 0.035;

    // Smooth references for gravity + depth (Gaussian weight avoids nearest-form staircase)
    var ref_y = 0.0;
    var ref_w = 0.0;
    var ref_depth = 0.0;

    for (var i = 0u; i < params.form_count; i++) {
      let d = eval_sdf(forms[i], p, aspect);
      union_d = smooth_union(union_d, d, blend_k);

      // Gaussian weight: smooth falloff, no hard cutoff
      let w = exp(-d * d * 100.0);
      ref_y += forms[i].y * w;
      ref_depth += forms[i].depth * w;
      ref_w += w;

      if (d < nearest_d) {
        nearest_d = d;
        nearest_i = i;
      }
    }

    // Shade the union shape using nearest form's properties, smoothed references
    let nf = forms[nearest_i];
    let smooth_y = select(nf.y, ref_y / ref_w, ref_w > 0.001);
    let smooth_depth = select(nf.depth, ref_depth / ref_w, ref_w > 0.001);
    let depth_diss = smooth_depth * smooth_depth * 2.0;
    let eff_soft = nf.softness
      * (1.0 + depth_diss * 0.3)
      * (1.0 + dissolution_mask * 1.5);

    // Gravity: asymmetric softness — bottom edges dissolve, top stays defined
    let below = max(0.0, p.y - smooth_y);
    let grav = smoothstep(0.0, 0.25, below) * params.gravity;
    let gravity_pull = grav * 0.04;
    let gravity_soft = grav * 1.5;
    var final_d = union_d - gravity_pull;
    var final_soft = eff_soft * (1.0 + gravity_soft);

    // Form brush (type=3): inherent asymmetric softness even at gravity=0
    if (nf.type_id > 2.5) {
      let asym = smoothstep(0.0, 0.12, below);
      final_soft *= (1.0 + asym * 1.2);
    }

    let edge = 1.0 - smoothstep(0.0, max(final_soft, 0.001), final_d);
    var form_color = vec3f(nf.color_r, nf.color_g, nf.color_b);

    // Gentle tonal variation along stroke direction
    let sl = length(vec2f(nf.stroke_dir_x, nf.stroke_dir_y));
    let sd = select(sun_dir, normalize(vec2f(nf.stroke_dir_x, nf.stroke_dir_y)), sl > 0.01);
    let sp = vec2f(-sd.y, sd.x);
    let sun_facing = dot(sp, sun_dir) * 0.5 + 0.5;
    form_color *= mix(0.95, 1.05, sun_facing);

    // Stroke texture: coarse dry-brush scrape
    if (sl > 0.01) {
      let sc_along = dot(p, sd) * 4.0;
      let sc_across = dot(p, sp) * 14.0;
      let scrape = snoise2d(vec2f(sc_along, sc_across)) * 0.5
                 + snoise2d(vec2f(sc_along * 0.5, sc_across * 0.5)) * 0.3;
      form_color *= (1.0 + scrape * 0.10);
    }

    // Light response
    let highlight = max(0.0, sun_facing - 0.5) * 0.12 * (1.0 - smooth_depth * 0.5);
    form_color += vec3f(highlight * 1.1, highlight * 0.9, highlight * 0.7);

    // Tonal hierarchy
    if (params.tonal_enabled > 0.5) {
      let tv = tonal_value(depth, params.key_value, params.value_range, params.contrast);
      let lr = tv / max(lum(form_color), 0.001);
      form_color *= clamp(lr, 0.3, 3.0);
    }

    // Apply velvet and output
    let alpha = edge * nf.opacity;
    let velvet_exp = mix(1.5, 0.7, params.velvet);
    result_alpha = pow(alpha, velvet_exp);
    result_color = form_color;
  }

  textureStore(output_tex, vec2i(gid.xy), vec4f(result_color, result_alpha));
}
