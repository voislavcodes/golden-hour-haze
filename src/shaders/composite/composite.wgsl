// V2 Final compositor — sky + paint surface + lights + full pipeline
// 11-step: sky -> paint -> lights -> conformance -> desat -> bleed -> grade -> grain -> tonemap -> sRGB

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
  anchor_x: f32,
  anchor_y: f32,
  anchor_boost: f32,
  anchor_falloff: f32,
  sun_grade_warmth: f32,
  sun_grade_intensity: f32,
  grain_intensity: f32,
  grain_angle: f32,
  grain_depth: f32,
  grain_scale: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var density_tex: texture_2d<f32>;
@group(1) @binding(1) var scatter_tex: texture_2d<f32>;
@group(1) @binding(2) var grain_lut: texture_2d<f32>;
@group(1) @binding(3) var accum_tex: texture_2d<f32>;
@group(1) @binding(4) var light_tex: texture_2d<f32>;
@group(1) @binding(5) var bloom_tex: texture_2d<f32>;
@group(1) @binding(6) var tex_sampler: sampler;
@group(1) @binding(7) var grain_sampler: sampler;
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

// Convert K-M accumulation (K, S) back to reflectance then RGB
fn km_to_rgb(K: f32, S: f32) -> vec3f {
  let ks = K / max(S, 0.001);
  let R = 1.0 + ks - sqrt(ks * ks + 2.0 * ks);
  let reflectance = clamp(R, 0.0, 1.0);
  return vec3f(sqrt(reflectance));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.uv;

  // 1. Sky — the base layer
  var sky = textureSample(scatter_tex, tex_sampler, uv).rgb;

  // 2. Paint surface — K-M pigment to RGB
  let accum = textureSample(accum_tex, tex_sampler, uv);
  let paint_weight = accum.b;
  let paint_rgb = km_to_rgb(accum.r, accum.g);

  // 3. Lights
  let light = textureSample(light_tex, tex_sampler, uv).rgb;
  let bloom = textureSample(bloom_tex, tex_sampler, uv).rgb;
  let light_boost = dot(light, vec3f(0.2126, 0.7152, 0.0722));

  // 4. Blend paint over sky based on weight
  let paint_opacity = clamp(paint_weight * 2.0, 0.0, 1.0);
  var color = mix(sky, paint_rgb, paint_opacity);

  // 5. Add lights (additive)
  color += light * 0.5;
  color += bloom * 0.3;

  // 6. Atmospheric brightness conformance
  let atmo_lum = dot(sky, vec3f(0.2126, 0.7152, 0.0722));
  let form_lum = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  let ceiling = atmo_lum + light_boost * 1.5;
  color *= min(1.0, ceiling / max(form_lum, 0.001));

  // 7. Desaturation — darkness + density kill chroma
  let density_data = textureSample(density_tex, tex_sampler, uv);
  let density = density_data.r;
  let darkness = 1.0 - clamp(atmo_lum * 2.0, 0.0, 1.0);
  let desat = max(darkness * 0.7, density * 0.35) * (1.0 - clamp(light_boost * 2.0, 0.0, 1.0));
  let grey = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(color, vec3f(grey), desat);

  // 8. Color bleed — atmosphere tints paint
  let density_bleed = density * 0.35 * (1.0 - clamp(light_boost, 0.0, 1.0));
  color = mix(color, sky * (grey / max(atmo_lum, 0.01)), density_bleed);

  // 9. Anchor chroma focus point
  let anchor_pos = vec2f(comp_params.anchor_x, comp_params.anchor_y);
  let dist_to_anchor = length(uv - anchor_pos);
  let anchor_influence = 1.0 - smoothstep(0.0, comp_params.anchor_falloff, dist_to_anchor);
  let gray_for_anchor = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  let sat_scale = mix(1.0 - comp_params.anchor_boost * 0.4, 1.0 + comp_params.anchor_boost * 0.3, anchor_influence);
  color = mix(vec3f(gray_for_anchor), color, sat_scale);

  // 10. TIME color grade
  let grade = mix(vec3f(0.90, 0.88, 1.08), vec3f(1.06, 0.93, 0.88),
                  comp_params.sun_grade_warmth * 0.5 + 0.5);
  color *= mix(vec3f(1.0), grade, comp_params.sun_grade_intensity);

  // 11. Grain
  let grain_uv = uv * comp_params.grain_scale + vec2f(globals.time * 0.37, globals.time * 0.53);
  let grain = textureSample(grain_lut, grain_sampler, grain_uv).r;
  let grain_amount = grain * comp_params.grain_intensity * 0.08;
  color += vec3f(grain_amount - comp_params.grain_intensity * 0.04);

  // 12. ACES tonemap + sRGB
  color = aces_tonemap(color);
  color = linear_to_srgb(color);

  // Grayscale preview toggle
  color = mix(color, vec3f(dot(color, vec3f(0.2126, 0.7152, 0.0722))), comp_params.grayscale);

  return vec4f(color, 1.0);
}
