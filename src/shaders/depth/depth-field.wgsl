// Depth field compute shader
// Writes r16float depth texture from control points + noise

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct DepthParams {
  near_plane: f32,
  far_plane: f32,
  noise_scale: f32,
  noise_strength: f32,
  control_count: u32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
  control_points: array<vec4f, 8>, // xy pairs packed as vec4 (x0,y0,x1,y1)
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: DepthParams;
@group(2) @binding(0) var output_tex: texture_storage_2d<r32float, write>;

// Inline simplex noise to avoid cross-module dependency in compute
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

fn fbm(p: vec2f, octaves: i32) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  var pos = p;
  for (var i = 0; i < octaves; i++) {
    value += amp * snoise2d(pos * freq);
    freq *= 2.0;
    amp *= 0.5;
    pos = vec2f(pos.y + 100.0, pos.x + 100.0);
  }
  return value;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x), f32(gid.y)) / vec2f(f32(dims.x), f32(dims.y));

  // Base depth gradient (bottom=near, top=far with slight perspective)
  var depth = mix(params.near_plane, params.far_plane, uv.y);

  // Add gentle radial falloff from center
  let center_dist = length(uv - vec2f(0.5, 0.5));
  depth += center_dist * 0.1;

  // Influence from control points — wide Gaussian, strong pull
  for (var i = 0u; i < params.control_count; i++) {
    let pack_idx = i / 2u;
    var cp: vec2f;
    if (i % 2u == 0u) {
      cp = params.control_points[pack_idx].xy;
    } else {
      cp = params.control_points[pack_idx].zw;
    }
    let d = length(uv - cp);
    // Wide influence radius (~0.3 of screen), strong blend
    let influence = exp(-d * d * 5.0);
    depth = mix(depth, cp.y, influence * 0.85);
  }

  // Noise-based terrain variation
  let noise = fbm(uv * params.noise_scale, 4);
  depth += noise * params.noise_strength;

  depth = clamp(depth, 0.0, 1.0);

  textureStore(output_tex, vec2i(gid.xy), vec4f(depth, 0.0, 0.0, 0.0));
}
