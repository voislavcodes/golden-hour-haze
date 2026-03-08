// Color space conversions

fn srgb_to_linear(c: vec3f) -> vec3f {
  let cutoff = step(c, vec3f(0.04045));
  let low = c / 12.92;
  let high = pow((c + 0.055) / 1.055, vec3f(2.4));
  return mix(high, low, cutoff);
}

fn linear_to_srgb(c: vec3f) -> vec3f {
  let cutoff = step(c, vec3f(0.0031308));
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return mix(high, low, cutoff);
}

// Linear RGB to OKLab
fn linear_to_oklab(c: vec3f) -> vec3f {
  let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;

  let l_ = pow(max(l, 0.0), 1.0 / 3.0);
  let m_ = pow(max(m, 0.0), 1.0 / 3.0);
  let s_ = pow(max(s, 0.0), 1.0 / 3.0);

  return vec3f(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  );
}

// OKLab to Linear RGB
fn oklab_to_linear(lab: vec3f) -> vec3f {
  let l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  let m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  let s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;

  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;

  return vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

// OKLab <-> OKLCH
fn oklab_to_oklch(lab: vec3f) -> vec3f {
  let C = sqrt(lab.y * lab.y + lab.z * lab.z);
  let h = atan2(lab.z, lab.y);
  return vec3f(lab.x, C, h);
}

fn oklch_to_oklab(lch: vec3f) -> vec3f {
  return vec3f(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
}

// Luminance
fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}
