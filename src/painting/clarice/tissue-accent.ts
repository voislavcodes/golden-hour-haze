// T7: Accent Detector — identifies high-chroma, small-area accent regions
// Accents receive oil + anchor for vivid color marks.

import type { Region } from './region-analysis.js';
import type { AccentResult } from './types.js';

const CHROMA_THRESHOLD = 0.09;
const AREA_THRESHOLD = 0.03;

export function detectAccents(
  regions: Region[],
): Map<number, AccentResult> {
  const result = new Map<number, AccentResult>();

  for (const region of regions) {
    const isAccent = region.maxChroma > CHROMA_THRESHOLD && region.areaFraction < AREA_THRESHOLD;
    result.set(region.id, {
      regionId: region.id,
      isAccent,
      intensity: region.maxChroma,
    });
  }

  return result;
}
