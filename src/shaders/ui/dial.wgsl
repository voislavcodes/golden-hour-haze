// Time dial UI element
// Renders a radial gradient with a sun angle indicator

struct Globals {
  resolution: vec2f,
  time: f32,
  dt: f32,
  mouse: vec2f,
  dpr: f32,
  _pad: f32,
};

struct DialUniforms {
  // Viewport rect: xy = top-left position, zw = width/height (pixels)
  rect: vec4f,
  sun_angle: f32,     // radians, 0 = right, counter-clockwise
  sun_elevation: f32,  // 0..1
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> dial: DialUniforms;

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
  // Map fragment to dial-local coordinates
  let pixel = in.uv * globals.resolution;
  let local = (pixel - dial.rect.xy) / dial.rect.zw;

  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) {
    discard;
  }

  // Center coordinates in [-1, 1]
  let p = local * 2.0 - 1.0;
  let dist = length(p);

  // Discard outside the dial circle
  if (dist > 1.0) {
    discard;
  }

  // Angle of current pixel from center
  let pixel_angle = atan2(p.y, p.x);

  // --- Background gradient: sky-to-ground ---
  // Vertical gradient: top = sky blue/orange, bottom = dark ground
  let sky_day = vec3f(0.45, 0.65, 0.90);
  let sky_sunset = vec3f(0.95, 0.50, 0.20);
  let ground = vec3f(0.10, 0.08, 0.06);

  // Use elevation to tint the sky
  let sky_color = mix(sky_day, sky_sunset, 1.0 - dial.sun_elevation);
  let bg_t = smoothstep(-0.5, 0.5, -p.y); // top-heavy
  let bg = mix(ground, sky_color, bg_t);

  // Dim toward edges for depth
  let vignette = 1.0 - smoothstep(0.6, 1.0, dist);
  var color = bg * vignette * 0.7;

  // --- Ring track ---
  let ring_outer = 0.92;
  let ring_inner = 0.82;
  let ring_mask = smoothstep(ring_outer, ring_outer - 0.02, dist) *
                  smoothstep(ring_inner - 0.02, ring_inner, dist);
  let ring_color = vec3f(0.3, 0.28, 0.25);
  color = mix(color, ring_color, ring_mask * 0.5);

  // --- Tick marks ---
  // 12 ticks around the ring for hours
  let tick_count = 12.0;
  let tick_angle = pixel_angle;
  let tick_frac = fract((tick_angle / (2.0 * 3.14159265) + 0.5) * tick_count);
  let tick_dist = min(tick_frac, 1.0 - tick_frac) * tick_count;
  let tick_mask = smoothstep(0.4, 0.2, tick_dist) *
                  smoothstep(ring_inner - 0.02, ring_inner + 0.01, dist) *
                  smoothstep(ring_outer + 0.01, ring_outer - 0.02, dist);
  color = mix(color, vec3f(0.6, 0.55, 0.5), tick_mask * 0.6);

  // --- Sun indicator dot on the ring ---
  let sun_r = (ring_inner + ring_outer) * 0.5;
  let sun_pos = vec2f(cos(dial.sun_angle), sin(dial.sun_angle)) * sun_r;
  let sun_dist = length(p - sun_pos);
  let sun_size = 0.07;

  // Sun glow
  let glow = exp(-sun_dist * sun_dist / (sun_size * sun_size * 2.0));
  let sun_core = smoothstep(sun_size, sun_size * 0.4, sun_dist);
  let sun_color = vec3f(1.0, 0.85, 0.4);
  color += sun_color * glow * 0.5;
  color = mix(color, sun_color, sun_core);

  // --- Elevation arc inside the ring ---
  // A small arc showing the elevation value
  let arc_r = 0.55;
  let arc_dist = abs(dist - arc_r);
  let arc_width = 0.025;
  let arc_mask = smoothstep(arc_width, arc_width * 0.3, arc_dist);
  // Only draw on the upper half, proportional to elevation
  let arc_angle_limit = 3.14159265 * dial.sun_elevation;
  let shifted_angle = pixel_angle + 3.14159265 * 0.5; // shift so top = 0
  let arc_angle_test = abs(shifted_angle);
  let arc_active = step(arc_angle_test, arc_angle_limit) * step(0.0, -p.y);
  let arc_color = mix(vec3f(0.4, 0.35, 0.3), sun_color, dial.sun_elevation);
  color = mix(color, arc_color, arc_mask * arc_active * 0.7);

  // Anti-aliased circle edge
  let alpha = smoothstep(1.0, 0.98, dist);

  return vec4f(color, alpha);
}
