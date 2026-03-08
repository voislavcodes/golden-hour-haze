// Atmosphere orb UI element
// Renders a sphere SDF with atmospheric scattering-like shading

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct OrbUniforms {
  // Viewport rect: xy = top-left position, zw = width/height (pixels)
  rect: vec4f,
  density: f32,
  warmth: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> orb: OrbUniforms;

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

fn sdf_sphere(p: vec3f, radius: f32) -> f32 {
  return length(p) - radius;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // Map fragment position to orb-local coordinates
  let pixel = in.uv * globals.resolution;
  let local = (pixel - orb.rect.xy) / orb.rect.zw;

  // Discard fragments outside the rect
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) {
    discard;
  }

  // Center coordinates in [-1, 1]
  let p2d = local * 2.0 - 1.0;
  let r2 = dot(p2d, p2d);

  // Outside the sphere circle: fully transparent
  if (r2 > 1.0) {
    discard;
  }

  // Reconstruct Z on unit sphere surface
  let z = sqrt(1.0 - r2);
  let p3d = vec3f(p2d, z);
  let normal = normalize(p3d);

  // Animated light direction
  let light_angle = globals.time * 0.3;
  let light_dir = normalize(vec3f(sin(light_angle) * 0.5, 0.6, cos(light_angle) * 0.5 + 0.5));

  // Diffuse lighting
  let ndl = max(dot(normal, light_dir), 0.0);

  // Atmosphere rim glow: stronger at edges
  let rim = 1.0 - z;
  let atmosphere = pow(rim, 2.0) * orb.density;

  // Color based on warmth: interpolate between cool blue and warm orange
  let cool = vec3f(0.25, 0.35, 0.65);
  let warm = vec3f(0.95, 0.55, 0.20);
  let warmth_t = clamp(orb.warmth * 0.5 + 0.5, 0.0, 1.0); // remap -1..1 to 0..1
  let base_color = mix(cool, warm, warmth_t);

  // Core sphere color with diffuse shading
  let sphere_color = base_color * (0.3 + 0.7 * ndl);

  // Atmosphere glow color: warmer, brighter at the rim
  let glow_color = mix(base_color, warm, 0.5) * 1.5;

  // Composite
  let color = mix(sphere_color, glow_color, atmosphere);

  // Subtle fresnel highlight
  let fresnel = pow(rim, 4.0) * 0.4;

  let final_color = color + vec3f(fresnel);
  let alpha = smoothstep(1.0, 0.98, sqrt(r2));

  return vec4f(final_color, alpha);
}
