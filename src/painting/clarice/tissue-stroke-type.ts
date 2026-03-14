// T8: Stroke Type Inferrer — heuristic fallback
// Maps region classification + shape to appropriate stroke construction method.
// ML model (5K params) replaces this in Sprint 2.

import type { Region } from './region-analysis.js';
import type { DepthClass, StrokeType } from './types.js';

export function inferStrokeTypes(
  regions: Region[],
  _depths: Map<number, DepthClass>,
): Map<number, StrokeType> {
  const result = new Map<number, StrokeType>();

  for (const region of regions) {
    let strokeType: StrokeType;

    switch (region.classification) {
      case 'sky':
      case 'ground':
      case 'fill':
      case 'horizon':
        strokeType = 'horizontal-wash';
        break;
      case 'mass': {
        // Wide masses get horizontal wash instead of dabs
        const bboxW = region.boundingBox.x1 - region.boundingBox.x0 + 1;
        const bboxH = region.boundingBox.y1 - region.boundingBox.y0 + 1;
        strokeType = (bboxW > bboxH * 2.5) ? 'horizontal-wash' : 'clustered-dabs';
        break;
      }
      case 'vertical':
        strokeType = 'vertical-stroke';
        break;
      case 'accent':
        strokeType = 'single-dab';
        break;
      case 'reflection':
        strokeType = 'vertical-stroke';
        break;
      default:
        strokeType = 'horizontal-wash';
    }

    result.set(region.id, strokeType);
  }

  return result;
}
