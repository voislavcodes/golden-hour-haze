// Wipe brush — physical rag: smears, lifts, stains, and fails
// Smear FIRST (paint redistribution), then lift (paint absorption)
// Pressure splits behavior: light = blend, heavy = remove
// result = current - smeared_out + smeared_in - lifted

#include "../common/wetness.wgsl"

struct WipeParams {
  center: vec2f,              // cursor position (normalized 0-1)
  wipe_direction: vec2f,      // smoothed movement direction (zero = no direction yet)
  radius: f32,                // wipe area
  thinners: f32,              // master physics variable
  strength: f32,              // from reservoir (LOAD depletion)
  ghost_retention: f32,       // 0.15 — pigment survives full wipe
  session_time: f32,          // current session time
  surface_dry_speed: f32,     // drying rate multiplier
  residue_floor: f32,         // material-dependent minimum paint floor (absolute)
  smear_amount: f32,          // pressure-derived smear vs lift split
  pressure: f32,              // raw pressure (0-1)
  rag_Kr: f32,                // rag contamination K-M red
  rag_Kg: f32,                // rag contamination K-M green
  rag_Kb: f32,                // rag contamination K-M blue
  cloth_scale: vec2f,         // surface_dims / 256.0 (cloth tiling frequency)
  rag_saturation: f32,        // rag paint load (0-1)
  wipe_speed: f32,            // normalized movement speed
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(0) var<uniform> params: WipeParams;
@group(1) @binding(0) var accum_read: texture_2d<f32>;
@group(1) @binding(1) var accum_write: texture_storage_2d<rgba16float, write>;
@group(2) @binding(0) var surface_height: texture_2d<f32>;
@group(2) @binding(1) var grain_sampler: sampler;
@group(2) @binding(2) var cloth_height: texture_2d<f32>;
@group(2) @binding(3) var cloth_sampler: sampler;
@group(3) @binding(0) var state_read: texture_2d<f32>;
@group(3) @binding(1) var state_write: texture_storage_2d<rgba32float, write>;

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

  if (alpha < 0.001) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // --- Wetness ---
  let wetness = calculate_wetness(state.r, params.session_time, params.surface_dry_speed, state.g);
  let tacky = smoothstep(0.1, 0.25, wetness) * smoothstep(0.5, 0.35, wetness);
  let wetness_factor = mix(0.05, 1.0, wetness) * (1.0 - tacky * 0.4);
  let oil_fluidity = state.b * 0.3;
  let smear_effectiveness = saturate(wetness * (1.0 - tacky * 0.6) + oil_fluidity);

  // Dry paint: rag does nothing (need palette knife to remove dry paint)
  if (wetness < 0.05) {
    textureStore(accum_write, vec2i(gid.xy), existing);
    textureStore(state_write, vec2i(gid.xy), state);
    return;
  }

  // --- Surface grain ---
  let grain_uv = uv * vec2f(f32(dims.x) / 2048.0, f32(dims.y) / 2048.0);
  let grain = textureSampleLevel(surface_height, grain_sampler, grain_uv, 0.0).r;
  let grain_lift = smoothstep(0.35, 0.75, grain);

  // --- Cloth contact ---
  // Rotate UV by wipe angle so different cloth ridges lead in different directions
  let has_direction = length(params.wipe_direction) > 0.5;
  var base_uv = uv;
  if (has_direction) {
    let angle = atan2(params.wipe_direction.y, params.wipe_direction.x);
    let ca = cos(angle);
    let sa = sin(angle);
    let offset = uv - params.center;
    base_uv = vec2f(offset.x * ca - offset.y * sa, offset.x * sa + offset.y * ca) + params.center;
  }
  let cloth_uv = base_uv * params.cloth_scale;
  let cloth_h = textureSampleLevel(cloth_height, cloth_sampler, cloth_uv, 0.0).r;

  // Pressure → contact threshold: light = only fold ridges, heavy = broad contact
  let threshold = mix(0.3, 0.8, params.pressure);
  let contact = saturate((threshold - cloth_h) / max(threshold, 0.001));

  // --- Pressure falloff from center ---
  let pressure_dist = 1.0 - dist / params.radius;
  let pressure_curve = pressure_dist * pressure_dist;

  // --- Pressure-derived behavior split ---
  // Light pressure = blending tool (more smear, less lift)
  // Heavy pressure = removal tool (less smear, more lift)
  let smear_fraction = mix(0.7, 0.3, params.pressure);
  let lift_fraction = mix(0.3, 0.7, params.pressure);

  // --- Smear: additive paint transfer (not a lerp!) ---
  // Paint physically moves from upstream to current texel in wipe direction
  var result_K = existing.rgb;
  var result_weight = existing.a;

  let do_smear = has_direction && params.wipe_speed > 0.001 && smear_effectiveness > 0.05;

  if (do_smear) {
    // Sample upstream: where paint was before the rag pushed it here
    let smear_dist = smear_fraction * params.radius * smear_effectiveness * 0.4;
    let upstream_uv = uv - params.wipe_direction * smear_dist;
    let upstream_px = clamp(vec2i(upstream_uv * vec2f(dims)), vec2i(0), vec2i(dims) - 1);
    let upstream = textureLoad(accum_read, upstream_px, 0);

    let speed_factor = saturate(params.wipe_speed);
    let transfer = saturate(contact * alpha * pressure_curve * smear_effectiveness * speed_factor * 0.25);

    // Paint leaving this texel downstream
    let out_K = existing.rgb * transfer;
    let out_w = existing.a * transfer;

    // Paint arriving from upstream
    let in_K = upstream.rgb * transfer;
    let in_w = upstream.a * transfer;

    // Net: current - out + in (paint redistribution, not erasure)
    result_K = existing.rgb - out_K + in_K;
    result_weight = existing.a - out_w + in_w;

    // Accumulation ridge at wipe boundary — paint bulldozed to the edge
    let ridge = smoothstep(0.85, 0.95, alpha) * transfer * 0.3;
    result_weight += ridge * upstream.a;
  }

  // --- Lift: rag absorbs paint (secondary to smear) ---
  let rag_absorb = 1.0 - params.rag_saturation;
  let thin_lift_bonus = state.g * 0.1;
  let base_lift = alpha * params.strength * grain_lift * contact * pressure_curve
                  * lift_fraction * rag_absorb * 0.12;
  let lift_amount = (base_lift + thin_lift_bonus) * wetness_factor;

  // Residue floor — absolute minimum per material (never wipe below this)
  let residue = select(params.residue_floor, params.ghost_retention, params.residue_floor < 0.001);
  let floor_val = max(residue, params.ghost_retention * (1.0 - wetness));
  // Don't lift below floor; don't raise already-thin paint to floor
  let effective_floor = min(existing.a, floor_val);
  let new_weight = max(effective_floor, result_weight - lift_amount);

  // Scale K proportionally with weight change
  let k_scale = select(1.0, new_weight / max(result_weight, 0.001), result_weight > 0.001);
  var final_K = result_K * k_scale;

  // Ghost stain — K values never drop below floor fraction of original
  let ghost_floor = existing.rgb * floor_val;
  final_K = max(ghost_floor, final_K);

  // --- Rag contamination deposit (dirty rag tints the surface) ---
  var final_weight = new_weight;
  if (params.rag_saturation > 0.05) {
    let rag_K = vec3f(params.rag_Kr, params.rag_Kg, params.rag_Kb);
    let deposit_strength = params.rag_saturation * contact * alpha * pressure_curve;
    final_K += rag_K * deposit_strength * 0.08;
    final_weight += deposit_strength * 0.02;
  }

  textureStore(accum_write, vec2i(gid.xy), vec4f(final_K, final_weight));
  // Wiping doesn't refresh paint time — keep existing state
  textureStore(state_write, vec2i(gid.xy), state);
}
