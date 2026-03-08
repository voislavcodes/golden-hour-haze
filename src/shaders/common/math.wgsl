// Math utilities

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;
const INV_PI: f32 = 0.31830988618;
const HALF_PI: f32 = 1.57079632679;

fn remap(value: f32, from_low: f32, from_high: f32, to_low: f32, to_high: f32) -> f32 {
  return to_low + (value - from_low) * (to_high - to_low) / (from_high - from_low);
}

fn saturate(x: f32) -> f32 {
  return clamp(x, 0.0, 1.0);
}

fn saturate3(x: vec3f) -> vec3f {
  return clamp(x, vec3f(0.0), vec3f(1.0));
}

fn smootherstep(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, vec3f(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2f) -> vec2f {
  let n = sin(vec3f(dot(p, vec2f(127.1, 311.7)),
                     dot(p, vec2f(269.5, 183.3)),
                     dot(p, vec2f(419.2, 371.9))));
  return fract(n.xy * 43758.5453) * 2.0 - 1.0;
}

fn rotation2d(angle: f32) -> mat2x2f {
  let c = cos(angle);
  let s = sin(angle);
  return mat2x2f(c, -s, s, c);
}
