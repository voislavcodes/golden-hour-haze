// O3: Atmosphere Density Reader — heuristic
// Produces a fog density scalar (0-1) from scene features.

import type { SceneFeatures } from './types.js';

export function readAtmosphere(features: SceneFeatures): number {
  const total = Math.max(1, features.countNear + features.countMid + features.countFar);
  const farRatio = features.countFar / total;

  const fog =
    features.skyAreaFraction * 0.3 +
    (1 - Math.min(1, features.avgChroma / 0.12)) * 0.3 +
    farRatio * 0.2 +
    features.ratioSoft * 0.2;

  return Math.max(0, Math.min(1, fog));
}
