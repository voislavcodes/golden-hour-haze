// Generates a 256x256 tiling FBM noise LUT
// R = base FBM, G = grain-frequency variant
// Tiling via edge-blend: blend 16px border with offset sample

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

struct LUTParams {
  turbulence: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

@group(0) @binding(0) var<uniform> params: LUTParams;
@group(0) @binding(1) var output_tex: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2f(f32(dims.x), f32(dims.y));

  // Base FBM noise (4 octaves)
  let base_noise = fbm_noise(uv * 4.0, 4) * params.turbulence;

  // Grain-frequency variant (higher frequency)
  let grain_noise = snoise(uv * 50.0) * 0.5 + 0.5;

  // Edge-blend for tiling: blend 16px border with offset sample
  let border = 16.0 / f32(dims.x);
  let bx = smoothstep(0.0, border, uv.x) * smoothstep(0.0, border, 1.0 - uv.x);
  let by = smoothstep(0.0, border, uv.y) * smoothstep(0.0, border, 1.0 - uv.y);
  let blend = bx * by;

  // Offset sample (wraps around)
  let offset_uv = fract(uv + 0.5);
  let base_offset = fbm_noise(offset_uv * 4.0, 4) * params.turbulence;
  let grain_offset = snoise(offset_uv * 50.0) * 0.5 + 0.5;

  let final_base = mix(base_offset, base_noise, blend);
  let final_grain = mix(grain_offset, grain_noise, blend);

  textureStore(output_tex, vec2i(gid.xy), vec4f(final_base, final_grain, 0.0, 0.0));
}
