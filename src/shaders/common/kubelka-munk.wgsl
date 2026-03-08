// Kubelka-Munk pigment mixing via Mixbox-style latent space
// Simplified spectral mixing: convert RGB to latent, mix in latent, convert back

// Approximate K-M: convert to reflectance-like space for subtractive mixing
fn rgb_to_reflectance(c: vec3f) -> vec3f {
  // Saunderson correction approximation
  let r = clamp(c, vec3f(0.001), vec3f(0.999));
  return r * r; // Approximate K/S ratio
}

fn reflectance_to_rgb(r: vec3f) -> vec3f {
  return sqrt(clamp(r, vec3f(0.0), vec3f(1.0)));
}

// Subtractive mix in reflectance space (approximates K-M single-constant theory)
fn km_mix(c1: vec3f, c2: vec3f, t: f32) -> vec3f {
  let r1 = rgb_to_reflectance(c1);
  let r2 = rgb_to_reflectance(c2);

  // K/S from reflectance: K/S = (1-R)^2 / (2R)
  let ks1 = (1.0 - r1) * (1.0 - r1) / (2.0 * r1);
  let ks2 = (1.0 - r2) * (1.0 - r2) / (2.0 * r2);

  // Linear mix in K/S space
  let ks_mix = mix(ks1, ks2, t);

  // Back to reflectance: R = 1 + K/S - sqrt(K/S^2 + 2*K/S)
  let r = 1.0 + ks_mix - sqrt(ks_mix * ks_mix + 2.0 * ks_mix);

  return reflectance_to_rgb(r);
}

// Multi-pigment mix (up to 4 colors with weights)
fn km_mix4(
  c0: vec3f, w0: f32,
  c1: vec3f, w1: f32,
  c2: vec3f, w2: f32,
  c3: vec3f, w3: f32,
) -> vec3f {
  let total = w0 + w1 + w2 + w3;
  if (total < 0.001) { return vec3f(0.0); }

  let r0 = rgb_to_reflectance(c0);
  let r1 = rgb_to_reflectance(c1);
  let r2 = rgb_to_reflectance(c2);
  let r3 = rgb_to_reflectance(c3);

  let ks0 = (1.0 - r0) * (1.0 - r0) / (2.0 * r0);
  let ks1 = (1.0 - r1) * (1.0 - r1) / (2.0 * r1);
  let ks2 = (1.0 - r2) * (1.0 - r2) / (2.0 * r2);
  let ks3 = (1.0 - r3) * (1.0 - r3) / (2.0 * r3);

  let ks = (ks0 * w0 + ks1 * w1 + ks2 * w2 + ks3 * w3) / total;
  let r = 1.0 + ks - sqrt(ks * ks + 2.0 * ks);

  return reflectance_to_rgb(r);
}
