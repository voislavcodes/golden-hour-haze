// Atmosphere density compute shader — simplified, static (no drift/advection)
// Reads depth, writes density once from mood params
// R=density, G=warmth, B=grain_local, A=scatter_local

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct AtmosphereParams {
  density: f32,
  warmth: f32,
  grain: f32,
  scatter: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  humidity: f32,
  grain_depth: f32,
  horizon_y: f32,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: AtmosphereParams;
@group(2) @binding(0) var prev_density: texture_2d<f32>;
@group(2) @binding(1) var depth_tex: texture_2d<f32>;
@group(2) @binding(2) var density_sampler: sampler;
@group(2) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;
@group(2) @binding(4) var noise_lut: texture_2d<f32>;
@group(2) @binding(5) var noise_sampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2f(f32(dims.x), f32(dims.y));

  // Dense fog suppression: kills all spatial variation by density ~0.8
  let fog_suppress = smoothstep(0.2, 0.7, params.density);

  // Read depth (use density sampler for bilinear)
  let depth = textureSampleLevel(depth_tex, density_sampler, uv, 0.0).r;

  // Base density from depth (deeper = more atmosphere)
  let effective_density = params.density + pow(params.density, 3.0) * 0.5;
  let flat_depth = mix(depth, 1.0, fog_suppress);
  var depth_density = flat_depth * effective_density + effective_density * 0.3;
  depth_density *= 1.0 + params.humidity * 0.5;

  // Sample noise LUT for spatial variation (static — no drift offset)
  let noise_data = textureSampleLevel(noise_lut, noise_sampler, uv * 4.0, 0.0);

  // Gentle horizon haze
  let horizon_dist = abs((1.0 - uv.y) - params.horizon_y);
  let horizon_haze = select(0.0, exp(-horizon_dist * horizon_dist * 20.0) * params.density * 0.15 * (1.0 - fog_suppress), params.horizon_y >= 0.0);

  let new_density = depth_density + horizon_haze;

  // Warmth
  let warmth = mix(params.warmth, params.warmth * (1.0 - flat_depth * 0.5), 0.5);

  // Local grain variation from LUT G channel
  let grain_noise = noise_data.g;
  let grain_depth_scale = 1.0 - depth * (1.0 - params.grain_depth);
  let grain_val = grain_noise * params.grain * grain_depth_scale * (1.0 - fog_suppress);

  // Local scatter based on density and depth
  let scatter_val = new_density * params.scatter * (0.5 + flat_depth * 0.5);

  textureStore(output_tex, vec2i(gid.xy), vec4f(
    clamp(new_density, 0.0, 1.5),
    clamp(warmth, -1.0, 1.0),
    clamp(grain_val, 0.0, 1.0),
    clamp(scatter_val, 0.0, 1.0)
  ));
}
