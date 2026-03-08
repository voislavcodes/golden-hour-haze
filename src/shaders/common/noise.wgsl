// Simplex noise 2D/3D + FBM

fn mod289_3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_2(x: vec2f) -> vec2f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_4(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute3(x: vec3f) -> vec3f { return mod289_3((x * 34.0 + 10.0) * x); }
fn permute4(x: vec4f) -> vec4f { return mod289_4((x * 34.0 + 10.0) * x); }

fn simplex2d(v: vec2f) -> f32 {
  let C = vec4f(0.211324865405187, 0.366025403784439,
                -0.577350269189626, 0.024390243902439);

  var i = floor(v + dot(v, C.yy));
  let x0 = v - i + dot(i, C.xx);

  var i1: vec2f;
  if (x0.x > x0.y) { i1 = vec2f(1.0, 0.0); } else { i1 = vec2f(0.0, 1.0); }

  var x12 = vec4f(x0.x + C.x, x0.y + C.x, x0.x + C.z, x0.y + C.z);
  x12 = vec4f(x12.xy - i1, x12.zw);

  i = mod289_2(i);
  let p = permute3(permute3(vec3f(i.y, i.y + i1.y, i.y + 1.0)) +
                    vec3f(i.x, i.x + i1.x, i.x + 1.0));

  var m = max(vec3f(0.5) - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
  m = m * m;
  m = m * m;

  let x = 2.0 * fract(p * C.www) - 1.0;
  let h = abs(x) - 0.5;
  let ox = floor(x + 0.5);
  let a0 = x - ox;

  m *= vec3f(1.79284291400159) - 0.85373472095314 * (a0 * a0 + h * h);

  let g0 = a0.x * x0.x + h.x * x0.y;
  let g1 = a0.y * x12.x + h.y * x12.y;
  let g2 = a0.z * x12.z + h.z * x12.w;

  return 130.0 * dot(m, vec3f(g0, g1, g2));
}

fn simplex3d(v: vec3f) -> f32 {
  let C = vec2f(1.0 / 6.0, 1.0 / 3.0);

  let i = floor(v + dot(v, vec3f(C.y)));
  let x0 = v - i + dot(i, vec3f(C.x));

  let g = step(vec3f(x0.y, x0.z, x0.x), x0);
  let l = 1.0 - g;
  let i1 = min(g, vec3f(l.z, l.x, l.y));
  let i2 = max(g, vec3f(l.z, l.x, l.y));

  let x1 = x0 - i1 + C.x;
  let x2 = x0 - i2 + C.y;
  let x3 = x0 - 0.5;

  let ii = mod289_3(i);
  let p = permute4(permute4(permute4(
    vec4f(ii.z, ii.z + i1.z, ii.z + i2.z, ii.z + 1.0)) +
    vec4f(ii.y, ii.y + i1.y, ii.y + i2.y, ii.y + 1.0)) +
    vec4f(ii.x, ii.x + i1.x, ii.x + i2.x, ii.x + 1.0));

  let ns = vec3f(0.285714285714, -0.928571428571, 0.142857142857);

  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let xv = x_ * ns.x + vec4f(ns.y);
  let yv = y_ * ns.x + vec4f(ns.y);
  let h = 1.0 - abs(xv) - abs(yv);

  let b0 = vec4f(xv.x, xv.y, yv.x, yv.y);
  let b1 = vec4f(xv.z, xv.w, yv.z, yv.w);

  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4f(0.0));

  let a0 = vec4f(b0.x + s0.x * sh.x, b0.z + s0.z * sh.y, b0.y + s0.y * sh.x, b0.w + s0.w * sh.y);
  let a1 = vec4f(b1.x + s1.x * sh.z, b1.z + s1.z * sh.w, b1.y + s1.y * sh.z, b1.w + s1.w * sh.w);

  var p0 = vec3f(a0.xy, h.x);
  var p1 = vec3f(a0.zw, h.y);
  var p2 = vec3f(a1.xy, h.z);
  var p3 = vec3f(a1.zw, h.w);

  let norm = 1.79284291400159 - 0.85373472095314 *
    vec4f(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  var m = max(vec4f(0.6) - vec4f(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4f(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4f(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

fn fbm2d(p: vec2f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var pos = p;
  for (var i = 0; i < octaves; i++) {
    value += amplitude * simplex2d(pos * frequency);
    frequency *= 2.0;
    amplitude *= 0.5;
    pos = vec2f(pos.y + 100.0, pos.x + 100.0); // rotate domain
  }
  return value;
}

fn fbm3d(p: vec3f, octaves: i32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var pos = p;
  for (var i = 0; i < octaves; i++) {
    value += amplitude * simplex3d(pos * frequency);
    frequency *= 2.0;
    amplitude *= 0.5;
    pos = vec3f(pos.y + 100.0, pos.z + 100.0, pos.x + 100.0);
  }
  return value;
}
