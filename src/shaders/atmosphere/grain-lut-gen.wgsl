// Generates a 512x512 tiling grain LUT (r8unorm)
// Multi-octave hash noise, pre-rotated by grain angle

struct GrainLUTParams {
  scale: f32,
  angle: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> params: GrainLUTParams;
@group(0) @binding(1) var output_tex: texture_storage_2d<r8unorm, write>;

fn hash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, vec3f(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
  return fract((p3.x + p3.y) * p3.z);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(output_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let raw_p = vec2f(f32(gid.x), f32(gid.y));

  // Rotate by grain angle
  let ca = cos(params.angle);
  let sa = sin(params.angle);
  let rotated_p = vec2f(raw_p.x * ca - raw_p.y * sa, raw_p.x * sa + raw_p.y * ca);

  let p1 = rotated_p * params.scale;
  let g1 = hash(p1);
  let g2 = hash(p1 * 2.37 + vec2f(17.3, 11.1));
  let g3 = hash(p1 * 0.73 + vec2f(3.1, 17.9));

  let grain = g1 * 0.5 + g2 * 0.3 + g3 * 0.2;

  textureStore(output_tex, vec2i(gid.xy), vec4f(grain, 0.0, 0.0, 0.0));
}
