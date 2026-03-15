// Incremental per-bristle capsule SDF brush — 48 bristle segments with multiplicative coverage
// Each bristle = 1 capsule (prev→curr) per frame. Baked immediately. No mask, no snapshot.
// Accumulation texture layout: R=K_r, G=K_g, B=K_b, A=paint_weight
// Paint state texture: R=session_time_painted, G=thinners_at_paint_time

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
  bristle_count: u32,           // offset 68  — number of bristle segments (48)
  oil_remaining: f32,           // offset 72  — oil on brush (0=none, 1=full)
  anchor_intensity: f32,        // offset 76  — anchor chroma unlock (0=none, 1=full)
  surface_tooth: f32,           // offset 80
  _pad0: f32,                   // offset 84  (alignment padding)
  _pad1: f32,                   // offset 88
  _pad2: f32,                   // offset 92
};

struct BristleSegment {
  prev_pos: vec2f,      // 0
  curr_pos: vec2f,      // 8
  prev_radius: f32,     // 16
  curr_radius: f32,     // 20
  prev_load: f32,       // 24
  curr_load: f32,       // 28
  ring_norm: f32,       // 32
  color_kr: f32,        // 36
  color_kg: f32,        // 40
  color_kb: f32,        // 44
};  // 48 bytes, naturally aligned

@group(0) @binding(0) var<uniform> params: BrushParams;
@group(0) @binding(1) var<storage, read> segments: array<BristleSegment>;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var surface_height: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;
@group(2) @binding(2) var state_read: texture_2d<f32>;
@group(2) @binding(3) var state_write: texture_storage_2d<rgba32float, write>;

// Simple hash noise for edge roughness
fn hash_noise(angle: f32, seed: f32) -> f32 {
  let s = sin(angle * 127.1 + seed * 311.7) * 43758.5453;
  return fract(s);
}

// Capsule SDF: returns (signed_distance, t_along_segment)
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

  // AABB early reject (entire dispatch bounding box)
  if (uv.x < params.bb_min.x || uv.x > params.bb_max.x ||
      uv.y < params.bb_min.y || uv.y > params.bb_max.y) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // === Per-bristle SDF evaluation with multiplicative coverage compositing ===
  // Each bristle = 1 capsule (prev→curr). Combined coverage = 1 - ∏(1 - alpha_i * load_i)
  var miss = 1.0;
  var weighted_K = vec3f(0.0);
  var total_weight: f32 = 0.0;
  var any_contact = false;
  var weighted_load: f32 = 0.0;
  var load_weight_sum: f32 = 0.0;
  var closest_dist: f32 = 999.0;
  var closest_dir: vec2f = vec2f(1.0, 0.0);

  let bristle_count = min(params.bristle_count, 48u);
  let pixel_size = 1.0 / f32(dims.x);

  for (var bi: u32 = 0u; bi < bristle_count; bi = bi + 1u) {
    let seg = segments[bi];

    // Per-bristle AABB cull — computed from prev/curr positions
    let max_r = max(seg.prev_radius, seg.curr_radius) * 6.0; // paint spread margin
    let bb_min = min(seg.prev_pos, seg.curr_pos) - vec2f(max_r);
    let bb_max = max(seg.prev_pos, seg.curr_pos) + vec2f(max_r);
    if (uv.x < bb_min.x || uv.x > bb_max.x ||
        uv.y < bb_min.y || uv.y > bb_max.y) {
      continue;
    }

    // Junction gap prevention — extend capsule backward by 0.5px past prev_pos
    let seg_vec = seg.curr_pos - seg.prev_pos;
    let seg_len = length(seg_vec);
    let gap_extend = select(0.5 * pixel_size / seg_len, 0.0, seg_len < 0.0001);
    let actual_start = seg.prev_pos - seg_vec * gap_extend;

    // Single capsule SDF for this bristle
    let sdf = capsule_sdf(uv, actual_start, seg.curr_pos, seg.prev_radius, seg.curr_radius);
    let b_min_dist = sdf.x;
    let b_best_t = sdf.y;

    // Conservative early exit: outside bristle + max paint spread
    if (b_min_dist > max(seg.prev_radius, seg.curr_radius) * 5.0) { continue; }

    // Local properties at closest point
    let local_r = mix(seg.prev_radius, seg.curr_radius, b_best_t);
    let local_load = mix(seg.prev_load, seg.curr_load, b_best_t);

    // Paint spread: wet loaded paint flows beyond the physical bristle tip
    let spread = local_r * smoothstep(0.05, 0.3, local_load) * 5.0;

    // Outside physical bristle + spread — no contribution
    if (b_min_dist > spread) { continue; }

    any_contact = true;

    // Edge softness for this bristle
    let edge_softness = local_r * (0.2 + params.thinners * 0.3);
    let edge_noise_angle = atan2(uv.y - seg.prev_pos.y, uv.x - seg.prev_pos.x);
    let roughness = 0.05 + params.age * 0.22;
    let edge_noise = hash_noise(edge_noise_angle * 3.0, params.bristle_seed + f32(bi)) * 0.7
                   + hash_noise(edge_noise_angle * 12.0, params.bristle_seed + f32(bi) + 5.0) * 0.3;
    let edge_roughness = edge_noise * roughness * local_r;
    let bristle_alpha = 1.0 - smoothstep(-edge_softness - edge_roughness, spread, b_min_dist);

    // Radial bias — edges of the bundle deposit less
    let ring = seg.ring_norm;
    let edge_sq = ring * ring;
    let radial_bias = 1.0 - edge_sq * 0.4;

    // Per-bristle contribution: alpha × load × radial bias
    let contrib = bristle_alpha * max(local_load, 0.01) * radial_bias;
    miss *= (1.0 - saturate(contrib));

    // Accumulate weighted load for smooth dry brush transition
    weighted_load += local_load * contrib;
    load_weight_sum += contrib;

    // Weighted K-M color — per-bristle contamination/pickup
    let bristle_K = vec3f(seg.color_kr, seg.color_kg, seg.color_kb);
    let contamination = length(bristle_K);
    let use_bristle = select(0.0, 0.5, contamination > 0.01);
    let effective_K = mix(params.palette_K, bristle_K, use_bristle);
    weighted_K += effective_K * contrib;
    total_weight += contrib;

    // Track closest bristle for direction
    if (b_min_dist < closest_dist) {
      closest_dist = b_min_dist;
      closest_dir = select(vec2f(1.0, 0.0), seg_vec / seg_len, seg_len > 0.0001);
    }
  }

  let total_coverage = 1.0 - miss;
  let alpha = total_coverage;

  // No bristle covers this pixel — passthrough
  if (!any_contact || alpha < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  let final_K = weighted_K / max(total_weight, 0.001);
  let final_reservoir = select(0.0, weighted_load / load_weight_sum, load_weight_sum > 0.001);
  let dir = closest_dir;

  // Wetness of existing paint (needed for tooth model + later physics)
  let wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);
  let tacky = smoothstep(0.1, 0.25, wetness) * smoothstep(0.5, 0.35, wetness);

  // === Paint physics uses alpha directly (no mask delta needed) ===

  // Surface grain sampling
  let grain_uv = uv * vec2f(f32(dims.x) / 2048.0, f32(dims.y) / 2048.0);
  let grain = textureSampleLevel(surface_height, grain_sampler, grain_uv, 0.0).r;

  // Dry brush detection — age-dependent transition
  let dry_onset = 0.4 + params.age * 0.2;
  let dry_full  = 0.08 + params.age * 0.07;
  let dry_brush_t = smoothstep(dry_onset, dry_full, final_reservoir);

  // Grain-aware deposition — surface texture gates paint more as brush depletes
  let reservoir_depletion = pow(1.0 - final_reservoir, 2.0);
  let depletion_curve = pow(reservoir_depletion, 1.5);
  let grain_factor = params.thinners * 0.15 + depletion_curve * 0.85;
  let grain_factor_final = mix(grain_factor, 1.0, dry_brush_t);
  let grain_thresh = mix(0.0, 0.45, depletion_curve);
  let dry_thresh = mix(grain_thresh, 0.35, dry_brush_t);
  let grain_gated = smoothstep(dry_thresh, dry_thresh + 0.12, grain);
  let grain_interaction = mix(1.0, grain_gated, grain_factor_final);

  // Diminishing returns — per-stroke only
  let layers_this_stroke = max(existing.a - params.stroke_start_layers, 0.0);
  let opacity_boost = mix(2.2, 1.0, params.thinners);

  // Surface tooth saturation — filled tooth blocks further deposition
  let tooth_fill_rate = 1.5 / (0.5 + params.surface_tooth);
  let paint_fill = saturate(existing.a * tooth_fill_rate);
  let wet_block = paint_fill * wetness * 0.15;
  let dry_block = paint_fill * (1.0 - wetness) * 0.5;
  let tooth_remaining = pow(max(1.0 - wet_block - dry_block, 0.0), 1.8);

  // Dry brush: proportional boost keeps fresh dry brush visible
  let dry_reservoir = mix(final_reservoir, final_reservoir * 3.0, dry_brush_t);
  let effective_alpha = alpha * params.pigment_density * opacity_boost * pow(params.falloff, layers_this_stroke) * dry_reservoir * grain_interaction * tooth_remaining;

  // === Depleted brush interaction — the brush always does something ===
  let brush_contact = alpha > 0.01;
  let brush_empty = final_reservoir < 0.05;

  // Sample upstream — where the brush is dragging paint FROM
  let upstream_px = vec2i(clamp(vec2f(gid.xy) - dir * 3.0, vec2f(0.0), vec2f(dims) - 1.0));
  let upstream = textureLoad(accum_read, upstream_px, 0);
  let upstream_state = textureLoad(state_read, upstream_px, 0);
  let has_paint_to_drag = existing.a > 0.01 || upstream.a > 0.01;

  if (effective_alpha < 0.001 && has_paint_to_drag && brush_contact && brush_empty) {
    let up_wetness = calculate_wetness(upstream_state.r, params.session_time, params.surface_dry_speed, upstream_state.g);
    let local_wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);
    let smear_wetness = max(up_wetness, local_wetness);
    let smear_tacky = smoothstep(0.1, 0.25, smear_wetness) * smoothstep(0.5, 0.35, smear_wetness);

    let smear_base = smear_wetness * 0.7 + smear_tacky * 0.8;
    let smear_strength = smear_base * alpha * (0.5 + params.age * 0.5);

    if (smear_strength > 0.001) {
      let transfer = upstream.a * smear_strength;
      let blend_ratio = transfer / (existing.a + transfer + 0.001);
      let smeared_K = mix(existing.rgb, upstream.rgb, blend_ratio);
      let smeared_weight = existing.a + transfer;
      let avg_K = dot(smeared_K, vec3f(0.333));
      let muddy_smear = mix(smeared_K, vec3f(avg_K), smear_tacky * 0.25);

      textureStore(accum_write, vec2i(gid.xy), vec4f(muddy_smear, smeared_weight));
      let drag_wetness = max(up_wetness, local_wetness);
      let smear_time = select(state.r, upstream_state.r, upstream.a > existing.a && drag_wetness > 0.3);
      let smear_thin = select(state.g, upstream_state.g, upstream.a > existing.a);
      let smear_oil = select(state.b, upstream_state.b, upstream.a > existing.a);
      let smear_anchor = select(state.a, upstream_state.a, upstream.a > existing.a);
      textureStore(state_write, vec2i(gid.xy), vec4f(smear_time, smear_thin, smear_oil, smear_anchor));
      return;
    }
  }

  if (effective_alpha < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // Pure medium mode
  if (params.thinners > 0.9) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), vec4f(params.session_time, 1.0, state.b, state.a));
    return;
  }

  // Surface absorption
  let bare_surface = 1.0 - saturate(existing.a * 3.0);
  let thinners_absorption = params.surface_absorption * (1.0 + params.thinners);
  let absorbed = effective_alpha * thinners_absorption * bare_surface;
  let deposited = effective_alpha - absorbed;

  // Emergent color pickup
  let bristle_reservoir = final_reservoir;
  let base_pickup = wetness * bristle_reservoir
             * (0.3 + params.age * 0.7)
             * (0.2 + params.thinners * 0.8);
  let pickup = base_pickup + tacky * 0.6;
  let input_K = mix(final_K, existing.rgb, pickup);

  // Tacky muddying
  let avg_K = dot(input_K, vec3f(0.333));
  let muddy_K = mix(input_K, vec3f(avg_K), tacky * 0.35);
  let input_K_final = mix(input_K, muddy_K, tacky);

  // Absorbed stain
  let absorbed_stain = input_K_final * absorbed * 0.5;

  // Dry layering / scumbling
  let dry_layer = smoothstep(0.15, 0.02, wetness);
  let scumble_gate = mix(1.0, smoothstep(0.3, 0.7, grain), dry_layer * 0.8);
  let scumble_deposited = deposited * scumble_gate;

  // K-M mixing
  let depth_cap = mix(0.8, 2.0, params.thinners);
  let paint_depth = min(existing.a, depth_cap);
  let wet_blend = scumble_deposited / (paint_depth + scumble_deposited + 0.001);
  let blend_factor = mix(wet_blend, max(wet_blend, 0.85), dry_layer);
  let merge_strength = wetness * saturate(existing.a * 4.0);
  let pressure_punch = smoothstep(0.5, 0.85, effective_alpha) * 0.35;
  let effective_deposit = scumble_deposited * (1.0 - merge_strength * (0.85 - pressure_punch));
  let scumble_weight = existing.a + effective_deposit;

  let wet_result = mix(existing.rgb + absorbed_stain, input_K_final, blend_factor);
  let dry_overlay = existing.rgb * (1.0 - blend_factor) + input_K_final * blend_factor + absorbed_stain;
  let result_K = mix(dry_overlay, wet_result, wetness);

  textureStore(accum_write, vec2i(gid.xy), vec4f(result_K, scumble_weight));

  // Write paint state
  let new_state = select(state.rg, vec2f(params.session_time, params.thinners), effective_alpha > 0.01);
  let new_oil = select(state.b, params.oil_remaining, effective_alpha > 0.01);
  let new_anchor = select(state.a, params.anchor_intensity, effective_alpha > 0.01);
  textureStore(state_write, vec2i(gid.xy), vec4f(new_state, new_oil, new_anchor));
}
