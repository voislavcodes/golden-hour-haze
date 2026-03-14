// O4: Layer Budget Allocator — heuristic
// Lookup table indexed by composition class → per-layer stroke fractions.

import type { CompositionClass, LayerBudget } from './types.js';

const BUDGET_TABLE: Record<CompositionClass, {
  atmosphere: number; background: number; midtones: number;
  darkForms: number; accents: number; veil: number;
}> = {
  'lonely-figure':  { atmosphere: 0.25, background: 0.15, midtones: 0.10, darkForms: 0.10, accents: 0.05, veil: 0.35 },
  'street-scene':   { atmosphere: 0.20, background: 0.15, midtones: 0.15, darkForms: 0.15, accents: 0.08, veil: 0.27 },
  'seascape':       { atmosphere: 0.25, background: 0.20, midtones: 0.10, darkForms: 0.05, accents: 0.03, veil: 0.37 },
  'twilight-glow':  { atmosphere: 0.20, background: 0.12, midtones: 0.10, darkForms: 0.10, accents: 0.08, veil: 0.40 },
  'intimate-scene': { atmosphere: 0.18, background: 0.15, midtones: 0.15, darkForms: 0.15, accents: 0.05, veil: 0.32 },
  'abstract-masses':{ atmosphere: 0.20, background: 0.15, midtones: 0.15, darkForms: 0.12, accents: 0.05, veil: 0.33 },
};

export function allocateBudget(
  composition: CompositionClass,
  regionCount: number,
): LayerBudget {
  const fractions = BUDGET_TABLE[composition];
  // Generous budget — Beckett's technique builds up many translucent layers
  const total = 800 + regionCount * 8;

  return {
    atmosphere: Math.round(fractions.atmosphere * total),
    background: Math.round(fractions.background * total),
    midtones: Math.round(fractions.midtones * total),
    darkForms: Math.round(fractions.darkForms * total),
    accents: Math.round(fractions.accents * total),
    veil: Math.round(fractions.veil * total),
  };
}
