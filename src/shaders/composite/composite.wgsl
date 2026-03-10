// V3 Compositor — 8-step pipeline: sky, paint K-M, blend, surface grain, drying vis, conformance, desaturation+bleed, grain+tonemap+sRGB
// Light wells, bloom, anchor, TIME grade removed. Paint state drying added.

#include "../common/wetness.wgsl"

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct CompositorParams {
  shadow_chroma: f32,
  grayscale: f32,
  grain_intensity: f32,
  grain_angle: f32,
  grain_depth: f32,
  grain_scale: f32,
  surface_intensity: f32,
  session_time: f32,
  surface_dry_speed: f32,
  _pad3: f32,
  _pad4: f32,
  _pad5: f32,
  _pad6: f32,
  _pad7: f32,
  _pad8: f32,
  _pad9: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var density_tex: texture_2d<f32>;
@group(1) @binding(1) var scatter_tex: texture_2d<f32>;
@group(1) @binding(2) var grain_lut: texture_2d<f32>;
@group(1) @binding(3) var accum_tex: texture_2d<f32>;
@group(1) @binding(4) var tex_sampler: sampler;
@group(1) @binding(5) var grain_sampler: sampler;
@group(1) @binding(6) var surface_lut: texture_2d<f32>;
@group(1) @binding(7) var paint_state_tex: texture_2d<f32>;
@group(2) @binding(0) var<uniform> comp_params: CompositorParams;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let x = f32(i32(vi) / 2) * 4.0 - 1.0;
  let y = f32(i32(vi) & 1) * 4.0 - 1.0;
  var out: VertexOutput;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

fn aces_tonemap(x: vec3f) -> vec3f {
  let a = x * (x * 2.51 + 0.03);
  let b = x * (x * 2.43 + 0.59) + 0.14;
  return clamp(a / b, vec3f(0.0), vec3f(1.0));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
  let cutoff = step(c, vec3f(0.0031308));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return mix(high, low, cutoff);
}

// Convert per-channel K-M absorption back to RGB (S=1.0 implicit)
fn km_reflectance(K: f32) -> f32 {
  let R = 1.0 + K - sqrt(K * K + 2.0 * K);
  return clamp(R, 0.0, 1.0);
}

fn km_to_rgb(Kr: f32, Kg: f32, Kb: f32) -> vec3f {
  return vec3f(
    sqrt(km_reflectance(Kr)),
    sqrt(km_reflectance(Kg)),
    sqrt(km_reflectance(Kb))
  );
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.uv;

  // 1. Sky — the base layer
  var sky = textureSample(scatter_tex, tex_sampler, uv).rgb;

  // 2. Paint surface — per-channel K-M pigment to RGB
  //    Thicker paint absorbs more light (K-M depth scaling).
  let accum = textureSample(accum_tex, tex_sampler, uv);
  let paint_weight = accum.a;
  let depth_factor = max(paint_weight - 0.5, 0.0);
  let depth_scale = 1.0 + depth_factor / (depth_factor + 1.5);
  let paint_rgb = km_to_rgb(accum.r * depth_scale, accum.g * depth_scale, accum.b * depth_scale);

  // 3. Blend paint over sky based on weight
  let paint_opacity = clamp(paint_weight * 2.0, 0.0, 1.0);
  var color = mix(sky, paint_rgb, paint_opacity);

  // 4. Surface texture — grain shows through thin paint, buried by thick
  let surface_tiling = globals.resolution / 512.0;
  let surface_uv = uv * surface_tiling;
  let surface_grain = textureSample(surface_lut, grain_sampler, surface_uv).r;
  let grain_fill = saturate(paint_weight * 2.0);
  let grain_visibility = (1.0 - saturate(paint_weight * 1.5)) * comp_params.surface_intensity * (1.0 - grain_fill * 0.7);
  let grain_offset = (surface_grain - 0.5) * 2.0 * grain_visibility;
  let grain_tint = mix(vec3f(grain_offset), sky * grain_offset * 2.0, 0.3);
  color += grain_tint;

  // 5. Visual drying — wet sheen, dry matte
  let state = textureLoad(paint_state_tex, vec2i(in.position.xy), 0);
  let wetness = calculate_wetness(state.r, comp_params.session_time, comp_params.surface_dry_speed, state.g);
  // Wet paint has subtle sheen (brighter)
  color = mix(color, color * 1.08, wetness * 0.04 * paint_opacity);
  // Dry paint has subtle matte desaturation
  let dry_grey = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(color, vec3f(dry_grey), (1.0 - wetness) * 0.025 * paint_opacity);

  // 6. Atmospheric brightness conformance
  let atmo_lum = dot(sky, vec3f(0.2126, 0.7152, 0.0722));
  let form_lum = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  let ceiling = atmo_lum + 0.3;
  color *= min(1.0, ceiling / max(form_lum, 0.001));

  // 7. Desaturation — darkness + density kill chroma
  //    Color bleed — atmosphere tints paint
  let density_data = textureSample(density_tex, tex_sampler, uv);
  let density = density_data.r;
  let darkness = 1.0 - clamp(atmo_lum * 2.0, 0.0, 1.0);
  let desat = max(darkness * 0.7, density * 0.35);
  let grey = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(color, vec3f(grey), desat);

  let density_bleed = density * 0.35;
  color = mix(color, sky * (grey / max(atmo_lum, 0.01)), density_bleed);

  // 8. Grain + tonemap + sRGB
  let grain_uv = uv * comp_params.grain_scale;
  let grain = textureSample(grain_lut, grain_sampler, grain_uv).r;
  let grain_amount = grain * comp_params.grain_intensity * 0.08;
  color += vec3f(grain_amount - comp_params.grain_intensity * 0.04);

  color = aces_tonemap(color);
  color = linear_to_srgb(color);

  // Grayscale preview toggle
  color = mix(color, vec3f(dot(color, vec3f(0.2126, 0.7152, 0.0722))), comp_params.grayscale);

  return vec4f(color, 1.0);
}
