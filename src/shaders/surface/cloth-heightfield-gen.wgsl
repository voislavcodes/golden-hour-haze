// Cloth contact heightfield — 64x64 Worley noise + analytical weave
// Used by wipe shader for rag contact texture
// 0.0 = ridge tip (maximum contact), 1.0 = valley (no contact)

struct ClothParams {
  seed: f32,
  crumple_scale: f32,
  weave_freq: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: ClothParams;
@group(0) @binding(1) var cloth_out: texture_storage_2d<rgba8unorm, write>;

// Hash for Worley feature point placement
fn hash2(p: vec2f) -> vec2f {
  return fract(sin(vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3))
  )) * 43758.5453);
}

// Worley (cellular) noise — distance to nearest feature point
fn worley(uv: vec2f, cells: f32, seed: f32) -> f32 {
  let p = uv * cells;
  let cell = floor(p);
  var min_dist = 1.0;

  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let neighbor = cell + vec2f(f32(dx), f32(dy));
      let h = hash2(neighbor + seed);
      let feature = neighbor + h;
      let d = length(p - feature);
      min_dist = min(min_dist, d);
    }
  }

  return saturate(min_dist);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(cloth_out);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);

  // Worley crumple — inverted so fold ridges = low values (high contact)
  let w1 = worley(uv, 4.0, params.seed);
  let w2 = worley(uv, 3.0, params.seed + 100.0) * 0.5;
  let crumple = 1.0 - saturate((w1 + w2) / 1.5);

  // Analytical weave — crossed sine waves with slight irregularity (cotton)
  let freq = params.weave_freq;
  let noise_mod = fract(sin(dot(uv, vec2f(12.9898, 78.233)) + params.seed) * 43758.5453) * 0.3;
  let warp = sin((uv.x + noise_mod * 0.02) * freq * 6.2831853) * 0.5 + 0.5;
  let weft = sin((uv.y + noise_mod * 0.02) * freq * 6.2831853) * 0.5 + 0.5;
  let weave = max(warp, weft);

  // Combined: crumple dominates, weave adds fine texture between folds
  let cloth_height = crumple * 0.8 + (1.0 - weave) * 0.2;

  textureStore(cloth_out, vec2i(gid.xy), vec4f(cloth_height, 0.0, 0.0, 1.0));
}
