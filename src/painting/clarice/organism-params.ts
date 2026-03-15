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
  // CMA-ES tuned depth progression: far=thin/light, mid=moderate, near=committed/heavy.
  // brushSlot/pressure kept from original — CMA only tunes thinners/load via depth override.
  sky:        { brushSlot: 4, pressure: 0.22, thinners: 0.20, load: 0.29 },
  ground:     { brushSlot: 3, pressure: 0.30, thinners: 0.11, load: 0.43 },
  horizon:    { brushSlot: 3, pressure: 0.28, thinners: 0.11, load: 0.43 },
  mass:       { brushSlot: 2, pressure: 0.38, thinners: 0.04, load: 0.63 },
  vertical:   { brushSlot: 1, pressure: 0.30, thinners: 0.04, load: 0.63 },
  accent:     { brushSlot: 1, pressure: 0.50, thinners: 0.00, load: 0.63 },
  reflection: { brushSlot: 2, pressure: 0.25, thinners: 0.20, load: 0.29 },
  fill:       { brushSlot: 3, pressure: 0.28, thinners: 0.11, load: 0.43 },
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

/** CMA-ES vector-driven parameter refinement — Group C (indices 11-16).
 *  Overrides thinners/load per depth class, keeping other logic (tonal scaling,
 *  atmospheric perspective, focal distance) from the heuristic path. */
export function refineParametersFromVector(
  regions: Region[],
  depths: Map<number, DepthClass>,
  _colors: Map<number, ColorAnalysis>,
  tones: Map<number, number>,
  focalPoint: FocalPoint,
  vec: number[],
): Map<number, RefinedParams> {
  const depthOverrides: Record<DepthClass, { thinners: number; load: number }> = {
    far:  { thinners: vec[11], load: vec[12] },
    mid:  { thinners: vec[13], load: vec[14] },
    near: { thinners: vec[15], load: vec[16] },
  };

  const result = new Map<number, RefinedParams>();

  for (const region of regions) {
    const base = BASE_CONFIG[region.classification];
    const depth = depths.get(region.id) || 'mid';
    const meldrumIndex = tones.get(region.id) ?? region.meldrumIndex;

    let { brushSlot, pressure } = base;
    // Use vector-driven thinners/load for this depth class
    let { thinners, load } = depthOverrides[depth];

    // Tonal scaling (same as heuristic)
    if (meldrumIndex < MID) {
      thinners = Math.min(1.0, thinners + 0.08);
      load = Math.max(0.15, load - 0.25);
      pressure = Math.max(0.20, pressure - 0.15);
    } else if (meldrumIndex > MID) {
      load = Math.min(0.85, load + 0.08);
      pressure = Math.min(0.75, pressure + 0.05);
      thinners = Math.max(0.01, thinners);
    }

    // Atmospheric perspective
    if (region.centroid.y < 0.4) {
      thinners = Math.min(1.0, thinners + 0.02);
      brushSlot = Math.min(4, brushSlot + 1);
    }

    // Depth-driven brush slot (keep from heuristic)
    if (depth === 'far') {
      brushSlot = Math.min(4, brushSlot + 1);
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
