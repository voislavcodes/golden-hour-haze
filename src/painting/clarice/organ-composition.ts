// O1: Composition Reader — heuristic fallback
// Classifies the scene into one of 6 composition types from aggregated features.
// ML model (10K params) replaces this in Sprint 2.

import type { CompositionClass, SceneFeatures } from './types.js';

export function classifyComposition(
  features: SceneFeatures,
): { class: CompositionClass; confidence: number } {
  // Decision tree — each condition checked in priority order

  // Lonely figure: 1 vertical + 0 accents + large sky
  if (features.countVertical === 1 && features.countAccent === 0 && features.skyAreaFraction > 0.2) {
    return { class: 'lonely-figure', confidence: 0.80 };
  }

  // Street scene: 3+ verticals + accent
  if (features.countVertical >= 3 && features.countAccent >= 1) {
    return { class: 'street-scene', confidence: 0.75 };
  }

  // Seascape: large sky or large ground + horizon in upper half
  // Beach/harbor scenes have masses (buildings) but are still seascapes.
  // Detect by: dominant ground area (sand/water) + horizon in upper portion
  if (features.skyAreaFraction > 0.2 && features.groundAreaFraction > 0.2 && features.horizonY < 0.5) {
    return { class: 'seascape', confidence: 0.70 };
  }
  // Also seascape if huge ground with low vertical count (open water/beach)
  if (features.groundAreaFraction > 0.35 && features.countVertical <= 1) {
    return { class: 'seascape', confidence: 0.65 };
  }

  // Twilight glow: high chroma + warm dominant hue (30-60° orange range)
  if (features.avgChroma > 0.05 && features.dominantHueAngle > 15 && features.dominantHueAngle < 75) {
    return { class: 'twilight-glow', confidence: 0.65 };
  }

  // Intimate scene: large ground + many masses
  if (features.groundAreaFraction > 0.2 && features.countMass >= 3) {
    return { class: 'intimate-scene', confidence: 0.60 };
  }

  // Default
  return { class: 'abstract-masses', confidence: 0.50 };
}
