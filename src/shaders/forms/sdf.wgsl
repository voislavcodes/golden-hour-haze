// SDF primitives

fn sdf_circle(p: vec2f, center: vec2f, radius: f32) -> f32 {
  return length(p - center) - radius;
}

fn sdf_box(p: vec2f, center: vec2f, half_size: vec2f, rotation: f32) -> f32 {
  let c = cos(rotation);
  let s = sin(rotation);
  let d = p - center;
  let rotated = vec2f(d.x * c + d.y * s, -d.x * s + d.y * c);
  let q = abs(rotated) - half_size;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

fn sdf_line(p: vec2f, a: vec2f, b: vec2f, thickness: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - thickness;
}

// Smooth operations
fn smooth_union(d1: f32, d2: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}

fn smooth_subtract(d1: f32, d2: f32, k: f32) -> f32 {
  let h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0);
  return mix(d2, -d1, h) + k * h * (1.0 - h);
}

fn smooth_intersect(d1: f32, d2: f32, k: f32) -> f32 {
  let h = clamp(0.5 - 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) + k * h * (1.0 - h);
}
