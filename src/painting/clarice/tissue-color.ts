// T4: Color Analyzer — per-region color statistics from the tonal grid
// Computes average lightness, chroma, hue (circular mean), and chromatic flag.

import type { Region } from './region-analysis.js';
import type { TonalMap } from './tonal-recreation.js';
import type { ColorAnalysis } from './types.js';

const CHROMATIC_THRESHOLD = 0.04;

export function analyzeColors(
  regions: Region[],
  map: TonalMap,
): Map<number, ColorAnalysis> {
  const result = new Map<number, ColorAnalysis>();

  for (const region of regions) {
    let sumL = 0;
    let sumChroma = 0;
    let sinSum = 0;
    let cosSum = 0;
    const hueCounts = new Map<number, number>();

    for (const { gridX, gridY } of region.cells) {
      const cell = map.cells[gridY][gridX];
      sumL += cell.labL;
      sumChroma += cell.chroma;
      const rad = cell.hue * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
      hueCounts.set(cell.assignedHueIndex, (hueCounts.get(cell.assignedHueIndex) || 0) + 1);
    }

    const n = region.cells.length;
    const avgL = sumL / n;
    const avgChroma = sumChroma / n;
    let avgHue = Math.atan2(sinSum / n, cosSum / n) * 180 / Math.PI;
    if (avgHue < 0) avgHue += 360;

    // Majority hue index
    let nearestHueIndex = 0;
    let maxCount = 0;
    for (const [idx, count] of hueCounts) {
      if (count > maxCount) { maxCount = count; nearestHueIndex = idx; }
    }

    result.set(region.id, {
      regionId: region.id,
      avgL,
      avgChroma,
      avgHue,
      nearestHueIndex,
      chromatic: avgChroma > CHROMATIC_THRESHOLD,
    });
  }

  return result;
}
