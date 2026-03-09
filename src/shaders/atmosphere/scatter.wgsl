// Rayleigh/Mie atmospheric scattering + sky gradient
// Fragment shader — reads density + depth, produces sky+scatter combined

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct ScatterParams {
  sun_angle: f32,
  sun_elevation: f32,
  intensity: f32,
  sun_azimuth: f32,
  horizon_y: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: ScatterParams;
@group(2) @binding(0) var density_tex: texture_2d<f32>;
@group(2) @binding(1) var depth_tex: texture_2d<f32>;
@group(2) @binding(2) var tex_sampler: sampler;

// Sky color palette
const NIGHT_ZENITH = vec3f(0.03, 0.03, 0.08);
const DAY_ZENITH = vec3f(0.15, 0.20, 0.45);
const GOLDEN_HORIZON = vec3f(0.95, 0.65, 0.30);
const NIGHT_HORIZON = vec3f(0.05, 0.05, 0.12);
const GOLDEN_GLOW = vec3f(0.95, 0.80, 0.50);

fn compute_sky(uv: vec2f, elevation: f32, azimuth: f32, density: f32, warmth: f32) -> vec3f {
  // Normalize elevation: -0.6 to 0.9 range
  let elev_norm = clamp((elevation + 0.6) / 1.5, 0.0, 1.0); // 0=deep night, 1=noon

  // Zenith color: night blue-black to day blue
  let zenith = mix(NIGHT_ZENITH, DAY_ZENITH, smoothstep(0.0, 0.6, elev_norm));

  // Horizon color: night dark to golden warm
  let golden_t = smoothstep(0.2, 0.5, elev_norm) * smoothstep(0.8, 0.5, elev_norm); // peaks at golden hour
  let day_horizon = vec3f(0.60, 0.55, 0.55); // bleached flat at noon
  let horizon_base = mix(NIGHT_HORIZON, day_horizon, smoothstep(0.0, 0.7, elev_norm));
  let horizon = mix(horizon_base, GOLDEN_HORIZON, golden_t);

  // Vertical gradient — v=0 bottom, v=1 top (matches horizon_y convention)
  let horizon_width = mix(0.35, 0.6, elev_norm);
  let v = 1.0 - uv.y; // flip: 0=bottom, 1=top

  var sky: vec3f;
  if (params.horizon_y >= 0.0) {
    let h = params.horizon_y;

    if (v <= h) {
      // Below horizon: dark ground up to horizon color
      let t = v / max(h, 0.01);
      sky = mix(mix(horizon, zenith, 0.5) * 0.25, horizon, pow(t, 0.8));
    } else {
      // Above horizon: horizon → zenith
      let t = (v - h) / max(1.0 - h, 0.01);
      sky = mix(horizon, zenith, pow(t, 1.5 + (1.0 - horizon_width) * 2.0));
    }
  } else {
    // Horizon off: simple vertical blend without horizon pivot
    let sky_factor = pow(v, 1.5 + elev_norm * 2.0);
    sky = mix(horizon, zenith, sky_factor);
  }

  // Horizontal sun glow — directional warmth toward sun azimuth, centered on horizon
  let sun_glow = exp(-(uv.x - azimuth) * (uv.x - azimuth) * 3.0);
  let glow_strength = golden_t * 0.6 + smoothstep(0.0, 0.3, elev_norm) * 0.15;
  let horizon_proximity = select(1.0 - saturate(abs(v - params.horizon_y) * 2.0), 1.0 - v * 0.8, params.horizon_y < 0.0);
  sky += GOLDEN_GLOW * sun_glow * glow_strength * horizon_proximity;

  // Night mode: below-horizon darkening
  if (elevation < -0.1) {
    let night_t = smoothstep(-0.1, -0.5, elevation);
    sky = mix(sky, NIGHT_ZENITH * 0.5, night_t);
  }

  // Dense atmosphere flattens the sky gradient toward uniform fog
  let temp_darkness = mix(0.35, 0.65, saturate(warmth * 0.5 + 0.5));
  let fog_color = mix(zenith, horizon, 0.5) * temp_darkness;
  let gradient_strength = max(1.0 - pow(density, 1.5) * 0.9, 0.0);
  sky = mix(fog_color, sky, gradient_strength);

  // Dense atmosphere absorbs light
  let density_darken = 1.0 - density * 0.3;
  sky *= density_darken;

  return sky;
}

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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let density_data = textureSample(density_tex, tex_sampler, in.uv);
  let depth = textureSample(depth_tex, tex_sampler, in.uv).r;
  let density = density_data.r;
  let warmth = density_data.g;

  // Compute sky gradient
  var sky = compute_sky(in.uv, params.sun_elevation, params.sun_azimuth, density, warmth);

  // Atmosphere orb influence on sky gradient:
  // Density → haze: washes out gradient contrast toward a uniform fog
  let sky_lum = dot(sky, vec3f(0.3, 0.5, 0.2));
  let haze_tint = 1.0 - saturate(density);
  let haze = vec3f(sky_lum * (1.0 + 0.1 * haze_tint), sky_lum * (1.0 + 0.05 * haze_tint), sky_lum);
  sky = mix(sky, haze, density * 0.5);

  // Warmth → tint: shifts sky warmer (amber) or cooler (blue)
  sky *= vec3f(1.0 + warmth * 0.15, 1.0 + warmth * 0.03, 1.0 - warmth * 0.12);

  // Sun direction from angle + elevation
  let sun_dir = normalize(vec3f(
    cos(params.sun_angle) * cos(params.sun_elevation),
    sin(params.sun_elevation),
    sin(params.sun_angle) * cos(params.sun_elevation)
  ));

  // View direction (simplified - camera looking forward)
  let view_dir = normalize(vec3f(in.uv * 2.0 - 1.0, 1.0));

  // Rayleigh scattering coefficients at 3 wavelengths
  let lambda = vec3f(700.0, 546.0, 435.0);
  let rayleigh_coeff = 1.0 / (lambda * lambda * lambda * lambda);
  let rayleigh_norm = rayleigh_coeff / rayleigh_coeff.z;

  // Scattering angle
  let cos_theta = dot(view_dir, sun_dir);

  // Rayleigh phase function
  let rayleigh_phase = 0.75 * (1.0 + cos_theta * cos_theta);

  // Mie phase function (Henyey-Greenstein, g=0.76)
  let g = 0.76;
  let mie_phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cos_theta, 1.5) / (4.0 * 3.14159);

  // Combined scatter — use smoothed density (average of local + global)
  // to avoid per-pixel noise turbulence creating visible moving clouds
  let smooth_density = mix(density, params.intensity * 0.5, 0.7);
  let optical_depth = smooth_density * depth * 3.0;
  // Dense fog: multiple scattering equalizes wavelengths → achromatic
  let wavelength_factor = 1.0 - saturate(pow(density, 2.0));
  let avg_rayleigh = dot(rayleigh_norm, vec3f(0.333));
  let effective_rayleigh = mix(vec3f(avg_rayleigh), rayleigh_norm, wavelength_factor);
  let rayleigh = effective_rayleigh * rayleigh_phase * (1.0 - exp(-optical_depth));
  let mie = vec3f(mie_phase) * smooth_density * 0.3;

  // Dense fog absorbs scatter — no directional light variation in thick fog
  let scatter_suppress = max(1.0 - density * 0.8, 0.0);
  var scatter_color = (rayleigh * 0.5 + mie) * params.intensity * 0.4 * scatter_suppress;

  // Golden hour warmth shift
  let golden_tint = vec3f(1.2, 0.85, 0.5) * (1.0 + warmth * 0.5);
  scatter_color *= golden_tint;

  // Combine: sky as base, scatter tints subtly on top
  return vec4f(sky + scatter_color, density);
}
