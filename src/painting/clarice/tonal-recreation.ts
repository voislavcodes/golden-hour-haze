// Tonal Recreation — procedural painting from reference images
// Analyzes a reference image and generates painting strokes following tonalist principles:
// mother color first, large→small, tone before color, 5 discrete Meldrum values.

import { rgbToOklab } from '../../mood/oklch.js';
import { sampleTonalColumn, MELDRUM_VALUES, BRUSH_SLOT_SIZES } from '../palette.js';
import type { KColor, ComplementConfig } from '../../mood/moods.js';

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
  mother:     { brushSlot: 4, pressure: 0.45, thinners: 0.08, load: 0.55 },
  background: { brushSlot: 4, pressure: 0.45, thinners: 0.02, load: 0.65 },
  midtone:    { brushSlot: 3, pressure: 0.55, thinners: 0.01, load: 0.70 },
  dark:       { brushSlot: 3, pressure: 0.65, thinners: 0.0,  load: 0.85 },
  darkBlack:  { brushSlot: 2, pressure: 0.70, thinners: 0.0,  load: 0.92 },
  accent:     { brushSlot: 1, pressure: 0.65, thinners: 0.0,  load: 0.65 },
  vertical:   { brushSlot: 1, pressure: 0.60, thinners: 0.0,  load: 0.80 },
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
    const y = (span.row + 0.5) / rows + (Math.sin(i * 0.73 + span.row * 0.37) * 0.5 * cellH);
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
  const spacing = bs * 0.15;
  const strokes: StrokeCommand[] = [];
  const nPts = Math.max(30, Math.round((x1 - x0) * 80));

  for (let pass = 0; pass < passes; pass++) {
    const off = pass * spacing * 0.5;
    const rowCount = Math.ceil((yEnd - yStart) / spacing);
    for (let i = 0; i < rowCount; i++) {
      const y = yStart + i * spacing + off;
      if (y > yEnd) break;
      // Alternate stroke direction for natural look
      const reverse = (i + pass) % 2 === 1;
      const points = Array.from({ length: nPts }, (_, pi) => {
        const t = pi / (nPts - 1);
        const xPos = reverse ? (x1 - t * (x1 - x0)) : (x0 + t * (x1 - x0));
        // Crosshatch drift: alternating +/- diagonal to break up banding
        const drift = (t - 0.5) * spacing * 0.8 * ((i % 2 === 0) ? 1 : -1);
        return {
          x: xPos,
          y: y + Math.sin(pi * 0.31 + pass * 1.7) * 0.006 + drift,
          pressure: cfg.pressure + Math.sin(pi * 0.47) * 0.01,
        };
      });
      strokes.push({
        points, brushSlot: cfg.brushSlot, brushSize: bs,
        hueIndex, meldrumIndex, thinners: cfg.thinners, load: cfg.load,
        useOil: false, useAnchor: false,
      });
    }
  }
  return strokes;
}

// Detect vertical features by contrast + aspect ratio.
// Finds tall, narrow features (poles, figure silhouettes) that the horizontal span
// system misses. Uses aspect ratio filtering to reject short/wide dark patches.
function detectVerticalStrokes(map: TonalMap): StrokeCommand[] {
  const strokes: StrokeCommand[] = [];
  const { cols, rows } = map;
  const cfg = LAYER_CONFIG.vertical;

  for (let col = 1; col < cols - 1; col++) {
    let r = 0;
    while (r < rows) {
      const cell = map.cells[r][col];
      const leftL = map.cells[r][col - 1].labL;
      const rightL = map.cells[r][col + 1].labL;
      const contrast = (leftL + rightL) / 2 - cell.labL;

      // Darker than at least one neighbor, or absolutely DARK
      const isFeature = cell.meldrumIndex >= DARK || contrast > 0.04;

      if (isFeature) {
        let end = r;
        while (end + 1 < rows) {
          const next = map.cells[end + 1][col];
          const nLeft = map.cells[end + 1][col - 1].labL;
          const nRight = map.cells[end + 1][col + 1].labL;
          const nContrast = (nLeft + nRight) / 2 - next.labL;
          if (next.meldrumIndex >= DARK || nContrast > 0.04) end++;
          else break;
        }

        const height = end - r + 1;

        // Measure average width of the dark region at this column
        let totalWidth = 0;
        for (let i = r; i <= end; i++) {
          let w = 1;
          for (let c = col - 1; c >= 0 && map.cells[i][c].meldrumIndex >= DARK; c--) w++;
          for (let c = col + 1; c < cols && map.cells[i][c].meldrumIndex >= DARK; c++) w++;
          totalWidth += w;
        }
        const avgWidth = totalWidth / height;

        // Aspect ratio filter: only tall-relative-to-width features
        const aspectRatio = height / avgWidth;
        const isThinPole = avgWidth <= 2 && height >= 4 && aspectRatio >= 2;
        const isFigure = avgWidth <= 8 && height >= 6 && aspectRatio >= 1.5;

        if (isThinPole || isFigure) {
          const x = (col + 0.5) / cols;
          const yStart = (r + 0.3) / rows;
          const yEnd = (end + 0.7) / rows;
          const nPts = Math.max(10, height * 3);
          const hueIdx = map.cells[r][col].assignedHueIndex;

          let maxMeldrum = 0;
          for (let i = r; i <= end; i++) {
            maxMeldrum = Math.max(maxMeldrum, map.cells[i][col].meldrumIndex);
          }
          const mIdx = Math.max(maxMeldrum, DARK);

          // Thin poles: Small brush, 3 passes. Wider features: Small brush, 3 passes.
          const brushSlot = cfg.brushSlot; // Small brush for all verticals
          const passCount = 3;

          for (let pass = 0; pass < passCount; pass++) {
            const xOff = (pass - 1) * (isThinPole ? 0.003 : 0.005);
            strokes.push({
              points: Array.from({ length: nPts }, (_, i) => ({
                x: x + xOff + Math.sin(i * 0.5 + col * 0.3 + pass) * 0.003,
                y: yStart + (i / (nPts - 1)) * (yEnd - yStart),
                pressure: cfg.pressure + Math.sin(i * 0.3) * 0.01,
              })),
              brushSlot,
              brushSize: BRUSH_SLOT_SIZES[brushSlot],
              hueIndex: hueIdx,
              meldrumIndex: mIdx,
              thinners: cfg.thinners,
              load: cfg.load,
              useOil: false,
              useAnchor: false,
            });
          }
        }
        r = end + 1;
      } else {
        r++;
      }
    }
  }
  return strokes;
}

export function assemblePlan(
  spans: Span[],
  map: TonalMap,
  luts: MeldrumLUT[],
): PaintingPlan {
  const { cols, rows, motherHueIndex } = map;
  const layers: { name: string; strokes: StrokeCommand[] }[] = [];

  // Compute mother meldrum: closest LUT match to motherTone, at least MID
  const motherLut = luts[motherHueIndex];
  let motherMeldrum = MID;
  let bestDist = Infinity;
  for (let i = 0; i < 5; i++) {
    const d = Math.abs(map.motherTone - motherLut.luminances[i]);
    if (d < bestDist) { bestDist = d; motherMeldrum = i; }
  }
  motherMeldrum = Math.max(motherMeldrum, MID);

  // Categorize spans
  const bgSpans = spans.filter(s => s.meldrumIndex < motherMeldrum && !s.isAccent);
  const midSpans = spans.filter(s => s.meldrumIndex === MID && !s.isAccent);
  const darkSpans = spans.filter(s => s.meldrumIndex === DARK && !s.isAccent);
  const blackSpans = spans.filter(s => s.meldrumIndex === BLACK && !s.isAccent);
  const accentSpans = spans.filter(s => s.isAccent);

  // Layer 1: Mother wash — 2 passes for moderate coverage
  const motherStrokes = fillStrokes(0.0, 1.0, 0.0, 1.0, LAYER_CONFIG.mother, motherHueIndex, motherMeldrum, 2);
  layers.push({ name: 'Mother', strokes: motherStrokes });

  // Layer 2: Background — tripled spans for sky/ground lightening
  const bgStrokes = bgSpans.flatMap(s => [
    spanToStroke(s, cols, rows, LAYER_CONFIG.background, false, false),
    spanToStroke({ ...s, row: s.row + 0.4 }, cols, rows, LAYER_CONFIG.background, false, false),
    spanToStroke({ ...s, row: s.row - 0.4 }, cols, rows, LAYER_CONFIG.background, false, false),
  ]);
  layers.push({ name: 'Background', strokes: budgetStrokes(bgStrokes, 450) });

  // Layer 3: Midtone — hue variation at mother value
  const midStrokes = midSpans.map(s => spanToStroke(s, cols, rows, LAYER_CONFIG.midtone, false, false));
  layers.push({ name: 'Midtone', strokes: budgetStrokes(midStrokes, 350) });

  // Layer 4: Dark forms — tripled horizontal spans for better Y coverage
  const darkStrokes = [
    ...darkSpans.flatMap(s => [
      spanToStroke(s, cols, rows, LAYER_CONFIG.dark, false, false),
      spanToStroke({ ...s, row: s.row + 0.3 }, cols, rows, LAYER_CONFIG.dark, false, false),
      spanToStroke({ ...s, row: s.row - 0.3 }, cols, rows, LAYER_CONFIG.dark, false, false),
    ]),
    ...blackSpans.flatMap(s => [
      spanToStroke(s, cols, rows, LAYER_CONFIG.darkBlack, false, false),
      spanToStroke({ ...s, row: s.row + 0.3 }, cols, rows, LAYER_CONFIG.darkBlack, false, false),
      spanToStroke({ ...s, row: s.row - 0.3 }, cols, rows, LAYER_CONFIG.darkBlack, false, false),
    ]),
  ];
  layers.push({ name: 'Dark forms', strokes: budgetStrokes(darkStrokes, 500) });

  // Layer 5: Vertical features — contrast-detected thin strokes (poles, figure edges)
  const verticalStrokes = detectVerticalStrokes(map);
  layers.push({ name: 'Verticals', strokes: budgetStrokes(verticalStrokes, 150) });

  // Layer 6: Accents (high chroma) — double-pass for prominence
  const accentStrokes = accentSpans.flatMap(s => [
    spanToStroke(s, cols, rows, LAYER_CONFIG.accent, true, true),
    spanToStroke(s, cols, rows, { ...LAYER_CONFIG.accent, pressure: 0.55, load: 0.55 }, true, true),
  ]);
  layers.push({ name: 'Accents', strokes: budgetStrokes(accentStrokes, 120) });

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

// --- Full pipeline (legacy span-based) ---

export function createPaintingPlanLegacy(
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
  return assemblePlan(spans, map, luts);
}

// --- Full pipeline (region-based, V3) ---

import { extractRegions, detectHorizon, computeRegionFeatures } from './region-analysis.js';
import { classifyAllHeuristic, classifyRegionHeuristic } from './region-classify-heuristic.js';
import { initClassifier, isClassifierReady, classifyRegionsBatch, getConfidenceThreshold } from './region-classify-ml.js';
import { extractPatch } from './region-patches.js';
import { assembleRegionPlan } from './region-strokes.js';

// Hierarchy imports
import { mapDepths } from './tissue-depth.js';
import { analyzeColors } from './tissue-color.js';
import { mapTones } from './tissue-tonal.js';
import { detectEdges } from './tissue-edges.js';
import { detectAccents } from './tissue-accent.js';
import { inferStrokeTypes } from './tissue-stroke-type.js';
import { classifyRecipes } from './tissue-recipe.js';
import { aggregateFeatures } from './features.js';
import { classifyComposition } from './organ-composition.js';
import { locateFocalPoint } from './organ-focal.js';
import { readAtmosphere } from './organ-atmosphere.js';
import { allocateBudget, allocateBudgetFromVector } from './organ-budget.js';
import { refineParameters, refineParametersFromVector } from './organism-params.js';
import { conductPainting, conductPaintingFromVector } from './organism-conductor.js';
import type { ConductorDecisions } from './types.js';
import { setRecipeParams } from './recipes.js';
import { assemblePlan as assembleHierarchyPlan } from './assembly.js';
import { initModel, isModelReady } from './onnx-registry.js';
import type { ModelName } from './onnx-registry.js';
import {
  inferStrokeTypesML, classifyRecipesML, classifyCompositionML,
  refineParametersML, conductPaintingML,
} from './ml-inference.js';

export async function createPaintingPlan(
  imageData: ImageData,
  paletteColors: KColor[],
  complement: ComplementConfig,
  gridCols = 40,
  gridRows = 30,
  fullResImageData?: ImageData,
): Promise<PaintingPlan> {
  // Steps 1-4: tonal analysis (unchanged)
  const map = analyzeTonalStructure(imageData, gridCols, gridRows);
  assignHuesToCells(map, paletteColors);
  const luts = buildMeldrumLUTs(paletteColors, complement);
  quantizeCells(map, luts);

  // Step 5: Connected component analysis
  const regions = extractRegions(map);
  const horizonRow = detectHorizon(map);

  // Step 6: Classification
  // Try ML first, fall back to heuristic
  let usedML = false;
  await initClassifier().catch(() => false);

  if (isClassifierReady() && fullResImageData) {
    try {
      const patches = regions.map(r => extractPatch(fullResImageData, r, gridCols, gridRows));
      const features = regions.map(r => computeRegionFeatures(r, gridCols, gridRows));
      const mlResults = await classifyRegionsBatch(patches, features);
      const threshold = getConfidenceThreshold();

      for (let i = 0; i < regions.length; i++) {
        if (mlResults[i].confidence >= threshold) {
          regions[i].classification = mlResults[i].classification;
          regions[i].confidence = mlResults[i].confidence;
        } else {
          // Low confidence — use heuristic for this region
          const features_i = computeRegionFeatures(regions[i], gridCols, gridRows);
          const result = classifyRegionHeuristic(regions[i], features_i, horizonRow, gridRows);
          regions[i].classification = result.classification;
          regions[i].confidence = result.confidence;
        }
      }
      usedML = true;
    } catch {
      // ML failed — fall through to heuristic
    }
  }

  if (!usedML) {
    classifyAllHeuristic(regions, horizonRow, gridRows);
  }

  // Step 7: Assemble region-based painting plan
  return assembleRegionPlan(regions, map, luts, map.motherHueIndex);
}

// --- Full pipeline (hierarchy-based) ---

export async function clariceHierarchy(
  imageData: ImageData,
  paletteColors: KColor[],
  complement: ComplementConfig,
  gridCols = 40,
  gridRows = 30,
  fullResImageData?: ImageData,
): Promise<PaintingPlan> {
  // Steps 1-4: tonal analysis (shared with legacy pipeline)
  const map = analyzeTonalStructure(imageData, gridCols, gridRows);
  assignHuesToCells(map, paletteColors);
  const luts = buildMeldrumLUTs(paletteColors, complement);
  quantizeCells(map, luts);

  // T1: Region Segmenter
  const regions = extractRegions(map);
  const horizonRow = detectHorizon(map);

  // Edge case: empty region list
  if (regions.length === 0) {
    return {
      layers: [{ name: 'Mother', strokes: [] }],
      metadata: {
        gridSize: [gridCols, gridRows],
        strokeCount: 0,
        motherHueIndex: map.motherHueIndex,
        hueAssignments: Array.from({ length: 5 }, (_, i) => ({ hueIndex: i, hue: 0 })),
      },
    };
  }

  // Init only T8 + T9 ML models (stroke type + shape recipe).
  // Everything else is algorithmic — ML for params/conductor/composition was unreliable.
  for (const name of ['stroke-type', 'shape-recipe'] as const) {
    await initModel(name as ModelName).catch(() => false);
  }

  // T2: Region Classifier — heuristic only (ML classifier needs full-res patches, unreliable)
  classifyAllHeuristic(regions, horizonRow, gridRows);

  // Edge case: all regions classified identically
  const uniqueClasses = new Set(regions.map(r => r.classification));

  // T3: Depth Mapper
  const depths = mapDepths(regions, horizonRow, gridRows);

  // T4: Color Analyzer
  const colors = analyzeColors(regions, map);

  // T5: Tonal Mapper (per-region)
  const tones = mapTones(regions, colors, luts);

  // T6: Edge Detector
  const edges = detectEdges(regions, map, depths, horizonRow);

  // T7: Accent Detector
  const accents = detectAccents(regions);

  // T8: Stroke Type Inferrer (ML — 82% accuracy)
  const strokeTypes = await inferStrokeTypesML(regions, depths, fullResImageData, gridCols, gridRows);

  // T9: Shape Recipe Classifier (ML — 95% accuracy)
  const recipes = await classifyRecipesML(regions, depths, map);

  // Feature Aggregation
  const sceneFeatures = aggregateFeatures(
    regions, depths, colors, accents, edges, horizonRow, gridRows,
  );

  // O1: Composition Reader — heuristic only
  const composition = uniqueClasses.size <= 1
    ? { class: 'abstract-masses' as const, confidence: 0.4 }
    : classifyComposition(sceneFeatures);

  // O2: Focal Point Locator
  const focalPoint = locateFocalPoint(accents, regions, colors);

  // O3: Atmosphere Density
  const fogDensity = readAtmosphere(sceneFeatures);

  // O4: Layer Budget
  const budget = allocateBudget(composition.class, regions.length);

  // SO1: Parameter Refinement — heuristic only (deterministic lookup tables)
  const refinedParams = refineParameters(regions, depths, colors, tones, focalPoint);

  // SO2: Painting Conductor — heuristic only (gardener-tuned defaults)
  const conductor = conductPainting(composition.class, focalPoint, fogDensity, budget, sceneFeatures);

  // Assembly
  return assembleHierarchyPlan(
    regions, map, luts, tones, colors, accents, recipes,
    refinedParams, edges, focalPoint, budget, conductor,
  );
}

/** Debug version — returns intermediate tissue/organ outputs alongside the plan.
 *  Optional conductorOverrides merges into the computed conductor decisions,
 *  enabling A/B comparison of different painting strategies. */
export async function clariceHierarchyDebug(
  imageData: ImageData,
  paletteColors: KColor[],
  complement: ComplementConfig,
  gridCols = 40,
  gridRows = 30,
  _fullResImageData?: ImageData,
  conductorOverrides?: Partial<ConductorDecisions>,
) {
  const map = analyzeTonalStructure(imageData, gridCols, gridRows);
  assignHuesToCells(map, paletteColors);
  const luts = buildMeldrumLUTs(paletteColors, complement);
  quantizeCells(map, luts);

  const regions = extractRegions(map);
  const horizonRow = detectHorizon(map);

  if (regions.length === 0) {
    return { plan: { layers: [{ name: 'Mother', strokes: [] }], metadata: { gridSize: [gridCols, gridRows], strokeCount: 0, motherHueIndex: map.motherHueIndex, hueAssignments: [] } }, tissues: {}, organs: {}, organism: {} };
  }

  classifyAllHeuristic(regions, horizonRow, gridRows);

  const depths = mapDepths(regions, horizonRow, gridRows);
  const colors = analyzeColors(regions, map);
  const tones = mapTones(regions, colors, luts);
  const edges = detectEdges(regions, map, depths, horizonRow);
  const accents = detectAccents(regions);
  const strokeTypes = inferStrokeTypes(regions, depths);
  const recipes = classifyRecipes(regions, depths);
  const sceneFeatures = aggregateFeatures(regions, depths, colors, accents, edges, horizonRow, gridRows);
  const composition = classifyComposition(sceneFeatures);
  const focalPoint = locateFocalPoint(accents, regions, colors);
  const fogDensity = readAtmosphere(sceneFeatures);
  const budget = allocateBudget(composition.class, regions.length);
  const refinedParams = refineParameters(regions, depths, colors, tones, focalPoint);
  let conductor = conductPainting(composition.class, focalPoint, fogDensity, budget, sceneFeatures);
  if (conductorOverrides) {
    conductor = { ...conductor, ...conductorOverrides };
  }

  const plan = assembleHierarchyPlan(
    regions, map, luts, tones, colors, accents, recipes,
    refinedParams, edges, focalPoint, budget, conductor,
  );

  return {
    plan,
    tissues: {
      depths: Object.fromEntries(depths),
      colors: Object.fromEntries(colors),
      tones: Object.fromEntries(tones),
      edges,
      accents: Object.fromEntries(accents),
      strokeTypes: Object.fromEntries(strokeTypes),
      recipes: Object.fromEntries(recipes),
    },
    organs: {
      composition,
      focalPoint,
      fogDensity,
      budget,
    },
    organism: {
      conductor,
      sceneFeatures,
    },
    mlStatus: {
      'region-classifier': isModelReady('region-classifier'),
      'stroke-type': isModelReady('stroke-type'),
      'shape-recipe': isModelReady('shape-recipe'),
      'composition': isModelReady('composition'),
      'param-refinement': isModelReady('param-refinement'),
      'painting-conductor': isModelReady('painting-conductor'),
    },
  };
}

// --- Full pipeline (CMA-ES vector-driven) ---

/** Vector-parameterized pipeline for CMA-ES optimization.
 *  Takes a 47-element parameter vector that controls all tunable constants.
 *  Groups: A(0-6) conductor, B(7-10) composition modifiers, C(11-16) brush params,
 *  D(17-21) layer budgets, E(22-24) global painting, F(25-46) recipe tuning. */
export async function clariceHierarchyWithParams(
  imageData: ImageData,
  paletteColors: KColor[],
  complement: ComplementConfig,
  paramVector: number[],
  gridCols = 80,
  gridRows = 60,
): Promise<PaintingPlan> {
  // Steps 1-4: tonal analysis (shared)
  const map = analyzeTonalStructure(imageData, gridCols, gridRows);
  assignHuesToCells(map, paletteColors);
  const luts = buildMeldrumLUTs(paletteColors, complement);
  quantizeCells(map, luts);

  // T1: Region Segmenter
  const regions = extractRegions(map);
  const horizonRow = detectHorizon(map);

  if (regions.length === 0) {
    return {
      layers: [{ name: 'Mother', strokes: [] }],
      metadata: {
        gridSize: [gridCols, gridRows],
        strokeCount: 0,
        motherHueIndex: map.motherHueIndex,
        hueAssignments: Array.from({ length: 5 }, (_, i) => ({ hueIndex: i, hue: 0 })),
      },
    };
  }

  // T2: Region Classifier — heuristic only
  classifyAllHeuristic(regions, horizonRow, gridRows);

  // T3-T7: Tissue analysis (same as standard pipeline)
  const depths = mapDepths(regions, horizonRow, gridRows);
  const colors = analyzeColors(regions, map);
  const tones = mapTones(regions, colors, luts);
  const edges = detectEdges(regions, map, depths, horizonRow);
  const accents = detectAccents(regions);

  // T8-T9: Stroke types and recipes (heuristic — no ML models needed)
  const _strokeTypes = inferStrokeTypes(regions, depths);
  const recipes = classifyRecipes(regions, depths);

  // Feature aggregation
  const sceneFeatures = aggregateFeatures(
    regions, depths, colors, accents, edges, horizonRow, gridRows,
  );

  // O2: Focal Point
  const focalPoint = locateFocalPoint(accents, regions, colors);

  // O3: Atmosphere Density
  const fogDensity = readAtmosphere(sceneFeatures);

  // Apply Group F (recipe tuning params, indices 25-46)
  setRecipeParams({
    wash_spacing_mult: paramVector[25],
    wash_passes: Math.round(paramVector[26]),
    tree_wash_load: paramVector[27],
    tree_mel_shift: Math.round(paramVector[28]),
    tree_dab_count_scale: paramVector[29],
    building_load_mult: paramVector[30],
    pole_load_mult: paramVector[31],
    trunk_curve: paramVector[32],
    trunk_branch_prob: paramVector[33],
    figure_load_mult: paramVector[34],
    figure_passes: Math.round(paramVector[35]),
    umbrella_spoke_count: Math.round(paramVector[36]),
    boat_hull_length: paramVector[37],
    boat_mast_height: paramVector[38],
    reflection_opacity: paramVector[39],
    reflection_smear: paramVector[40],
    lightdot_size: paramVector[41],
    lightdot_brightness: Math.round(paramVector[42]),
    wave_spacing: paramVector[43],
    wave_load: paramVector[44],
    headland_edge_rough: paramVector[45],
    mass_mel_shift: Math.round(paramVector[46]),
  });

  // SO2: Conductor from vector (Groups A+B, indices 0-10)
  const { conductor } = conductPaintingFromVector(fogDensity, paramVector);

  // SO1: Parameter refinement from vector (Group C, indices 11-16)
  const refinedParams = refineParametersFromVector(
    regions, depths, colors, tones, focalPoint, paramVector,
  );

  // O4: Budget from vector (Groups D+E, indices 17-24)
  const budget = allocateBudgetFromVector(regions.length, paramVector);

  // Assembly
  return assembleHierarchyPlan(
    regions, map, luts, tones, colors, accents, recipes,
    refinedParams, edges, focalPoint, budget, conductor,
  );
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
