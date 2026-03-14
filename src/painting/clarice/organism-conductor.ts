// SO2: Painting Conductor — per-composition defaults fallback
// Makes painting-level decisions: restraint, focal density, veil, etc.
// ML model (25K params) replaces this in Sprint 2.

import type { CompositionClass, ConductorDecisions, FocalPoint, LayerBudget, SceneFeatures } from './types.js';

const COMPOSITION_DEFAULTS: Record<CompositionClass, ConductorDecisions> = {
  'lonely-figure':  { restraint: 0.65, focalDensity: 2.0, veilStrength: 0.70, bareCanvasThreshold: 0.05, darkSoftening: 0.50, accentTiming: 0.85, interRegionBleed: 0.60 },
  'street-scene':   { restraint: 0.70, focalDensity: 1.8, veilStrength: 0.55, bareCanvasThreshold: 0.00, darkSoftening: 0.35, accentTiming: 0.85, interRegionBleed: 0.45 },
  'seascape':       { restraint: 0.60, focalDensity: 1.3, veilStrength: 0.75, bareCanvasThreshold: 0.05, darkSoftening: 0.45, accentTiming: 0.40, interRegionBleed: 0.55 },
  'twilight-glow':  { restraint: 0.55, focalDensity: 1.5, veilStrength: 0.80, bareCanvasThreshold: 0.00, darkSoftening: 0.55, accentTiming: 0.70, interRegionBleed: 0.65 },
  'intimate-scene': { restraint: 0.65, focalDensity: 1.5, veilStrength: 0.55, bareCanvasThreshold: 0.00, darkSoftening: 0.40, accentTiming: 0.85, interRegionBleed: 0.50 },
  'abstract-masses':{ restraint: 0.60, focalDensity: 1.2, veilStrength: 0.60, bareCanvasThreshold: 0.00, darkSoftening: 0.35, accentTiming: 0.85, interRegionBleed: 0.55 },
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
