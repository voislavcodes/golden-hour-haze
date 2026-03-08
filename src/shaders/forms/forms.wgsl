// Forms compute shader
// Evaluates SDF forms, writes color via palette, depth-modulated dissolution

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
};

struct FormsParams {
  form_count: u32,
  _pad1: f32,
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

// Inline SDF
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

    // Perceptual edge dissolution
    let form_color = vec3f(f.color_r, f.color_g, f.color_b);
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

    // Front-to-back composite
    if (result_alpha < 0.999) {
      let contrib = alpha * (1.0 - result_alpha);
      result_color += form_color * contrib;
      result_alpha += contrib;
    }
  }

  textureStore(output_tex, vec2i(gid.xy), vec4f(result_color, result_alpha));
}
