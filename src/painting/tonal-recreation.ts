// Tonal Recreation — procedural painting from reference images
// Analyzes a reference image and generates painting strokes following tonalist principles:
// mother color first, large→small, tone before color, 5 discrete Meldrum values.

import { rgbToOklab } from '../mood/oklch.js';
import { sampleTonalColumn, MELDRUM_VALUES, BRUSH_SLOT_SIZES } from './palette.js';
import type { KColor, ComplementConfig } from '../mood/moods.js';

// --- Data structures ---

export interface TonalCell {
  gridX: number;
  gridY: number;
  labL: number;           // OKLab lightness 0-1
  chroma: number;         // sqrt(a² + b²)
  hue: number;            // degrees
  assignedHueIndex: number; // 0-4 palette slot
  meldrumIndex: number;   // 0-4 (WHITE/LIGHT/MID/DARK/BLACK)
}

export interface TonalMap {
  cols: number;
  rows: number;
  cells: TonalCell[][];   // [row][col]
  motherTone: number;     // median L
  motherHueIndex: number; // palette slot closest to dominant hue
}

export interface MeldrumLUT {
  hueIndex: number;
  luminances: [number, number, number, number, number]; // L at each MELDRUM_VALUES step
}

export interface Span {
  row: number;
  colStart: number;
  colEnd: number;         // inclusive
  meldrumIndex: number;   // 0-4
  hueIndex: number;       // 0-4
  isAccent: boolean;      // high chroma → anchor+oil
}

export interface StrokeCommand {
  points: { x: number; y: number; pressure: number }[];
  brushSlot: number;
  brushSize: number;
  hueIndex: number;
  meldrumIndex: number;   // 0-4
  thinners: number;
  load: number;
  useOil: boolean;
  useAnchor: boolean;
}

export interface PaintingPlan {
  layers: { name: string; strokes: StrokeCommand[] }[];
  metadata: {
    gridSize: [number, number];
    strokeCount: number;
    motherHueIndex: number;
    hueAssignments: { hueIndex: number; hue: number }[];
  };
}

// --- Constants ---

const WHITE = 0, LIGHT = 1, MID = 2, DARK = 3, BLACK = 4;
const CHROMA_ACCENT_THRESHOLD = 0.06;
const CHROMA_NEUTRAL_THRESHOLD = 0.02;
const MIN_SPAN_WIDTH = 1;

// --- Step 1: Analyze tonal structure ---

export function analyzeTonalStructure(imageData: ImageData, cols: number, rows: number): TonalMap {
  const { data, width, height } = imageData;
  const cellW = width / cols;
  const cellH = height / rows;

  const cells: TonalCell[][] = [];
  const allL: number[] = [];

  for (let row = 0; row < rows; row++) {
    const rowCells: TonalCell[] = [];
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor(col * cellW);
      const y0 = Math.floor(row * cellH);
      const x1 = Math.floor((col + 1) * cellW);
      const y1 = Math.floor((row + 1) * cellH);

      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * width + px) * 4;
          rSum += data[i] / 255;
          gSum += data[i + 1] / 255;
          bSum += data[i + 2] / 255;
          count++;
        }
      }

      const r = rSum / count;
      const g = gSum / count;
      const b = bSum / count;
      const [L, a, bk] = rgbToOklab(r, g, b);
      const chroma = Math.sqrt(a * a + bk * bk);
      let hue = Math.atan2(bk, a) * 180 / Math.PI;
      if (hue < 0) hue += 360;

      allL.push(L);
      rowCells.push({
        gridX: col, gridY: row,
        labL: L, chroma, hue,
        assignedHueIndex: 0, meldrumIndex: MID,
      });
    }
    cells.push(rowCells);
  }

  allL.sort((a, b) => a - b);
  const motherTone = allL[Math.floor(allL.length / 2)];
  return { cols, rows, cells, motherTone, motherHueIndex: 0 };
}

// --- Step 2: Assign hues to cells ---

export function assignHuesToCells(map: TonalMap, paletteColors: KColor[]): void {
  const paletteHues: number[] = paletteColors.map(c => {
    const [, a, b] = rgbToOklab(c.r, c.g, c.b);
    let h = Math.atan2(b, a) * 180 / Math.PI;
    if (h < 0) h += 360;
    return h;
  });

  const hueCounts = [0, 0, 0, 0, 0];

  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      const cell = map.cells[row][col];
      if (cell.chroma < CHROMA_NEUTRAL_THRESHOLD) {
        cell.assignedHueIndex = -1;
      } else {
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < paletteHues.length; i++) {
          let d = Math.abs(cell.hue - paletteHues[i]);
          if (d > 180) d = 360 - d;
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        cell.assignedHueIndex = bestIdx;
        hueCounts[bestIdx]++;
      }
    }
  }

  let motherHueIndex = 0, maxCount = 0;
  for (let i = 0; i < 5; i++) {
    if (hueCounts[i] > maxCount) { maxCount = hueCounts[i]; motherHueIndex = i; }
  }
  map.motherHueIndex = motherHueIndex;

  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      if (map.cells[row][col].assignedHueIndex === -1) {
        map.cells[row][col].assignedHueIndex = motherHueIndex;
      }
    }
  }
}

// --- Step 3: Build Meldrum LUTs ---
// Use raw sampleTonalColumn → OKLab L (NOT previewColor, which compresses the range)

export function buildMeldrumLUTs(
  paletteColors: KColor[],
  complement: ComplementConfig,
): MeldrumLUT[] {
  return paletteColors.map((baseColor, hueIndex) => {
    const luminances: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) {
      const sample = sampleTonalColumn(baseColor, MELDRUM_VALUES[i], complement);
      const [L] = rgbToOklab(sample.r, sample.g, sample.b);
      luminances[i] = L;
    }
    return { hueIndex, luminances };
  });
}

// --- Step 4: Quantize cells ---

export function quantizeCells(map: TonalMap, luts: MeldrumLUT[]): void {
  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      const cell = map.cells[row][col];
      const lut = luts[cell.assignedHueIndex];
      let bestIdx = MID, bestDist = Infinity;
      for (let i = 0; i < 5; i++) {
        const d = Math.abs(cell.labL - lut.luminances[i]);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      cell.meldrumIndex = bestIdx;
    }
  }
}

// --- Step 5: Generate spans ---
// Merge adjacent cells with same meldrumIndex into horizontal spans.
// Hue index is taken from the majority hue in the span.

export function generateSpans(map: TonalMap): Span[] {
  const spans: Span[] = [];

  for (let row = 0; row < map.rows; row++) {
    let col = 0;
    while (col < map.cols) {
      const mIdx = map.cells[row][col].meldrumIndex;
      let end = col;

      // Merge by meldrumIndex only — produces broader strokes
      while (end + 1 < map.cols && map.cells[row][end + 1].meldrumIndex === mIdx) {
        end++;
      }

      const spanWidth = end - col + 1;
      if (spanWidth >= MIN_SPAN_WIDTH) {
        // Majority hue for the span
        const hueCounts = [0, 0, 0, 0, 0];
        let maxChroma = 0;
        for (let c = col; c <= end; c++) {
          hueCounts[map.cells[row][c].assignedHueIndex]++;
          if (map.cells[row][c].chroma > maxChroma) maxChroma = map.cells[row][c].chroma;
        }
        let hIdx = 0, hMax = 0;
        for (let i = 0; i < 5; i++) {
          if (hueCounts[i] > hMax) { hMax = hueCounts[i]; hIdx = i; }
        }

        spans.push({
          row, colStart: col, colEnd: end,
          meldrumIndex: mIdx, hueIndex: hIdx,
          isAccent: maxChroma > CHROMA_ACCENT_THRESHOLD,
        });
      }
      col = end + 1;
    }
  }

  return spans;
}

// --- Step 6: Assemble plan ---

const LAYER_CONFIG: Record<string, { brushSlot: number; pressure: number; thinners: number; load: number }> = {
  mother:     { brushSlot: 4, pressure: 0.45, thinners: 0.0,  load: 0.70 },
  background: { brushSlot: 4, pressure: 0.38, thinners: 0.02, load: 0.50 },
  midtone:    { brushSlot: 3, pressure: 0.48, thinners: 0.01, load: 0.55 },
  dark:       { brushSlot: 3, pressure: 0.55, thinners: 0.0,  load: 0.72 },
  darkBlack:  { brushSlot: 2, pressure: 0.62, thinners: 0.0,  load: 0.88 },
  accent:     { brushSlot: 1, pressure: 0.65, thinners: 0.0,  load: 0.65 },
  veil:       { brushSlot: 4, pressure: 0.15, thinners: 0.06, load: 0.14 },
};

function spanToStroke(
  span: Span,
  cols: number,
  rows: number,
  cfg: { brushSlot: number; pressure: number; thinners: number; load: number },
  useOil: boolean,
  useAnchor: boolean,
): StrokeCommand {
  const spanLen = span.colEnd - span.colStart + 1;
  const nPoints = Math.max(8, Math.min(24, Math.round(spanLen * 1.5)));
  const cellH = 1 / rows;
  const points: { x: number; y: number; pressure: number }[] = [];

  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    const col = span.colStart + t * (span.colEnd - span.colStart);
    const x = (col + 0.5) / cols;
    const y = (span.row + 0.5) / rows + (Math.sin(i * 0.73 + span.row * 0.37) * 0.3 * cellH);
    const p = cfg.pressure + Math.sin(i * 0.47) * 0.015;
    points.push({ x, y, pressure: Math.max(0.05, Math.min(0.95, p)) });
  }

  return {
    points,
    brushSlot: cfg.brushSlot,
    brushSize: BRUSH_SLOT_SIZES[cfg.brushSlot],
    hueIndex: span.hueIndex,
    meldrumIndex: span.meldrumIndex,
    thinners: cfg.thinners,
    load: cfg.load,
    useOil,
    useAnchor,
  };
}

// Generate dense fill strokes — like the mother wash in the Beckett test
function fillStrokes(
  yStart: number, yEnd: number, x0: number, x1: number,
  cfg: { brushSlot: number; pressure: number; thinners: number; load: number },
  hueIndex: number, meldrumIndex: number,
  passes = 1,
): StrokeCommand[] {
  const bs = BRUSH_SLOT_SIZES[cfg.brushSlot];
  const spacing = bs * 0.20;
  const strokes: StrokeCommand[] = [];
  const nPts = Math.max(30, Math.round((x1 - x0) * 80));

  for (let pass = 0; pass < passes; pass++) {
    const off = pass * spacing * 0.4;
    const rowCount = Math.ceil((yEnd - yStart) / spacing);
    for (let i = 0; i < rowCount; i++) {
      const y = yStart + i * spacing + off;
      if (y > yEnd) break;
      const points = Array.from({ length: nPts }, (_, pi) => ({
        x: x0 + (pi / (nPts - 1)) * (x1 - x0),
        y: y + Math.sin(pi * 0.31) * 0.002,
        pressure: cfg.pressure + Math.sin(pi * 0.47) * 0.01,
      }));
      strokes.push({
        points, brushSlot: cfg.brushSlot, brushSize: bs,
        hueIndex, meldrumIndex, thinners: cfg.thinners, load: cfg.load,
        useOil: false, useAnchor: false,
      });
    }
  }
  return strokes;
}

export function assemblePlan(
  spans: Span[],
  map: TonalMap,
): PaintingPlan {
  const { cols, rows, motherHueIndex } = map;
  const layers: { name: string; strokes: StrokeCommand[] }[] = [];

  // Layer 1: Mother — full-coverage wash, 2 passes
  const motherStrokes = fillStrokes(0.0, 1.0, 0.0, 1.0, LAYER_CONFIG.mother, motherHueIndex, LIGHT, 2);
  layers.push({ name: 'Mother', strokes: motherStrokes });

  // Categorize spans
  const bgSpans = spans.filter(s => (s.meldrumIndex === WHITE || s.meldrumIndex === LIGHT) && !s.isAccent);
  const midSpans = spans.filter(s => s.meldrumIndex === MID && !s.isAccent);
  const darkSpans = spans.filter(s => s.meldrumIndex === DARK && !s.isAccent);
  const blackSpans = spans.filter(s => s.meldrumIndex === BLACK && !s.isAccent);
  const accentSpans = spans.filter(s => s.isAccent);

  // Layer 2: Background
  const bgStrokes = bgSpans.map(s => spanToStroke(s, cols, rows, LAYER_CONFIG.background, false, false));
  layers.push({ name: 'Background', strokes: budgetStrokes(bgStrokes, 80) });

  // Layer 3: Midtone
  const midStrokes = midSpans.map(s => spanToStroke(s, cols, rows, LAYER_CONFIG.midtone, false, false));
  layers.push({ name: 'Midtone', strokes: budgetStrokes(midStrokes, 120) });

  // Layer 4: Dark forms
  const darkStrokes = [
    ...darkSpans.map(s => spanToStroke(s, cols, rows, LAYER_CONFIG.dark, false, false)),
    ...blackSpans.map(s => spanToStroke(s, cols, rows, LAYER_CONFIG.darkBlack, false, false)),
  ];
  layers.push({ name: 'Dark forms', strokes: budgetStrokes(darkStrokes, 100) });

  // Layer 5: Accents (high chroma)
  const accentStrokes = accentSpans.map(s => spanToStroke(s, cols, rows, LAYER_CONFIG.accent, true, true));
  layers.push({ name: 'Accents', strokes: budgetStrokes(accentStrokes, 40) });

  // Layer 6: Atmospheric veil — skip dark regions
  const veilStrokes: StrokeCommand[] = [];
  for (let row = 0; row < rows; row += 3) {
    let darkCount = 0;
    for (let col = 0; col < cols; col++) {
      if (map.cells[row][col].meldrumIndex >= DARK) darkCount++;
    }
    if (darkCount > cols * 0.5) continue;

    const nPoints = 12;
    const y = (row + 0.5) / rows;
    const points = Array.from({ length: nPoints }, (_, i) => ({
      x: i / (nPoints - 1),
      y: y + Math.sin(i * 0.6 + row * 0.2) * 0.004,
      pressure: 0.14 + Math.sin(i * 0.4) * 0.015,
    }));
    veilStrokes.push({
      points,
      brushSlot: 4, brushSize: BRUSH_SLOT_SIZES[4],
      hueIndex: motherHueIndex, meldrumIndex: WHITE,
      thinners: 0.06, load: 0.14,
      useOil: false, useAnchor: false,
    });
  }
  layers.push({ name: 'Atmospheric veil', strokes: budgetStrokes(veilStrokes, 20) });

  // Metadata
  const hueAssignments: { hueIndex: number; hue: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const huesForIndex: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (map.cells[r][c].assignedHueIndex === i) huesForIndex.push(map.cells[r][c].hue);
      }
    }
    const medianHue = huesForIndex.length > 0
      ? huesForIndex.sort((a, b) => a - b)[Math.floor(huesForIndex.length / 2)]
      : 0;
    hueAssignments.push({ hueIndex: i, hue: medianHue });
  }

  const totalStrokes = layers.reduce((sum, l) => sum + l.strokes.length, 0);
  return {
    layers,
    metadata: { gridSize: [cols, rows], strokeCount: totalStrokes, motherHueIndex, hueAssignments },
  };
}

// Budget: evenly sample if exceeding max
function budgetStrokes(strokes: StrokeCommand[], max: number): StrokeCommand[] {
  if (strokes.length <= max) return strokes;
  const step = strokes.length / max;
  const result: StrokeCommand[] = [];
  for (let i = 0; i < max; i++) {
    result.push(strokes[Math.floor(i * step)]);
  }
  return result;
}

// --- Full pipeline ---

export function createPaintingPlan(
  imageData: ImageData,
  paletteColors: KColor[],
  complement: ComplementConfig,
  gridCols = 40,
  gridRows = 30,
): PaintingPlan {
  const map = analyzeTonalStructure(imageData, gridCols, gridRows);
  assignHuesToCells(map, paletteColors);
  const luts = buildMeldrumLUTs(paletteColors, complement);
  quantizeCells(map, luts);
  const spans = generateSpans(map);
  return assemblePlan(spans, map);
}

// --- Utility: downsample image to grid-sized ImageData ---

export async function downsampleImage(
  blob: Blob,
  cols: number,
  rows: number,
): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(cols, rows);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, cols, rows);
  bitmap.close();
  return ctx.getImageData(0, 0, cols, rows);
}
