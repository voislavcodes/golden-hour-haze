// High-frequency grain compute shader
// Writes r8unorm grain texture

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct GrainParams {
  intensity: f32,
  scale: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: GrainParams;
@group(2) @binding(0) var depth_tex: texture_2d<f32>;
@group(2) @binding(1) var output_tex: texture_storage_2d<r32float, write>;

fn hash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, vec3f(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
  return fract((p3.x + p3.y) * p3.z);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x), f32(gid.y)) / vec2f(f32(dims.x), f32(dims.y));

  // Read depth — grain scale inversely proportional to depth
  let depth = textureLoad(depth_tex, vec2i(gid.xy), 0).r;
  let depth_scale = 1.0 - depth * 0.7; // near = full grain, far = reduced

  // High frequency noise at varying scales
  let t = globals.time;
  let p1 = vec2f(f32(gid.x), f32(gid.y)) * params.scale;
  let g1 = hash(p1 + vec2f(t * 7.3, t * 11.1));
  let g2 = hash(p1 * 2.37 + vec2f(t * 13.7, t * 5.3));
  let g3 = hash(p1 * 0.73 + vec2f(t * 3.1, t * 17.9));

  // Mix octaves
  let grain = (g1 * 0.5 + g2 * 0.3 + g3 * 0.2) * params.intensity * depth_scale;

  textureStore(output_tex, vec2i(gid.xy), vec4f(grain, 0.0, 0.0, 0.0));
}
