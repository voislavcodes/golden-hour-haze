// SO1: Parameter Refinement — lookup table fallback
// Maps depth × classification → brush parameters, with tone-aware and atmospheric scaling.
// ML model (15K params) replaces this in Sprint 2.

import type { Region, RegionClass } from './region-analysis.js';
import type { ColorAnalysis, DepthClass, FocalPoint, RefinedParams } from './types.js';
import { BRUSH_SLOT_SIZES } from '../palette.js';

// Base config extracted from existing CLASS_CONFIG in region-strokes.ts
const BASE_CONFIG: Record<RegionClass, {
  brushSlot: number; pressure: number; thinners: number; load: number;
}> = {
  // Beckett technique: atmosphere is transparent, darks are committed.
  // sky/ground/horizon = glazes (high thinners, let mother show through)
  // mass/vertical = committed marks (lower thinners, anchoring the painting)
  sky:        { brushSlot: 4, pressure: 0.30, thinners: 0.40, load: 0.30 },
  ground:     { brushSlot: 3, pressure: 0.35, thinners: 0.30, load: 0.35 },
  horizon:    { brushSlot: 3, pressure: 0.32, thinners: 0.35, load: 0.32 },
  mass:       { brushSlot: 2, pressure: 0.50, thinners: 0.08, load: 0.55 },
  vertical:   { brushSlot: 1, pressure: 0.55, thinners: 0.04, load: 0.65 },
  accent:     { brushSlot: 1, pressure: 0.55, thinners: 0.00, load: 0.65 },
  reflection: { brushSlot: 2, pressure: 0.30, thinners: 0.30, load: 0.35 },
  fill:       { brushSlot: 3, pressure: 0.35, thinners: 0.20, load: 0.40 },
};

const MID = 2;

export function refineParameters(
  regions: Region[],
  depths: Map<number, DepthClass>,
  _colors: Map<number, ColorAnalysis>,
  tones: Map<number, number>,
  focalPoint: FocalPoint,
): Map<number, RefinedParams> {
  const result = new Map<number, RefinedParams>();

  for (const region of regions) {
    const base = BASE_CONFIG[region.classification];
    const depth = depths.get(region.id) || 'mid';
    const meldrumIndex = tones.get(region.id) ?? region.meldrumIndex;

    let { brushSlot, pressure, thinners, load } = base;

    // Tonal scaling: WHITE/LIGHT → more transparent; DARK/BLACK → more committed but still atmospheric
    if (meldrumIndex < MID) {
      thinners = Math.min(1.0, thinners + 0.08);
      load = Math.max(0.15, load - 0.25);
      pressure = Math.max(0.20, pressure - 0.15);
    } else if (meldrumIndex > MID) {
      load = Math.min(0.85, load + 0.08);
      pressure = Math.min(0.75, pressure + 0.05);
      // Darks still need some transparency for Beckett's atmospheric quality
      thinners = Math.max(0.01, thinners);
    }

    // Atmospheric perspective: above horizon → softer, bigger brush
    if (region.centroid.y < 0.4) {
      thinners = Math.min(1.0, thinners + 0.02);
      brushSlot = Math.min(4, brushSlot + 1);
    }

    // Depth scaling
    if (depth === 'far') {
      thinners = Math.min(1.0, thinners + 0.03);
      load = Math.max(0.2, load - 0.1);
      brushSlot = Math.min(4, brushSlot + 1);
    } else if (depth === 'near') {
      load = Math.min(1.0, load + 0.05);
      pressure = Math.min(0.85, pressure + 0.05);
    }

    // Focal distance modulation
    const dx = region.centroid.x - focalPoint.x;
    const dy = region.centroid.y - focalPoint.y;
    const focalDist = Math.sqrt(dx * dx + dy * dy);
    if (focalDist < 0.2) {
      pressure = Math.min(0.90, pressure + 0.05);
      load = Math.min(1.0, load + 0.05);
    }

    const brushSize = BRUSH_SLOT_SIZES[brushSlot];
    result.set(region.id, { thinners, load, pressure, brushSize, brushSlot });
  }

  return result;
}
