// Surface grain LUT generator — 512x512 r8unorm
// Standard mode: directional stretch + surface tooth
// Woodblock mode: domain-warped flowing grain

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

struct SurfaceParams {
  grain_size: f32,
  directionality: f32,
  seed: f32,
  mode: u32,
};

@group(0) @binding(0) var<uniform> params: SurfaceParams;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;

fn generate_standard(uv: vec2f) -> f32 {
  let base_freq = mix(120.0, 30.0, params.grain_size);
  let detail_freq = base_freq * 2.0;

  let dir_stretch = mix(1.0, 4.0, params.directionality);
  let grain_uv = uv * vec2f(base_freq / dir_stretch, base_freq * dir_stretch * 0.5);
  let detail_uv = uv * vec2f(detail_freq / dir_stretch, detail_freq * dir_stretch * 0.5);

  // Board grain — directional component
  let board = snoise2d(grain_uv + params.seed) * params.directionality;

  // Surface tooth — isotropic component
  let tooth_uv = uv * vec2f(base_freq, base_freq);
  let tooth = snoise2d(tooth_uv + params.seed * 2.0) * 0.6
            + snoise2d(tooth_uv * 2.0 + params.seed * 3.0) * 0.3;
  let tooth_strength = 1.0 - params.directionality * 0.5;

  let combined = board * 0.5 + tooth * tooth_strength * 0.5;
  return combined * 0.5 + 0.5;
}

fn generate_woodblock(uv: vec2f) -> f32 {
  let base_freq = mix(80.0, 25.0, params.grain_size);

  // Primary warp — large-scale curves in the grain
  let warp1 = snoise2d(uv * vec2f(3.0, 0.5) + params.seed) * 0.4;

  // Secondary warp — smaller wobbles
  let warp2 = snoise2d(uv * vec2f(8.0, 1.5) + params.seed * 2.0) * 0.1;

  // Displace y coordinate before sampling directional grain
  let warped_uv = uv + vec2f(0.0, warp1 + warp2);

  // Primary grain lines — tight horizontal, stretched by warp
  let grain = snoise2d(warped_uv * vec2f(2.0, base_freq));

  // Occasional knots — rare high-frequency disruptions
  let knot_chance = snoise2d(uv * 4.0 + params.seed * 3.0);
  let knot = select(0.0, snoise2d(uv * 40.0) * 0.3, knot_chance > 0.85);

  return (grain * 0.7 + knot) * 0.5 + 0.5;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2f(f32(dims.x), f32(dims.y));

  // Generate based on mode
  var value: f32;
  if (params.mode == 1u) {
    value = generate_woodblock(uv);
  } else {
    value = generate_standard(uv);
  }

  // Edge-blend 16px border for tiling
  let border = 16.0 / f32(dims.x);
  let bx = smoothstep(0.0, border, uv.x) * smoothstep(0.0, border, 1.0 - uv.x);
  let by = smoothstep(0.0, border, uv.y) * smoothstep(0.0, border, 1.0 - uv.y);
  let blend = bx * by;

  // Offset sample for seamless tiling
  let offset_uv = fract(uv + 0.5);
  var value_offset: f32;
  if (params.mode == 1u) {
    value_offset = generate_woodblock(offset_uv);
  } else {
    value_offset = generate_standard(offset_uv);
  }

  let final_value = mix(value_offset, value, blend);

  textureStore(output, vec2i(gid.xy), vec4f(final_value, 0.0, 0.0, 0.0));
}
