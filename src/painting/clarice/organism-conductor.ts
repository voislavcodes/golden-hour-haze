// SO2: Painting Conductor — per-composition defaults fallback
// Makes painting-level decisions: restraint, focal density, veil, etc.
// ML model (25K params) replaces this in Sprint 2.

import type { CompositionClass, ConductorDecisions, FocalPoint, LayerBudget, SceneFeatures } from './types.js';

// Gardener-tuned v2: A/B comparison of 5 variations consistently shows "sparse" wins.
// Beckett favors HIGH restraint, LOW darkSoftening, LOW focalDensity, LOW interRegionBleed.
// The atmosphere IS the painting — marks should be rare, committed, and precise.
// CMA-ES tuned (gen 10, score 0.44): high bareCanvasThreshold, low darkSoftening,
// early accents, tight interRegionBleed, strong focal concentration.
const COMPOSITION_DEFAULTS: Record<CompositionClass, ConductorDecisions> = {
  'lonely-figure':  { restraint: 0.82, focalDensity: 1.59, veilStrength: 0.79, bareCanvasThreshold: 0.39, darkSoftening: 0.14, accentTiming: 0.44, interRegionBleed: 0.17 },
  'street-scene':   { restraint: 0.84, focalDensity: 1.50, veilStrength: 0.65, bareCanvasThreshold: 0.35, darkSoftening: 0.14, accentTiming: 0.44, interRegionBleed: 0.17 },
  'seascape':       { restraint: 0.82, focalDensity: 1.50, veilStrength: 0.75, bareCanvasThreshold: 0.35, darkSoftening: 0.14, accentTiming: 0.44, interRegionBleed: 0.17 },
  'twilight-glow':  { restraint: 0.80, focalDensity: 1.40, veilStrength: 0.85, bareCanvasThreshold: 0.30, darkSoftening: 0.14, accentTiming: 0.44, interRegionBleed: 0.20 },
  'intimate-scene': { restraint: 0.82, focalDensity: 1.50, veilStrength: 0.65, bareCanvasThreshold: 0.35, darkSoftening: 0.14, accentTiming: 0.44, interRegionBleed: 0.17 },
  'abstract-masses':{ restraint: 0.80, focalDensity: 1.40, veilStrength: 0.70, bareCanvasThreshold: 0.30, darkSoftening: 0.14, accentTiming: 0.44, interRegionBleed: 0.20 },
};

export function conductPainting(
  composition: CompositionClass,
  _focalPoint: FocalPoint,
  fogDensity: number,
  _budget: LayerBudget,
  _features: SceneFeatures,
): ConductorDecisions {
  const defaults = COMPOSITION_DEFAULTS[composition];

  // Modulate veil strength by actual fog density
  const veilStrength = Math.min(1, defaults.veilStrength * (0.5 + fogDensity));

  return {
    ...defaults,
    veilStrength,
  };
}

/** CMA-ES vector-driven conductor — Group A (indices 0-6) + Group B (indices 7-10).
 *  Group A directly sets the 7 conductor values.
 *  Group B modifiers are stored for downstream use by assembly. */
export interface CompositionModifiers {
  sparse_composition_mult: number;
  atmospheric_emphasis: number;
  focal_emphasis: number;
  dark_commitment: number;
}

export function conductPaintingFromVector(
  fogDensity: number,
  vec: number[],
): { conductor: ConductorDecisions; modifiers: CompositionModifiers } {
  const conductor: ConductorDecisions = {
    restraint: vec[0],
    focalDensity: vec[1],
    veilStrength: Math.min(1, vec[2] * (0.5 + fogDensity)),
    bareCanvasThreshold: vec[3],
    darkSoftening: vec[4],
    accentTiming: vec[5],
    interRegionBleed: vec[6],
  };
  const modifiers: CompositionModifiers = {
    sparse_composition_mult: vec[7],
    atmospheric_emphasis: vec[8],
    focal_emphasis: vec[9],
    dark_commitment: vec[10],
  };
  return { conductor, modifiers };
}
