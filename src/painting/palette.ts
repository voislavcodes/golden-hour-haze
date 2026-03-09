// Palette + tonal column sampling
// Each palette swatch is a tonal column: scroll to set value, brush receives K-M coefficients

import { sceneStore } from '../state/scene-state.js';

interface RGB {
  r: number;
  g: number;
  b: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rgbToReflectance(c: RGB): RGB {
  const r = clamp(c.r, 0.001, 0.999);
  const g = clamp(c.g, 0.001, 0.999);
  const b = clamp(c.b, 0.001, 0.999);
  return { r: r * r, g: g * g, b: b * b };
}

function ksFromReflectance(r: number): number {
  return (1 - r) * (1 - r) / (2 * r);
}

function reflectanceFromKS(ks: number): number {
  return 1 + ks - Math.sqrt(ks * ks + 2 * ks);
}

export function kmMixCPU(c1: RGB, c2: RGB, t: number): RGB {
  const r1 = rgbToReflectance(c1);
  const r2 = rgbToReflectance(c2);

  const ks1r = ksFromReflectance(r1.r), ks1g = ksFromReflectance(r1.g), ks1b = ksFromReflectance(r1.b);
  const ks2r = ksFromReflectance(r2.r), ks2g = ksFromReflectance(r2.g), ks2b = ksFromReflectance(r2.b);

  const ksr = ks1r + (ks2r - ks1r) * t;
  const ksg = ks1g + (ks2g - ks1g) * t;
  const ksb = ks1b + (ks2b - ks1b) * t;

  return {
    r: Math.sqrt(clamp(reflectanceFromKS(ksr), 0, 1)),
    g: Math.sqrt(clamp(reflectanceFromKS(ksg), 0, 1)),
    b: Math.sqrt(clamp(reflectanceFromKS(ksb), 0, 1)),
  };
}

const WARM_WHITE: RGB = { r: 0.95, g: 0.93, b: 0.88 };

/** Rich dark version of a hue */
function richDark(base: RGB): RGB {
  const max = Math.max(base.r, base.g, base.b);
  const min = Math.min(base.r, base.g, base.b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d < 0.001) {
    const dark = clamp(l * 0.3, 0.08, 1);
    return { r: dark, g: dark, b: dark };
  }

  let h = 0;
  const s = d / (1 - Math.abs(2 * l - 1));

  if (max === base.r) h = ((base.g - base.b) / d + 6) % 6;
  else if (max === base.g) h = (base.b - base.r) / d + 2;
  else h = (base.r - base.g) / d + 4;
  h /= 6;

  const newS = clamp(s * 1.3, 0, 1);
  const newL = clamp(l * 0.3, 0.08, 0.4);

  const c = (1 - Math.abs(2 * newL - 1)) * newS;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = newL - c / 2;

  let r1 = 0, g1 = 0, b1 = 0;
  const sector = Math.floor(h * 6);
  if (sector === 0 || sector === 6) { r1 = c; g1 = x; }
  else if (sector === 1) { r1 = x; g1 = c; }
  else if (sector === 2) { g1 = c; b1 = x; }
  else if (sector === 3) { g1 = x; b1 = c; }
  else if (sector === 4) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }

  return {
    r: clamp(r1 + m, 0, 1),
    g: clamp(g1 + m, 0, 1),
    b: clamp(b1 + m, 0, 1),
  };
}

/**
 * Sample a tonal column for a palette color.
 * value 0 = light (warm white), 0.5 = base color, 1 = rich dark
 */
export function sampleTonalColumn(base: RGB, value: number): RGB {
  const v = clamp(value, 0, 1);
  if (v < 0.5) {
    return kmMixCPU(WARM_WHITE, base, v * 2);
  }
  return kmMixCPU(base, richDark(base), (v - 0.5) * 2);
}

/**
 * Convert an RGB color to per-channel K-M absorption coefficients.
 * S (scattering) is always 1.0 in the simplified model and kept implicit.
 */
export function rgbToKS(color: RGB): { Kr: number; Kg: number; Kb: number } {
  const rr = Math.max(color.r * color.r, 0.001);
  const rg = Math.max(color.g * color.g, 0.001);
  const rb = Math.max(color.b * color.b, 0.001);
  return {
    Kr: (1 - rr) * (1 - rr) / (2 * rr),
    Kg: (1 - rg) * (1 - rg) / (2 * rg),
    Kb: (1 - rb) * (1 - rb) / (2 * rb),
  };
}

/**
 * Get active palette K-M coefficients for the brush shader.
 * Reads scene state, samples tonal column, converts to per-channel K.
 */
export function getActiveKS(): { Kr: number; Kg: number; Kb: number; color: RGB } {
  const scene = sceneStore.get();
  const { palette } = scene;
  const baseColor = palette.colors[palette.activeIndex];
  const value = palette.tonalValues[palette.activeIndex];
  const color = sampleTonalColumn(baseColor, value);
  const ks = rgbToKS(color);
  return { ...ks, color };
}
