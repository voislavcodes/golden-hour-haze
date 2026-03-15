// OKLCH color utilities — convert between OKLCH and sRGB for mood creation
// OKLCH: L (0-1 lightness), C (0-0.4 chroma), H (0-360 hue)

import type { KColor, MoodLens, MoodPile } from './moods.js';

export interface OklchColor {
  l: number;  // 0-1 lightness
  c: number;  // 0-0.4 chroma
  h: number;  // 0-360 hue
}

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

/** sRGB to OKLab [L, a, b] */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  const lg = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  const lb = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bk = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757533 * s_;
  return [L, a, bk];
}

/** OKLab [L, a, b] to OKLCH */
export function oklabToOklch(L: number, a: number, b: number): OklchColor {
  const c = Math.sqrt(a * a + b * b);
  let h = Math.atan2(b, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

function circularLerp(a: number, b: number, t: number): number {
  let diff = b - a;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((a + diff * t) % 360 + 360) % 360;
}

/** Bend extracted OKLCH colors through a mood's lens — the mood acts as a filter.
 *  Returns bent colors in OKLCH space (no lossy RGB roundtrip). */
export function bendThroughMood(colors: OklchColor[], lens: MoodLens, density: number): OklchColor[] {
  return colors.map(c => {
    const bentH = circularLerp(c.h, lens.hueCenter, lens.huePull);
    const bentC = c.c * (1.0 - density * lens.chromaSuppression);
    const bentL = lens.lightnessFloor + c.l * (lens.lightnessCeiling - lens.lightnessFloor);
    return { l: bentL, c: bentC, h: bentH };
  });
}

/** Generate light/medium/dark pile from a full OKLCH value.
 *  Enforces a chroma floor so K-means-averaged colors retain visible hue. */
export function oklchToPile(lch: OklchColor): MoodPile {
  // K-M pipeline compresses color ratios (pow 0.65 + ACES tonemap),
  // so palette mediums need moderate chroma to show visible hue in output
  const c = Math.max(lch.c, 0.08);
  return {
    light:  oklchToRGB(Math.min(lch.l + 0.30, 0.92), c * 0.55, lch.h),
    medium: oklchToRGB(lch.l, c, lch.h),
    dark:   oklchToRGB(Math.max(lch.l - 0.30, 0.15), c * 0.85, lch.h),
  };
}

/** Generate piles from bent OKLCH colors — no lossy RGB roundtrip */
export function bentColorsToPiles(bentColors: OklchColor[]): MoodPile[] {
  return bentColors.map(c => oklchToPile(c));
}

/** Maximum chroma at 70% saturation cap for custom moods */
const MAX_CHROMA = 0.15;

/** Generate light/medium/dark from a single hue angle.
 *  chromaScale (0-1, default 1) reduces chroma for muted palettes. */
export function hueToMoodPile(hue: number, chromaScale = 1): { light: KColor; medium: KColor; dark: KColor } {
  const c = MAX_CHROMA * chromaScale;
  return {
    light:  oklchToRGB(0.85, c * 0.55, hue),
    medium: oklchToRGB(0.55, c * 0.85, hue),
    dark:   oklchToRGB(0.25, c * 0.70, hue),
  };
}

/** Generate a full 5-pile mood from 5 hue angles.
 *  chromaScale (0-1, default 1) reduces chroma for muted palettes. */
export function huesToMoodPiles(hues: number[], chromaScale = 1): { light: KColor; medium: KColor; dark: KColor }[] {
  return hues.slice(0, 5).map(h => hueToMoodPile(h, chromaScale));
}
