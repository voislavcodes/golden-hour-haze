// T5: Tonal Mapper — per-region Meldrum index using average luminance
// Re-computes using the region's *average* L against the LUT (not BFS majority vote).
// Downstream consumers use T5's output; Region.meldrumIndex is only for BFS grouping.

import type { Region } from './region-analysis.js';
import type { MeldrumLUT } from './tonal-recreation.js';
import type { ColorAnalysis } from './types.js';

export function mapTones(
  regions: Region[],
  colors: Map<number, ColorAnalysis>,
  luts: MeldrumLUT[],
): Map<number, number> {
  const result = new Map<number, number>();

  for (const region of regions) {
    const color = colors.get(region.id);
    if (!color) { result.set(region.id, region.meldrumIndex); continue; }

    const lut = luts[color.nearestHueIndex];
    if (!lut) { result.set(region.id, region.meldrumIndex); continue; }

    let bestIdx = 2; // default MID
    let bestDist = Infinity;
    for (let i = 0; i < 5; i++) {
      const d = Math.abs(color.avgL - lut.luminances[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    result.set(region.id, bestIdx);
  }

  return result;
}
