// Wipe brush — rag removal from accumulation surface
// Omnidirectional, grain-aware, patchy cloth texture, leaves ghost stain

struct WipeParams {
  center: vec2f,            // cursor position (normalized 0-1)
  radius: f32,              // wipe area
  softness: f32,            // from VELVET — edge softness
  strength: f32,            // from reservoir (LOAD depletion)
  ghost_retention: f32,     // 0.15 — how much pigment survives full wipe
  patchiness: f32,          // 0.6 — how uneven the removal is
  _pad0: f32,
}

@group(0) @binding(0) var<uniform> params: WipeParams;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var grain_lut: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let existing = textureLoad(accum_read, vec2i(gid.xy), 0);

  // Distance from cursor — soft circular area
  let dist = length(uv - params.center);
  let alpha = 1.0 - smoothstep(params.radius - params.softness, params.radius, dist);

  if (alpha < 0.001 || existing.a < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    return;
  }

  // --- Surface grain interaction ---
  // Same as scrape — peaks lift, valleys hold
  let grain_uv = uv * vec2f(f32(dims.x) / 512.0, f32(dims.y) / 512.0);
  let grain = textureSampleLevel(grain_lut, grain_sampler, grain_uv, 0.0).r;
  let grain_lift = smoothstep(0.35, 0.75, grain);

  // --- Patchiness ---
  // A rag doesn't lift paint evenly. Some areas press harder.
  // Use a second grain sample at different frequency for cloth texture
  let cloth_uv = uv * vec2f(f32(dims.x) / 256.0, f32(dims.y) / 256.0);
  let cloth = textureSampleLevel(grain_lut, grain_sampler, cloth_uv + 0.37, 0.0).r;
  let cloth_lift = mix(1.0, cloth, params.patchiness);

  // --- Pressure falloff from center ---
  // The rag presses hardest at the center, lighter at edges
  let pressure = 1.0 - dist / params.radius;
  let pressure_curve = pressure * pressure;  // quadratic falloff

  // --- Combined removal ---
  let wipe_amount = alpha * params.strength * grain_lift * cloth_lift * pressure_curve;

  // --- Reduce paint weight ---
  let new_weight = max(0.0, existing.a - wipe_amount);

  // --- Ghost stain ---
  let ghost_floor = existing.rgb * params.ghost_retention;
  let weight_ratio = new_weight / max(existing.a, 0.001);
  let wiped_K = max(ghost_floor, existing.rgb * weight_ratio);

  textureStore(accum_write, vec2i(gid.xy), vec4f(wiped_K, new_weight));
}
