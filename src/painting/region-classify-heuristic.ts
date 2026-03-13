// Heuristic Region Classifier — rule-based classification for bootstrap labeling + fallback
// Uses position, tone, shape, chroma, and area to classify regions.
// Tuned for tonalist paintings (Beckett/Meldrum) where overall chroma is moderate.

import type { Region, RegionClass, RegionFeatures } from './region-analysis.js';

const MID = 2, DARK = 3;

export function classifyRegionHeuristic(
  region: Region,
  features: RegionFeatures,
  horizonRow: number,
  totalRows: number,
): { classification: RegionClass; confidence: number } {
  const normalizedHorizon = horizonRow / totalRows;
  const bboxTop = region.boundingBox.y0 / totalRows;
  const bboxBot = region.boundingBox.y1 / totalRows;
  const bboxW = region.boundingBox.x1 - region.boundingBox.x0 + 1;
  const bboxH = region.boundingBox.y1 - region.boundingBox.y0 + 1;

  // 1. Vertical: tall aspect + dark — poles, figures, posts
  //    Check before accent so dark poles with some chroma aren't misclassified
  if (features.aspectRatio >= 2.0 && region.meldrumIndex >= DARK) {
    return { classification: 'vertical', confidence: 0.85 };
  }

  // 2. Accent: high chroma AND small area — vivid focal marks (tram, lights)
  //    Must be small; large warm regions are sky/ground, not accents
  if (region.maxChroma > 0.08 && features.areaFraction < 0.03) {
    return { classification: 'accent', confidence: 0.90 };
  }

  // 3. Sky: centroid above horizon, meaningful area
  //    Tonalist skies are often mid-tone warm grey — don't filter by lightness
  if (features.y < normalizedHorizon && features.areaFraction > 0.01) {
    if (bboxBot < normalizedHorizon + 0.15) {
      return { classification: 'sky', confidence: 0.85 };
    }
  }

  // 4. Horizon: bbox straddles horizon line, wider than tall
  if (bboxTop <= normalizedHorizon && bboxBot >= normalizedHorizon && bboxW > 2 * bboxH) {
    return { classification: 'horizon', confidence: 0.70 };
  }

  // 5. Mass: darker than mid, compact shape, not huge
  //    Tree masses, building silhouettes, dark shapes at horizon
  if (region.meldrumIndex >= DARK && features.aspectRatio < 2.5 && features.areaFraction < 0.15) {
    return { classification: 'mass', confidence: 0.75 };
  }

  // 6. Reflection: lower half, tallish aspect, mid-to-dark
  //    Dark streaks on wet pavement below figures
  if (features.y > 0.55 && features.aspectRatio > 1.3 && region.meldrumIndex >= MID) {
    return { classification: 'reflection', confidence: 0.60 };
  }

  // 7. Ground: centroid below horizon, meaningful area
  if (features.y > normalizedHorizon + 0.05 && features.areaFraction > 0.01) {
    return { classification: 'ground', confidence: 0.80 };
  }

  // 8. Position-based fallback: above horizon → sky, below → ground
  if (features.y < normalizedHorizon) {
    return { classification: 'sky', confidence: 0.50 };
  }
  if (features.y > normalizedHorizon) {
    return { classification: 'ground', confidence: 0.50 };
  }

  return { classification: 'fill', confidence: 0.40 };
}

/** Classify all regions using heuristic rules */
export function classifyAllHeuristic(
  regions: Region[],
  horizonRow: number,
  totalRows: number,
): void {
  for (const region of regions) {
    const features: RegionFeatures = {
      x: region.centroid.x,
      y: region.centroid.y,
      aspectRatio: region.aspectRatio,
      areaFraction: region.areaFraction,
      meldrumIndex: region.meldrumIndex / 4,
      maxChroma: region.maxChroma,
    };
    const result = classifyRegionHeuristic(region, features, horizonRow, totalRows);
    region.classification = result.classification;
    region.confidence = result.confidence;
  }
}
