// V2 Light wells — Gaussian core + density-modulated bloom
// Occlusion reads accumulation surface weight (not forms alpha)

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct LightData {
  x: f32,
  y: f32,
  core_radius: f32,
  bloom_radius: f32,
  intensity: f32,
  aspect_ratio: f32,
  rotation: f32,
  palette_slot: f32,
  color_r: f32,
  color_g: f32,
  color_b: f32,
  depth: f32,
};

struct LightParams {
  light_count: u32,
  sun_elevation: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
  _pad5: f32,
  _pad6: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: LightParams;
@group(1) @binding(1) var<storage, read> lights: array<LightData>;
@group(2) @binding(0) var density_tex: texture_2d<f32>;
@group(2) @binding(1) var accum_tex: texture_2d<f32>;
@group(2) @binding(2) var output_tex: texture_storage_2d<rgba16float, write>;

fn elliptical_dist(p: vec2f, center: vec2f, aspect: f32, rot: f32) -> f32 {
  let d = p - center;
  let cr = cos(-rot);
  let sr = sin(-rot);
  let rd = vec2f(d.x * cr - d.y * sr, d.x * sr + d.y * cr);
  let scaled = vec2f(rd.x, rd.y / max(aspect, 0.001));
  return length(scaled);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2f(f32(dims.x), f32(dims.y));

  let density_dims = vec2f(textureDimensions(density_tex));
  let density_coord = vec2i(uv * density_dims);
  let density = textureLoad(density_tex, density_coord, 0).r;

  // V2: Read paint weight from accumulation surface for occlusion
  let accum_dims = textureDimensions(accum_tex);
  let accum_coord = vec2i(uv * vec2f(accum_dims));
  let paint_weight = textureLoad(accum_tex, accum_coord, 0).b;
  let paint_opacity = clamp(paint_weight * 2.0, 0.0, 1.0);

  var total_light = vec3f(0.0);
  var accumulated_brightness = 0.0;

  for (var li = 0u; li < params.light_count; li++) {
    let light = lights[li];
    let light_pos = vec2f(light.x, light.y);
    let light_color = vec3f(light.color_r, light.color_g, light.color_b);

    let edist = elliptical_dist(uv, light_pos, light.aspect_ratio, light.rotation);

    let core_sigma = max(light.core_radius, 0.001);
    let core = exp(-edist * edist / (2.0 * core_sigma * core_sigma));

    let density_widen = 1.0 + density * 2.0;
    let bloom_sigma = max(light.bloom_radius * density_widen, 0.001);
    let bloom = exp(-edist * edist / (2.0 * bloom_sigma * bloom_sigma));

    // V2: Occlusion from painting surface weight
    let core_occlusion = 1.0 - paint_opacity * 0.8;
    let bloom_occlusion = 1.0 - paint_opacity * 0.3;

    let core_contrib = core * core_occlusion;
    let bloom_contrib = bloom * bloom_occlusion * 0.4;
    let combined = (core_contrib + bloom_contrib) * light.intensity;

    let diminish = 1.0 / (1.0 + accumulated_brightness * 0.5);
    total_light += light_color * combined * diminish;
    accumulated_brightness += combined;
  }

  textureStore(output_tex, vec2i(gid.xy), vec4f(total_light, 1.0));
}
