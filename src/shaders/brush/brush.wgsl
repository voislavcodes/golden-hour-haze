// Polyline SDF brush — single-pass K-M pigment into accumulation surface
// Accumulation texture layout: R=K_r, G=K_g, B=K_b, A=paint_weight
// Paint state texture: R=session_time_painted, G=thinners_at_paint_time
// Stroke mask: R=max geometric alpha (prevents re-deposition across frames)
// Entire stroke polyline in storage buffer; one dispatch finds global min SDF per pixel

#include "../common/wetness.wgsl"

struct BrushParams {
  bb_min: vec2f,                // offset  0  — AABB for early reject
  bb_max: vec2f,                // offset  8
  palette_K: vec3f,             // offset 16  — K-M absorption (16-byte aligned)
  thinners: f32,                // offset 28
  falloff: f32,                 // offset 32
  pigment_density: f32,         // offset 36
  reservoir: f32,               // offset 40
  age: f32,                     // offset 44
  bristle_seed: f32,            // offset 48
  stroke_start_layers: f32,     // offset 52
  surface_absorption: f32,      // offset 56
  session_time: f32,            // offset 60
  surface_dry_speed: f32,       // offset 64
  vertex_count: u32,            // offset 68
  _pad: vec2f,                  // offset 72  — pad to 80
};

struct StrokeVertex {
  pos: vec2f,      // offset 0
  radius: f32,     // offset 8   — pre-baked: pressure × taper × spread × splay
  reservoir: f32,  // offset 12  — per-vertex reservoir for smooth depletion
};

@group(0) @binding(0) var<uniform> params: BrushParams;
@group(0) @binding(1) var<storage, read> vertices: array<StrokeVertex>;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var surface_height: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;
@group(2) @binding(2) var state_read: texture_2d<f32>;
@group(2) @binding(3) var state_write: texture_storage_2d<rg32float, write>;
@group(2) @binding(4) var mask_read: texture_2d<f32>;
@group(2) @binding(5) var mask_write: texture_storage_2d<r32float, write>;

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
  let prev_mask = textureLoad(mask_read, vec2i(gid.xy), 0).r;

  // AABB early reject (entire polyline bounding box)
  if (uv.x < params.bb_min.x || uv.x > params.bb_max.x ||
      uv.y < params.bb_min.y || uv.y > params.bb_max.y) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    textureStore(mask_write, vec2i(gid.xy), vec4f(prev_mask, 0.0, 0.0, 0.0));
    return;
  }

  var min_dist: f32 = 999.0;
  var best_seg: u32 = 0u;
  var best_t: f32 = 0.0;
  var local_r: f32;
  var local_reservoir: f32;
  var dir: vec2f;
  var perp: vec2f;
  var nearest: vec2f;

  if (params.vertex_count == 1u) {
    // Single vertex → circle SDF
    min_dist = length(uv - vertices[0].pos) - vertices[0].radius;
    local_r = vertices[0].radius;
    local_reservoir = vertices[0].reservoir;
    dir = vec2f(1.0, 0.0);
    perp = vec2f(0.0, 1.0);
    nearest = vertices[0].pos;
  } else {
    // Polyline SDF: find global minimum distance across ALL segments
    let seg_count = params.vertex_count - 1u;
    for (var i: u32 = 0u; i < seg_count; i = i + 1u) {
      let sdf = capsule_sdf(uv, vertices[i].pos, vertices[i + 1u].pos,
                             vertices[i].radius, vertices[i + 1u].radius);
      if (sdf.x < min_dist) {
        min_dist = sdf.x;
        best_seg = i;
        best_t = sdf.y;
      }
    }
    // Derive local properties at closest point
    local_r = mix(vertices[best_seg].radius, vertices[best_seg + 1u].radius, best_t);
    local_reservoir = mix(vertices[best_seg].reservoir, vertices[best_seg + 1u].reservoir, best_t);
    let seg_vec = vertices[best_seg + 1u].pos - vertices[best_seg].pos;
    let seg_len = length(seg_vec);
    dir = select(vec2f(1.0, 0.0), seg_vec / seg_len, seg_len > 0.0001);
    perp = vec2f(-dir.y, dir.x);
    nearest = vertices[best_seg].pos + seg_vec * best_t;
  }

  // Bristle clump density — irregular groups via non-harmonic sines
  // Creates ~3-5 wide clump peaks across brush width, not uniform grooves
  let bristle_angle = dot(uv - nearest, perp) / max(local_r, 0.0001);
  let ba = bristle_angle * 6.28;
  let clump_cross = 0.5
    + 0.28 * sin(ba * 2.7 + params.bristle_seed * 5.1)
    + 0.15 * sin(ba * 6.3 + params.bristle_seed * 3.7)
    + 0.07 * sin(ba * 11.1 + params.bristle_seed * 8.3);

  // Along-stroke variation — ADDITIVE so gaps can bridge and reopen
  let along_uv = dot(uv, dir);
  let along_freq = 1.0 / max(local_r * 2.0, 0.001);
  let along_variation =
      0.12 * sin(along_uv * along_freq * 1.7 + ba * 3.1 + params.bristle_seed * 2.3)
    + 0.06 * sin(along_uv * along_freq * 4.3 + ba * 6.7 + params.bristle_seed * 6.1);

  let bristle_load = saturate(clump_cross + along_variation);

  // Radial bias — outer edges thin slightly faster, only when depleting
  let radial_pos = min(abs(bristle_angle), 1.0);
  let radial_bias = 1.0 - radial_pos * 0.3 * (1.0 - local_reservoir);

  // Squared depletion ramp — gentle change at high reservoir (no visible dab
  // boundaries), progressive separation at low reservoir (dry-brush effect).
  let reservoir_depletion = pow(1.0 - local_reservoir, 2.0);
  let variation = reservoir_depletion;
  let bristle_reservoir = local_reservoir * mix(1.0, bristle_load, variation) * radial_bias;
  let final_reservoir = bristle_reservoir;

  // Fine bristle texture — subtle surface marks, not the dominant pattern
  let bristle_count = mix(8.0, 16.0, params.age);
  let fine_pos = bristle_angle * bristle_count + params.bristle_seed * 6.28;
  let fine_groove = smoothstep(0.0, 0.15, fract(fine_pos))
                  * smoothstep(1.0, 0.85, fract(fine_pos));
  let depth = max(-min_dist, 0.0) / max(local_r, 0.0001);
  let edge_emphasis = smoothstep(0.2, 0.85, 1.0 - depth);
  // Fine texture — very subtle, grain does the real dry-brush work
  let depletion = 1.0 - final_reservoir;
  let fine_vis = smoothstep(0.5, 1.0, depletion) * (0.05 + params.age * 0.15);
  let bristle_pattern = 1.0 - edge_emphasis * (1.0 - fine_groove) * fine_vis;

  // Edge softness + roughness
  let edge_softness = local_r * (0.08 + params.thinners * 0.4);
  let roughness_strength = 0.06 + params.age * 0.14 + depletion * 0.15;
  let edge_noise = hash_noise(bristle_angle * 3.0, params.bristle_seed) * 0.7
                 + hash_noise(bristle_angle * 12.0, params.bristle_seed + 5.0) * 0.3;
  let edge_roughness = edge_noise * roughness_strength * local_r;
  let alpha = (1.0 - smoothstep(-edge_softness - edge_roughness, 0.0, min_dist)) * bristle_pattern;

  // Stroke mask — only deposit the incremental coverage since last frame
  let new_mask = max(alpha, prev_mask);
  let delta = max(0.0, alpha - prev_mask);
  textureStore(mask_write, vec2i(gid.xy), vec4f(new_mask, 0.0, 0.0, 0.0));

  // === Paint physics uses delta (incremental alpha) ===

  // Grain-aware deposition — thin paint catches only on raised surface peaks
  // As paint depletes, surface texture increasingly gates where paint deposits
  let grain_uv = uv * vec2f(f32(dims.x) / 2048.0, f32(dims.y) / 2048.0);
  let grain = textureSampleLevel(surface_height, grain_sampler, grain_uv, 0.0).r;
  // Use reservoir directly (uniform per frame) — avoids visible dab ridges
  // Per-pixel depletion amplified frame-to-frame differences at capsule boundaries
  let grain_factor = params.thinners * 0.1 + reservoir_depletion * 0.85;
  let grain_interaction = mix(1.0, grain, grain_factor);

  // Diminishing returns — per-stroke only; new strokes arrive at full opacity
  let layers_this_stroke = max(existing.a - params.stroke_start_layers, 0.0);
  let effective_alpha = delta * params.pigment_density * pow(params.falloff, layers_this_stroke) * final_reservoir * grain_interaction;

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

  // Emergent color pickup — dry bristles pick up less existing paint
  let pickup = wetness * bristle_reservoir
             * (0.3 + params.age * 0.7)
             * (0.2 + params.thinners * 0.8);
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
