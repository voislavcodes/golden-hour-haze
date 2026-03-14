// ML Inference Wrappers — 5 ML models with shared boilerplate
// Each function inits its model via registry, falls back to heuristic if unavailable.

import type { Region, RegionClass } from './region-analysis.js';
import type { TonalMap } from './tonal-recreation.js';
import type {
  AccentResult, ColorAnalysis, CompositionClass, ConductorDecisions,
  DepthClass, FocalPoint, LayerBudget, RecipeClass, RefinedParams,
  SceneFeatures, StrokeType,
} from './types.js';
import { isModelReady, getSession, getOrt } from './onnx-registry.js';
import { extractPatch } from './region-patches.js';
import { extractSilhouettePatch } from './tissue-recipe.js';
import { computeRegionFeatures } from './region-analysis.js';
import { inferStrokeTypes } from './tissue-stroke-type.js';
import { classifyRecipes } from './tissue-recipe.js';
import { classifyComposition } from './organ-composition.js';
import { refineParameters } from './organism-params.js';
import { conductPainting } from './organism-conductor.js';
import {
  serializeSceneFeatures, serializeRegionContext, serializeConductorInput,
} from './feature-serialize.js';
import { BRUSH_SLOT_SIZES } from '../palette.js';

// --- Shared helpers ---

function softmax(logits: Float32Array, offset: number, count: number): { index: number; confidence: number } {
  let maxLogit = -Infinity;
  for (let j = 0; j < count; j++) {
    if (logits[offset + j] > maxLogit) maxLogit = logits[offset + j];
  }
  let sumExp = 0;
  const probs = new Float32Array(count);
  for (let j = 0; j < count; j++) {
    probs[j] = Math.exp(logits[offset + j] - maxLogit);
    sumExp += probs[j];
  }
  let bestIdx = 0, bestProb = 0;
  for (let j = 0; j < count; j++) {
    probs[j] /= sumExp;
    if (probs[j] > bestProb) { bestProb = probs[j]; bestIdx = j; }
  }
  return { index: bestIdx, confidence: bestProb };
}

// --- T8: Stroke Type ML ---

const STROKE_TYPE_LABELS: StrokeType[] = [
  'horizontal-wash', 'vertical-stroke', 'clustered-dabs', 'single-dab', 'arc',
];
const T8_THRESHOLD = 0.55;

export async function inferStrokeTypesML(
  regions: Region[],
  depths: Map<number, DepthClass>,
  fullResImageData: ImageData | undefined,
  gridCols: number,
  gridRows: number,
): Promise<Map<number, StrokeType>> {
  // Fallback if model not ready or no full-res image for patches
  if (!isModelReady('stroke-type') || !fullResImageData) {
    return inferStrokeTypes(regions, depths);
  }

  const session = getSession('stroke-type');
  const ort = getOrt();
  if (!session || !ort) return inferStrokeTypes(regions, depths);

  const N = regions.length;
  if (N === 0) return new Map();

  try {
    // Extract patches and features
    const patchData = new Float32Array(N * 3 * 16 * 16);
    const featData = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const patch = extractPatch(fullResImageData, regions[i], gridCols, gridRows);
      patchData.set(patch, i * 768);
      const f = computeRegionFeatures(regions[i], gridCols, gridRows);
      featData[i * 6 + 0] = f.x;
      featData[i * 6 + 1] = f.y;
      featData[i * 6 + 2] = f.aspectRatio;
      featData[i * 6 + 3] = f.areaFraction;
      featData[i * 6 + 4] = f.meldrumIndex;
      featData[i * 6 + 5] = f.maxChroma;
    }

    const patchTensor = new ort.Tensor('float32', patchData, [N, 3, 16, 16]);
    const featTensor = new ort.Tensor('float32', featData, [N, 6]);
    const results = await session.run({ patch: patchTensor, features: featTensor });
    const logits = results[session.outputNames[0]].data as Float32Array;

    // Per-region fallback if confidence too low
    const heuristicFallback = inferStrokeTypes(regions, depths);
    const result = new Map<number, StrokeType>();

    for (let i = 0; i < N; i++) {
      const { index, confidence } = softmax(logits, i * 5, 5);
      if (confidence >= T8_THRESHOLD) {
        result.set(regions[i].id, STROKE_TYPE_LABELS[index]);
      } else {
        result.set(regions[i].id, heuristicFallback.get(regions[i].id)!);
      }
    }
    return result;
  } catch {
    return inferStrokeTypes(regions, depths);
  }
}

// --- T9: Shape Recipe ML ---

const RECIPE_LABELS: RecipeClass[] = [
  'figure-umbrella', 'figure-standing', 'pole-simple', 'pole-crossbar',
  'tree-rounded', 'tree-spread', 'hedge-band', 'vehicle-body',
  'building-block', 'atmospheric-wash',
];
const REGION_CLASSES: RegionClass[] = [
  'sky', 'ground', 'horizon', 'mass', 'vertical', 'accent', 'reflection', 'fill',
];
const DEPTH_CLASSES: DepthClass[] = ['near', 'mid', 'far'];
const T9_THRESHOLD = 0.50;

export async function classifyRecipesML(
  regions: Region[],
  depths: Map<number, DepthClass>,
  map: TonalMap,
): Promise<Map<number, RecipeClass>> {
  if (!isModelReady('shape-recipe')) {
    return classifyRecipes(regions, depths);
  }

  const session = getSession('shape-recipe');
  const ort = getOrt();
  if (!session || !ort) return classifyRecipes(regions, depths);

  const N = regions.length;
  if (N === 0) return new Map();

  try {
    // Silhouette patches [N, 1, 16, 16] + scalars [N, 13]
    const silData = new Float32Array(N * 1 * 16 * 16);
    const scalarData = new Float32Array(N * 13);

    for (let i = 0; i < N; i++) {
      const sil = extractSilhouettePatch(regions[i], map);
      silData.set(sil, i * 256);

      // 13 = classification one-hot(8) + depth one-hot(3) + aspect(1) + area(1)
      let j = i * 13;
      const depth = depths.get(regions[i].id) || 'mid';
      for (const cls of REGION_CLASSES) scalarData[j++] = regions[i].classification === cls ? 1 : 0;
      for (const d of DEPTH_CLASSES) scalarData[j++] = depth === d ? 1 : 0;
      scalarData[j++] = regions[i].aspectRatio;
      scalarData[j++] = regions[i].areaFraction;
    }

    const silTensor = new ort.Tensor('float32', silData, [N, 1, 16, 16]);
    const scalarTensor = new ort.Tensor('float32', scalarData, [N, 13]);
    const results = await session.run({ silhouette: silTensor, scalars: scalarTensor });
    const logits = results[session.outputNames[0]].data as Float32Array;

    const heuristicFallback = classifyRecipes(regions, depths);
    const result = new Map<number, RecipeClass>();

    for (let i = 0; i < N; i++) {
      const { index, confidence } = softmax(logits, i * 10, 10);
      if (confidence >= T9_THRESHOLD) {
        result.set(regions[i].id, RECIPE_LABELS[index]);
      } else {
        result.set(regions[i].id, heuristicFallback.get(regions[i].id)!);
      }
    }
    return result;
  } catch {
    return classifyRecipes(regions, depths);
  }
}

// --- O1: Composition ML ---

const COMPOSITION_LABELS: CompositionClass[] = [
  'lonely-figure', 'street-scene', 'seascape',
  'twilight-glow', 'intimate-scene', 'abstract-masses',
];
const O1_THRESHOLD = 0.55;

export async function classifyCompositionML(
  features: SceneFeatures,
): Promise<{ class: CompositionClass; confidence: number }> {
  if (!isModelReady('composition')) {
    return classifyComposition(features);
  }

  const session = getSession('composition');
  const ort = getOrt();
  if (!session || !ort) return classifyComposition(features);

  try {
    const input = serializeSceneFeatures(features);
    const tensor = new ort.Tensor('float32', input, [1, 30]);
    const results = await session.run({ features: tensor });
    const logits = results[session.outputNames[0]].data as Float32Array;

    const { index, confidence } = softmax(logits, 0, 6);
    if (confidence >= O1_THRESHOLD) {
      return { class: COMPOSITION_LABELS[index], confidence };
    }
    return classifyComposition(features);
  } catch {
    return classifyComposition(features);
  }
}

// --- SO1: Parameter Refinement ML ---

const BRUSH_SLOTS = BRUSH_SLOT_SIZES.length;

export async function refineParametersML(
  regions: Region[],
  depths: Map<number, DepthClass>,
  colors: Map<number, ColorAnalysis>,
  tones: Map<number, number>,
  focalPoint: FocalPoint,
  composition: CompositionClass,
  fogDensity: number,
  accents: Map<number, AccentResult>,
  strokeTypes: Map<number, StrokeType>,
): Promise<Map<number, RefinedParams>> {
  if (!isModelReady('param-refinement')) {
    return refineParameters(regions, depths, colors, tones, focalPoint);
  }

  const session = getSession('param-refinement');
  const ort = getOrt();
  if (!session || !ort) {
    return refineParameters(regions, depths, colors, tones, focalPoint);
  }

  const N = regions.length;
  if (N === 0) return new Map();

  try {
    // Count regions per meldrum band for same_band_count feature
    const bandCounts = new Map<number, number>();
    for (const r of regions) {
      const tone = tones.get(r.id) ?? r.meldrumIndex;
      bandCounts.set(tone, (bandCounts.get(tone) || 0) + 1);
    }

    const contextData = new Float32Array(N * 32);
    for (let i = 0; i < N; i++) {
      const r = regions[i];
      const depth = depths.get(r.id) || 'mid';
      const color = colors.get(r.id) || { regionId: r.id, avgL: 0.5, avgChroma: 0, avgHue: 0, nearestHueIndex: 0, chromatic: false };
      const tone = tones.get(r.id) ?? r.meldrumIndex;
      const dx = r.centroid.x - focalPoint.x;
      const dy = r.centroid.y - focalPoint.y;
      const focalDist = Math.sqrt(dx * dx + dy * dy);
      const accent = accents.get(r.id) || { regionId: r.id, isAccent: false, intensity: 0 };
      const strokeType = strokeTypes.get(r.id) || 'horizontal-wash';
      const sameBand = bandCounts.get(tone) || 1;

      const ctx = serializeRegionContext(
        r, depth, color, tone, focalDist, composition, fogDensity,
        accent, strokeType, sameBand,
      );
      contextData.set(ctx, i * 32);
    }

    const tensor = new ort.Tensor('float32', contextData, [N, 32]);
    const results = await session.run({ context: tensor });
    const output = results[session.outputNames[0]].data as Float32Array;

    const result = new Map<number, RefinedParams>();
    for (let i = 0; i < N; i++) {
      const base = i * 5;
      // Sigmoid outputs → denormalize to physical ranges
      // Beckett glazing: thinners range expanded for translucent technique
      const thinners = output[base + 0] * 0.60;                      // [0, 0.60]
      const load = 0.10 + output[base + 1] * 0.55;                   // [0.10, 0.65]
      const pressure = 0.20 + output[base + 2] * 0.55;               // [0.20, 0.75]
      const brushSizeRaw = output[base + 3];                          // [0, 1]
      const brushSlot = Math.round(brushSizeRaw * (BRUSH_SLOTS - 1)); // nearest slot
      const brushSize = BRUSH_SLOT_SIZES[Math.min(BRUSH_SLOTS - 1, Math.max(0, brushSlot))];

      result.set(regions[i].id, { thinners, load, pressure, brushSize, brushSlot });
    }
    return result;
  } catch {
    return refineParameters(regions, depths, colors, tones, focalPoint);
  }
}

// --- SO2: Painting Conductor ML ---

export async function conductPaintingML(
  composition: CompositionClass,
  focalPoint: FocalPoint,
  fogDensity: number,
  budget: LayerBudget,
  features: SceneFeatures,
): Promise<ConductorDecisions> {
  if (!isModelReady('painting-conductor')) {
    return conductPainting(composition, focalPoint, fogDensity, budget, features);
  }

  const session = getSession('painting-conductor');
  const ort = getOrt();
  if (!session || !ort) {
    return conductPainting(composition, focalPoint, fogDensity, budget, features);
  }

  try {
    const input = serializeConductorInput(composition, focalPoint, fogDensity, budget, features);
    const tensor = new ort.Tensor('float32', input, [1, 30]);
    const results = await session.run({ input: tensor });
    const output = results[session.outputNames[0]].data as Float32Array;

    // Denormalize 7 outputs
    return {
      restraint: Math.max(0, Math.min(1, output[0])),
      focalDensity: 1.0 + output[1] * 2.0,          // [1.0, 3.0]
      veilStrength: Math.max(0, Math.min(1, output[2])),
      bareCanvasThreshold: Math.max(0, Math.min(1, output[3])),
      darkSoftening: Math.max(0, Math.min(1, output[4])),
      accentTiming: Math.max(0, Math.min(1, output[5])),
      interRegionBleed: Math.max(0, Math.min(1, output[6])),
    };
  } catch {
    return conductPainting(composition, focalPoint, fogDensity, budget, features);
  }
}
