// Light scatter compute shader
// Screen-space ray march through atmosphere density

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
  depth: f32,
  intensity: f32,
  radius: f32,
  color_r: f32,
  color_g: f32,
  color_b: f32,
  scatter: f32,
  scale_x: f32,
  scale_y: f32,
  rotation: f32,
};

struct LightParams {
  light_count: u32,
  max_steps: u32,
  sun_elevation: f32,
  sun_scatter_boost: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: LightParams;
@group(1) @binding(1) var<storage, read> lights: array<LightData>;
@group(2) @binding(0) var density_tex: texture_2d<f32>;
@group(2) @binding(1) var depth_tex: texture_2d<f32>;
@group(2) @binding(2) var forms_tex: texture_2d<f32>;
@group(2) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;

// Elliptical distance: transform point by inverse rotation + scale
fn elliptical_dist(p: vec2f, center: vec2f, sx: f32, sy: f32, rot: f32) -> f32 {
  let d = p - center;
  let cr = cos(-rot);
  let sr = sin(-rot);
  let rd = vec2f(d.x * cr - d.y * sr, d.x * sr + d.y * cr);
  let scaled = vec2f(rd.x / max(sx, 0.001), rd.y / max(sy, 0.001));
  return length(scaled);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2f(f32(dims.x), f32(dims.y));
  let pixel_depth = textureLoad(depth_tex, vec2i(gid.xy), 0).r;
  let form_alpha = textureLoad(forms_tex, vec2i(gid.xy), 0).a;

  var total_light = vec3f(0.0);

  for (var li = 0u; li < params.light_count; li++) {
    let light = lights[li];
    let light_pos = vec2f(light.x, light.y);
    let light_color = vec3f(light.color_r, light.color_g, light.color_b);

    // Direct light contribution with elliptical falloff
    let to_light = light_pos - uv;
    let dist = length(to_light);
    let edist = elliptical_dist(uv, light_pos, light.scale_x, light.scale_y, light.rotation);
    let falloff = 1.0 / (1.0 + edist * edist * 4.0 / (light.radius * light.radius));

    // Ray march from pixel toward light through density
    let dir = normalize(to_light);
    let step_size = dist / f32(params.max_steps);
    var accumulated_density = 0.0;
    var scatter_contrib = vec3f(0.0);

    for (var s = 0u; s < params.max_steps; s++) {
      let t = (f32(s) + 0.5) / f32(params.max_steps);
      let sample_pos = uv + dir * (t * dist);
      let sample_coord = vec2i(
        clamp(i32(sample_pos.x * f32(dims.x)), 0, i32(dims.x) - 1),
        clamp(i32(sample_pos.y * f32(dims.y)), 0, i32(dims.y) - 1)
      );

      let density = textureLoad(density_tex, sample_coord, 0).r;
      accumulated_density += density * step_size * 5.0;

      // In-scattering: light scattered toward viewer at this point
      let scatter_falloff = exp(-accumulated_density);
      let point_edist = elliptical_dist(sample_pos, light_pos, light.scale_x, light.scale_y, light.rotation);
      let point_falloff = 1.0 / (1.0 + point_edist * point_edist * 8.0 / (light.radius * light.radius));
      scatter_contrib += light_color * scatter_falloff * point_falloff * step_size * light.scatter;
    }

    // Form occlusion
    let occlusion = 1.0 - form_alpha * 0.5;

    // Combine direct + scattered
    let transmission = exp(-accumulated_density);
    let direct = light_color * light.intensity * falloff * transmission * occlusion;
    total_light += direct + scatter_contrib * light.intensity * params.sun_scatter_boost;
  }

  textureStore(output_tex, vec2i(gid.xy), vec4f(total_light, 1.0));
}
