// Final compositor — samples all layer outputs, depth-aware blending, ACES tonemapping

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
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
  let scatter = textureSample(scatter_tex, tex_sampler, uv).rgb;
  let grain = textureSample(grain_tex, tex_sampler, uv).r;
  let forms = textureSample(forms_tex, tex_sampler, uv);
  let light = textureSample(light_tex, tex_sampler, uv).rgb;
  let bloom = textureSample(bloom_tex, tex_sampler, uv).rgb;

  let density = density_data.r;
  let warmth = density_data.g;

  // Base sky gradient — warm golden hour colors
  let sky_top = vec3f(0.15, 0.20, 0.45); // deep blue
  let sky_mid = vec3f(0.85, 0.55, 0.30); // warm orange
  let sky_bot = vec3f(0.95, 0.80, 0.50); // golden

  var sky: vec3f;
  if (uv.y < 0.5) {
    sky = mix(sky_bot, sky_mid, uv.y * 2.0);
  } else {
    sky = mix(sky_mid, sky_top, (uv.y - 0.5) * 2.0);
  }

  // Warmth shift
  let warm_tint = vec3f(1.1, 0.9, 0.7);
  let cool_tint = vec3f(0.8, 0.9, 1.1);
  let tint = mix(cool_tint, warm_tint, warmth * 0.5 + 0.5);
  sky *= tint;

  // Apply atmospheric scatter to sky
  let atmo_contribution = scatter * density * 1.5;
  sky += atmo_contribution;

  // Composite forms over sky with depth-aware atmospheric opacity
  let depth2 = depth * depth; // quadratic — distant forms dissolve faster
  let haze_color = sky * 0.5 + scatter * 0.3; // haze tinted by sky + scatter
  let atmo_opacity = clamp(depth2 * density * 2.0, 0.0, 0.85); // cap at 85%
  let form_through_atmo = mix(forms.rgb, haze_color, atmo_opacity);
  var color = mix(sky, form_through_atmo, forms.a * (1.0 - atmo_opacity * 0.5));

  // Add light scatter and bloom
  color += light * 0.5;
  color += bloom * 0.3;

  // Grain overlay
  let grain_amount = grain * 0.08;
  color += vec3f(grain_amount - 0.04); // centered around 0

  // Tonemapping
  color = aces_tonemap(color);

  // sRGB output
  color = linear_to_srgb(color);

  return vec4f(color, 1.0);
}
