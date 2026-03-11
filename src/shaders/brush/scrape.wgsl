// Scrape brush — palette knife removal from accumulation surface
// Rectangular blade, behind-cursor bias, side ridges, directional scratches
// Wetness modulates scrape effectiveness — wet lifts cleanly, dry resists

#include "../common/wetness.wgsl"

struct ScrapeParams {
  center: vec2f,            // cursor position (normalized 0-1)
  radius: f32,              // scrape width
  thinners: f32,            // master physics variable (replaces softness)
  scrape_direction: vec2f,  // normalized gesture direction
  strength: f32,            // from reservoir (LOAD depletion)
  ghost_retention: f32,     // 0.15 — how much pigment survives full scrape
  session_time: f32,        // current session time
  surface_dry_speed: f32,   // drying rate multiplier
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> params: ScrapeParams;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var surface_height: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;
@group(3) @binding(0) var state_read: texture_2d<f32>;
@group(3) @binding(1) var state_write: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let existing = textureLoad(accum_read, vec2i(gid.xy), 0);
  let state = textureLoad(state_read, vec2i(gid.xy), 0);

  // --- Blade coordinate system ---
  let stroke_dir = params.scrape_direction;
  let perp = vec2f(-stroke_dir.y, stroke_dir.x);
  let to_pixel = uv - params.center;

  let along = dot(to_pixel, stroke_dir);   // negative = behind cursor, positive = ahead
  let across = dot(to_pixel, perp);         // signed distance from center line

  // --- Rectangular blade shape ---
  let blade_half_width = params.radius;
  let blade_depth = params.radius * 0.3;
  let softness = params.thinners * params.radius;

  let in_blade_across = 1.0 - smoothstep(blade_half_width - softness, blade_half_width, abs(across));
  let in_blade_along = 1.0 - smoothstep(blade_depth, blade_depth + softness * 0.5, abs(along));
  let blade_mask = in_blade_across * in_blade_along;

  if (blade_mask < 0.001 || existing.a < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // --- Wetness modulates scrape effectiveness ---
  let wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);
  let tacky = smoothstep(0.1, 0.25, wetness) * smoothstep(0.5, 0.35, wetness);
  let scrape_power = mix(0.3, 1.0, wetness) * (1.0 + tacky * 0.5);
  let paint_thickness = existing.a * (1.0 - state.g * 0.5);
  let scrape_effectiveness = smoothstep(0.05, 0.3, paint_thickness) * scrape_power;

  // --- Behind-cursor bias ---
  let behind_factor = smoothstep(0.0, blade_depth, -along);
  let removal_strength = blade_mask * params.strength * behind_factor * scrape_effectiveness;

  // --- Surface grain interaction ---
  let grain_uv = uv * vec2f(f32(dims.x) / 2048.0, f32(dims.y) / 2048.0);
  let grain = textureSampleLevel(surface_height, grain_sampler, grain_uv, 0.0).r;
  let grain_lift = smoothstep(0.35, 0.75, grain);

  // --- Knife scratches (prominent, parallel to blade) ---
  let scratch_coord = dot(vec2f(gid.xy), perp);
  let scratches = 0.7 + 0.3 * sin(scratch_coord * 0.5);

  // --- Side ridges (paint pushed to blade edges) ---
  let edge_proximity = abs(across) / blade_half_width;
  let ridge_factor = smoothstep(0.65, 0.95, edge_proximity);

  // --- Center of blade: scrape with grain + scratches ---
  let scrape_removal = removal_strength * grain_lift * scratches * (1.0 - ridge_factor);
  let new_weight = max(0.0, existing.a - scrape_removal);

  // --- Ghost stain ---
  let ghost_floor = existing.rgb * params.ghost_retention;
  let weight_ratio = new_weight / max(existing.a, 0.001);
  let scraped_K = max(ghost_floor, existing.rgb * weight_ratio);

  // --- Edge ridges: deposit paint pushed sideways ---
  let ridge_deposit = blade_mask * behind_factor * params.strength * ridge_factor * 0.15;
  let final_weight = mix(new_weight, existing.a + ridge_deposit, ridge_factor);
  let final_K = mix(scraped_K, existing.rgb, ridge_factor);

  textureStore(accum_write, vec2i(gid.xy), vec4f(final_K, final_weight));
  // Scraping doesn't refresh paint — keep existing state
  textureStore(state_write, vec2i(gid.xy), state);
}
