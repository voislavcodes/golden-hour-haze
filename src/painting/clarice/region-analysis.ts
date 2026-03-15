// Region Analysis — connected component extraction from tonal maps
// BFS flood fill on meldrumIndex, computes bounding boxes, centroids, edge density.

import type { TonalMap } from './tonal-recreation.js';

export type RegionClass = 'sky' | 'ground' | 'horizon' | 'mass' | 'vertical' | 'accent' | 'reflection' | 'fill';

export interface Region {
  id: number;
  cells: { gridX: number; gridY: number }[];
  meldrumIndex: number;
  hueIndex: number;
  maxChroma: number;
  boundingBox: { x0: number; y0: number; x1: number; y1: number };
  areaFraction: number;
  aspectRatio: number;
  centroid: { x: number; y: number };  // normalized 0-1
  edgeCells: number;
  edgeDensity: number;
  classification: RegionClass;
  confidence: number;
}

export interface RegionFeatures {
  x: number; y: number;        // centroid, normalized 0-1
  aspectRatio: number;
  areaFraction: number;
  meldrumIndex: number;        // normalized 0-0.25 (divided by 4)
  maxChroma: number;
}

// --- Connected components via BFS flood fill ---

export function extractRegions(map: TonalMap): Region[] {
  const { cols, rows, cells } = map;
  const visited = new Uint8Array(rows * cols);
  const regions: Region[] = [];
  let nextId = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (visited[r * cols + c]) continue;

      const mIdx = cells[r][c].meldrumIndex;
      const hIdx = cells[r][c].assignedHueIndex;
      const regionCells: { gridX: number; gridY: number }[] = [];
      const queue: [number, number][] = [[r, c]];
      visited[r * cols + c] = 1;

      while (queue.length > 0) {
        const [qr, qc] = queue.pop()!;
        regionCells.push({ gridX: qc, gridY: qr });

        // 4-connectivity neighbors
        const neighbors: [number, number][] = [
          [qr - 1, qc], [qr + 1, qc], [qr, qc - 1], [qr, qc + 1],
        ];
        for (const [nr, nc] of neighbors) {
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (visited[nr * cols + nc]) continue;
          // Merge requires BOTH same meldrum tone AND same hue assignment
          if (cells[nr][nc].meldrumIndex !== mIdx) continue;
          if (cells[nr][nc].assignedHueIndex !== hIdx) continue;
          visited[nr * cols + nc] = 1;
          queue.push([nr, nc]);
        }
      }

      regions.push(buildRegion(nextId++, regionCells, mIdx, map));
    }
  }

  // Merge tiny regions (< 3 cells) into largest neighbor
  return mergeSmallRegions(regions, map);
}

function buildRegion(
  id: number,
  cells: { gridX: number; gridY: number }[],
  meldrumIndex: number,
  map: TonalMap,
): Region {
  const { cols, rows } = map;
  const totalCells = cols * rows;

  let x0 = cols, y0 = rows, x1 = 0, y1 = 0;
  let sumX = 0, sumY = 0;
  let maxChroma = 0;
  const hueCounts = new Map<number, number>();

  for (const { gridX, gridY } of cells) {
    if (gridX < x0) x0 = gridX;
    if (gridX > x1) x1 = gridX;
    if (gridY < y0) y0 = gridY;
    if (gridY > y1) y1 = gridY;
    sumX += gridX;
    sumY += gridY;

    const cell = map.cells[gridY][gridX];
    if (cell.chroma > maxChroma) maxChroma = cell.chroma;
    hueCounts.set(cell.assignedHueIndex, (hueCounts.get(cell.assignedHueIndex) || 0) + 1);
  }

  // Majority hue
  let hueIndex = 0, maxHueCount = 0;
  for (const [idx, count] of hueCounts) {
    if (count > maxHueCount) { maxHueCount = count; hueIndex = idx; }
  }

  // Edge cells: cells with at least one neighbor of different meldrumIndex
  let edgeCells = 0;
  for (const { gridX, gridY } of cells) {
    const neighbors: [number, number][] = [
      [gridY - 1, gridX], [gridY + 1, gridX], [gridY, gridX - 1], [gridY, gridX + 1],
    ];
    for (const [nr, nc] of neighbors) {
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) { edgeCells++; break; }
      if (map.cells[nr][nc].meldrumIndex !== meldrumIndex) { edgeCells++; break; }
    }
  }

  const bboxW = x1 - x0 + 1;
  const bboxH = y1 - y0 + 1;

  return {
    id,
    cells,
    meldrumIndex,
    hueIndex,
    maxChroma,
    boundingBox: { x0, y0, x1, y1 },
    areaFraction: cells.length / totalCells,
    aspectRatio: bboxW > 0 ? bboxH / bboxW : 1,
    centroid: {
      x: (sumX / cells.length) / cols,
      y: (sumY / cells.length) / rows,
    },
    edgeCells,
    edgeDensity: cells.length > 0 ? edgeCells / cells.length : 0,
    classification: 'fill',
    confidence: 0,
  };
}

function mergeSmallRegions(regions: Region[], map: TonalMap): Region[] {
  const MIN_SIZE = 5;
  const small = regions.filter(r => r.cells.length < MIN_SIZE);
  const large = regions.filter(r => r.cells.length >= MIN_SIZE);

  if (large.length === 0) return regions; // edge case: all small

  // Build cell → region lookup for large regions
  const cellToRegion = new Map<string, Region>();
  for (const r of large) {
    for (const c of r.cells) {
      cellToRegion.set(`${c.gridX},${c.gridY}`, r);
    }
  }

  // For each small region, find adjacent large region or nearest large region
  for (const sr of small) {
    let bestNeighbor: Region | null = null;
    let bestSize = 0;

    for (const { gridX, gridY } of sr.cells) {
      const neighbors: [number, number][] = [
        [gridY - 1, gridX], [gridY + 1, gridX], [gridY, gridX - 1], [gridY, gridX + 1],
      ];
      for (const [nr, nc] of neighbors) {
        const key = `${nc},${nr}`;
        const neighbor = cellToRegion.get(key);
        if (neighbor && neighbor.cells.length > bestSize) {
          bestSize = neighbor.cells.length;
          bestNeighbor = neighbor;
        }
      }
    }

    if (!bestNeighbor) {
      // No adjacent large region — merge into the largest
      bestNeighbor = large.reduce((a, b) => a.cells.length > b.cells.length ? a : b);
    }

    // Merge cells into the neighbor
    for (const c of sr.cells) {
      bestNeighbor.cells.push(c);
      cellToRegion.set(`${c.gridX},${c.gridY}`, bestNeighbor);
    }
  }

  // Rebuild stats for regions that received cells
  return large.map(r => buildRegion(r.id, r.cells, r.meldrumIndex, map));
}

// --- Horizon detection ---
// Find sharpest drop in average lightness across rows 20-60%

export function detectHorizon(map: TonalMap): number {
  const { cols, rows, cells } = map;
  const rowAvgL: number[] = [];

  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let c = 0; c < cols; c++) sum += cells[r][c].labL;
    rowAvgL.push(sum / cols);
  }

  const startRow = Math.floor(rows * 0.2);
  const endRow = Math.floor(rows * 0.6);
  let maxDrop = 0;
  let horizonRow = Math.floor(rows * 0.4); // default

  for (let r = startRow; r < endRow; r++) {
    const drop = rowAvgL[r] - rowAvgL[r + 1];
    if (drop > maxDrop) {
      maxDrop = drop;
      horizonRow = r;
    }
  }

  // Only accept if drop is significant
  if (maxDrop < 0.03) horizonRow = Math.floor(rows * 0.4);

  return horizonRow;
}

// --- Feature extraction ---

export function computeRegionFeatures(region: Region, _cols: number, _rows: number): RegionFeatures {
  return {
    x: region.centroid.x,
    y: region.centroid.y,
    aspectRatio: region.aspectRatio,
    areaFraction: region.areaFraction,
    meldrumIndex: region.meldrumIndex / 4,
    maxChroma: region.maxChroma,
  };
}
