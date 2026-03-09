// Clear compute shader — writes zeros to forms + accum texture pair

@group(0) @binding(0) var forms_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var accum_tex: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(forms_tex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  textureStore(forms_tex, vec2i(gid.xy), vec4f(0.0));
  textureStore(accum_tex, vec2i(gid.xy), vec4f(0.0));
}
