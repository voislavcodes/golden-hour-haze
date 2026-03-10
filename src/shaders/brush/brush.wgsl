// Form brush — capsule segment K-M pigment into accumulation surface
// Accumulation texture layout: R=K_r, G=K_g, B=K_b, A=paint_weight
// Paint state texture: R=session_time_painted, G=thinners_at_paint_time
// Capsule SDF between consecutive stroke points with pressure-varying radius
// Bristle streaks aligned to stroke direction

#include "../common/wetness.wgsl"

struct BrushParams {
  seg_start: vec2f,           // offset 0   — segment start position
  seg_end: vec2f,             // offset 8   — segment end position
  start_radius: f32,          // offset 16  — radius at seg_start (pressure-modulated)
  end_radius: f32,            // offset 20  — radius at seg_end
  thinners: f32,              // offset 24  — master physics variable
  pigment_density: f32,       // offset 28
  palette_K: vec3f,           // offset 32  — K-M absorption (16-byte aligned)
  falloff: f32,               // offset 44
  reservoir: f32,             // offset 48
  age: f32,                   // offset 52
  bristle_seed: f32,          // offset 56
  stroke_start_layers: f32,   // offset 60
  surface_absorption: f32,    // offset 64
  session_time: f32,          // offset 68
  surface_dry_speed: f32,     // offset 72
  _pad: f32,                  // offset 76
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

// Capsule SDF: returns (signed_distance, t_along_segment)
// Negative distance = inside. Degenerates to circle when a == b.
fn capsule_sdf(p: vec2f, a: vec2f, b: vec2f, ra: f32, rb: f32) -> vec2f {
  let ab = b - a;
  let len_sq = dot(ab, ab);
  if (len_sq < 0.0000001) {
    return vec2f(length(p - a) - ra, 0.0);
  }
  let t = clamp(dot(p - a, ab) / len_sq, 0.0, 1.0);
  let r = mix(ra, rb, t);
  return vec2f(length(p - a - ab * t) - r, t);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(accum_read);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims);
  let existing = textureLoad(accum_read, vec2i(gid.xy), 0);
  let state = textureLoad(state_read, vec2i(gid.xy), 0);

  // Thinners-driven spread and age-driven splay
  let spread = 1.0 + params.thinners * 0.4;
  let splay = 1.0 + params.age * 0.3;

  // Effective radii with spread + splay
  let eff_sr = params.start_radius * spread * splay;
  let eff_er = params.end_radius * spread * splay;

  // AABB early reject
  let max_r = max(eff_sr, eff_er);
  let bb_min = min(params.seg_start, params.seg_end) - vec2f(max_r);
  let bb_max = max(params.seg_start, params.seg_end) + vec2f(max_r);
  if (uv.x < bb_min.x || uv.x > bb_max.x || uv.y < bb_min.y || uv.y > bb_max.y) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // Capsule SDF
  let sdf = capsule_sdf(uv, params.seg_start, params.seg_end, eff_sr, eff_er);
  let dist = sdf.x;       // negative inside, positive outside
  let t_along = sdf.y;    // 0..1 along segment

  // Stroke direction for bristle alignment
  let seg_vec = params.seg_end - params.seg_start;
  let seg_len = length(seg_vec);
  let dir = select(vec2f(1.0, 0.0), seg_vec / seg_len, seg_len > 0.0001);
  let perp = vec2f(-dir.y, dir.x);

  // Project pixel perpendicular to stroke for bristle angle
  let local_r = mix(eff_sr, eff_er, t_along);
  let nearest = params.seg_start + seg_vec * t_along;
  let to_px = uv - nearest;
  let across = dot(to_px, perp);
  let bristle_angle = across / max(local_r, 0.0001);

  // Edge softness from local radius
  let edge_softness = local_r * params.thinners * 0.5;
  let edge_roughness = hash_noise(bristle_angle * 6.28, params.bristle_seed) * params.age * 0.15 * local_r;

  // Bristle streaks run parallel to stroke
  let bristle_count = mix(5.0, 14.0, params.age);
  let depth = max(-dist, 0.0) / max(local_r, 0.0001);
  let edge_emphasis = smoothstep(0.3, 0.9, 1.0 - depth);
  let bristle_pattern = 1.0 - edge_emphasis
      * (0.5 + 0.5 * sin(bristle_angle * bristle_count + params.bristle_seed * 6.28))
      * params.age;

  // Alpha from capsule SDF (negative inside -> smoothstep from -softness to 0)
  let alpha = (1.0 - smoothstep(-edge_softness - edge_roughness, 0.0, dist)) * bristle_pattern;

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
             * (0.3 + params.age * 0.7)       // age 0->0.3, age 1->1.0
             * (0.2 + params.thinners * 0.8);  // thinners 0->0.2, thinners 1->1.0
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
