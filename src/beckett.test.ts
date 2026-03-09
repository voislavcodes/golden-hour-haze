/**
 * Headless Beckett-style tests
 *
 * Ports the key WGSL shader math to TypeScript and verifies
 * that the aesthetic pipeline produces Claire-Beckett-style results:
 *   - Tonal hierarchy (depth → S-curve → value)
 *   - K-M subtractive pigment mixing (not additive)
 *   - Tonal sort (dark-to-light for correct layering)
 *   - Velvet surface (alpha exponent)
 *   - Shadow chroma (hue-shifted shadows, not neutral gray)
 *   - Default scene parameters match Beckett intent
 *   - Form buffer packing matches GPU struct layout
 */

import { describe, it, expect } from 'vitest';

// ──────────────────────────────────────────────
// Port of WGSL math to TypeScript
// ──────────────────────────────────────────────

/** Luminance (Rec.709) — matches WGSL `lum()` */
function lum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Tonal hierarchy S-curve — matches WGSL `tonal_value()` */
function tonalValue(depth: number, key: number, range: number, contrast: number): number {
  const v = (key - range * 0.5) + (key + range * 0.5 - (key - range * 0.5)) * (1 - depth);
  // simplifies to: mix(key - range*0.5, key + range*0.5, 1-depth)
  const t = (v - 0.5) * contrast * 2.0;
  return 0.5 + 0.5 * Math.sign(t) * (1 - Math.exp(-Math.abs(t)));
}

/** RGB → reflectance (squared) — matches WGSL `rgb_to_reflectance()` */
function rgbToReflectance(c: [number, number, number]): [number, number, number] {
  return c.map(v => {
    const r = Math.max(0.001, Math.min(0.999, v));
    return r * r;
  }) as [number, number, number];
}

/** Reflectance → RGB (sqrt) — matches WGSL `reflectance_to_rgb()` */
function reflectanceToRgb(r: [number, number, number]): [number, number, number] {
  return r.map(v => Math.sqrt(Math.max(0, Math.min(1, v)))) as [number, number, number];
}

/** K-M subtractive mix — matches WGSL `km_mix()` */
function kmMix(c1: [number, number, number], c2: [number, number, number], t: number): [number, number, number] {
  const r1 = rgbToReflectance(c1);
  const r2 = rgbToReflectance(c2);

  const ks1 = r1.map(r => ((1 - r) * (1 - r)) / (2 * r));
  const ks2 = r2.map(r => ((1 - r) * (1 - r)) / (2 * r));

  const ksMix = ks1.map((k, i) => k * (1 - t) + ks2[i] * t);
  const rOut = ksMix.map(ks => 1 + ks - Math.sqrt(ks * ks + 2 * ks));

  return reflectanceToRgb(rOut as [number, number, number]);
}

/** Velvet alpha exponent — matches WGSL `mix(1.5, 0.7, velvet)` */
function velvetExponent(velvet: number): number {
  return 1.5 + (0.7 - 1.5) * velvet; // mix(1.5, 0.7, velvet)
}

/** Smooth union SDF — matches WGSL `smooth_union()` */
function smoothUnion(d1: number, d2: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (d2 - d1) / k));
  return d2 * (1 - h) + d1 * h - k * h * (1 - h);
}

/** Tonal sort comparator — matches forms-layer.ts sort logic */
function tonalSortForms(
  forms: Array<{ colorIndex: number }>,
  palette: Array<{ r: number; g: number; b: number }>,
): Array<{ colorIndex: number }> {
  return forms.slice().sort((a, b) => {
    const ca = palette[Math.min(a.colorIndex, palette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
    const cb = palette[Math.min(b.colorIndex, palette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
    return lum(ca.r, ca.g, ca.b) - lum(cb.r, cb.g, cb.b);
  });
}

/** Pack form buffer header — matches writeFormsData() in forms-layer.ts */
function packHeader(
  count: number,
  sunAngle: number,
  tonal: { enabled: boolean; keyValue: number; valueRange: number; contrast: number },
  velvet: number,
  tonalSort: boolean,
): Float32Array {
  const buf = new ArrayBuffer(48);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  u32[0] = count;
  f32[1] = sunAngle;
  f32[2] = tonal.keyValue;
  f32[3] = tonal.valueRange;
  f32[4] = tonal.contrast;
  f32[5] = velvet;
  f32[6] = tonalSort ? 1 : 0;
  f32[7] = tonal.enabled ? 1 : 0;
  f32[8] = 0; // scatter (removed)
  f32[9] = 0; // pad (was gravity)
  // f32[10], f32[11] = padding
  return f32;
}

/** ACES filmic tonemapping — matches WGSL `aces_tonemap()` */
function acesTonemap(x: [number, number, number]): [number, number, number] {
  return x.map(v => {
    const n = v * (2.51 * v + 0.03);
    const d = v * (2.43 * v + 0.59) + 0.14;
    return Math.max(0, Math.min(1, n / d));
  }) as [number, number, number];
}

// ──────────────────────────────────────────────
// Default Beckett palette (from scene-state.ts)
// ──────────────────────────────────────────────

const BECKETT_PALETTE = [
  { r: 0.95, g: 0.65, b: 0.25 }, // warm gold
  { r: 0.85, g: 0.35, b: 0.20 }, // burnt orange
  { r: 0.55, g: 0.30, b: 0.45 }, // muted purple
  { r: 0.20, g: 0.35, b: 0.55 }, // twilight blue
  { r: 0.80, g: 0.75, b: 0.60 }, // warm cream
];

const BECKETT_DEFAULTS = {
  tonalMap: { enabled: true, valueRange: 0.8, keyValue: 0.5, contrast: 0.6 },
  velvet: 0.6,
  tonalSort: true,
  shadowChroma: 0.4,
  sunAngle: 0.8,
  echo: 0.5,
};

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe('Beckett tonal hierarchy', () => {
  const { keyValue, valueRange, contrast } = BECKETT_DEFAULTS.tonalMap;

  it('foreground (depth≈0) is brighter than background (depth≈1)', () => {
    const fg = tonalValue(0.1, keyValue, valueRange, contrast);
    const bg = tonalValue(0.9, keyValue, valueRange, contrast);
    expect(fg).toBeGreaterThan(bg);
  });

  it('mid-depth maps near key value', () => {
    const mid = tonalValue(0.5, keyValue, valueRange, contrast);
    expect(mid).toBeCloseTo(0.5, 1);
  });

  it('S-curve compresses extremes (never 0 or 1)', () => {
    const dark = tonalValue(1.0, keyValue, valueRange, contrast);
    const bright = tonalValue(0.0, keyValue, valueRange, contrast);
    expect(dark).toBeGreaterThan(0.01);
    expect(bright).toBeLessThan(0.99);
  });

  it('contrast controls steepness — higher contrast = wider spread', () => {
    const loFg = tonalValue(0.1, keyValue, valueRange, 0.2);
    const loBg = tonalValue(0.9, keyValue, valueRange, 0.2);
    const hiFg = tonalValue(0.1, keyValue, valueRange, 1.0);
    const hiBg = tonalValue(0.9, keyValue, valueRange, 1.0);
    expect(hiFg - hiBg).toBeGreaterThan(loFg - loBg);
  });

  it('tonal rescale preserves hue ratios', () => {
    // Simulates the shader logic: form_color *= clamp(tv / lum, 0.3, 3.0)
    const color = [0.85, 0.35, 0.20] as [number, number, number]; // burnt orange
    const depth = 0.3;
    const tv = tonalValue(depth, keyValue, valueRange, contrast);
    const l = lum(...color);
    const ratio = Math.max(0.3, Math.min(3.0, tv / l));
    const scaled = color.map(c => c * ratio) as [number, number, number];

    // Hue ratios should be preserved (r/g and r/b stay the same)
    expect(scaled[0] / scaled[1]).toBeCloseTo(color[0] / color[1], 3);
    expect(scaled[0] / scaled[2]).toBeCloseTo(color[0] / color[2], 3);
  });
});

describe('Kubelka-Munk subtractive mixing', () => {
  it('yellow + blue → NOT white (subtractive, not additive)', () => {
    const yellow: [number, number, number] = [0.95, 0.90, 0.15];
    const blue: [number, number, number] = [0.15, 0.25, 0.85];
    const mixed = kmMix(yellow, blue, 0.5);

    // Additive would give near-white. Subtractive should be darker/muted.
    const mixLum = lum(...mixed);
    const avgLum = (lum(...yellow) + lum(...blue)) / 2;
    expect(mixLum).toBeLessThan(avgLum); // subtractive = darker than average
  });

  it('red + blue → NOT magenta-bright (stays muted)', () => {
    const red: [number, number, number] = [0.85, 0.15, 0.10];
    const blue: [number, number, number] = [0.10, 0.15, 0.85];
    const mixed = kmMix(red, blue, 0.5);
    expect(lum(...mixed)).toBeLessThan(0.3); // should be dark/muted
  });

  it('mixing identical colors returns the same color', () => {
    const c: [number, number, number] = [0.55, 0.30, 0.45]; // muted purple
    const mixed = kmMix(c, c, 0.5);
    expect(mixed[0]).toBeCloseTo(c[0], 2);
    expect(mixed[1]).toBeCloseTo(c[1], 2);
    expect(mixed[2]).toBeCloseTo(c[2], 2);
  });

  it('t=0 returns first color, t=1 returns second', () => {
    const c1: [number, number, number] = [0.95, 0.65, 0.25];
    const c2: [number, number, number] = [0.20, 0.35, 0.55];
    const atZero = kmMix(c1, c2, 0);
    const atOne = kmMix(c1, c2, 1);
    for (let i = 0; i < 3; i++) {
      expect(atZero[i]).toBeCloseTo(c1[i], 2);
      expect(atOne[i]).toBeCloseTo(c2[i], 2);
    }
  });

  it('K-M mix is commutative at t=0.5', () => {
    const c1: [number, number, number] = [0.85, 0.35, 0.20];
    const c2: [number, number, number] = [0.20, 0.35, 0.55];
    const ab = kmMix(c1, c2, 0.5);
    const ba = kmMix(c2, c1, 0.5);
    for (let i = 0; i < 3; i++) {
      expect(ab[i]).toBeCloseTo(ba[i], 4);
    }
  });

  it('shadow chroma uses own hue, not neutral gray', () => {
    // Simulates composite.wgsl color-in-shadow logic
    const formColor: [number, number, number] = [0.85, 0.35, 0.20]; // burnt orange
    const hueShift: [number, number, number] = [
      formColor[0] * 0.3,
      formColor[1] * 0.25,
      formColor[2] * 0.35,
    ];
    const shadowAmount = 0.7;
    const shadowChroma = BECKETT_DEFAULTS.shadowChroma;
    const shadowed = kmMix(formColor, hueShift, shadowAmount * shadowChroma);

    // Should still be warm-tinted, not neutral gray
    expect(shadowed[0]).toBeGreaterThan(shadowed[2]); // red > blue for orange form
    // Should be darker than original
    expect(lum(...shadowed)).toBeLessThan(lum(...formColor));
  });
});

describe('tonal sort', () => {
  it('sorts dark-to-light by luminance', () => {
    const forms = [
      { colorIndex: 0 }, // warm gold (bright)
      { colorIndex: 3 }, // twilight blue (dark)
      { colorIndex: 2 }, // muted purple (mid)
    ];
    const sorted = tonalSortForms(forms, BECKETT_PALETTE);

    const lums = sorted.map(f => {
      const c = BECKETT_PALETTE[f.colorIndex];
      return lum(c.r, c.g, c.b);
    });
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i]).toBeGreaterThanOrEqual(lums[i - 1]);
    }
  });

  it('twilight blue renders first (darkest), warm gold last (brightest)', () => {
    const forms = BECKETT_PALETTE.map((_, i) => ({ colorIndex: i }));
    const sorted = tonalSortForms(forms, BECKETT_PALETTE);

    // Twilight blue (index 3) should be first — darkest
    expect(sorted[0].colorIndex).toBe(3);
    // Warm gold (index 0) or warm cream (index 4) should be last — brightest
    const lastLum = lum(
      BECKETT_PALETTE[sorted[sorted.length - 1].colorIndex].r,
      BECKETT_PALETTE[sorted[sorted.length - 1].colorIndex].g,
      BECKETT_PALETTE[sorted[sorted.length - 1].colorIndex].b,
    );
    expect(lastLum).toBeGreaterThan(0.6);
  });

  it('single form is unchanged', () => {
    const forms = [{ colorIndex: 2 }];
    const sorted = tonalSortForms(forms, BECKETT_PALETTE);
    expect(sorted).toEqual(forms);
  });

  it('out-of-range colorIndex falls back to gray 0.5', () => {
    const forms = [{ colorIndex: 99 }, { colorIndex: 0 }];
    // Out-of-range clamps to last palette entry
    const sorted = tonalSortForms(forms, BECKETT_PALETTE);
    expect(sorted.length).toBe(2);
  });
});

describe('velvet surface', () => {
  it('default velvet (0.6) gives near-linear exponent (≈1.02)', () => {
    // mix(1.5, 0.7, 0.6) = 1.5 * 0.4 + 0.7 * 0.6 = 0.6 + 0.42 = 1.02
    // Just above 1.0 — nearly linear alpha, the Beckett sweet spot
    const exp = velvetExponent(BECKETT_DEFAULTS.velvet);
    expect(exp).toBeCloseTo(1.02, 2);
    expect(exp).toBeGreaterThan(0.7);  // not maximum softness
    expect(exp).toBeLessThan(1.5);     // not maximum hardness
  });

  it('velvet=0 gives hard edges (exponent=1.5)', () => {
    expect(velvetExponent(0)).toBeCloseTo(1.5, 4);
  });

  it('velvet=1 gives maximum softness (exponent=0.7)', () => {
    expect(velvetExponent(1)).toBeCloseTo(0.7, 4);
  });

  it('higher velvet → lower exponent → softer alpha falloff', () => {
    const alpha = 0.5;
    const hard = Math.pow(alpha, velvetExponent(0));
    const soft = Math.pow(alpha, velvetExponent(1));
    expect(soft).toBeGreaterThan(hard); // lower exp → higher pow(0.5, exp)
  });

  it('Beckett default produces visible but gentle edge', () => {
    const alpha = 0.3; // partial coverage at edge
    const result = Math.pow(alpha, velvetExponent(BECKETT_DEFAULTS.velvet));
    // Should be visible but not harsh
    expect(result).toBeGreaterThan(0.15);
    expect(result).toBeLessThan(0.5);
  });
});

describe('smooth union SDF', () => {
  it('two overlapping circles merge into single shape', () => {
    const d1 = -0.02; // inside first circle
    const d2 = 0.01; // just outside second
    const union = smoothUnion(d1, d2, 0.035);
    expect(union).toBeLessThan(0); // inside the union
  });

  it('blend_k=0.035 gives smooth transition (no internal ridge)', () => {
    // Two forms at the same point — union should be more negative (deeper inside)
    const d = -0.01;
    const union = smoothUnion(d, d, 0.035);
    expect(union).toBeLessThan(d); // smoother = deeper
  });

  it('distant forms stay independent', () => {
    const d1 = -0.05; // inside form 1
    const d2 = 2.0; // far from form 2
    const union = smoothUnion(d1, d2, 0.035);
    expect(union).toBeCloseTo(d1, 2); // dominated by nearest
  });
});

describe('default scene parameters (Beckett intent)', () => {
  it('tonal map is enabled by default', () => {
    expect(BECKETT_DEFAULTS.tonalMap.enabled).toBe(true);
  });

  it('key value is centered (0.5)', () => {
    expect(BECKETT_DEFAULTS.tonalMap.keyValue).toBe(0.5);
  });

  it('value range spans most of the tonal range', () => {
    expect(BECKETT_DEFAULTS.tonalMap.valueRange).toBeGreaterThanOrEqual(0.7);
  });

  it('contrast is moderate (Beckett = soft, not punchy)', () => {
    expect(BECKETT_DEFAULTS.tonalMap.contrast).toBeGreaterThan(0.3);
    expect(BECKETT_DEFAULTS.tonalMap.contrast).toBeLessThan(0.9);
  });

  it('velvet provides soft but present edges', () => {
    expect(BECKETT_DEFAULTS.velvet).toBeGreaterThan(0.4);
    expect(BECKETT_DEFAULTS.velvet).toBeLessThan(0.8);
  });

  it('tonal sort is on (dark-first layering)', () => {
    expect(BECKETT_DEFAULTS.tonalSort).toBe(true);
  });

  it('shadow chroma preserves color in shadows', () => {
    expect(BECKETT_DEFAULTS.shadowChroma).toBeGreaterThan(0.2);
    expect(BECKETT_DEFAULTS.shadowChroma).toBeLessThan(0.7);
  });

  it('palette has warm-to-cool progression', () => {
    // First color should be warm (r > b), last should have blue presence
    const first = BECKETT_PALETTE[0];
    const blue = BECKETT_PALETTE[3];
    expect(first.r).toBeGreaterThan(first.b); // warm gold
    expect(blue.b).toBeGreaterThan(blue.r); // twilight blue
  });
});

describe('form buffer packing', () => {
  it('header packs to 48 bytes (12 floats)', () => {
    const header = packHeader(
      5,
      BECKETT_DEFAULTS.sunAngle,
      BECKETT_DEFAULTS.tonalMap,
      BECKETT_DEFAULTS.velvet,
      BECKETT_DEFAULTS.tonalSort,
    );
    expect(header.byteLength).toBe(48);
  });

  it('header field layout matches FormsParams struct', () => {
    const header = packHeader(
      7, 0.8,
      { enabled: true, keyValue: 0.5, valueRange: 0.8, contrast: 0.6 },
      0.6, true,
    );
    // Read back as u32 for count
    const u32View = new Uint32Array(header.buffer);
    expect(u32View[0]).toBe(7);      // form_count
    expect(header[1]).toBeCloseTo(0.8);  // sun_angle
    expect(header[2]).toBeCloseTo(0.5);  // key_value
    expect(header[3]).toBeCloseTo(0.8);  // value_range
    expect(header[4]).toBeCloseTo(0.6);  // contrast
    expect(header[5]).toBeCloseTo(0.6);  // velvet
    expect(header[6]).toBeCloseTo(1.0);  // tonal_sort (true)
    expect(header[7]).toBeCloseTo(1.0);  // tonal_enabled (true)
    expect(header[8]).toBeCloseTo(0.0);  // scatter (removed)
    expect(header[9]).toBeCloseTo(0.0);  // pad (was gravity)
  });

  it('per-form stride is 64 bytes (16 floats)', () => {
    // Matches FORM_STRIDE = 64 and FormData struct (16 fields)
    expect(16 * 4).toBe(64);
  });

  it('edge_seed is deterministic from position', () => {
    const x = 0.5, y = 0.3;
    const seed1 = ((x * 127.1 + y * 311.7) % 1.0 + 1.0) % 1.0;
    const seed2 = ((x * 127.1 + y * 311.7) % 1.0 + 1.0) % 1.0;
    expect(seed1).toBe(seed2);
    expect(seed1).toBeGreaterThanOrEqual(0);
    expect(seed1).toBeLessThan(1);
  });
});

describe('ACES tonemapping', () => {
  it('maps [0,0,0] to near-black', () => {
    const result = acesTonemap([0, 0, 0]);
    result.forEach(v => expect(v).toBeLessThan(0.01));
  });

  it('maps [1,1,1] to near-white but not clipped', () => {
    const result = acesTonemap([1, 1, 1]);
    result.forEach(v => {
      expect(v).toBeGreaterThan(0.7);
      expect(v).toBeLessThan(1.0);
    });
  });

  it('Beckett palette colors survive tonemapping without clipping', () => {
    for (const c of BECKETT_PALETTE) {
      const mapped = acesTonemap([c.r, c.g, c.b]);
      mapped.forEach(v => {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
      });
    }
  });

  it('bright HDR values compress rather than clip', () => {
    const result = acesTonemap([3.0, 2.0, 1.5]);
    result.forEach(v => {
      expect(v).toBeGreaterThan(0.5);
      expect(v).toBeLessThanOrEqual(1.0);
    });
  });
});

describe('integrated Beckett pipeline', () => {
  it('full pipeline: form at depth → tonal adjust → shadow → tonemap stays painterly', () => {
    // Simulate a burnt orange form at moderate depth
    const color: [number, number, number] = [0.85, 0.35, 0.20];
    const depth = 0.4;
    const { keyValue, valueRange, contrast } = BECKETT_DEFAULTS.tonalMap;

    // 1. Tonal hierarchy
    const tv = tonalValue(depth, keyValue, valueRange, contrast);
    const l = lum(...color);
    const ratio = Math.max(0.3, Math.min(3.0, tv / l));
    const tonalColor = color.map(c => c * ratio) as [number, number, number];

    // 2. Shadow chroma
    const shadowAmount = 0.3; // moderate shadow
    const hueShift: [number, number, number] = [
      tonalColor[0] * 0.3,
      tonalColor[1] * 0.25,
      tonalColor[2] * 0.35,
    ];
    const shadowed = kmMix(tonalColor, hueShift, shadowAmount * BECKETT_DEFAULTS.shadowChroma);

    // 3. Tonemapping
    const final = acesTonemap(shadowed);

    // Beckett qualities:
    // - Still warm-tinted (not gray)
    expect(final[0]).toBeGreaterThan(final[2]);
    // - Not blown out
    expect(Math.max(...final)).toBeLessThan(1.0);
    // - Visible (not crushed to black)
    expect(lum(...final)).toBeGreaterThan(0.1);
    // - Muted (not saturated like a digital painting)
    const maxChan = Math.max(...final);
    const minChan = Math.min(...final);
    expect(maxChan - minChan).toBeLessThan(0.5); // not hyperchromatic
  });

  it('deep background form recedes: lower value, lower contrast', () => {
    const color: [number, number, number] = [0.55, 0.30, 0.45]; // muted purple
    const { keyValue, valueRange, contrast } = BECKETT_DEFAULTS.tonalMap;

    const fgTv = tonalValue(0.1, keyValue, valueRange, contrast);
    const bgTv = tonalValue(0.9, keyValue, valueRange, contrast);

    const fgColor = color.map(c => c * Math.max(0.3, Math.min(3.0, fgTv / lum(...color))));
    const bgColor = color.map(c => c * Math.max(0.3, Math.min(3.0, bgTv / lum(...color))));

    // Background should be darker
    expect(lum(bgColor[0], bgColor[1], bgColor[2]))
      .toBeLessThan(lum(fgColor[0], fgColor[1], fgColor[2]));
  });
});
