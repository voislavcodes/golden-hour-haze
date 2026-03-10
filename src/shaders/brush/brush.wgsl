// Form brush — paint K-M pigment into accumulation surface
// Accumulation texture layout: R=K_r, G=K_g, B=K_b, A=paint_weight
// Paint state texture: R=session_time_painted, G=thinners_at_paint_time
// Thinners modulates: pigment density, edge softness, grain interaction
// Bristle physics: age controls splay, edge roughness, bristle streaks

#include "../common/wetness.wgsl"

struct BrushParams {
  center: vec2f,              // offset 0   — cursor position
  radius: f32,                // offset 8   — brush size
  thinners: f32,              // offset 12  — master physics variable

  palette_K: vec3f,           // offset 16  — K-M absorption
  pigment_density: f32,       // offset 28  — replaces base_opacity

  falloff: f32,               // offset 32  — per-stroke diminishing
  reservoir: f32,             // offset 36  — paint remaining
  age: f32,                   // offset 40  — 0=new, 0.5=worn, 1.0=old
  bristle_seed: f32,          // offset 44  — random per session

  surface_absorption: f32,    // offset 48  — surface absorbs first stroke
  session_time: f32,          // offset 52  — current session time
  surface_dry_speed: f32,     // offset 56  — drying rate multiplier
  stroke_start_layers: f32,   // offset 60  — existing (for diminishing returns)
};

@group(0) @binding(0) var<uniform> params: BrushParams;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var grain_lut: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;
@group(2) @binding(2) var state_read: texture_2d<f32>;
@group(2) @binding(3) var state_write: texture_storage_2d<rg32float, write>;

// Simple hash noise for edge roughness
fn hash_noise(angle: f32, seed: f32) -> f32 {
  let s = sin(angle * 127.1 + seed * 311.7) * 43758.5453;
  return fract(s);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let existing = textureLoad(accum_read, vec2i(gid.xy), 0);
  let state = textureLoad(state_read, vec2i(gid.xy), 0);

  // Vector from cursor to pixel
  let to_pixel = uv - params.center;
  let dist = length(to_pixel);

  // Angle for bristle pattern
  let angle = atan2(to_pixel.y, to_pixel.x);

  // Thinners-driven edge softness and spread
  let spread = 1.0 + params.thinners * 0.4;

  // Bristle physics: age controls splay and roughness
  let splay = 1.0 + params.age * 0.3;
  let effective_radius = params.radius * spread * splay;
  let edge_softness = params.radius * params.thinners * 0.5;
  let edge_roughness = hash_noise(angle, params.bristle_seed) * params.age * 0.15 * params.radius;

  // Bristle streak pattern
  let bristle_count = mix(5.0, 14.0, params.age);
  let radial_pos = dist / max(effective_radius, 0.0001);
  let edge_emphasis = smoothstep(0.3, 0.9, radial_pos);
  let bristle_pattern = 1.0 - edge_emphasis * (0.5 + 0.5 * sin(angle * bristle_count + params.bristle_seed * 6.28)) * params.age;

  // Combined alpha with bristle modulation
  let alpha = (1.0 - smoothstep(effective_radius - edge_softness - edge_roughness, effective_radius, dist)) * bristle_pattern;

  // Grain-aware deposition
  let grain_uv = uv * vec2f(f32(dims.x) / 512.0, f32(dims.y) / 512.0);
  let grain = textureSampleLevel(grain_lut, grain_sampler, grain_uv, 0.0).r;
  let grain_interaction = mix(1.0, grain, params.thinners * 0.5);

  // Diminishing returns — per-stroke only; new strokes arrive at full opacity
  let layers_this_stroke = max(existing.a - params.stroke_start_layers, 0.0);
  let effective_alpha = alpha * params.pigment_density * pow(params.falloff, layers_this_stroke) * params.reservoir * grain_interaction;

  if (effective_alpha < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // Pure medium mode — thinners > 0.9 wets surface without depositing pigment
  if (params.thinners > 0.9) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), vec4f(params.session_time, 1.0, 0.0, 0.0));
    return;
  }

  // Wetness of existing paint
  let wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);

  // Surface absorption — bare surface absorbs more, sealed surface doesn't
  let bare_surface = 1.0 - saturate(existing.a * 3.0);
  let thinners_absorption = params.surface_absorption * (1.0 + params.thinners);
  let absorbed = effective_alpha * thinners_absorption * bare_surface;
  let deposited = effective_alpha - absorbed;

  // Emergent color pickup — four variables, all from earlier phases
  let pickup = wetness * params.reservoir
             * (0.3 + params.age * 0.7)       // age 0→0.3, age 1→1.0
             * (0.2 + params.thinners * 0.8);  // thinners 0→0.2, thinners 1→1.0
  let input_K = mix(params.palette_K, existing.rgb, pickup);

  // Absorbed paint leaves deep stain
  let absorbed_stain = input_K * absorbed * 0.5;

  // K-M mixing — wetness modulates blend mode
  let new_weight = existing.a + deposited;
  let paint_depth = min(existing.a, 2.0);
  let blend_factor = deposited / (paint_depth + deposited + 0.001);

  // Wet paint: full K-M mixing. Dry paint: overlay (less subtractive blend)
  let wet_result = mix(existing.rgb + absorbed_stain, input_K, blend_factor);
  let dry_overlay = existing.rgb * (1.0 - blend_factor) + input_K * blend_factor + absorbed_stain;
  let result_K = mix(dry_overlay, wet_result, wetness);

  textureStore(accum_write, vec2i(gid.xy), vec4f(result_K, new_weight));

  // Write paint state — timestamp + thinners for wetness tracking
  let new_state = select(state.rg, vec2f(params.session_time, params.thinners), effective_alpha > 0.01);
  textureStore(state_write, vec2i(gid.xy), vec4f(new_state, 0.0, 0.0));
}
