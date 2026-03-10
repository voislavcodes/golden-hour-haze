// OKLCH color utilities — convert between OKLCH and sRGB for mood creation
// OKLCH: L (0-1 lightness), C (0-0.4 chroma), H (0-360 hue)

import type { KColor } from './moods.js';

// Oklab to linear sRGB matrix
function oklabToLinearSRGB(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function linearToSRGB(c: number): number {
  if (c <= 0.0031308) return 12.92 * c;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Convert OKLCH (L 0-1, C 0-0.4, H 0-360) to sRGB KColor */
export function oklchToRGB(L: number, C: number, H: number): KColor {
  const hRad = H * Math.PI / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const [lr, lg, lb] = oklabToLinearSRGB(L, a, b);
  return {
    r: clamp01(linearToSRGB(lr)),
    g: clamp01(linearToSRGB(lg)),
    b: clamp01(linearToSRGB(lb)),
  };
}

/** Maximum chroma at 70% saturation cap for custom moods */
const MAX_CHROMA = 0.15;

/** Generate light/medium/dark from a single hue angle */
export function hueToMoodPile(hue: number): { light: KColor; medium: KColor; dark: KColor } {
  return {
    light:  oklchToRGB(0.85, MAX_CHROMA * 0.55, hue),
    medium: oklchToRGB(0.55, MAX_CHROMA * 0.85, hue),
    dark:   oklchToRGB(0.25, MAX_CHROMA * 0.70, hue),
  };
}

/** Generate a full 5-pile mood from 5 hue angles */
export function huesToMoodPiles(hues: number[]): { light: KColor; medium: KColor; dark: KColor }[] {
  return hues.slice(0, 5).map(h => hueToMoodPile(h));
}
