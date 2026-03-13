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
  oil_remaining: f32,           // offset 72  — oil on brush (0=none, 1=full)
  anchor_intensity: f32,         // offset 76  — anchor chroma unlock (0=none, 1=full)
};

struct StrokeVertex {
  pos: vec2f,      // offset 0
  radius: f32,     // offset 8   — pre-baked: pressure × taper × spread × splay
  reservoir: f32,  // offset 12  — per-vertex reservoir for smooth depletion
};

@group(0) @binding(0) var<uniform> params: BrushParams;
@group(0) @binding(1) var<storage, read> vertices: array<StrokeVertex>;
@group(0) @binding(2) var<storage, read> bristle_profile: array<f32>;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var surface_height: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;
@group(2) @binding(2) var state_read: texture_2d<f32>;
@group(2) @binding(3) var state_write: texture_storage_2d<rgba32float, write>;
@group(2) @binding(4) var mask_read: texture_2d<f32>;
@group(2) @binding(5) var mask_write: texture_storage_2d<r32float, write>;

// Simple hash noise for edge roughness
fn hash_noise(angle: f32, seed: f32) -> f32 {
  let s = sin(angle * 127.1 + seed * 311.7) * 43758.5453;
  return fract(s);
}

// 2D smooth value noise — coherent patches for dry brush contact variation
fn value_noise_2d(p: vec2f, seed: f32) -> f32 {
  let ip = floor(p);
  let fp = fract(p);
  let u = fp * fp * (3.0 - 2.0 * fp);
  let a = fract(sin(dot(ip, vec2f(127.1, 311.7)) + seed * 43.17) * 43758.5453);
  let b = fract(sin(dot(ip + vec2f(1.0, 0.0), vec2f(127.1, 311.7)) + seed * 43.17) * 43758.5453);
  let c = fract(sin(dot(ip + vec2f(0.0, 1.0), vec2f(127.1, 311.7)) + seed * 43.17) * 43758.5453);
  let d = fract(sin(dot(ip + vec2f(1.0, 1.0), vec2f(127.1, 311.7)) + seed * 43.17) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
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
    let seg_dir = select(vec2f(1.0, 0.0), seg_vec / seg_len, seg_len > 0.0001);
    nearest = vertices[best_seg].pos + seg_vec * best_t;

    // Smooth tangent — interpolate between vertex tangents to eliminate
    // bristle pattern discontinuities at segment joints
    var tan0 = seg_dir;
    if (best_seg > 0u) {
      let pv = vertices[best_seg].pos - vertices[best_seg - 1u].pos;
      let pl = length(pv);
      if (pl > 0.0001) { tan0 = normalize(pv / pl + seg_dir); }
    }
    var tan1 = seg_dir;
    if (best_seg + 2u < params.vertex_count) {
      let nv = vertices[best_seg + 2u].pos - vertices[best_seg + 1u].pos;
      let nl = length(nv);
      if (nl > 0.0001) { tan1 = normalize(seg_dir + nv / nl); }
    }
    dir = normalize(mix(tan0, tan1, best_t));
    perp = vec2f(-dir.y, dir.x);
  }

  // Bristle density from physical 1024-tip bundle profile.
  // CPU projects all tips onto cross-stroke axis each frame → 64-bin density array.
  // Loaded brush: relatively uniform (all tips loaded). Mid-depletion: edge tips
  // deplete first → variation emerges. Dry brush: patchy contact pattern.
  let bristle_angle = dot(uv - nearest, perp) / max(local_r, 0.0001);
  let profile_uv = clamp((bristle_angle + 1.0) * 0.5, 0.0, 1.0);
  let profile_pos = profile_uv * 63.0;
  let idx0 = u32(floor(profile_pos));
  let idx1 = min(idx0 + 1u, 63u);
  let profile_frac = fract(profile_pos);
  let bristle_density = mix(bristle_profile[idx0], bristle_profile[idx1], profile_frac);

  // Along-stroke variation — subtle texture from tips lifting/re-engaging.
  // Cross-stroke phase shift ensures light patches are staggered, not full-width.
  let along_uv = dot(uv, dir);
  let along_freq = 1.0 / max(local_r * 2.0, 0.001);
  let along_phase = bristle_angle * 2.3;
  let along_variation =
      0.03 * sin(along_uv * along_freq * 1.7 + along_phase + params.bristle_seed * 2.3)
    + 0.015 * sin(along_uv * along_freq * 4.3 + along_phase * 1.7 + params.bristle_seed * 6.1);

  // Floor at 0.4 — capillary action ensures continuous paint film, never zero.
  // Physical profile drives cross-stroke structure; along_variation adds subtle texture.
  let bristle_load = max(0.4, bristle_density + along_variation);

  // Radial bias — edges always slightly thinner + deplete first
  let radial_pos = min(abs(bristle_angle), 1.0);
  let edge_sq = radial_pos * radial_pos;
  let base_edge = 1.0 - edge_sq * 0.12;
  let radial_bias = base_edge * (1.0 - edge_sq * 0.55 * (1.0 - local_reservoir));

  // Dry brush detection — activates for rag-wiped brush (reservoir ~0.2) and
  // natural late-stroke depletion. Starts at 0.5, fully active at 0.1.
  let dry_brush_t = smoothstep(0.5, 0.1, local_reservoir);

  // Depletion drives grain/texture interactions downstream
  let reservoir_depletion = pow(1.0 - local_reservoir, 2.0);
  // Bell curve for bristle separation: solid when loaded, visible at mid-depletion.
  // In dry brush mode, bristle pattern is suppressed — surface texture takes over.
  let variation_raw = smoothstep(0.8, 0.35, local_reservoir) * smoothstep(0.0, 0.25, local_reservoir);
  let variation = variation_raw * (1.0 - dry_brush_t);
  let bristle_reservoir = local_reservoir * mix(1.0, bristle_load, variation) * radial_bias;
  let final_reservoir = bristle_reservoir;

  // Fine bristle texture — subtle surface marks at mid-depletion only
  let bristle_count = mix(8.0, 16.0, params.age);
  let fine_pos = bristle_angle * bristle_count + params.bristle_seed * 6.28;
  let fine_groove = smoothstep(0.0, 0.15, fract(fine_pos))
                  * smoothstep(1.0, 0.85, fract(fine_pos));
  let depth = max(-min_dist, 0.0) / max(local_r, 0.0001);
  let edge_emphasis = smoothstep(0.2, 0.85, 1.0 - depth);
  let depletion = 1.0 - final_reservoir;
  // Bell curve: peak at mid-depletion, invisible when loaded or dry
  let fine_bell = smoothstep(0.3, 0.6, depletion) * smoothstep(0.95, 0.75, depletion) * (1.0 - dry_brush_t);
  let fine_vis = fine_bell * (0.03 + params.age * 0.2);
  let bristle_pattern = 1.0 - edge_emphasis * (1.0 - fine_groove) * fine_vis;

  // Edge softness — dry brush gets wider, softer edges (feathered contact)
  let edge_softness = local_r * (0.08 + params.thinners * 0.4 + dry_brush_t * 0.3);
  let roughness_strength = 0.05 + params.age * 0.22 + fine_bell * 0.12;
  let edge_noise = hash_noise(bristle_angle * 3.0, params.bristle_seed) * 0.7
                 + hash_noise(bristle_angle * 12.0, params.bristle_seed + 5.0) * 0.3;
  let edge_roughness = edge_noise * roughness_strength * local_r;
  let alpha = (1.0 - smoothstep(-edge_softness - edge_roughness, 0.0, min_dist)) * bristle_pattern;

  // Stroke mask — only deposit the incremental coverage since last frame
  let new_mask = max(alpha, prev_mask);
  let delta = max(0.0, alpha - prev_mask);
  textureStore(mask_write, vec2i(gid.xy), vec4f(new_mask, 0.0, 0.0, 0.0));

  // === Paint physics uses delta (incremental alpha) ===

  // Surface grain sampling
  let grain_uv = uv * vec2f(f32(dims.x) / 2048.0, f32(dims.y) / 2048.0);
  let grain = textureSampleLevel(surface_height, grain_sampler, grain_uv, 0.0).r;

  // Grain-aware deposition — surface texture gates paint more as brush depletes
  let depletion_curve = pow(reservoir_depletion, 1.5);
  let grain_factor = params.thinners * 0.15 + depletion_curve * 0.85;
  // Dry brush: surface height FULLY gates deposition (paint only on raised peaks)
  let grain_factor_final = mix(grain_factor, 1.0, dry_brush_t);
  let grain_thresh = mix(0.0, 0.45, depletion_curve);
  // Dry brush: moderate threshold — raised peaks and ridges make contact (not just tallest)
  let dry_thresh = mix(grain_thresh, 0.35, dry_brush_t);
  let grain_gated = smoothstep(dry_thresh, dry_thresh + 0.12, grain);
  let grain_interaction = mix(1.0, grain_gated, grain_factor_final);

  // Dry brush contact gate — reuses bristle_density from profile (computed above).
  // Along-stroke modulation: tips lift and re-engage as brush moves.
  // Two incommensurate frequencies create irregular lift pattern.
  // Phase shifts with bristle_angle so adjacent cross-stroke rows are staggered.
  let along_base = along_uv * along_freq;
  let along_mod = 0.55
    + 0.28 * sin(along_base * 3.0 + bristle_angle * 5.0 + params.bristle_seed * 4.3)
    + 0.17 * sin(along_base * 7.0 + bristle_angle * 3.1 + params.bristle_seed * 7.1);
  let streak_gate = smoothstep(0.05, 0.4, bristle_density * along_mod);
  // Multi-pass gap filling: where previous strokes deposited paint, bristles have
  // better contact (existing paint fills surface valleys, bridging gaps).
  // Pass 1 = streaky on bare surface. Pass 2+ fills gaps progressively.
  let existing_fill = saturate(existing.a * 4.0);
  let gate_strength = saturate(dry_brush_t * 1.5) * (1.0 - existing_fill);
  let contact_gate = mix(1.0, streak_gate, gate_strength);

  // Diminishing returns — per-stroke only; new strokes arrive at full opacity
  let layers_this_stroke = max(existing.a - params.stroke_start_layers, 0.0);
  let opacity_boost = mix(2.2, 1.0, params.thinners);

  // Dry brush: thin bristle coating transfers efficiently to surface peaks.
  // Proportional boost (3x) keeps fresh dry brush visible but allows full depletion.
  let dry_reservoir = mix(final_reservoir, final_reservoir * 3.0, dry_brush_t);
  let effective_alpha = delta * params.pigment_density * opacity_boost * pow(params.falloff, layers_this_stroke) * dry_reservoir * grain_interaction * contact_gate;

  // === Depleted brush interaction — the brush always does something ===
  // Dry brush drags paint from upstream (opposite of stroke direction) onto current pixel.
  // This spreads paint beyond its original edge — the key blending behavior.
  let brush_contact = delta > 0.01;
  let brush_empty = final_reservoir < 0.05;

  // Sample upstream — where the brush is dragging paint FROM
  let upstream_px = vec2i(clamp(vec2f(gid.xy) - dir * 3.0, vec2f(0.0), vec2f(dims) - 1.0));
  let upstream = textureLoad(accum_read, upstream_px, 0);
  let upstream_state = textureLoad(state_read, upstream_px, 0);
  let has_paint_to_drag = existing.a > 0.01 || upstream.a > 0.01;

  if (effective_alpha < 0.001 && has_paint_to_drag && brush_contact && brush_empty) {
    let up_wetness = calculate_wetness(upstream_state.r, params.session_time, params.surface_dry_speed, upstream_state.g);
    let local_wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);
    let wetness = max(up_wetness, local_wetness);
    let tacky = smoothstep(0.1, 0.25, wetness) * smoothstep(0.5, 0.35, wetness);

    // Smear strength: wet paint moves easily, tacky drags aggressively
    let smear_base = wetness * 0.7 + tacky * 0.8;
    let smear_strength = smear_base * delta * (0.5 + params.age * 0.5);

    if (smear_strength > 0.001) {
      // Additive paint transfer — brush picks up chunk of upstream and deposits it here
      let transfer = upstream.a * smear_strength;

      // Color: K-M blend proportional to how much new paint vs existing
      let blend_ratio = transfer / (existing.a + transfer + 0.001);
      let smeared_K = mix(existing.rgb, upstream.rgb, blend_ratio);
      let smeared_weight = existing.a + transfer;

      // Tacky muddying
      let avg_K = dot(smeared_K, vec3f(0.333));
      let muddy_smear = mix(smeared_K, vec3f(avg_K), tacky * 0.25);

      textureStore(accum_write, vec2i(gid.xy), vec4f(muddy_smear, smeared_weight));
      // Smearing refreshes paint state — use upstream state if dragging wet paint onto bare
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

  // Pure medium mode — thinners > 0.9 wets surface without depositing pigment
  if (params.thinners > 0.9) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), vec4f(params.session_time, 1.0, state.b, state.a));
    return;
  }

  // Wetness of existing paint
  let wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);

  // Tacky zone detection — bell curve peaking at wetness ~0.3
  let tacky = smoothstep(0.1, 0.25, wetness) * smoothstep(0.5, 0.35, wetness);

  // Surface absorption — bare surface absorbs more, sealed surface doesn't
  let bare_surface = 1.0 - saturate(existing.a * 3.0);
  let thinners_absorption = params.surface_absorption * (1.0 + params.thinners);
  let absorbed = effective_alpha * thinners_absorption * bare_surface;
  let deposited = effective_alpha - absorbed;

  // Emergent color pickup — tacky paint clings, up to 2.5× more transfer
  let base_pickup = wetness * bristle_reservoir
             * (0.3 + params.age * 0.7)
             * (0.2 + params.thinners * 0.8);
  let pickup = base_pickup + tacky * 0.6;
  let input_K = mix(params.palette_K, existing.rgb, pickup);

  // Tacky muddying — colors pushed toward chromatic neutral
  let avg_K = dot(input_K, vec3f(0.333));
  let muddy_K = mix(input_K, vec3f(avg_K), tacky * 0.35);
  let input_K_final = mix(input_K, muddy_K, tacky);

  // Absorbed paint leaves deep stain
  let absorbed_stain = input_K_final * absorbed * 0.5;

  // Dry layering / scumbling — grain-gated broken coverage on set/dry paint
  let dry_layer = smoothstep(0.15, 0.02, wetness);
  let scumble_gate = mix(1.0, smoothstep(0.3, 0.7, grain), dry_layer * 0.8);
  let scumble_deposited = deposited * scumble_gate;

  // K-M mixing — wetness modulates blend mode
  // Thick incoming paint covers existing layers more easily
  let depth_cap = mix(0.8, 2.0, params.thinners);
  let paint_depth = min(existing.a, depth_cap);
  let wet_blend = scumble_deposited / (paint_depth + scumble_deposited + 0.001);
  // Force blend_factor toward 1.0 on dry layer — new paint dominates, no mixing
  let blend_factor = mix(wet_blend, max(wet_blend, 0.85), dry_layer);
  // Wet-into-wet: new paint merges into existing film (weight converges).
  // Dry: full additive stacking (physically correct ridge).
  // Heavy strokes push through wet film more (physically: firm contact displaces wet paint).
  let merge_strength = wetness * saturate(existing.a * 4.0);
  let pressure_punch = smoothstep(0.5, 0.85, effective_alpha) * 0.35;
  let effective_deposit = scumble_deposited * (1.0 - merge_strength * (0.85 - pressure_punch));
  let scumble_weight = existing.a + effective_deposit;

  // Wet paint: full K-M mixing. Dry paint: overlay (less subtractive blend)
  let wet_result = mix(existing.rgb + absorbed_stain, input_K_final, blend_factor);
  let dry_overlay = existing.rgb * (1.0 - blend_factor) + input_K_final * blend_factor + absorbed_stain;
  let result_K = mix(dry_overlay, wet_result, wetness);

  textureStore(accum_write, vec2i(gid.xy), vec4f(result_K, scumble_weight));

  // Write paint state — timestamp + thinners for wetness tracking
  let new_state = select(state.rg, vec2f(params.session_time, params.thinners), effective_alpha > 0.01);
  let new_oil = select(state.b, params.oil_remaining, effective_alpha > 0.01);
  let new_anchor = select(state.a, params.anchor_intensity, effective_alpha > 0.01);
  textureStore(state_write, vec2i(gid.xy), vec4f(new_state, new_oil, new_anchor));
}
