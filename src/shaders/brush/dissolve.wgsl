// Dissolve brush — subtract paint from accumulation surface
// Thins pigment proportionally, atmosphere shows through

struct DissolveParams {
  center: vec2f,           // cursor position (normalized 0-1)
  radius: f32,             // brush size (normalized)
  softness: f32,           // edge softness
  dissolve_strength: f32,  // how much to remove per dab
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> params: DissolveParams;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let existing = textureLoad(accum_read, vec2i(gid.xy), 0);

  // Distance from cursor
  let dist = length(uv - params.center);
  let inner_edge = params.radius - params.softness;
  let alpha = 1.0 - smoothstep(inner_edge, params.radius, dist);

  let dissolve_amount = alpha * params.dissolve_strength;

  if (dissolve_amount < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    return;
  }

  // Reduce weight, scale K and S proportionally
  let new_weight = max(0.0, existing.b - dissolve_amount);
  let scale = new_weight / max(existing.b, 0.001);
  let new_K = existing.r * scale;
  let new_S = existing.g * scale;

  textureStore(accum_write, vec2i(gid.xy), vec4f(new_K, new_S, new_weight, existing.a));
}
