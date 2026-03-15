// Assembly Rules — 6-layer painting plan configured by conductor decisions
// Replaces the flat assembleRegionPlan with hierarchy-aware layer construction.

import type { Region } from './region-analysis.js';
import type { TonalMap, MeldrumLUT, StrokeCommand, PaintingPlan } from './tonal-recreation.js';
import type {
  AccentResult, ColorAnalysis, ConductorDecisions, EdgeResult,
  FocalPoint, LayerBudget, RecipeClass, RefinedParams, TissueContext,
} from './types.js';
import { executeRecipe, getRecipeParams } from './recipes.js';
import { BRUSH_SLOT_SIZES } from '../palette.js';

const DARK = 3;

// Budget: evenly sample if exceeding max
function budgetStrokes(strokes: StrokeCommand[], max: number): StrokeCommand[] {
  if (strokes.length <= max || max <= 0) return strokes;
  const step = strokes.length / max;
  const result: StrokeCommand[] = [];
  for (let i = 0; i < max; i++) {
    result.push(strokes[Math.floor(i * step)]);
  }
  return result;
}

function focalDistanceMultiplier(
  region: Region,
  focalPoint: FocalPoint,
  focalDensity: number,
): number {
  const dx = region.centroid.x - focalPoint.x;
  const dy = region.centroid.y - focalPoint.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Closer to focal → more strokes (up to focalDensity multiplier)
  if (dist < 0.15) return focalDensity;
  if (dist < 0.3) return 1 + (focalDensity - 1) * 0.5;
  return 1.0;
}

export function assemblePlan(
  regions: Region[],
  map: TonalMap,
  luts: MeldrumLUT[],
  tones: Map<number, number>,
  colors: Map<number, ColorAnalysis>,
  accents: Map<number, AccentResult>,
  recipes: Map<number, RecipeClass>,
  refinedParams: Map<number, RefinedParams>,
  _edges: EdgeResult[],
  focalPoint: FocalPoint,
  budget: LayerBudget,
  conductor: ConductorDecisions,
): PaintingPlan {
  const { cols, rows, motherHueIndex } = map;
  const layers: { name: string; strokes: StrokeCommand[] }[] = [];

  // --- Layer 1: Mother Wash ---
  const motherMeldrum = computeMotherMeldrum(map, luts, motherHueIndex);
  const motherStrokes = generateMotherWash(motherHueIndex, motherMeldrum);
  layers.push({ name: 'Mother', strokes: budgetStrokes(motherStrokes, budget.atmosphere) });

  // --- Layer 2: Background (sky + ground) ---
  const bgRegions = regions.filter(r =>
    r.classification === 'sky' || r.classification === 'ground');
  const bgStrokes = bgRegions.flatMap(r => {
    const tone = tones.get(r.id) ?? r.meldrumIndex;
    // Skip regions lighter than bareCanvasThreshold (mapped to meldrum band)
    if (tone < Math.round(conductor.bareCanvasThreshold * 4) && r.classification !== 'accent') {
      return [];
    }
    const params = refinedParams.get(r.id);
    if (!params) return [];
    const color = colors.get(r.id);
    const accent = accents.get(r.id);
    const ctx = buildContext(r, color, accent, tone, motherHueIndex);
    const recipe = recipes.get(r.id) || 'atmospheric-wash';
    const strokes = executeRecipe(recipe, r, params, ctx, cols, rows, conductor.interRegionBleed);
    const mult = focalDistanceMultiplier(r, focalPoint, conductor.focalDensity);
    return mult > 1.5 ? strokes : budgetStrokes(strokes, Math.round(strokes.length * mult));
  });
  layers.push({ name: 'Background', strokes: budgetStrokes(bgStrokes, budget.background) });

  // --- Layer 3: Midtones (non-dark mass + horizon) ---
  // Dark masses (mel >= DARK) go exclusively in Dark Forms to avoid double-painting.
  const midRegions = regions.filter(r => {
    if (r.classification === 'horizon') return true;
    if (r.classification === 'mass') {
      const tone = tones.get(r.id) ?? r.meldrumIndex;
      return tone < DARK; // only light/mid masses here
    }
    return false;
  });
  const midStrokes = midRegions.flatMap(r => {
    const tone = tones.get(r.id) ?? r.meldrumIndex;
    if (tone < Math.round(conductor.bareCanvasThreshold * 4)) return [];
    const params = refinedParams.get(r.id);
    if (!params) return [];
    const color = colors.get(r.id);
    const accent = accents.get(r.id);
    const ctx = buildContext(r, color, accent, tone, motherHueIndex);
    const recipe = recipes.get(r.id) || 'atmospheric-wash';
    const strokes = executeRecipe(recipe, r, params, ctx, cols, rows, conductor.interRegionBleed);
    const mult = focalDistanceMultiplier(r, focalPoint, conductor.focalDensity);
    return mult > 1.5 ? strokes : budgetStrokes(strokes, Math.round(strokes.length * mult));
  });
  layers.push({ name: 'Midtones', strokes: budgetStrokes(midStrokes, budget.midtones) });

  // --- Layer 4: Dark Forms (verticals + dark masses + fill + reflection) ---
  const darkRegions = regions.filter(r =>
    r.classification === 'vertical' ||
    (r.classification === 'mass' && (tones.get(r.id) ?? r.meldrumIndex) >= DARK) ||
    r.classification === 'fill' ||
    r.classification === 'reflection');
  // Filter out mass regions already handled in midtones (non-dark)
  const darkOnly = darkRegions.filter(r => {
    if (r.classification === 'mass') return (tones.get(r.id) ?? r.meldrumIndex) >= DARK;
    return true;
  });
  const darkStrokes = darkOnly.flatMap(r => {
    const tone = tones.get(r.id) ?? r.meldrumIndex;
    const params = refinedParams.get(r.id);
    if (!params) return [];
    const color = colors.get(r.id);
    const accent = accents.get(r.id);
    // Atmospheric lightening: mass regions get shifted by mass_mel_shift steps lighter.
    // Beckett's tree masses are atmospheric mid-tones, not absolute darks.
    // Verticals stay dark — they're committed anchor marks.
    const isMass = r.classification === 'mass';
    const massMelShift = getRecipeParams().mass_mel_shift;
    const adjustedTone = isMass ? Math.max(0, tone - massMelShift) : tone;
    const ctx = buildContext(r, color, accent, adjustedTone, motherHueIndex);
    const recipe = recipes.get(r.id) || 'atmospheric-wash';
    const strokes = executeRecipe(recipe, r, params, ctx, cols, rows, conductor.interRegionBleed);
    const mult = focalDistanceMultiplier(r, focalPoint, conductor.focalDensity);
    const result = mult > 1.5 ? strokes : budgetStrokes(strokes, Math.round(strokes.length * mult));

    // Dark softening: add thin veil pass OVER dark marks
    if (conductor.darkSoftening > 0.2 && tone >= DARK) {
      const veilParams: RefinedParams = {
        thinners: 0.08,
        load: 0.25 * conductor.darkSoftening,
        pressure: 0.20,
        brushSize: BRUSH_SLOT_SIZES[4],
        brushSlot: 4,
      };
      const veilCtx: TissueContext = {
        hueIndex: motherHueIndex,
        meldrumIndex: 0, // WHITE
        useOil: false,
        useAnchor: false,
      };
      const veilStrokes = executeRecipe('atmospheric-wash', r, veilParams, veilCtx, cols, rows);
      result.push(...budgetStrokes(veilStrokes, Math.max(1, Math.round(veilStrokes.length * 0.3))));
    }

    return result;
  });
  layers.push({ name: 'Dark Forms', strokes: budgetStrokes(darkStrokes, budget.darkForms) });

  // --- Layer 5: Accents (reordered by accentTiming below) ---
  const accentRegions = regions.filter(r => {
    const a = accents.get(r.id);
    return a && a.isAccent;
  });
  const accentStrokes = accentRegions.flatMap(r => {
    const params = refinedParams.get(r.id);
    if (!params) return [];
    const color = colors.get(r.id);
    const ctx: TissueContext = {
      hueIndex: color?.nearestHueIndex ?? r.hueIndex,
      meldrumIndex: 2, // MID — peak chroma zone for accents
      useOil: true,
      useAnchor: true,
    };
    const recipe = recipes.get(r.id) || 'atmospheric-wash';
    return executeRecipe(recipe, r,
      { ...params, load: Math.min(1, params.load + 0.15), thinners: 0 },
      ctx, cols, rows, conductor.interRegionBleed);
  });
  layers.push({ name: 'Accents', strokes: budgetStrokes(accentStrokes, budget.accents) });

  // --- Layer 6: Atmospheric Veil ---
  // TODO: Rework with ML model. Disabled for now — veil needs per-pixel control
  // that can't be achieved with uniform brush passes.
  layers.push({ name: 'Veil', strokes: [] });

  // --- accentTiming: reorder accent layer position ---
  const accentIdx = layers.findIndex(l => l.name === 'Accents');
  if (accentIdx >= 0) {
    const accentLayer = layers.splice(accentIdx, 1)[0];
    const insertAt = Math.max(1, Math.min(layers.length, Math.round(conductor.accentTiming * 5)));
    layers.splice(insertAt, 0, accentLayer);
  }

  // Apply restraint to painting layers (not Mother or Veil — atmosphere is sacred)
  for (let i = 1; i < layers.length; i++) {
    if (layers[i].name === 'Veil') continue;
    const target = Math.max(1, Math.round(layers[i].strokes.length * conductor.restraint));
    layers[i].strokes = budgetStrokes(layers[i].strokes, target);
  }

  // Metadata: hueAssignments from TonalMap
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
    metadata: {
      gridSize: [cols, rows],
      strokeCount: totalStrokes,
      motherHueIndex,
      hueAssignments,
    },
  };
}

// --- Helpers ---

function buildContext(
  region: Region,
  color: ColorAnalysis | undefined,
  accent: AccentResult | undefined,
  meldrumIndex: number,
  motherHueIdx?: number,
): TissueContext {
  const isAccent = accent?.isAccent ?? false;
  const cls = region.classification;

  // Atmospheric lightening: only SKY gets shifted 1 step lighter.
  // Ground keeps its observed tone — critical for seascapes (blue water ≠ pale sky).
  // Masses, verticals, reflections keep committed tone — Beckett's darks anchor the painting.
  const isSky = cls === 'sky';
  const shifted = (isSky && !isAccent) ? Math.max(0, meldrumIndex - 1) : meldrumIndex;

  // Sky uses mother hue for atmospheric unity — but only LARGE sky regions.
  // Small sky patches near the horizon keep their distinct hue (building-adjacent sky
  // should show local color, not mother wash).
  let hueIndex = color?.nearestHueIndex ?? region.hueIndex;
  if (motherHueIdx !== undefined && isSky && region.areaFraction > 0.02) {
    hueIndex = motherHueIdx;
  }

  return {
    hueIndex,
    meldrumIndex: shifted,
    useOil: isAccent,
    useAnchor: isAccent,
  };
}

function computeMotherMeldrum(map: TonalMap, luts: MeldrumLUT[], motherHueIndex: number): number {
  const motherLut = luts[motherHueIndex];
  let motherMeldrum = 2;
  let bestDist = Infinity;
  for (let i = 0; i < 5; i++) {
    const d = Math.abs(map.motherTone - motherLut.luminances[i]);
    if (d < bestDist) { bestDist = d; motherMeldrum = i; }
  }
  // Beckett's mother IS the atmosphere — nearly white.
  // Force to WHITE (0): the luminous ground that everything floats in.
  // All color and tone comes from subsequent layers.
  return 0;
}

function generateMotherWash(hueIndex: number, meldrumIndex: number): StrokeCommand[] {
  const bs = BRUSH_SLOT_SIZES[4];
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
        thinners: 0.14,
        load: 0.40,
        useOil: false,
        useAnchor: false,
      });
    }
  }
  return strokes;
}
