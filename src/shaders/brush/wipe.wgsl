// Wipe brush — rag removal from accumulation surface
// Omnidirectional, grain-aware, patchy cloth texture, leaves ghost stain
// Wetness modulates wipe effectiveness — thin wet paint lifts easily, dry paint resists

#include "../common/wetness.wgsl"

struct WipeParams {
  center: vec2f,            // cursor position (normalized 0-1)
  radius: f32,              // wipe area
  thinners: f32,            // master physics variable (replaces softness)
  strength: f32,            // from reservoir (LOAD depletion)
  ghost_retention: f32,     // 0.15 — how much pigment survives full wipe
  patchiness: f32,          // 0.6 — how uneven the removal is
  session_time: f32,        // current session time
  surface_dry_speed: f32,   // drying rate multiplier
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

@group(0) @binding(0) var<uniform> params: WipeParams;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var surface_height: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;
@group(3) @binding(0) var state_read: texture_2d<f32>;
@group(3) @binding(1) var state_write: texture_storage_2d<rg32float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let existing = textureLoad(accum_read, vec2i(gid.xy), 0);
  let state = textureLoad(state_read, vec2i(gid.xy), 0);

  // Distance from cursor — soft circular area
  let dist = length(uv - params.center);
  let alpha = 1.0 - smoothstep(params.radius - params.thinners * params.radius, params.radius, dist);

  if (alpha < 0.001 || existing.a < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // --- Wetness modulates wipe effectiveness ---
  let wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);
  let wetness_factor = mix(0.05, 1.0, wetness);
  let thin_lift_bonus = state.g * 0.5;  // thinners makes paint easier to lift

  // --- Surface grain interaction ---
  // Same as scrape — peaks lift, valleys hold
  let grain_uv = uv * vec2f(f32(dims.x) / 2048.0, f32(dims.y) / 2048.0);
  let grain = textureSampleLevel(surface_height, grain_sampler, grain_uv, 0.0).r;
  let grain_lift = smoothstep(0.35, 0.75, grain);

  // --- Patchiness ---
  // A rag doesn't lift paint evenly. Some areas press harder.
  // Use a second grain sample at different frequency for cloth texture
  let cloth_uv = uv * vec2f(f32(dims.x) / 256.0, f32(dims.y) / 256.0);
  let cloth = textureSampleLevel(surface_height, grain_sampler, cloth_uv + 0.37, 0.0).r;
  let cloth_lift = mix(1.0, cloth, params.patchiness);

  // --- Pressure falloff from center ---
  // The rag presses hardest at the center, lighter at edges
  let pressure = 1.0 - dist / params.radius;
  let pressure_curve = pressure * pressure;  // quadratic falloff

  // --- Combined removal ---
  let base_wipe = alpha * params.strength * grain_lift * cloth_lift * pressure_curve;
  let wipe_amount = (base_wipe + thin_lift_bonus) * wetness_factor;

  // --- Reduce paint weight ---
  let new_weight = max(0.0, existing.a - wipe_amount);

  // --- Ghost stain ---
  let ghost_floor = existing.rgb * params.ghost_retention;
  let weight_ratio = new_weight / max(existing.a, 0.001);
  let wiped_K = max(ghost_floor, existing.rgb * weight_ratio);

  textureStore(accum_write, vec2i(gid.xy), vec4f(wiped_K, new_weight));
  // Wiping doesn't refresh paint — keep existing state
  textureStore(state_write, vec2i(gid.xy), state);
}
