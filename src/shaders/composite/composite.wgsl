// Final compositor — samples all layer outputs, depth-aware blending, ACES tonemapping

#include "../common/kubelka-munk.wgsl"

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
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var depth_tex: texture_2d<f32>;
@group(1) @binding(1) var density_tex: texture_2d<f32>;
@group(1) @binding(2) var scatter_tex: texture_2d<f32>;
@group(1) @binding(3) var grain_tex: texture_2d<f32>;
@group(1) @binding(4) var forms_tex: texture_2d<f32>;
@group(1) @binding(5) var light_tex: texture_2d<f32>;
@group(1) @binding(6) var bloom_tex: texture_2d<f32>;
@group(1) @binding(7) var tex_sampler: sampler;
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

// ACES filmic tonemapping
fn aces_tonemap(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
  let cutoff = step(c, vec3f(0.0031308));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return mix(high, low, cutoff);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.uv;

  // Sample all layers
  let depth = textureSample(depth_tex, tex_sampler, uv).r;
  let density_data = textureSample(density_tex, tex_sampler, uv);
  let grain = textureSample(grain_tex, tex_sampler, uv).r;
  let forms = textureLoad(forms_tex, vec2i(uv * vec2f(textureDimensions(forms_tex))), 0);
  let light = textureSample(light_tex, tex_sampler, uv).rgb;
  let bloom = textureSample(bloom_tex, tex_sampler, uv).rgb;

  let density = density_data.r;

  // Sky from scatter texture (sky gradient + atmospheric scatter baked together)
  var sky = textureSample(scatter_tex, tex_sampler, uv).rgb;

  // Color-in-shadow: darken forms with their own hue, not neutral gray
  let shadow_depth = density * depth;
  let shadow_amount = smoothstep(0.0, 0.8, shadow_depth);
  let form_hue_shadow = forms.rgb * vec3f(0.3, 0.25, 0.35);
  let shadowed = km_mix(forms.rgb, form_hue_shadow, shadow_amount * comp_params.shadow_chroma);

  // Composite forms over sky with depth-aware atmospheric opacity
  let atmosphere_fog = vec3f(0.75, 0.60, 0.50) * density * 0.2;
  var form_color = shadowed + atmosphere_fog * (1.0 - shadow_amount);

  // --- Atmospheric Brightness Conformance ---
  let atmo_lum = dot(sky, vec3f(0.2126, 0.7152, 0.0722));
  let light_boost = dot(light, vec3f(0.2126, 0.7152, 0.0722));

  // (a) Value clamp: atmosphere is the brightness ceiling, light wells raise it
  let form_lum = dot(form_color, vec3f(0.2126, 0.7152, 0.0722));
  let ceiling = atmo_lum + light_boost * 1.5;
  form_color *= min(1.0, ceiling / max(form_lum, 0.001));

  // (b) Desaturation: darkness kills chroma, light wells resist
  let darkness = 1.0 - saturate(atmo_lum * 2.0);
  let effective_darkness = darkness * (1.0 - saturate(light_boost * 2.0));
  let dimmed_lum = dot(form_color, vec3f(0.2126, 0.7152, 0.0722));
  form_color = mix(form_color, vec3f(dimmed_lum), effective_darkness * 0.6);

  // (c) Color bleed: atmosphere tints forms toward sky hue (darkness OR density)
  let darkness_bleed = darkness * 0.4;
  let density_bleed = density * 0.35;
  let bleed = max(darkness_bleed, density_bleed) * (1.0 - saturate(light_boost));
  form_color = mix(form_color, sky * (dimmed_lum / max(atmo_lum, 0.01)), bleed);

  // (d) Atmosphere eats form chroma based on density
  let chroma_loss = density * 0.5 * (1.0 - saturate(light_boost));
  let form_grey = dot(form_color, vec3f(0.2126, 0.7152, 0.0722));
  form_color = mix(form_color, vec3f(form_grey), chroma_loss);

  var color = mix(sky, form_color, forms.a);

  // Add light scatter and bloom
  color += light * 0.5;
  color += bloom * 0.3;

  // Grain overlay
  let grain_amount = grain * 0.08;
  color += vec3f(grain_amount - 0.04); // centered around 0

  // Anchor chroma focus point
  let anchor_pos = vec2f(comp_params.anchor_x, comp_params.anchor_y);
  let dist_to_anchor = length(uv - anchor_pos);
  let anchor_influence = 1.0 - smoothstep(0.0, comp_params.anchor_falloff, dist_to_anchor);
  let gray_for_anchor = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  let sat_scale = mix(1.0 - comp_params.anchor_boost * 0.4, 1.0 + comp_params.anchor_boost * 0.3, anchor_influence);
  color = mix(vec3f(gray_for_anchor), color, sat_scale);

  // Tonemapping
  color = aces_tonemap(color);

  // Sun-driven color grade (after tonemap, before sRGB)
  let grade = mix(vec3f(0.85, 0.92, 1.15), vec3f(1.1, 0.95, 0.8),
                  comp_params.sun_grade_warmth * 0.5 + 0.5);
  color *= mix(vec3f(1.0), grade, comp_params.sun_grade_intensity);

  // sRGB output
  color = linear_to_srgb(color);

  // Grayscale preview toggle
  color = mix(color, vec3f(dot(color, vec3f(0.2126, 0.7152, 0.0722))), comp_params.grayscale);

  return vec4f(color, 1.0);
}
