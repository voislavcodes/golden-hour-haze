// 10 Beckett construction recipes — deterministic stroke generation functions
// Each recipe produces StrokeCommand[] from region geometry + refined params + tissue context.

import type { Region } from './region-analysis.js';
import type { StrokeCommand } from './tonal-recreation.js';
import type { RecipeClass, RefinedParams, TissueContext } from './types.js';
// BRUSH_SLOT_SIZES available if recipes need slot→size conversion in future

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

// --- Simple recipes ---

function paintAtmosphericWash(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const bs = params.brushSize;
  const spacing = bs * 0.15;
  const nPts = Math.max(30, Math.round((xEnd - xStart) * 80));

  for (let pass = 0; pass < 2; pass++) {
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
  const x = (xStart + xEnd) / 2;
  const height = yEnd - yStart;
  const rand = lcg(region.id * 7919);

  // Segmented V strokes with wobble, 2 passes
  const segCount = Math.max(3, Math.ceil(height / 0.06));
  const segH = height / segCount;

  for (let pass = 0; pass < 2; pass++) {
    const xOff = (pass - 0.5) * params.brushSize * 0.3;
    for (let seg = 0; seg < segCount; seg++) {
      const y0 = yStart + seg * segH;
      const y1 = Math.min(yEnd, y0 + segH + 0.02); // slight overlap
      const wobble = (rand() - 0.5) * 0.003;
      strokes.push(taperV(
        x + xOff + wobble, y0, y1,
        params.pressure, params.pressure * 0.7,
        params, ctx, 8,
      ));
    }
  }

  return strokes;
}

function paintPoleCrossbar(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  // Pole first
  const strokes = paintPoleSimple(region, params, ctx, cols, rows, bleed);
  // Crossbar at ~30% from top
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
  const bs = params.brushSize;

  // 8-15 overlapping short H dabs, Gaussian distribution from centroid
  const dabCount = Math.max(8, Math.min(15, Math.round(region.cells.length * 0.8)));
  for (let d = 0; d < dabCount; d++) {
    // Box-Muller-ish distribution from centroid
    const ox = (rand() + rand() - 1) * rx;
    const oy = (rand() + rand() - 1) * ry;
    const len = bs * (2 + rand() * 2);
    const angle = (rand() - 0.5) * Math.PI * 0.3;
    strokes.push(dab(cx + ox, cy + oy, len, angle, params.pressure, params, ctx));
  }

  return strokes;
}

function paintTreeSpread(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 4523);
  const cx = (xStart + xEnd) / 2;
  const cy = (yStart + yEnd) / 2;
  const rx = (xEnd - xStart) / 2;
  const ry = (yEnd - yStart) / 2;

  // Wider, flatter, fewer dabs than rounded
  const dabCount = Math.max(5, Math.min(10, Math.round(region.cells.length * 0.5)));
  for (let d = 0; d < dabCount; d++) {
    const ox = (rand() - 0.5) * rx * 2;
    const oy = (rand() - 0.5) * ry * 1.2;
    const len = params.brushSize * (3 + rand() * 3);
    const angle = (rand() - 0.5) * Math.PI * 0.2; // mostly horizontal
    strokes.push(dab(cx + ox, cy + oy, len, angle, params.pressure * 0.9, params, ctx));
  }

  return strokes;
}

// --- Complex recipes ---

function paintFigureUmbrella(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const cx = (xStart + xEnd) / 2;
  const h = yEnd - yStart;
  const w = xEnd - xStart;

  // Dome arcs at top ~25% of height
  const domeY = yStart + h * 0.12;
  const domeRadius = w * 0.45;
  strokes.push(arc(cx, domeY + domeRadius * 0.3, domeRadius,
    Math.PI * 1.1, Math.PI * 1.9, params.pressure, params, ctx, 20));
  strokes.push(arc(cx, domeY + domeRadius * 0.4, domeRadius * 0.85,
    Math.PI * 1.15, Math.PI * 1.85, params.pressure * 0.9, params, ctx, 18));

  // Dark core of dome — fill
  const domeTop = yStart;
  const domeBot = yStart + h * 0.25;
  strokes.push(...H(
    (domeTop + domeBot) / 2, cx - w * 0.35, cx + w * 0.35,
    params.pressure * 1.1,
    { ...params, load: Math.min(1, params.load + 0.1) },
    { ...ctx, meldrumIndex: Math.min(4, ctx.meldrumIndex + 1) },
    2, 20,
  ));

  // Body column — 2-3 V passes
  const bodyTop = yStart + h * 0.28;
  const bodyBot = yStart + h * 0.75;
  strokes.push(...V(cx, bodyTop, bodyBot, params.pressure, params, ctx, 3, 20));

  // Hem widening
  const hemY = yStart + h * 0.72;
  strokes.push(...H(hemY, cx - w * 0.2, cx + w * 0.2, params.pressure * 0.9, params, ctx, 2, 12));

  // Tapered legs
  const legTop = yStart + h * 0.78;
  const legBot = yEnd;
  const legParams = { ...params, brushSize: params.brushSize * 0.6 };
  strokes.push(taperV(cx - w * 0.06, legTop, legBot, params.pressure * 0.8, params.pressure * 0.3, legParams, ctx, 15));
  strokes.push(taperV(cx + w * 0.06, legTop, legBot, params.pressure * 0.8, params.pressure * 0.3, legParams, ctx, 15));

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

  // Body column — 2-3 V passes
  const bodyTop = yStart + h * 0.05;
  const bodyBot = yStart + h * 0.78;
  strokes.push(...V(cx, bodyTop, bodyBot, params.pressure, params, ctx, 3, 24));

  // Legs — thin tapered V
  const legTop = yStart + h * 0.78;
  const legBot = yEnd;
  const legParams = { ...params, brushSize: params.brushSize * 0.5 };
  strokes.push(taperV(cx - w * 0.08, legTop, legBot, params.pressure * 0.7, params.pressure * 0.2, legParams, ctx, 12));
  strokes.push(taperV(cx + w * 0.08, legTop, legBot, params.pressure * 0.7, params.pressure * 0.2, legParams, ctx, 12));

  return strokes;
}

function paintHedgeBand(
  region: Region, params: RefinedParams, ctx: TissueContext,
  cols: number, rows: number, bleed = 0,
): StrokeCommand[] {
  const { xStart, yStart, xEnd, yEnd } = regionBounds(region, cols, rows, bleed);
  const strokes: StrokeCommand[] = [];
  const rand = lcg(region.id * 5711);

  // Horizontal fill at band height
  const bs = params.brushSize;
  const spacing = bs * 0.2;
  const bandH = yEnd - yStart;
  const rowCount = Math.max(2, Math.ceil(bandH / spacing));

  for (let i = 0; i < rowCount; i++) {
    const y = yStart + (i / (rowCount - 1)) * bandH;
    strokes.push(...H(y, xStart, xEnd, params.pressure, params, ctx, 1, 30));
  }

  // Scattered tree-top dabs above the band
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

  // Warm glow fill — larger brush, thin paint
  const glowParams = { ...params, brushSize: params.brushSize * 1.5, thinners: params.thinners + 0.02 };
  strokes.push(...H(cy, xStart - w * 0.1, xEnd + w * 0.1, params.pressure * 0.6, glowParams, ctx, 3, 20));

  // Vivid center with oil+anchor
  const vividCtx = { ...ctx, useOil: true, useAnchor: true };
  const vividParams = { ...params, load: Math.min(1, params.load + 0.15) };
  strokes.push(...H(cy, cx - w * 0.3, cx + w * 0.3, params.pressure, vividParams, vividCtx, 2, 14));

  // Dark structure lines
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

  // Rectangular mass — horizontal fill
  const bs = params.brushSize;
  const spacing = bs * 0.18;
  const h = yEnd - yStart;
  const rowCount = Math.max(2, Math.ceil(h / spacing));

  for (let i = 0; i < rowCount; i++) {
    const y = yStart + (i / Math.max(1, rowCount - 1)) * h;
    strokes.push(...H(y, xStart, xEnd, params.pressure, params, ctx, 1, 25));
  }

  // Hard vertical edges
  strokes.push(...V(xStart, yStart, yEnd, params.pressure * 0.9, params, ctx, 1, 15));
  strokes.push(...V(xEnd, yStart, yEnd, params.pressure * 0.9, params, ctx, 1, 15));

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
    case 'tree-spread':      return paintTreeSpread(region, params, ctx, cols, rows, bleed);
    case 'figure-umbrella':  return paintFigureUmbrella(region, params, ctx, cols, rows, bleed);
    case 'figure-standing':  return paintFigureStanding(region, params, ctx, cols, rows, bleed);
    case 'hedge-band':       return paintHedgeBand(region, params, ctx, cols, rows, bleed);
    case 'vehicle-body':     return paintVehicleBody(region, params, ctx, cols, rows, bleed);
    case 'building-block':   return paintBuildingBlock(region, params, ctx, cols, rows, bleed);
  }
}
