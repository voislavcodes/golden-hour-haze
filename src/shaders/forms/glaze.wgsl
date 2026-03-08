// Glaze bake compute shader
// Merges live stroke contribution into accumulation weight buffer
// Weight tracks how many effective layers of paint exist at each pixel

struct GlazeParams {
  is_clear: u32,
  _p1: u32,
  _p2: u32,
  _p3: u32,
};

@group(0) @binding(0) var<uniform> gp: GlazeParams;
@group(1) @binding(0) var live_tex: texture_2d<f32>;
@group(1) @binding(1) var accum_read: texture_2d<f32>;
@group(1) @binding(2) var accum_write: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let live = textureLoad(live_tex, vec2i(gid.xy), 0);
  let accum = textureLoad(accum_read, vec2i(gid.xy), 0);

  // On full rebake (is_clear), discard old accumulation
  let base_weight = select(accum.a, 0.0, gp.is_clear == 1u);
  let new_weight = base_weight + live.a;

  textureStore(accum_write, vec2i(gid.xy), vec4f(0.0, 0.0, 0.0, new_weight));
}
