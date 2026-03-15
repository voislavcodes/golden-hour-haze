// 18 Beckett construction recipes — deterministic stroke generation functions
// Each recipe produces StrokeCommand[] from region geometry + refined params + tissue context.
// CMA-ES optimizes recipe-internal constants via setRecipeParams().

import type { Region } from './region-analysis.js';
import type { StrokeCommand } from './tonal-recreation.js';
import type { RecipeClass, RefinedParams, TissueContext } from './types.js';

// --- Module-level recipe params (Group F from CMA-ES vector) ---

// CMA-ES tuned (gen 10, score 0.44): tighter wash spacing, heavier loads,
// more branches, stronger reflections, near-zero mass lightening.
let _recipeParams = {
  wash_spacing_mult: 0.10,
  wash_passes: 2,
  tree_wash_load: 0.33,
  tree_mel_shift: 3,
  tree_dab_count_scale: 1.13,
  building_load_mult: 0.92,
  pole_load_mult: 0.70,
  trunk_curve: 0.010,
  trunk_branch_prob: 0.50,
  figure_load_mult: 0.90,
  figure_passes: 4,
  umbrella_spoke_count: 6,
  boat_hull_length: 0.025,
  boat_mast_height: 0.047,
  reflection_opacity: 0.40,
  reflection_smear: 1.94,
  lightdot_size: 0.005,
  lightdot_brightness: 1,
  wave_spacing: 0.027,
  wave_load: 0.64,
  headland_edge_rough: 0.029,
  mass_mel_shift: 0,
};

export function setRecipeParams(params: Partial<typeof _recipeParams>) {
  _recipeParams = { ..._recipeParams, ...params };
}

export function getRecipeParams() {
  return _recipeParams;
}

// --- Seeded LCG for deterministic per-region randomness ---

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// --- Stroke primitives ---

function makeStroke(
  points: { x: number; y: number; pressure: number }[],
  params: RefinedParams,
  ctx: TissueContext,
  overrides?: Partial<StrokeCommand>,
): StrokeCommand {
  return {
    points,
    brushSlot: params.brushSlot,
    brushSize: params.brushSize,
    hueIndex: ctx.hueIndex,
    meldrumIndex: ctx.meldrumIndex,
    thinners: params.thinners,
    load: params.load,
    useOil: ctx.useOil,
    useAnchor: ctx.useAnchor,
    ...overrides,
  };
}

/** Horizontal stroke(s) at y, from x0 to x1 */
function H(
  y: number, x0: number, x1: number, pressure: number,
  params: RefinedParams, ctx: TissueContext,
  count = 1, n = 60,
): StrokeCommand[] {
  const strokes: StrokeCommand[] = [];
  const bs = params.brushSize;
  for (let c = 0; c < count; c++) {
    const yOff = (c - (count - 1) / 2) * bs * 0.3;
    const points = Array.from({ length: n }, (_, i) => ({
      x: x0 + (i / (n - 1)) * (x1 - x0),
      y: y + yOff + Math.sin(i * 0.31) * 0.002,
      pressure: pressure + Math.sin(i * 0.47) * 0.008,
    }));
    strokes.push(makeStroke(points, params, ctx));
  }
  return strokes;
}

/** Vertical stroke(s) at x, from y0 to y1 */
function V(
  x: number, y0: number, y1: number, pressure: number,
  params: RefinedParams, ctx: TissueContext,
  count = 1, n = 35,
): StrokeCommand[] {
  const strokes: StrokeCommand[] = [];
  const bs = params.brushSize;
  for (let c = 0; c < count; c++) {
    const xOff = (c - (count - 1) / 2) * bs * 0.4;
    const points = Array.from({ length: n }, (_, i) => ({
      x: x + xOff + Math.sin(i * 0.37) * 0.001,
      y: y0 + (i / (n - 1)) * (y1 - y0),
      pressure: pressure + Math.sin(i * 0.53) * 0.008,
    }));
    strokes.push(makeStroke(points, params, ctx));
  }
  return strokes;
}

/** Vertical with pressure taper */
function taperV(
  x: number, y0: number, y1: number,
  pStart: number, pEnd: number,
  params: RefinedParams, ctx: TissueContext,
  n = 25,
): StrokeCommand {
  const points = Array.from({ length: n }, (_, i) => ({
    x: x + Math.sin(i * 0.29) * 0.0008,
    y: y0 + (i / (n - 1)) * (y1 - y0),
    pressure: pStart + (pEnd - pStart) * (i / (n - 1)),
  }));
  return makeStroke(points, params, ctx);
}

/** Arc stroke — points along circular arc */
function arc(
  cx: number, cy: number, radius: number,
  startAngle: number, endAngle: number, pressure: number,
  params: RefinedParams, ctx: TissueContext,
  n = 20,
): StrokeCommand {
  const points = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const angle = startAngle + t * (endAngle - startAngle);
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      pressure: pressure * (1 - 0.15 * Math.abs(t - 0.5) * 2),
    };
  });
  return makeStroke(points, params, ctx);
}

/** Short stroke/dab at position */
function dab(
  x: number, y: number, length: number, angle: number, pressure: number,
  params: RefinedParams, ctx: TissueContext,
  n = 12,
): StrokeCommand {
  const points = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return {
      x: x + Math.cos(angle) * length * (t - 0.5),
      y: y + Math.sin(angle) * length * (t - 0.5),
      pressure: pressure * (1 - 0.2 * Math.abs(t - 0.5) * 2),
    };
  });
  return makeStroke(points, params, ctx);
}

// --- Region bounds helper ---

function regionBounds(region: Region, cols: number, rows: number, bleed = 0) {
  const { x0, y0, x1, y1 } = region.boundingBox;
  const bw = (x1 - x0 + 1) / cols;
  const bh = (y1 - y0 + 1) / rows;
  const bleedX = bw * bleed * 0.3;
  const bleedY = bh * bleed * 0.3;
  return {
    xStart: Math.max(0, x0 / cols - bleedX),
    yStart: Math.max(0, y0 / rows - bleedY),
    xEnd: Math.min(1, (x1 + 1) / cols + bleedX),
    yEnd: Math.min(1, (y1 + 1) / rows + bleedY),
    cols, rows,
  };
}

// --- Existing recipes (updated to read from _recipeParams) ---

function paintAtmosphericWash(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const bs = params.brushSize;
  const spacing = bs * _recipeParams.wash_spacing_mult;
  const nPts = Math.max(30, Math.round((xEnd - xStart) * 80));
  const passes = Math.round(_recipeParams.wash_passes);

  for (let pass = 0; pass < passes; pass++) {
    const off = pass * spacing * 0.5;
    const rowCount = Math.max(1, Math.ceil((yEnd - yStart) / spacing));
    for (let i = 0; i < rowCount; i++) {
      const y = yStart + i * spacing + off;
      if (y > yEnd) break;
      const reverse = (i + pass) % 2 === 1;
      const points = Array.from({ length: nPts }, (_, pi) => {
        const t = pi / (nPts - 1);
        const drift = (t - 0.5) * spacing * 0.8 * ((i % 2 === 0) ? 1 : -1);
        return {
          x: reverse ? (xEnd - t * (xEnd - xStart)) : (xStart + t * (xEnd - xStart)),
          y: y + Math.sin(pi * 0.31 + pass * 1.7) * 0.006 + drift,
          pressure: params.pressure + Math.sin(pi * 0.47) * 0.01,
        };
      });
      strokes.push(makeStroke(points, params, ctx));
    }
  }
  return strokes;
}

function paintPoleSimple(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const cx = (xStart + xEnd) / 2;

  const thin = {
    ...params,
    load: params.load * _recipeParams.pole_load_mult,
    thinners: Math.min(0.4, params.thinners + 0.05),
  };
  strokes.push(...V(
    cx, yStart, yEnd,
    thin.pressure, thin, ctx, 1,
    Math.max(10, Math.round((yEnd - yStart) * 40)),
  ));

  return strokes;
}

function paintPoleCrossbar(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes = paintPoleSimple(region, params, ctx, cols, rows, bleed);
  const crossY = yStart + (yEnd - yStart) * 0.3;
  const crossExtent = (xEnd - xStart) * 2;
  const cx = (xStart + xEnd) / 2;
  strokes.push(...H(
    crossY, cx - crossExtent / 2, cx + crossExtent / 2,
    params.pressure * 0.8, params, ctx, 1, 15,
  ));
  return strokes;
}

function paintTreeRounded(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 3571);
  const cx = (xStart + xEnd) / 2;
  const cy = (yStart + yEnd) / 2;
  const rx = (xEnd - xStart) / 2;
  const ry = (yEnd - yStart) / 2;

  const treeParams = { ...params, load: Math.min(0.35, params.load), thinners: Math.max(0.20, params.thinners) };
  const dabCount = Math.min(8, Math.max(4,
    Math.round(Math.sqrt(region.cells.length) * _recipeParams.tree_dab_count_scale)));
  for (let d = 0; d < dabCount; d++) {
    const ox = (rand() + rand() - 1) * rx * 1.1;
    const oy = (rand() + rand() - 1) * ry * 0.8 - ry * 0.2;
    const len = treeParams.brushSize * (2 + rand() * 3);
    const angle = (rand() - 0.5) * Math.PI * 0.5;
    strokes.push(dab(cx + ox, cy + oy, len, angle, treeParams.pressure, treeParams, ctx));
  }

  return strokes;
}

function paintFoliageMass(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  // Tonal wash — tree shape emerges from boundary, not drawn edges
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 4523);

  const melShift = Math.round(_recipeParams.tree_mel_shift);
  const lightCtx = { ...ctx, meldrumIndex: Math.max(0, ctx.meldrumIndex - melShift) };
  const washParams = {
    ...params,
    load: _recipeParams.tree_wash_load,
    thinners: 0.40,
    pressure: 0.22,
    brushSize: 0.20,
    brushSlot: 4,
  };
  const bs = 0.20;
  const spacing = bs * 1.2;
  const h = yEnd - yStart;
  const nPts = Math.max(20, Math.round((xEnd - xStart) * 60));

  const rowCount = Math.min(6, Math.max(1, Math.ceil(h / spacing)));
  for (let i = 0; i < rowCount; i++) {
    const y = yStart + i * spacing;
    if (y > yEnd) break;
    const reverse = i % 2 === 1;
    const points = Array.from({ length: nPts }, (_, pi) => {
      const t = pi / (nPts - 1);
      return {
        x: reverse ? (xEnd - t * (xEnd - xStart)) : (xStart + t * (xEnd - xStart)),
        y: y + Math.sin(pi * 0.31) * 0.008 + (rand() - 0.5) * 0.003,
        pressure: washParams.pressure + Math.sin(pi * 0.47) * 0.01,
      };
    });
    strokes.push(makeStroke(points, washParams, lightCtx));
  }

  // Gestural dabs at original tone
  const cx = (xStart + xEnd) / 2;
  const cy = (yStart + yEnd) / 2;
  const rx = (xEnd - xStart) / 2;
  const ry = (yEnd - yStart) / 2;
  const dabCount = Math.min(4, Math.max(2, Math.round(Math.sqrt(region.cells.length) * 0.5)));
  for (let d = 0; d < dabCount; d++) {
    const ox = (rand() - 0.5) * rx * 1.6;
    const oy = (rand() - 0.5) * ry * 1.2;
    const len = params.brushSize * (2 + rand() * 2);
    const angle = (rand() - 0.5) * Math.PI * 0.4;
    strokes.push(dab(cx + ox, cy + oy, len, angle, washParams.pressure * 0.7, washParams, ctx));
  }

  return strokes;
}

function paintFigureUmbrella(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const cx = (xStart + xEnd) / 2;
  const h = yEnd - yStart;
  const w = xEnd - xStart;
  const rand = lcg(region.id * 8831);

  const bold = { ...params, load: Math.min(0.9, params.load + 0.2), thinners: 0 };
  const domeCenter = { x: cx, y: yStart + h * 0.20 };
  const dabLen = Math.max(w * 0.5, params.brushSize * 3);

  const spokeCount = Math.round(_recipeParams.umbrella_spoke_count);
  for (let i = 0; i < spokeCount; i++) {
    const angle = Math.PI * 0.8 + (i / (spokeCount - 1)) * Math.PI * 0.4;
    const ox = (rand() - 0.5) * 0.003;
    const oy = (rand() - 0.5) * 0.003;
    strokes.push(dab(
      domeCenter.x + ox, domeCenter.y + oy,
      dabLen + rand() * dabLen * 0.3,
      angle, bold.pressure, bold, ctx, 14,
    ));
  }

  for (let i = 0; i < spokeCount - 1; i++) {
    const angle = Math.PI * 0.85 + (i / (spokeCount - 2)) * Math.PI * 0.3;
    strokes.push(dab(
      domeCenter.x, domeCenter.y + h * 0.03,
      dabLen * 0.7, angle, bold.pressure * 0.9, bold, ctx, 12,
    ));
  }

  const shadowCtx = { ...ctx, meldrumIndex: Math.min(4, ctx.meldrumIndex + 1) };
  const shadowY = yStart + h * 0.35;
  strokes.push(...H(shadowY, cx - w * 0.3, cx + w * 0.3, params.pressure,
    { ...params, load: Math.min(0.8, params.load + 0.1) }, shadowCtx, 2, 15));

  const bodyTop = yStart + h * 0.40;
  const bodyBot = yStart + h * 0.80;
  strokes.push(...V(cx, bodyTop, bodyBot, params.pressure, params, ctx, 3, 14));

  const legTop = yStart + h * 0.80;
  const legBot = yEnd;
  strokes.push(...V(cx - w * 0.08, legTop, legBot, params.pressure * 0.6, params, ctx, 1, 6));
  strokes.push(...V(cx + w * 0.08, legTop, legBot, params.pressure * 0.6, params, ctx, 1, 6));

  return strokes;
}

function paintFigureStanding(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const cx = (xStart + xEnd) / 2;
  const h = yEnd - yStart;
  const w = xEnd - xStart;
  const rand = lcg(region.id * 4219);

  const bold = {
    ...params,
    load: Math.min(_recipeParams.figure_load_mult, params.load + 0.15),
    thinners: 0,
  };

  const bodyTop = yStart + h * 0.02;
  const bodyBot = yStart + h * 0.82;
  const passCount = Math.round(_recipeParams.figure_passes);
  for (let i = 0; i < passCount; i++) {
    const x = cx + (i - (passCount - 1) / 2) * params.brushSize * 0.25;
    const wobble = (rand() - 0.5) * 0.002;
    strokes.push(...V(x + wobble, bodyTop, bodyBot, bold.pressure, bold, ctx, 1, 18));
  }

  const legTop = yStart + h * 0.80;
  const legBot = yEnd;
  const legParams = { ...params, brushSize: params.brushSize * 0.7, load: params.load * 0.8 };
  strokes.push(...V(cx - w * 0.12, legTop, legBot, params.pressure * 0.7, legParams, ctx, 1, 8));
  strokes.push(...V(cx + w * 0.12, legTop, legBot, params.pressure * 0.7, legParams, ctx, 1, 8));

  return strokes;
}

function paintHedgeBand(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 5711);

  const bs = params.brushSize;
  const spacing = bs * 0.2;
  const bandH = yEnd - yStart;
  const rowCount = Math.max(2, Math.ceil(bandH / spacing));

  for (let i = 0; i < rowCount; i++) {
    const y = yStart + (i / (rowCount - 1)) * bandH;
    strokes.push(...H(y, xStart, xEnd, params.pressure, params, ctx, 1, 30));
  }

  const dabCount = Math.max(3, Math.round((xEnd - xStart) * 15));
  for (let d = 0; d < dabCount; d++) {
    const dx = xStart + rand() * (xEnd - xStart);
    const dy = yStart - rand() * bs * 3;
    const len = bs * (1.5 + rand() * 2);
    strokes.push(dab(dx, dy, len, (rand() - 0.5) * 0.4, params.pressure * 0.7, params, ctx));
  }

  return strokes;
}

function paintVehicleBody(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const cx = (xStart + xEnd) / 2;
  const cy = (yStart + yEnd) / 2;
  const w = xEnd - xStart;

  const glowParams = { ...params, brushSize: params.brushSize * 1.5, thinners: params.thinners + 0.02 };
  strokes.push(...H(cy, xStart - w * 0.1, xEnd + w * 0.1, params.pressure * 0.6, glowParams, ctx, 3, 20));

  const vividCtx = { ...ctx, useOil: true, useAnchor: true };
  const vividParams = { ...params, load: Math.min(1, params.load + 0.15) };
  strokes.push(...H(cy, cx - w * 0.3, cx + w * 0.3, params.pressure, vividParams, vividCtx, 2, 14));

  const structParams = { ...params, load: params.load * 0.7, brushSize: params.brushSize * 0.5 };
  const structCtx = { ...ctx, meldrumIndex: Math.min(4, ctx.meldrumIndex + 1), useOil: false, useAnchor: false };
  strokes.push(...H(yStart, xStart, xEnd, params.pressure * 0.5, structParams, structCtx, 1, 14));
  strokes.push(...H(yEnd, xStart, xEnd, params.pressure * 0.5, structParams, structCtx, 1, 14));

  return strokes;
}

function paintBuildingBlock(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 6337);
  const w = xEnd - xStart;
  const h = yEnd - yStart;
  const aspect = h / Math.max(w, 0.001);

  const committed = {
    ...params,
    load: Math.min(_recipeParams.building_load_mult, params.load + 0.05),
    thinners: Math.max(0.05, params.thinners),
  };

  if (aspect > 1.2) {
    const bs = params.brushSize;
    const colSpacing = bs * 0.4;
    const colCount = Math.max(2, Math.min(6, Math.ceil(w / colSpacing)));

    for (let i = 0; i < colCount; i++) {
      const x = xStart + (i / Math.max(1, colCount - 1)) * w;
      const melShift = (rand() < 0.35) ? -1 : (rand() < 0.5) ? 1 : 0;
      const colCtx = { ...ctx, meldrumIndex: Math.max(0, Math.min(4, ctx.meldrumIndex + melShift)) };
      strokes.push(...V(
        x + (rand() - 0.5) * 0.003, yStart, yEnd,
        committed.pressure + (rand() - 0.5) * 0.03,
        committed, colCtx, 1, Math.max(10, Math.round(h * 40)),
      ));
    }
  } else {
    const rowCount = Math.min(4, Math.max(2, Math.ceil(h / (params.brushSize * 0.4))));
    for (let i = 0; i < rowCount; i++) {
      const y = yStart + (i / Math.max(1, rowCount - 1)) * h;
      strokes.push(...H(y, xStart, xEnd, committed.pressure, committed, ctx, 1, 15));
    }
    const bCx = (xStart + xEnd) / 2;
    const bCy = (yStart + yEnd) / 2;
    for (let d = 0; d < 3; d++) {
      const ox = (rand() - 0.5) * w * 0.8;
      const oy = (rand() - 0.5) * h * 0.6;
      const len = params.brushSize * (1.5 + rand() * 2);
      strokes.push(dab(bCx + ox, bCy + oy, len, (rand() - 0.5) * 0.5, committed.pressure * 0.8, committed, ctx));
    }
  }

  return strokes;
}

// --- NEW recipes ---

function paintTreeTrunk(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 7129);
  const cx = (xStart + xEnd) / 2;
  const h = yEnd - yStart;
  const n = Math.max(15, Math.round(h * 50));
  const curveAmp = _recipeParams.trunk_curve;
  const lean = (rand() - 0.5) * 0.02;

  // Single curved sinusoidal trunk
  const trunkParams = { ...params, load: params.load * _recipeParams.pole_load_mult };
  const points = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return {
      x: cx + lean * t + Math.sin(t * Math.PI * 1.5 + rand() * 2) * curveAmp,
      y: yStart + t * h,
      pressure: params.pressure * (0.7 + 0.3 * (1 - t)), // taper at top
    };
  });
  strokes.push(makeStroke(points, trunkParams, ctx));

  // Optional branches
  const branchProb = _recipeParams.trunk_branch_prob;
  const branchCount = Math.floor(h * 30); // potential branch points
  for (let i = 0; i < branchCount; i++) {
    if (rand() > branchProb) continue;
    const t = 0.2 + rand() * 0.5; // branch between 20-70% of height
    const bx = cx + lean * t + Math.sin(t * Math.PI * 1.5) * curveAmp;
    const by = yStart + t * h;
    const side = rand() > 0.5 ? 1 : -1;
    const bLen = (0.01 + rand() * 0.02) * side;
    const bEnd = by - 0.005 - rand() * 0.01;
    const branchPts = Array.from({ length: 8 }, (_, j) => {
      const bt = j / 7;
      return {
        x: bx + bt * bLen,
        y: by + (bEnd - by) * bt,
        pressure: params.pressure * 0.5 * (1 - bt * 0.5),
      };
    });
    strokes.push(makeStroke(branchPts, trunkParams, ctx));
  }

  return strokes;
}

function paintTreeCanopy(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 5197);
  const cx = (xStart + xEnd) / 2;
  const h = yEnd - yStart;
  const w = xEnd - xStart;

  // Curved trunk at base (bottom 40%)
  const trunkTop = yStart + h * 0.6;
  const trunkBot = yEnd;
  const trunkN = Math.max(10, Math.round((trunkBot - trunkTop) * 40));
  const curveAmp = _recipeParams.trunk_curve;
  const trunkParams = { ...params, load: params.load * _recipeParams.pole_load_mult };
  const trunkPts = Array.from({ length: trunkN }, (_, i) => {
    const t = i / (trunkN - 1);
    return {
      x: cx + Math.sin(t * Math.PI + rand() * 2) * curveAmp,
      y: trunkTop + t * (trunkBot - trunkTop),
      pressure: params.pressure * (0.8 + 0.2 * t),
    };
  });
  strokes.push(makeStroke(trunkPts, trunkParams, ctx));

  // Canopy dabs (upper 60%)
  const canopyBot = yStart + h * 0.65;
  const canopyCy = (yStart + canopyBot) / 2;
  const rx = w / 2;
  const ry = (canopyBot - yStart) / 2;
  const treeParams = { ...params, load: Math.min(0.35, params.load), thinners: Math.max(0.20, params.thinners) };
  const dabCount = Math.min(8, Math.max(3,
    Math.round(Math.sqrt(region.cells.length) * _recipeParams.tree_dab_count_scale)));

  for (let d = 0; d < dabCount; d++) {
    const ox = (rand() + rand() - 1) * rx * 1.1;
    const oy = (rand() + rand() - 1) * ry * 0.8 - ry * 0.2;
    const len = treeParams.brushSize * (2 + rand() * 3);
    const angle = (rand() - 0.5) * Math.PI * 0.5;
    strokes.push(dab(cx + ox, canopyCy + oy, len, angle, treeParams.pressure, treeParams, ctx));
  }

  return strokes;
}

function paintBoat(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const cx = (xStart + xEnd) / 2;
  const cy = (yStart + yEnd) / 2;
  const hullLen = _recipeParams.boat_hull_length;
  const mastH = _recipeParams.boat_mast_height;

  // Hull — short horizontal stroke
  strokes.push(...H(
    cy, cx - hullLen / 2, cx + hullLen / 2,
    params.pressure, params, ctx, 1, 20,
  ));

  // Mast — single thin vertical above hull center
  const mastParams = { ...params, load: params.load * _recipeParams.pole_load_mult };
  strokes.push(...V(
    cx, cy - mastH, cy,
    params.pressure * 0.7, mastParams, ctx, 1, 15,
  ));

  // Faint reflection below hull
  const reflCtx = { ...ctx, meldrumIndex: Math.max(0, ctx.meldrumIndex - 1) };
  const reflParams = {
    ...params,
    load: _recipeParams.reflection_opacity * 0.7,
    thinners: Math.min(0.5, params.thinners + 0.1),
  };
  strokes.push(...V(
    cx, cy + 0.005, cy + mastH * 0.5,
    params.pressure * 0.4, reflParams, reflCtx, 1, 10,
  ));

  return strokes;
}

function paintReflection(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 6173);
  const w = xEnd - xStart;
  const h = (yEnd - yStart) * _recipeParams.reflection_smear;

  // Lighter, thinner than source form
  const reflCtx = { ...ctx, meldrumIndex: Math.max(0, ctx.meldrumIndex - 1) };
  const reflParams = {
    ...params,
    load: _recipeParams.reflection_opacity,
    thinners: Math.min(0.5, params.thinners + 0.15),
  };

  // Soft vertical smears across the width
  const smearCount = Math.max(2, Math.round(w / (params.brushSize * 0.5)));
  for (let i = 0; i < smearCount; i++) {
    const x = xStart + (i / Math.max(1, smearCount - 1)) * w + (rand() - 0.5) * 0.005;
    const yOff = (rand() - 0.5) * h * 0.1;
    strokes.push(taperV(
      x, yStart + yOff, yStart + h + yOff,
      reflParams.pressure, reflParams.pressure * 0.3,
      reflParams, reflCtx,
      Math.max(8, Math.round(h * 30)),
    ));
  }

  return strokes;
}

function paintLightDot(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const cx = (xStart + xEnd) / 2;
  const cy = (yStart + yEnd) / 2;
  const size = _recipeParams.lightdot_size;
  const brightness = Math.round(_recipeParams.lightdot_brightness);

  // Single bright dab with oil + anchor
  const lightCtx = {
    ...ctx,
    meldrumIndex: Math.max(0, ctx.meldrumIndex - brightness),
    useOil: true,
    useAnchor: true,
  };
  const lightParams = { ...params, load: Math.min(0.9, params.load + 0.2), thinners: 0 };

  return [dab(cx, cy, size, 0, lightParams.pressure, lightParams, lightCtx, 8)];
}

function paintWaveLine(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 8293);
  const w = xEnd - xStart;
  const spacing = _recipeParams.wave_spacing;

  // Short horizontal white/light marks
  const waveCtx = { ...ctx, meldrumIndex: Math.max(0, ctx.meldrumIndex - 2) };
  const waveParams = {
    ...params,
    load: _recipeParams.wave_load,
    thinners: Math.min(0.3, params.thinners + 0.05),
  };

  const markCount = Math.max(2, Math.round(w / spacing));
  for (let i = 0; i < markCount; i++) {
    const x = xStart + rand() * w;
    const y = yStart + rand() * (yEnd - yStart);
    const markLen = 0.005 + rand() * 0.015;
    strokes.push(...H(y, x - markLen / 2, x + markLen / 2,
      waveParams.pressure * 0.7, waveParams, waveCtx, 1, 8));
  }

  return strokes;
}

function paintHeadland(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 9371);
  const bs = params.brushSize;
  const h = yEnd - yStart;
  const edgeRough = _recipeParams.headland_edge_rough;

  // Dense horizontal strokes for the dark mass
  const darkParams = { ...params, load: Math.min(0.7, params.load + 0.1), thinners: Math.max(0.02, params.thinners) };
  const spacing = bs * 0.15;
  const rowCount = Math.max(3, Math.ceil(h / spacing));
  const nPts = Math.max(20, Math.round((xEnd - xStart) * 60));

  for (let i = 0; i < rowCount; i++) {
    const y = yStart + (i / (rowCount - 1)) * h;
    const points = Array.from({ length: nPts }, (_, pi) => {
      const t = pi / (nPts - 1);
      return {
        x: xStart + t * (xEnd - xStart),
        y: y + Math.sin(pi * 0.41) * 0.003,
        pressure: darkParams.pressure + Math.sin(pi * 0.53) * 0.008,
      };
    });
    strokes.push(makeStroke(points, darkParams, ctx));
  }

  // Dissolving edge — scattered dabs along one side
  const isLeft = region.centroid.x < 0.5;
  const edgeX = isLeft ? xEnd : xStart;
  const dabCount = Math.max(3, Math.round(h * 20));
  const softParams = { ...params, load: params.load * 0.4, thinners: Math.min(0.4, params.thinners + 0.1) };
  const softCtx = { ...ctx, meldrumIndex: Math.max(0, ctx.meldrumIndex - 1) };

  for (let d = 0; d < dabCount; d++) {
    const dy = yStart + rand() * h;
    const dx = edgeX + (isLeft ? 1 : -1) * rand() * edgeRough * 2;
    const len = bs * (1 + rand() * 2);
    const angle = (rand() - 0.5) * Math.PI * 0.3;
    strokes.push(dab(dx, dy, len, angle, softParams.pressure * 0.5, softParams, softCtx));
  }

  return strokes;
}

function paintSunMoon(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const cx = (xStart + xEnd) / 2;
  const cy = (yStart + yEnd) / 2;

  // Warm/cool accent — larger than light-dot, with glow
  const glowCtx = { ...ctx, useOil: true, useAnchor: true };
  const glowParams = { ...params, load: Math.min(0.9, params.load + 0.2), thinners: 0 };
  const size = _recipeParams.lightdot_size * 2;

  // 3-4 concentric dabs of decreasing pressure for glow
  const strokes: StrokeCommand[] = [];
  for (let ring = 0; ring < 4; ring++) {
    const ringSize = size * (1 + ring * 0.5);
    const ringPressure = glowParams.pressure * (1 - ring * 0.2);
    const ringCtx = ring === 0 ? glowCtx : { ...glowCtx, useOil: ring < 2, useAnchor: ring < 2 };
    const ringParams = { ...glowParams, load: glowParams.load * (1 - ring * 0.2) };
    strokes.push(dab(cx, cy, ringSize, 0, ringPressure, ringParams, ringCtx, 10));
    // Offset dab for organic feel
    if (ring > 0) {
      strokes.push(dab(cx, cy, ringSize, Math.PI / 2, ringPressure * 0.8, ringParams, ringCtx, 10));
    }
  }

  return strokes;
}

// --- Dispatcher ---

export function executeRecipe(
  recipe: RecipeClass,
  region: Region,
  params: RefinedParams,
  ctx: TissueContext,
  cols: number,
  rows: number,
  bleed = 0,
): StrokeCommand[] {
  switch (recipe) {
    case 'atmospheric-wash': return paintAtmosphericWash(region, params, ctx, cols, rows, bleed);
    case 'pole-simple':      return paintPoleSimple(region, params, ctx, cols, rows, bleed);
    case 'pole-crossbar':    return paintPoleCrossbar(region, params, ctx, cols, rows, bleed);
    case 'tree-rounded':     return paintTreeRounded(region, params, ctx, cols, rows, bleed);
    case 'tree-spread':      return paintFoliageMass(region, params, ctx, cols, rows, bleed);
    case 'foliage-mass':     return paintFoliageMass(region, params, ctx, cols, rows, bleed);
    case 'tree-trunk':       return paintTreeTrunk(region, params, ctx, cols, rows, bleed);
    case 'tree-canopy':      return paintTreeCanopy(region, params, ctx, cols, rows, bleed);
    case 'figure-umbrella':  return paintFigureUmbrella(region, params, ctx, cols, rows, bleed);
    case 'figure-standing':  return paintFigureStanding(region, params, ctx, cols, rows, bleed);
    case 'hedge-band':       return paintHedgeBand(region, params, ctx, cols, rows, bleed);
    case 'vehicle-body':     return paintVehicleBody(region, params, ctx, cols, rows, bleed);
    case 'building-block':   return paintBuildingBlock(region, params, ctx, cols, rows, bleed);
    case 'boat':             return paintBoat(region, params, ctx, cols, rows, bleed);
    case 'reflection':       return paintReflection(region, params, ctx, cols, rows, bleed);
    case 'light-dot':        return paintLightDot(region, params, ctx, cols, rows, bleed);
    case 'wave-line':        return paintWaveLine(region, params, ctx, cols, rows, bleed);
    case 'headland':         return paintHeadland(region, params, ctx, cols, rows, bleed);
    case 'sun-moon':         return paintSunMoon(region, params, ctx, cols, rows, bleed);
    case 'beach-huts':       return paintBuildingBlock(region, params, ctx, cols, rows, bleed); // reuse building
    default:                 return paintAtmosphericWash(region, params, ctx, cols, rows, bleed);
  }
}
