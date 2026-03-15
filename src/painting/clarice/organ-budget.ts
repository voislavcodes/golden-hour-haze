// O4: Layer Budget Allocator — heuristic
// Lookup table indexed by composition class → per-layer stroke fractions.

import type { CompositionClass, LayerBudget } from './types.js';

// Veil budget kept small (disabled — needs ML per-pixel approach).
// Active painting layers get the bulk of the allocation.
const BUDGET_TABLE: Record<CompositionClass, {
  atmosphere: number; background: number; midtones: number;
  darkForms: number; accents: number; veil: number;
}> = {
  // CMA-ES tuned: heavy background allocation (0.34), substantial midtones/darks,
  // elevated accents (0.14), smaller atmosphere wash. Veil = remainder.
  'lonely-figure':  { atmosphere: 0.12, background: 0.34, midtones: 0.24, darkForms: 0.15, accents: 0.14, veil: 0.01 },
  'street-scene':   { atmosphere: 0.12, background: 0.34, midtones: 0.24, darkForms: 0.15, accents: 0.14, veil: 0.01 },
  'seascape':       { atmosphere: 0.14, background: 0.36, midtones: 0.22, darkForms: 0.14, accents: 0.12, veil: 0.02 },
  'twilight-glow':  { atmosphere: 0.14, background: 0.30, midtones: 0.24, darkForms: 0.16, accents: 0.14, veil: 0.02 },
  'intimate-scene': { atmosphere: 0.12, background: 0.32, midtones: 0.26, darkForms: 0.16, accents: 0.12, veil: 0.02 },
  'abstract-masses':{ atmosphere: 0.14, background: 0.30, midtones: 0.24, darkForms: 0.16, accents: 0.14, veil: 0.02 },
};

export function allocateBudget(
  composition: CompositionClass,
  regionCount: number,
): LayerBudget {
  const fractions = BUDGET_TABLE[composition];
  // Generous budget — Beckett's technique builds up many translucent layers.
  // More regions = more detail to capture = more strokes needed.
  // CMA-ES tuned: ~1800 base + ~9 per region (was 15)
  const total = 1800 + regionCount * 9;

  return {
    atmosphere: Math.round(fractions.atmosphere * total),
    background: Math.round(fractions.background * total),
    midtones: Math.round(fractions.midtones * total),
    darkForms: Math.round(fractions.darkForms * total),
    accents: Math.round(fractions.accents * total),
    veil: Math.round(fractions.veil * total),
  };
}

/** CMA-ES vector-driven budget allocation — Group D (indices 17-21) + Group E (indices 22-24).
 *  Budget fractions from vector, normalized to sum=1. Veil = remainder.
 *  Total stroke count from vec[22], per-region bonus from vec[23]. */
export function allocateBudgetFromVector(
  regionCount: number,
  vec: number[],
): LayerBudget {
  // Group D: layer fractions (normalize to sum ≤ 1, veil gets remainder)
  const rawAtmo = vec[17];
  const rawBg = vec[18];
  const rawMid = vec[19];
  const rawDark = vec[20];
  const rawAccent = vec[21];
  const rawSum = rawAtmo + rawBg + rawMid + rawDark + rawAccent;
  const cap = Math.min(rawSum, 0.95); // leave at least 5% for veil
  const scale = cap / rawSum;
  const atmo = rawAtmo * scale;
  const bg = rawBg * scale;
  const mid = rawMid * scale;
  const dark = rawDark * scale;
  const accent = rawAccent * scale;
  const veil = 1 - (atmo + bg + mid + dark + accent);

  // Group E: total stroke count
  const total = Math.round(vec[22] + regionCount * vec[23]);

  return {
    atmosphere: Math.round(atmo * total),
    background: Math.round(bg * total),
    midtones: Math.round(mid * total),
    darkForms: Math.round(dark * total),
    accents: Math.round(accent * total),
    veil: Math.round(veil * total),
  };
}
