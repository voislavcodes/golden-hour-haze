// Atmosphere density compute shader
// Reads previous density (ping), writes new density (pong)
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
  drift_x: f32,
  drift_y: f32,
  drift_speed: f32,
  turbulence: f32,
  humidity: f32,
  grain_depth: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: AtmosphereParams;
@group(2) @binding(0) var prev_density: texture_2d<f32>;
@group(2) @binding(1) var depth_tex: texture_2d<f32>;
@group(2) @binding(2) var density_sampler: sampler;
@group(2) @binding(3) var output_tex: texture_storage_2d<rgba16float, write>;

// Inline noise for compute shader
fn mod289v3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v2(x: vec2f) -> vec2f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permuteV3(x: vec3f) -> vec3f { return mod289v3((x * 34.0 + 10.0) * x); }

fn snoise(v: vec2f) -> f32 {
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

fn fbm_noise(p: vec2f, octaves: i32) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  var pos = p;
  for (var i = 0; i < octaves; i++) {
    value += amp * snoise(pos * freq);
    freq *= 2.0; amp *= 0.5;
    pos = vec2f(pos.y + 100.0, pos.x + 100.0);
  }
  return value;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2f(f32(dims.x), f32(dims.y));

  // Read previous density via sampler for drift advection
  let drift = vec2f(params.drift_x, params.drift_y) * params.drift_speed * globals.dt;
  let prev_uv = uv - drift;
  let prev = textureSampleLevel(prev_density, density_sampler, prev_uv, 0.0);

  // Read depth
  let depth = textureSampleLevel(depth_tex, density_sampler, uv, 0.0).r;

  // Base density from depth (deeper = more atmosphere)
  // Humidity amplifies density ceiling
  var depth_density = depth * params.density;
  depth_density *= 1.0 + params.humidity * 0.5;

  // FBM noise for turbulence — humidity dampens turbulence slightly
  let effective_turb = params.turbulence * (1.0 - params.humidity * 0.3);
  let noise_pos = uv * 4.0 + vec2f(globals.time * 0.05, globals.time * 0.03);
  let turb = fbm_noise(noise_pos, 4) * effective_turb;

  // Evolve density: blend previous with new computation
  let new_density = mix(depth_density + turb * 0.3, prev.r, 0.85);

  // Warmth: based on depth and global warmth param
  let warmth = mix(params.warmth, params.warmth * (1.0 - depth * 0.5), 0.5);

  // Local grain variation — grain_depth controls depth falloff
  let grain_noise = snoise(uv * 50.0 + vec2f(globals.time * 0.1)) * 0.5 + 0.5;
  let grain_depth_scale = 1.0 - depth * (1.0 - params.grain_depth);
  let grain_val = grain_noise * params.grain * grain_depth_scale;

  // Local scatter based on density and depth
  let scatter_val = new_density * params.scatter * (0.5 + depth * 0.5);

  textureStore(output_tex, vec2i(gid.xy), vec4f(
    clamp(new_density, 0.0, 1.0),
    clamp(warmth, -1.0, 1.0),
    clamp(grain_val, 0.0, 1.0),
    clamp(scatter_val, 0.0, 1.0)
  ));
}
