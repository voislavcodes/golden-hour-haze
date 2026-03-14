// Region Stroke Generators — per-classification stroke generation
// Each region class has a specific generator that produces physically appropriate marks.
// Strokes use normalized 0-1 coordinates mapping to the full artboard.

import type { Region, RegionClass } from './region-analysis.js';
import type { TonalMap, MeldrumLUT, StrokeCommand, PaintingPlan } from './tonal-recreation.js';
import { BRUSH_SLOT_SIZES } from '../palette.js';

// --- Constants ---

const MID = 2, DARK = 3;

// Layer ordering: mother → sky/ground → horizon → masses → fill → verticals → accents → reflections
const LAYER_ORDER: RegionClass[] = ['sky', 'ground', 'horizon', 'mass', 'fill', 'vertical', 'accent', 'reflection'];

// Per-class brush config
const CLASS_CONFIG: Record<RegionClass, {
  brushSlot: number;
  pressure: number;
  thinners: number;
  load: number;
}> = {
  sky:        { brushSlot: 4, pressure: 0.45, thinners: 0.08, load: 0.55 },
  ground:     { brushSlot: 3, pressure: 0.55, thinners: 0.02, load: 0.65 },
  horizon:    { brushSlot: 3, pressure: 0.50, thinners: 0.04, load: 0.60 },
  mass:       { brushSlot: 2, pressure: 0.60, thinners: 0.01, load: 0.75 },
  vertical:   { brushSlot: 1, pressure: 0.60, thinners: 0.00, load: 0.80 },
  accent:     { brushSlot: 1, pressure: 0.65, thinners: 0.00, load: 0.65 },
  reflection: { brushSlot: 2, pressure: 0.45, thinners: 0.06, load: 0.50 },
  fill:       { brushSlot: 3, pressure: 0.50, thinners: 0.03, load: 0.60 },
};

// Seeded LCG for deterministic per-region randomness
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// --- Helpers ---

/** Convert region bbox to normalized 0-1 coordinates */
function regionBounds(region: Region, cols: number, rows: number) {
  const { x0, y0, x1, y1 } = region.boundingBox;
  return {
    xStart: x0 / cols,
    yStart: y0 / rows,
    xEnd: (x1 + 1) / cols,
    yEnd: (y1 + 1) / rows,
  };
}

function makeStroke(
  points: { x: number; y: number; pressure: number }[],
  region: Region,
  cfg: typeof CLASS_CONFIG[RegionClass],
  overrides?: Partial<StrokeCommand>,
): StrokeCommand {
  return {
    points,
    brushSlot: cfg.brushSlot,
    brushSize: BRUSH_SLOT_SIZES[cfg.brushSlot],
    hueIndex: region.hueIndex,
    meldrumIndex: region.meldrumIndex,
    thinners: cfg.thinners,
    load: cfg.load,
    useOil: false,
    useAnchor: false,
    ...overrides,
  };
}

// --- Stroke generators ---

/**
 * Dense horizontal sweeps filling the region bbox.
 * Strokes span full width of bbox, spaced by brush diameter.
 */
function horizontalWash(
  region: Region,
  map: TonalMap,
  cfg: typeof CLASS_CONFIG[RegionClass],
  passes: number,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, map.cols, map.rows);
  const strokes: StrokeCommand[] = [];
  const bs = BRUSH_SLOT_SIZES[cfg.brushSlot];
  // Tight spacing — 15% of brush size gives ~85% overlap per row,
  // matching the legacy fillStrokes that produced complete coverage
  const spacing = bs * 0.15;
  const strokeWidth = xEnd - xStart;
  const nPts = Math.max(30, Math.round(strokeWidth * 80));

  for (let pass = 0; pass < passes; pass++) {
    // Half-spacing offset between passes for perfect interleave
    const off = pass * spacing * 0.5;
    const rowCount = Math.max(1, Math.ceil((yEnd - yStart) / spacing));
    for (let i = 0; i < rowCount; i++) {
      const y = yStart + i * spacing + off;
      if (y > yEnd) break;
      const reverse = (i + pass) % 2 === 1;
      const points = Array.from({ length: nPts }, (_, pi) => {
        const t = pi / (nPts - 1);
        const xPos = reverse ? (xEnd - t * strokeWidth) : (xStart + t * strokeWidth);
        // Aggressive crosshatch drift — alternating diagonals fill row gaps
        const drift = (t - 0.5) * spacing * 0.8 * ((i % 2 === 0) ? 1 : -1);
        return {
          x: xPos,
          y: y + Math.sin(pi * 0.31 + pass * 1.7) * 0.006 + drift,
          pressure: cfg.pressure + Math.sin(pi * 0.47) * 0.01,
        };
      });
      strokes.push(makeStroke(points, region, cfg));
    }
  }
  return strokes;
}

/**
 * Narrow horizontal strokes at the horizon height.
 */
function horizontalBand(
  region: Region,
  map: TonalMap,
  cfg: typeof CLASS_CONFIG[RegionClass],
): StrokeCommand[] {
  const { xStart, xEnd } = regionBounds(region, map.cols, map.rows);
  const strokes: StrokeCommand[] = [];
  const bs = BRUSH_SLOT_SIZES[cfg.brushSlot];
  const y = region.centroid.y;
  const nPts = Math.max(30, Math.round((xEnd - xStart) * 100));

  for (let pass = 0; pass < 3; pass++) {
    const yOff = (pass - 1) * bs * 0.4;
    const reverse = pass % 2 === 1;
    const points = Array.from({ length: nPts }, (_, pi) => {
      const t = pi / (nPts - 1);
      return {
        x: reverse ? (xEnd - t * (xEnd - xStart)) : (xStart + t * (xEnd - xStart)),
        y: y + yOff + Math.sin(pi * 0.4) * 0.003,
        pressure: cfg.pressure + Math.sin(pi * 0.3) * 0.008,
      };
    });
    strokes.push(makeStroke(points, region, cfg));
  }
  return strokes;
}

/**
 * Short overlapping dabs filling a mass region.
 * Random placement within bbox, length proportional to brush size.
 */
function clusteredDabs(
  region: Region,
  map: TonalMap,
  cfg: typeof CLASS_CONFIG[RegionClass],
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, map.cols, map.rows);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 7919 + 31);
  const bs = BRUSH_SLOT_SIZES[cfg.brushSlot];
  const regionW = xEnd - xStart;
  const regionH = yEnd - yStart;

  // Dense overlapping marks filling the mass — horizontal bias like Beckett
  const areaCells = region.cells.length;
  const dabCount = Math.max(8, Math.round(areaCells * 1.5));

  for (let d = 0; d < dabCount; d++) {
    const cx = xStart + rand() * regionW;
    const cy = yStart + rand() * regionH;
    // Wider marks (2-5× brush), mostly horizontal (±18°) — tonalist masses
    // are built with overlapping horizontal bands, not random dabs
    const len = bs * (2.0 + rand() * 3.0);
    const angle = (rand() - 0.5) * Math.PI * 0.25;
    const nPts = Math.max(10, Math.round(len * 100));

    const points = Array.from({ length: nPts }, (_, pi) => {
      const t = pi / (nPts - 1);
      return {
        x: cx + Math.cos(angle) * len * (t - 0.5),
        y: cy + Math.sin(angle) * len * (t - 0.5),
        pressure: cfg.pressure * (1 - 0.3 * Math.pow(Math.abs(t - 0.5) * 2, 1.5)),
      };
    });
    strokes.push(makeStroke(points, region, cfg));
  }
  return strokes;
}

/**
 * Top-to-bottom vertical strokes for poles, figures, posts.
 * Multi-pass across the region width, pressure taper at ends.
 */
function verticalStrokes(
  region: Region,
  map: TonalMap,
  cfg: typeof CLASS_CONFIG[RegionClass],
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, map.cols, map.rows);
  const strokes: StrokeCommand[] = [];
  const bs = BRUSH_SLOT_SIZES[cfg.brushSlot];
  const strokeH = yEnd - yStart;
  const nPts = Math.max(15, Math.round(strokeH * 100));
  const bboxW = region.boundingBox.x1 - region.boundingBox.x0 + 1;

  // Multi-pass: 3 minimum, more for wider features
  const passCount = Math.max(3, Math.min(8, bboxW * 2));

  for (let pass = 0; pass < passCount; pass++) {
    const xFrac = passCount > 1 ? pass / (passCount - 1) : 0.5;
    const x = xStart + xFrac * (xEnd - xStart);

    const points = Array.from({ length: nPts }, (_, pi) => {
      const t = pi / (nPts - 1);
      // Pressure taper at top and bottom
      const taper = 1 - Math.pow(2 * Math.abs(t - 0.5), 2) * 0.4;
      return {
        x: x + Math.sin(pi * 0.5 + pass) * 0.002,
        y: yStart + t * strokeH,
        pressure: cfg.pressure * taper,
      };
    });
    strokes.push(makeStroke(points, region, cfg, {
      meldrumIndex: Math.max(region.meldrumIndex, DARK),
    }));
  }
  return strokes;
}

/**
 * 2-5 short precise dabs for accent marks (tram, lights).
 * Uses oil + anchor for vivid color.
 */
function dabCluster(
  region: Region,
  _map: TonalMap,
  cfg: typeof CLASS_CONFIG[RegionClass],
): StrokeCommand[] {
  const cx = region.centroid.x;
  const cy = region.centroid.y;
  const strokes: StrokeCommand[] = [];
  const bs = BRUSH_SLOT_SIZES[cfg.brushSlot];
  const rand = lcg(region.id * 3571 + 17);

  // 2-5 short precise marks
  const count = Math.max(2, Math.min(5, Math.round(region.cells.length * 0.5)));

  for (let d = 0; d < count; d++) {
    const ox = (rand() - 0.5) * 0.04;
    const oy = (rand() - 0.5) * 0.03;
    const len = bs * (0.8 + rand() * 1.2);
    const angle = (rand() - 0.5) * Math.PI * 0.8;
    const nPts = 12;

    const points = Array.from({ length: nPts }, (_, pi) => {
      const t = pi / (nPts - 1);
      return {
        x: cx + ox + Math.cos(angle) * len * (t - 0.5),
        y: cy + oy + Math.sin(angle) * len * (t - 0.5),
        pressure: cfg.pressure * (1 - 0.2 * Math.abs(t - 0.5) * 2),
      };
    });
    strokes.push(makeStroke(points, region, cfg, {
      useOil: true,
      useAnchor: true,
    }));
  }
  return strokes;
}

/**
 * Soft vertical strokes with sinusoidal wobble for reflections on wet surfaces.
 * Lighter pressure, more thinners than verticalStrokes.
 */
function verticalSoft(
  region: Region,
  map: TonalMap,
  cfg: typeof CLASS_CONFIG[RegionClass],
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, map.cols, map.rows);
  const strokes: StrokeCommand[] = [];
  const bs = BRUSH_SLOT_SIZES[cfg.brushSlot];
  const rand = lcg(region.id * 4523 + 11);
  const strokeH = yEnd - yStart;
  const nPts = Math.max(15, Math.round(strokeH * 80));
  const bboxW = region.boundingBox.x1 - region.boundingBox.x0 + 1;
  const passCount = Math.max(3, Math.min(6, bboxW * 2));

  for (let pass = 0; pass < passCount; pass++) {
    const xFrac = passCount > 1 ? pass / (passCount - 1) : 0.5;
    const x = xStart + xFrac * (xEnd - xStart);
    const wobbleFreq = 2 + rand() * 3;
    const wobbleAmp = 0.004 + rand() * 0.008;

    const points = Array.from({ length: nPts }, (_, pi) => {
      const t = pi / (nPts - 1);
      return {
        x: x + Math.sin(t * wobbleFreq * Math.PI) * wobbleAmp,
        y: yStart + t * strokeH,
        pressure: (cfg.pressure - 0.05) * (1 - 0.3 * Math.abs(t - 0.5) * 2),
      };
    });
    strokes.push(makeStroke(points, region, cfg, {
      thinners: cfg.thinners + 0.03,
      load: Math.max(0.3, cfg.load - 0.1),
    }));
  }
  return strokes;
}

// --- Dispatch ---

function generateForRegion(region: Region, map: TonalMap): StrokeCommand[] {
  const cfg = CLASS_CONFIG[region.classification];
  const adjustedCfg = { ...cfg };

  // --- Tone-aware parameter scaling ---
  // Tonalist principle: the mother wash IS the painting's key value.
  // Light areas aren't painted light — they're where the mother shows through.
  // Dark areas are built up with committed, opaque marks.
  if (region.meldrumIndex < MID) {
    // WHITE/LIGHT — barely visible glazes, let mother dominate
    adjustedCfg.thinners = Math.min(1.0, cfg.thinners + 0.10);
    adjustedCfg.load = Math.max(0.15, cfg.load - 0.30);
    adjustedCfg.pressure = Math.max(0.20, cfg.pressure - 0.20);
  } else if (region.meldrumIndex > MID) {
    // DARK/BLACK — full commitment, build up opacity
    adjustedCfg.load = Math.min(1.0, cfg.load + 0.15);
    adjustedCfg.pressure = Math.min(0.85, cfg.pressure + 0.10);
    adjustedCfg.thinners = Math.max(0, cfg.thinners - 0.02);
  }

  // --- Atmospheric perspective ---
  // Above horizon: additional thinners + larger brush for soft distance
  if (region.centroid.y < 0.4) {
    adjustedCfg.thinners = Math.min(1.0, adjustedCfg.thinners + 0.02);
    adjustedCfg.brushSlot = Math.min(4, cfg.brushSlot + 1);
  }

  // --- Tonalist layering principle ---
  // The mother wash establishes the mid-tone key for the entire painting.
  // Only DARKER regions get additional paint — building contrast from the mother.
  // Lighter/equal regions are left alone: their luminance comes from the mother
  // showing through, not from depositing lighter pigment (which creates patches
  // when different hues have different K-M luminances at the same meldrum step).
  // Exception: accents always paint (vivid color marks).
  if (region.meldrumIndex <= MID && region.classification !== 'accent') {
    return [];
  }

  // Dark regions get 3 passes for full opacity buildup
  const washPasses = 3;

  switch (region.classification) {
    case 'sky':        return horizontalWash(region, map, adjustedCfg, washPasses);
    case 'ground':     return horizontalWash(region, map, adjustedCfg, washPasses);
    case 'horizon':    return horizontalBand(region, map, adjustedCfg);
    case 'mass':       return clusteredDabs(region, map, adjustedCfg);
    case 'vertical':   return verticalStrokes(region, map, adjustedCfg);
    case 'accent':     return dabCluster(region, map, adjustedCfg);
    case 'reflection': return verticalSoft(region, map, adjustedCfg);
    case 'fill':       return horizontalWash(region, map, adjustedCfg, washPasses);
  }
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

// --- Public API ---

export function generateRegionStrokes(region: Region, map: TonalMap): StrokeCommand[] {
  return generateForRegion(region, map);
}

export function assembleRegionPlan(
  regions: Region[],
  map: TonalMap,
  luts: MeldrumLUT[],
  motherHueIndex: number,
): PaintingPlan {
  const { cols, rows } = map;
  const layers: { name: string; strokes: StrokeCommand[] }[] = [];

  // Layer 0: Mother wash — full canvas
  const motherMeldrum = computeMotherMeldrum(map, luts, motherHueIndex);
  const motherStrokes = generateMotherWash(motherHueIndex, motherMeldrum);
  layers.push({ name: 'Mother', strokes: motherStrokes });

  // Group regions by classification, respecting layer order
  for (const cls of LAYER_ORDER) {
    const clsRegions = regions.filter(r => r.classification === cls);
    if (clsRegions.length === 0) continue;

    const layerStrokes = clsRegions.flatMap(r => generateRegionStrokes(r, map));
    if (layerStrokes.length === 0) continue;

    const layerName = cls.charAt(0).toUpperCase() + cls.slice(1);
    layers.push({ name: layerName, strokes: layerStrokes });
  }

  // Enforce total budget ~1500
  const TOTAL_BUDGET = 1500;
  let totalStrokes = layers.reduce((sum, l) => sum + l.strokes.length, 0);
  if (totalStrokes > TOTAL_BUDGET) {
    const scale = TOTAL_BUDGET / totalStrokes;
    for (const layer of layers) {
      if (layer.name === 'Mother') continue;
      const target = Math.max(1, Math.round(layer.strokes.length * scale));
      layer.strokes = budgetStrokes(layer.strokes, target);
    }
    totalStrokes = layers.reduce((sum, l) => sum + l.strokes.length, 0);
  }

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

  return {
    layers,
    metadata: {
      gridSize: [cols, rows],
      strokeCount: totalStrokes,
      motherHueIndex,
      hueAssignments,
    },
  };
}

// --- Helpers ---

function computeMotherMeldrum(map: TonalMap, luts: MeldrumLUT[], motherHueIndex: number): number {
  const motherLut = luts[motherHueIndex];
  let motherMeldrum = 2;
  let bestDist = Infinity;
  for (let i = 0; i < 5; i++) {
    const d = Math.abs(map.motherTone - motherLut.luminances[i]);
    if (d < bestDist) { bestDist = d; motherMeldrum = i; }
  }
  return Math.max(motherMeldrum, MID);
}

function generateMotherWash(
  hueIndex: number,
  meldrumIndex: number,
): StrokeCommand[] {
  const bs = BRUSH_SLOT_SIZES[4]; // wash brush
  // Match legacy fillStrokes spacing — 15% of brush for complete coverage
  const spacing = bs * 0.15;
  const strokes: StrokeCommand[] = [];
  const nPts = 60;

  for (let pass = 0; pass < 2; pass++) {
    const off = pass * spacing * 0.5;
    const rowCount = Math.ceil(1.0 / spacing);
    for (let i = 0; i < rowCount; i++) {
      const y = i * spacing + off;
      if (y > 1.0) break;
      const reverse = (i + pass) % 2 === 1;
      const points = Array.from({ length: nPts }, (_, pi) => {
        const t = pi / (nPts - 1);
        const drift = (t - 0.5) * spacing * 0.8 * ((i % 2 === 0) ? 1 : -1);
        return {
          x: reverse ? (1.0 - t) : t,
          y: y + Math.sin(pi * 0.31 + pass * 1.7) * 0.006 + drift,
          pressure: 0.45 + Math.sin(pi * 0.47) * 0.01,
        };
      });
      strokes.push({
        points,
        brushSlot: 4,
        brushSize: bs,
        hueIndex,
        meldrumIndex,
        thinners: 0.08,
        load: 0.55,
        useOil: false,
        useAnchor: false,
      });
    }
  }
  return strokes;
}
