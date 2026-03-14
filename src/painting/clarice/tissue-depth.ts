// T3: Depth Mapper — assigns near/mid/far depth to each region
// Uses centroid position relative to horizon, with tone-based overrides.

import type { Region } from './region-analysis.js';
import type { DepthClass } from './types.js';

const DARK = 3;

export function mapDepths(
  regions: Region[],
  horizonRow: number,
  totalRows: number,
): Map<number, DepthClass> {
  const result = new Map<number, DepthClass>();
  const normalizedHorizon = horizonRow / totalRows;

  for (const region of regions) {
    const cy = region.centroid.y;
    const ratio = cy / normalizedHorizon;

    let depth: DepthClass;
    if (ratio < 0.7) {
      depth = 'far';
    } else if (ratio > 1.3) {
      depth = 'near';
    } else {
      depth = 'mid';
    }

    // Override: dark regions tend to be near (silhouettes against light)
    if (region.meldrumIndex >= DARK && depth === 'far') {
      depth = 'mid';
    }
    // Override: light regions well above horizon are far (sky)
    if (region.meldrumIndex <= 1 && cy < normalizedHorizon * 0.7) {
      depth = 'far';
    }

    result.set(region.id, depth);
  }

  return result;
}
