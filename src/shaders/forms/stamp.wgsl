// Stamp compute shader — rasterizes ONE form into persistent ping-pong texture
// Evaluates SDF over bounding box only, K-M accumulates on top of existing paint

#include "../common/kubelka-munk.wgsl"

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct StampParams {
  canvas_w: f32,
  canvas_h: f32,
  bbox_x: f32,
  bbox_y: f32,
  bbox_w: f32,
  bbox_h: f32,
  sun_angle: f32,
  key_value: f32,
  value_range: f32,
  contrast: f32,
  velvet: f32,
  tonal_enabled: f32,
  base_opacity: f32,
  falloff: f32,
  edge_atmosphere: f32,
  horizon_y: f32,
};

struct FormData {
  type_id: f32,
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
  taper: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> sp: StampParams;
@group(1) @binding(1) var<uniform> form: FormData;
@group(2) @binding(0) var depth_tex: texture_2d<f32>;
@group(2) @binding(1) var dissolution_tex: texture_2d<f32>;
@group(2) @binding(2) var density_tex: texture_2d<f32>;
@group(2) @binding(3) var noise_tex: texture_2d<f32>;
@group(2) @binding(4) var noise_sampler: sampler;
@group(2) @binding(5) var forms_read: texture_2d<f32>;
@group(2) @binding(6) var accum_read: texture_2d<f32>;
@group(2) @binding(7) var forms_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(8) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(9) var density_sampler: sampler;

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

fn sdf_tapered_capsule(p: vec2f, a: vec2f, b: vec2f, ra: f32, rb: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let l2 = dot(ba, ba);
  if (l2 < 0.00001) { return length(pa) - ra; }
  let h = clamp(dot(pa, ba) / l2, 0.0, 1.0);
  let r = mix(ra, rb, h);
  return length(pa - ba * h) - r;
}

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn tonal_value(depth: f32, key: f32, range: f32, contrast: f32) -> f32 {
  let v = mix(key - range * 0.5, key + range * 0.5, 1.0 - depth);
  let t = (v - 0.5) * contrast * 2.0;
  return 0.5 + 0.5 * sign(t) * (1.0 - exp(-abs(t)));
}

fn eval_sdf(p: vec2f, aspect: f32) -> f32 {
  let center = vec2f(form.x * aspect, form.y);
  var d: f32;
  if (form.type_id < 0.5) {
    d = sdf_circle(p, center, form.size_x);
  } else if (form.type_id < 1.5) {
    d = sdf_box(p, center, vec2f(form.size_x, form.size_y), form.rotation);
  } else if (form.type_id < 2.5) {
    let end = center + vec2f(cos(form.rotation), sin(form.rotation)) * form.size_x;
    d = sdf_line_seg(p, center, end, form.size_y);
  } else {
    let end = center + vec2f(cos(form.rotation), sin(form.rotation)) * form.size_x;
    let end_r = form.size_y * form.taper;
    d = sdf_tapered_capsule(p, center, end, form.size_y, end_r);
  }
  return d;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // gid is relative to the bounding box dispatch
  let bbox_pixel = vec2f(sp.bbox_x + f32(gid.x), sp.bbox_y + f32(gid.y));
  let canvas_dims = vec2f(sp.canvas_w, sp.canvas_h);

  // Bounds check
  if (bbox_pixel.x >= canvas_dims.x || bbox_pixel.y >= canvas_dims.y) { return; }
  if (bbox_pixel.x < 0.0 || bbox_pixel.y < 0.0) { return; }

  let px = vec2i(bbox_pixel);
  let uv = (bbox_pixel + 0.5) / canvas_dims;
  let aspect = canvas_dims.x / canvas_dims.y;
  let p = vec2f(uv.x * aspect, uv.y);

  let depth = textureLoad(depth_tex, px, 0).r;
  let dissolution_mask = textureLoad(dissolution_tex, px, 0).r;
  let local_density = textureSampleLevel(density_tex, density_sampler, uv, 0.0).r;

  let sun_dir = vec2f(cos(sp.sun_angle), sin(sp.sun_angle));

  let d = eval_sdf(p, aspect);

  // Per-form softness with depth recession, dissolution, atmosphere, horizon
  let depth_diss = form.depth * form.depth * 2.0;
  let form_center_y = form.y;
  let form_horizon_dist = abs(form_center_y - sp.horizon_y);
  let horizon_softening = select(1.0, 1.0 + exp(-form_horizon_dist * form_horizon_dist * 8.0) * 0.5, sp.horizon_y >= 0.0);

  let eff_soft = form.softness
    * (1.0 + depth_diss * 0.3)
    * sp.edge_atmosphere
    * (1.0 + local_density * 0.15)
    * (1.0 + dissolution_mask * 3.0)
    * horizon_softening;

  let diss_erode = dissolution_mask * eff_soft * 2.0;
  let edge = 1.0 - smoothstep(-diss_erode, max(eff_soft, 0.001), d);
  if (edge < 0.001) {
    // No contribution — pre-copy already filled write texture
    return;
  }

  var form_color = vec3f(form.color_r, form.color_g, form.color_b);

  // Stroke direction and sun interaction
  let sl = length(vec2f(form.stroke_dir_x, form.stroke_dir_y));
  let sd = select(sun_dir, normalize(vec2f(form.stroke_dir_x, form.stroke_dir_y)), sl > 0.01);
  let sp2 = vec2f(-sd.y, sd.x);
  let sun_facing = dot(sp2, sun_dir) * 0.5 + 0.5;
  form_color *= mix(0.95, 1.05, sun_facing);

  // Stroke texture from pre-baked noise LUT
  if (sl > 0.01) {
    let sc_along = dot(p, sd) * 4.0;
    let sc_across = dot(p, sp2) * 14.0;
    let scrape_uv = vec2f(sc_along, sc_across);
    let scrape1 = textureSampleLevel(noise_tex, noise_sampler, scrape_uv, 0.0).r * 2.0 - 1.0;
    let scrape2 = textureSampleLevel(noise_tex, noise_sampler, scrape_uv * 0.5 + 0.5, 0.0).r * 2.0 - 1.0;
    let scrape = scrape1 * 0.5 + scrape2 * 0.3;
    form_color *= (1.0 + scrape * 0.10);
  }

  // Light response
  let highlight = max(0.0, sun_facing - 0.5) * 0.12 * (1.0 - form.depth * 0.5);
  form_color += vec3f(highlight * 1.1, highlight * 0.9, highlight * 0.7);

  // Tonal hierarchy
  if (sp.tonal_enabled > 0.5) {
    let tv = tonal_value(depth, sp.key_value, sp.value_range, sp.contrast);
    let lr = tv / max(lum(form_color), 0.001);
    form_color *= clamp(lr, 0.3, 3.0);
  }

  // Read existing accumulation
  let existing_forms = textureLoad(forms_read, px, 0);
  let existing_accum = textureLoad(accum_read, px, 0);
  let existing_weight = existing_accum.a;

  // Diminishing returns
  let velvet_exp = mix(1.5, 0.7, sp.velvet);
  let raw_alpha = pow(edge * form.opacity, velvet_exp);
  let attenuation = sp.base_opacity * pow(sp.falloff, existing_weight);
  let effective_alpha = raw_alpha * attenuation;

  // K/S pigment accumulation
  var ks_accum = vec3f(0.0);
  var weight_accum = 0.0;
  var opacity_accum = 0.0;

  // Seed from existing paint
  if (existing_forms.a > 0.001) {
    let existing_refl = rgb_to_reflectance(existing_forms.rgb);
    let existing_ks = (1.0 - existing_refl) * (1.0 - existing_refl) / (2.0 * existing_refl);
    ks_accum = existing_ks * existing_forms.a;
    weight_accum = existing_forms.a;
    opacity_accum = existing_forms.a;
  }

  // Add new pigment
  let refl = rgb_to_reflectance(form_color);
  let ks = (1.0 - refl) * (1.0 - refl) / (2.0 * refl);
  ks_accum += ks * effective_alpha;
  weight_accum += effective_alpha;
  opacity_accum = effective_alpha + opacity_accum * (1.0 - effective_alpha);

  // Convert weighted-average K/S to RGB
  let avg_ks = ks_accum / max(weight_accum, 0.001);
  let r_mixed = 1.0 + avg_ks - sqrt(avg_ks * avg_ks + 2.0 * avg_ks);
  let out_color = reflectance_to_rgb(r_mixed);

  textureStore(forms_write, px, vec4f(out_color, opacity_accum));

  // Update accum weight
  let stroke_landed = smoothstep(0.01, 0.15, effective_alpha);
  let new_weight = existing_weight + stroke_landed;
  textureStore(accum_write, px, vec4f(0.0, 0.0, 0.0, new_weight));
}
