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

  // 1. Vertical: tall aspect + mid-to-dark + NARROW — poles, figures, posts
  //    Must be narrow (< 8 cells wide) to avoid classifying tree masses as verticals.
  const bboxWidth = region.boundingBox.x1 - region.boundingBox.x0 + 1;
  if (features.aspectRatio >= 2.0 && region.meldrumIndex >= MID && bboxWidth <= 8) {
    return { classification: 'vertical', confidence: 0.85 };
  }
  if (features.aspectRatio >= 1.5 && region.meldrumIndex >= DARK && bboxWidth <= 5) {
    return { classification: 'vertical', confidence: 0.80 };
  }

  // 2. Accent: high chroma AND very small area — vivid focal marks (tram, lights, umbrella)
  //    Must be VERY small; mid-sized warm regions near horizon are buildings, not accents.
  //    Also exclude regions near the horizon — those are likely building fragments.
  if (region.maxChroma > 0.10 && features.areaFraction < 0.02) {
    return { classification: 'accent', confidence: 0.90 };
  }

  // 3. Compact structures near horizon — buildings, towers, boats
  //    These are often mid-tone and above the horizon, so they'd be misclassified as sky.
  //    Check BEFORE sky to give them priority.
  const horizonStructDist = Math.abs(features.y - normalizedHorizon);
  if (horizonStructDist < 0.20 && features.y <= normalizedHorizon + 0.05
      && features.aspectRatio >= 0.4 && features.aspectRatio <= 4.0
      && features.areaFraction >= 0.003 && features.areaFraction < 0.06
      && bboxW <= bboxH * 3) {
    return { classification: 'mass', confidence: 0.60 };
  }

  // 3b. Dark mass above horizon — tree silhouettes, not sky.
  //     Regions above the horizon that are MID-to-DARK are tree masses projecting
  //     into the sky, not the sky itself. Must check BEFORE sky classification.
  if (features.y < normalizedHorizon && region.meldrumIndex >= MID
      && features.areaFraction > 0.005 && features.areaFraction < 0.25) {
    return { classification: 'mass', confidence: 0.70 };
  }

  // 4. Sky: centroid above horizon, meaningful area, LIGHT tone
  //    Only truly LIGHT regions above horizon are sky. MID/DARK above horizon = trees.
  if (features.y < normalizedHorizon && features.areaFraction > 0.01
      && region.meldrumIndex < MID) {
    if (bboxBot < normalizedHorizon + 0.15) {
      return { classification: 'sky', confidence: 0.85 };
    }
  }
  // Fallback sky: above horizon but not dark enough for mass
  if (features.y < normalizedHorizon && features.areaFraction > 0.01) {
    return { classification: 'sky', confidence: 0.50 };
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
