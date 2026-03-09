// Form brush — paint K-M pigment into accumulation surface
// Accumulation texture layout: R=K, G=S, B=paint_weight, A=layer_count

struct BrushParams {
  center: vec2f,           // cursor position (normalized 0-1)
  radius: f32,             // brush size (normalized)
  softness: f32,           // edge softness (0=hard, up to radius=fully soft)
  palette_K: vec3f,        // K-M absorption from tonal column
  _pad0: f32,
  palette_S: vec3f,        // K-M scattering from tonal column
  _pad1: f32,
  base_opacity: f32,       // 0.5 default
  falloff: f32,            // 0.7 default — diminishing returns
  echo: f32,               // 0-1, surface color pickup
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> params: BrushParams;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let existing = textureLoad(accum_read, vec2i(gid.xy), 0);

  // Distance from cursor center
  let dist = length(uv - params.center);

  // Brush alpha with softness-controlled edge
  let inner_edge = params.radius - params.softness;
  let alpha = 1.0 - smoothstep(inner_edge, params.radius, dist);

  // Diminishing returns — existing paint resists new paint
  let existing_weight = existing.b;
  let effective_alpha = alpha * params.base_opacity * pow(params.falloff, existing_weight);

  if (effective_alpha < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    return;
  }

  // ECHO: mix palette color with existing surface color
  let surface_K = existing.r;
  let surface_S = existing.g;
  let input_K = mix(params.palette_K.r, surface_K, params.echo);
  let input_S = mix(params.palette_S.r, surface_S, params.echo);

  // K-M accumulation — new pigment glazes over existing
  let new_K = input_K * effective_alpha;
  let new_S = input_S * effective_alpha;

  let mixed_K = existing.r + new_K;
  let mixed_S = existing.g + new_S;
  let new_weight = existing.b + effective_alpha;
  let new_layers = existing.a + effective_alpha;

  textureStore(accum_write, vec2i(gid.xy), vec4f(mixed_K, mixed_S, new_weight, new_layers));
}
