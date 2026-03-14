// T9: Shape Recipe Classifier — heuristic fallback
// Maps region properties to one of 10 Beckett construction recipes.
// ML model (8K params) replaces this in Sprint 2.

import type { Region } from './region-analysis.js';
import type { TonalMap } from './tonal-recreation.js';
import type { DepthClass, RecipeClass } from './types.js';

const DARK = 3;

export function classifyRecipes(
  regions: Region[],
  depths: Map<number, DepthClass>,
): Map<number, RecipeClass> {
  const result = new Map<number, RecipeClass>();

  for (const region of regions) {
    result.set(region.id, classifyRegionRecipe(region, depths.get(region.id) || 'mid'));
  }

  return result;
}

function classifyRegionRecipe(region: Region, _depth: DepthClass): RecipeClass {
  const bboxW = region.boundingBox.x1 - region.boundingBox.x0 + 1;
  const bboxH = region.boundingBox.y1 - region.boundingBox.y0 + 1;
  const aspect = bboxH / Math.max(bboxW, 1);

  // Sky, ground, horizon, fill → atmospheric wash
  if (region.classification === 'sky' || region.classification === 'ground' ||
      region.classification === 'horizon' || region.classification === 'fill') {
    return 'atmospheric-wash';
  }

  // Reflection → atmospheric wash (soft vertical handled by stroke type)
  if (region.classification === 'reflection') {
    return 'atmospheric-wash';
  }

  // Verticals
  if (region.classification === 'vertical') {
    // Very narrow + tall → pole
    if (aspect > 5 && bboxW <= 3) {
      return 'pole-simple';
    }
    // Top wider than middle → umbrella figure
    if (region.areaFraction > 0.005 && isTopHeavy(region)) {
      return 'figure-umbrella';
    }
    // Larger area → standing figure
    if (region.areaFraction > 0.01) {
      return 'figure-standing';
    }
    // Default vertical → pole
    return 'pole-simple';
  }

  // Accent → vehicle-body if compact, otherwise atmospheric
  if (region.classification === 'accent') {
    if (region.areaFraction > 0.005 && aspect < 2) {
      return 'vehicle-body';
    }
    return 'atmospheric-wash';
  }

  // Mass
  if (region.classification === 'mass') {
    // Wider than tall → hedge band
    if (bboxW > bboxH * 1.5) {
      return 'hedge-band';
    }
    // Dark, block-shaped → building
    if (region.meldrumIndex >= DARK && aspect < 2 && aspect > 0.5) {
      return 'building-block';
    }
    // Spread out (large area, wide) → spread tree
    if (region.areaFraction > 0.02 && bboxW > 4) {
      return 'tree-spread';
    }
    // Compact → rounded tree
    return 'tree-rounded';
  }

  return 'atmospheric-wash';
}

/** Check if the top portion of the region is wider than the middle — umbrella silhouette */
function isTopHeavy(region: Region): boolean {
  const bboxH = region.boundingBox.y1 - region.boundingBox.y0 + 1;
  if (bboxH < 4) return false;

  const topThird = region.boundingBox.y0 + Math.floor(bboxH / 3);
  const midThird = region.boundingBox.y0 + Math.floor(bboxH * 2 / 3);

  let topMinX = Infinity, topMaxX = -Infinity;
  let midMinX = Infinity, midMaxX = -Infinity;

  for (const { gridX, gridY } of region.cells) {
    if (gridY <= topThird) {
      if (gridX < topMinX) topMinX = gridX;
      if (gridX > topMaxX) topMaxX = gridX;
    } else if (gridY <= midThird) {
      if (gridX < midMinX) midMinX = gridX;
      if (gridX > midMaxX) midMaxX = gridX;
    }
  }

  const topW = topMaxX - topMinX + 1;
  const midW = midMaxX - midMinX + 1;
  return topW > midW * 1.3 && topW >= 2;
}

/** Extract 16×16 binary silhouette mask for future ML input */
export function extractSilhouettePatch(
  region: Region,
  _map: TonalMap,
): Float32Array {
  const { x0, y0, x1, y1 } = region.boundingBox;
  const bboxW = x1 - x0 + 1;
  const bboxH = y1 - y0 + 1;
  const patch = new Float32Array(16 * 16);

  // Build cell membership set
  const cellSet = new Set<string>();
  for (const { gridX, gridY } of region.cells) {
    cellSet.add(`${gridX},${gridY}`);
  }

  // Downsample to 16×16
  for (let py = 0; py < 16; py++) {
    for (let px = 0; px < 16; px++) {
      const gx = x0 + Math.round(px / 15 * (bboxW - 1));
      const gy = y0 + Math.round(py / 15 * (bboxH - 1));
      patch[py * 16 + px] = cellSet.has(`${gx},${gy}`) ? 1.0 : 0.0;
    }
  }

  return patch;
}
