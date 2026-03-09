// Form brush — paint K-M pigment into accumulation surface
// Accumulation texture layout: R=K_r, G=K_g, B=K_b, A=paint_weight

struct BrushParams {
  center: vec2f,           // cursor position (normalized 0-1)
  radius: f32,             // brush size (normalized)
  softness: f32,           // edge softness (0=hard, up to radius=fully soft)
  palette_K: vec3f,        // per-channel K-M absorption from tonal column
  _pad0: f32,
  palette_S: vec3f,        // K-M scattering (always 1.0, kept for future use)
  _pad1: f32,
  base_opacity: f32,       // 0.5 default
  falloff: f32,            // 0.7 default — diminishing returns
  echo: f32,               // 0-1, surface color pickup
  stroke_start_layers: f32, // layer count at stroke start — per-stroke diminishing returns
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

  // Diminishing returns — per-stroke only; new strokes arrive at full opacity
  let layers_this_stroke = max(existing.a - params.stroke_start_layers, 0.0);
  let effective_alpha = alpha * params.base_opacity * pow(params.falloff, layers_this_stroke);

  if (effective_alpha < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    return;
  }

  // ECHO: mix palette color with existing surface color (per-channel)
  let surface_K = existing.rgb;
  let input_K = mix(params.palette_K, surface_K, params.echo);

  // Per-channel reflectance via K-M formula (S=1 implicit)
  // R(K) = 1 + K - sqrt(K² + 2K)
  let ex_K = existing.rgb;
  let ex_R = 1.0 + ex_K - sqrt(ex_K * ex_K + 2.0 * ex_K);
  let new_R = 1.0 + input_K - sqrt(input_K * input_K + 2.0 * input_K);

  // Compare luminance of reflectances to determine light vs dark
  let ex_lum = dot(ex_R, vec3f(0.2126, 0.7152, 0.0722));
  let new_lum = dot(new_R, vec3f(0.2126, 0.7152, 0.0722));

  // Smooth coverage factor — avoids hard branch seams between dab pixels
  let lum_diff = new_lum - ex_lum;
  let coverage_t = smoothstep(0.05, 0.25, lum_diff) * step(0.01, existing.a);

  // Glaze path — additive K (dark over light / bare canvas)
  let glaze_K = existing.rgb + input_K * effective_alpha;

  // Coverage path — replace toward lighter K
  let cover_K = mix(existing.rgb, input_K, effective_alpha * 0.8);

  // Blend between modes
  let result_K = mix(glaze_K, cover_K, coverage_t);
  let new_weight = existing.a + effective_alpha;
  textureStore(accum_write, vec2i(gid.xy), vec4f(result_K, new_weight));
}
