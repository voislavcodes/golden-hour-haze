// T6: Edge Detector — classifies boundaries between adjacent regions
// Uses depth, meldrum band, classification, and position to determine edge softness.

import type { Region } from './region-analysis.js';
import type { TonalMap } from './tonal-recreation.js';
import type { DepthClass, EdgeResult, EdgeType } from './types.js';

export function detectEdges(
  regions: Region[],
  map: TonalMap,
  depths: Map<number, DepthClass>,
  horizonRow: number,
): EdgeResult[] {
  const { cols, rows } = map;

  // Build cell → region ID lookup
  const cellToRegion = new Uint16Array(rows * cols);
  cellToRegion.fill(0xFFFF);
  for (const region of regions) {
    for (const { gridX, gridY } of region.cells) {
      cellToRegion[gridY * cols + gridX] = region.id;
    }
  }

  // Build region ID lookup
  const regionById = new Map<number, Region>();
  for (const r of regions) regionById.set(r.id, r);

  // Find adjacent region pairs
  const pairSet = new Set<string>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = cellToRegion[r * cols + c];
      if (id === 0xFFFF) continue;

      const neighbors: [number, number][] = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
      for (const [nr, nc] of neighbors) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nid = cellToRegion[nr * cols + nc];
        if (nid === 0xFFFF || nid === id) continue;
        const key = id < nid ? `${id},${nid}` : `${nid},${id}`;
        pairSet.add(key);
      }
    }
  }

  // Classify each edge
  const normalizedHorizon = horizonRow / rows;
  const results: EdgeResult[] = [];

  for (const key of pairSet) {
    const [aId, bId] = key.split(',').map(Number);
    const a = regionById.get(aId)!;
    const b = regionById.get(bId)!;
    if (!a || !b) continue;

    const edgeType = classifyEdge(a, b, depths, normalizedHorizon);
    results.push({ regionA: aId, regionB: bId, edgeType });
  }

  return results;
}

function classifyEdge(
  a: Region,
  b: Region,
  depths: Map<number, DepthClass>,
  normalizedHorizon: number,
): EdgeType {
  // Same meldrum → no visible edge
  if (a.meldrumIndex === b.meldrumIndex) return 'none';

  const depthA = depths.get(a.id) || 'mid';
  const depthB = depths.get(b.id) || 'mid';

  // Big depth gap → sharp boundary
  if ((depthA === 'near' && depthB === 'far') || (depthA === 'far' && depthB === 'near')) {
    return 'sharp';
  }

  // Either vertical → sharp (silhouette against background)
  if (a.classification === 'vertical' || b.classification === 'vertical') {
    return 'sharp';
  }

  // Both light, above horizon → soft (atmospheric blending)
  if (a.meldrumIndex <= 1 && b.meldrumIndex <= 1 &&
      a.centroid.y < normalizedHorizon && b.centroid.y < normalizedHorizon) {
    return 'soft';
  }

  // Default → soft (tonalist approach)
  return 'soft';
}
