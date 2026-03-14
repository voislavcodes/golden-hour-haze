// O2: Focal Point Locator — heuristic
// Identifies where the viewer's eye should go first.
// Priority: highest-chroma accent → largest/darkest vertical → warm horizon → mass center.

import type { Region } from './region-analysis.js';
import type { AccentResult, ColorAnalysis, FocalPoint } from './types.js';

export function locateFocalPoint(
  accents: Map<number, AccentResult>,
  regions: Region[],
  colors: Map<number, ColorAnalysis>,
): FocalPoint {
  // 1. Highest-chroma accent
  let bestAccent: { region: Region; chroma: number } | null = null;
  for (const [id, a] of accents) {
    if (!a.isAccent) continue;
    const region = regions.find(r => r.id === id);
    if (!region) continue;
    if (!bestAccent || a.intensity > bestAccent.chroma) {
      bestAccent = { region, chroma: a.intensity };
    }
  }
  if (bestAccent) {
    return { x: bestAccent.region.centroid.x, y: bestAccent.region.centroid.y, type: 'point' };
  }

  // 2. Largest/darkest vertical
  const verticals = regions.filter(r => r.classification === 'vertical');
  if (verticals.length > 0) {
    // Score by area × darkness
    let best: Region | null = null;
    let bestScore = -Infinity;
    for (const v of verticals) {
      const score = v.areaFraction * v.meldrumIndex;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (best) {
      return { x: best.centroid.x, y: best.centroid.y, type: 'figure' };
    }
  }

  // 3. Warm horizon center
  const horizons = regions.filter(r => r.classification === 'horizon');
  if (horizons.length > 0) {
    const color = colors.get(horizons[0].id);
    if (color && color.avgChroma > 0.03) {
      return { x: 0.5, y: horizons[0].centroid.y, type: 'band' };
    }
  }

  // 4. Mass-biased center
  const masses = regions.filter(r => r.classification === 'mass');
  if (masses.length > 0) {
    let sumX = 0, sumY = 0, totalArea = 0;
    for (const m of masses) {
      sumX += m.centroid.x * m.areaFraction;
      sumY += m.centroid.y * m.areaFraction;
      totalArea += m.areaFraction;
    }
    return { x: sumX / totalArea, y: sumY / totalArea, type: 'distributed' };
  }

  // Fallback: canvas center
  return { x: 0.5, y: 0.5, type: 'distributed' };
}
