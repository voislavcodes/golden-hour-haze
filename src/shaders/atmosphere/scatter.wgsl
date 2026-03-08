// Rayleigh/Mie atmospheric scattering approximation
// Fragment shader — reads density + depth, produces scatter color

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
  _pad: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> params: ScatterParams;
@group(2) @binding(0) var density_tex: texture_2d<f32>;
@group(2) @binding(1) var depth_tex: texture_2d<f32>;
@group(2) @binding(2) var tex_sampler: sampler;

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

  // Sun direction from angle + elevation
  let sun_dir = normalize(vec3f(
    cos(params.sun_angle) * cos(params.sun_elevation),
    sin(params.sun_elevation),
    sin(params.sun_angle) * cos(params.sun_elevation)
  ));

  // View direction (simplified - camera looking forward)
  let view_dir = normalize(vec3f(in.uv * 2.0 - 1.0, 1.0));

  // Rayleigh scattering coefficients at 3 wavelengths
  // λ_R=700nm, λ_G=546nm, λ_B=435nm
  // Rayleigh ∝ 1/λ^4
  let lambda = vec3f(700.0, 546.0, 435.0);
  let rayleigh_coeff = 1.0 / (lambda * lambda * lambda * lambda);
  let rayleigh_norm = rayleigh_coeff / rayleigh_coeff.z; // normalize to blue=1

  // Scattering angle
  let cos_theta = dot(view_dir, sun_dir);

  // Rayleigh phase function
  let rayleigh_phase = 0.75 * (1.0 + cos_theta * cos_theta);

  // Mie phase function (Henyey-Greenstein, g=0.76)
  let g = 0.76;
  let mie_phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cos_theta, 1.5) / (4.0 * 3.14159);

  // Combined scatter
  let optical_depth = density * depth * 3.0;
  let rayleigh = rayleigh_norm * rayleigh_phase * (1.0 - exp(-optical_depth));
  let mie = vec3f(mie_phase) * density * 0.3;

  var scatter_color = (rayleigh * 0.5 + mie) * params.intensity;

  // Golden hour warmth shift
  let golden_tint = vec3f(1.2, 0.85, 0.5) * (1.0 + warmth * 0.5);
  scatter_color *= golden_tint;

  return vec4f(scatter_color, density);
}
