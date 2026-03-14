// Feature Serialization — type→Float32Array converters for ML model inputs
// Deterministic field ordering for reproducible inference.

import type { Region, RegionClass } from './region-analysis.js';
import type {
  AccentResult, ColorAnalysis, CompositionClass, DepthClass,
  FocalPoint, LayerBudget, SceneFeatures, StrokeType,
} from './types.js';

// --- SceneFeatures (30 floats) ---
// SceneFeatures has 32 named fields. Two pairs are redundant:
// countVertical/verticalCount and countMass/massCount.
// Serializer uses countVertical and countMass, skips the duplicates.

export const SCENE_FEATURE_ORDER = [
  'countSky', 'countGround', 'countHorizon', 'countMass',
  'countVertical', 'countAccent', 'countReflection', 'countFill',
  'avgYVerticals', 'spreadYVerticals', 'avgYMasses', 'spreadYMasses',
  'countNear', 'countMid', 'countFar',
  'ratioSharp', 'ratioSoft',
  'hasAccent', 'accentX', 'accentY', 'accentChroma',
  'totalDarkArea', 'totalLightArea', 'darkToLightRatio',
  'horizonY', 'skyAreaFraction', 'groundAreaFraction',
  'avgChroma', 'chromaRange', 'dominantHueAngle',
] as const; // 30 fields — verticalCount/massCount excluded (dupes)

export function serializeSceneFeatures(f: SceneFeatures): Float32Array {
  return new Float32Array([
    f.countSky, f.countGround, f.countHorizon, f.countMass,
    f.countVertical, f.countAccent, f.countReflection, f.countFill,
    f.avgYVerticals, f.spreadYVerticals, f.avgYMasses, f.spreadYMasses,
    f.countNear, f.countMid, f.countFar,
    f.ratioSharp, f.ratioSoft,
    f.hasAccent, f.accentX, f.accentY, f.accentChroma,
    f.totalDarkArea, f.totalLightArea, f.darkToLightRatio,
    f.horizonY, f.skyAreaFraction, f.groundAreaFraction,
    f.avgChroma, f.chromaRange, f.dominantHueAngle,
  ]);
}

// --- Classification one-hot helpers ---

const REGION_CLASSES: RegionClass[] = [
  'sky', 'ground', 'horizon', 'mass', 'vertical', 'accent', 'reflection', 'fill',
];

const DEPTH_CLASSES: DepthClass[] = ['near', 'mid', 'far'];

const COMPOSITION_CLASSES: CompositionClass[] = [
  'lonely-figure', 'street-scene', 'seascape',
  'twilight-glow', 'intimate-scene', 'abstract-masses',
];

const STROKE_TYPES: StrokeType[] = [
  'horizontal-wash', 'vertical-stroke', 'clustered-dabs', 'single-dab', 'arc',
];

const FOCAL_TYPES = ['point', 'figure', 'band', 'distributed'] as const;

function oneHot<T>(value: T, classes: readonly T[]): number[] {
  return classes.map(c => c === value ? 1.0 : 0.0);
}

// --- Per-region context (32 floats) for SO1 ParamRefineNet ---
// 32 = classification one-hot(8) + depth one-hot(3) + meldrum(1) + position(2) +
//      focal_dist(1) + composition one-hot(6) + fog(1) + area(1) + chroma(1) +
//      edge_sharpness(1) + is_accent(1) + stroke_type one-hot(5) + same_band_count(1)

export function serializeRegionContext(
  region: Region,
  depth: DepthClass,
  color: ColorAnalysis,
  tone: number,
  focalDist: number,
  composition: CompositionClass,
  fogDensity: number,
  accent: AccentResult,
  strokeType: StrokeType,
  regionCountSameBand: number,
): Float32Array {
  const arr = new Float32Array(32);
  let i = 0;
  // classification one-hot(8)
  for (const v of oneHot(region.classification, REGION_CLASSES)) arr[i++] = v;
  // depth one-hot(3)
  for (const v of oneHot(depth, DEPTH_CLASSES)) arr[i++] = v;
  // meldrum (normalized 0-1)
  arr[i++] = tone / 4;
  // position (centroid x, y)
  arr[i++] = region.centroid.x;
  arr[i++] = region.centroid.y;
  // focal distance
  arr[i++] = focalDist;
  // composition one-hot(6)
  for (const v of oneHot(composition, COMPOSITION_CLASSES)) arr[i++] = v;
  // fog density
  arr[i++] = fogDensity;
  // area fraction
  arr[i++] = region.areaFraction;
  // chroma
  arr[i++] = color.avgChroma;
  // edge sharpness (proxy via edgeDensity)
  arr[i++] = region.edgeDensity;
  // is accent
  arr[i++] = accent.isAccent ? 1 : 0;
  // stroke type one-hot(5)
  for (const v of oneHot(strokeType, STROKE_TYPES)) arr[i++] = v;
  // same-band region count
  arr[i++] = regionCountSameBand;
  return arr;
}

// --- Conductor input (30 floats) for SO2 ConductorNet ---
// 30 = composition one-hot(6) + focal_type one-hot(4) + focal_xy(2) + fog(1) +
//      budget_6(6) + class_counts(8) + depth_counts(3)

export function serializeConductorInput(
  composition: CompositionClass,
  focalPoint: FocalPoint,
  fogDensity: number,
  budget: LayerBudget,
  features: SceneFeatures,
): Float32Array {
  const arr = new Float32Array(30);
  let i = 0;
  // composition one-hot(6)
  for (const v of oneHot(composition, COMPOSITION_CLASSES)) arr[i++] = v;
  // focal type one-hot(4)
  for (const v of oneHot(focalPoint.type, FOCAL_TYPES)) arr[i++] = v;
  // focal position
  arr[i++] = focalPoint.x;
  arr[i++] = focalPoint.y;
  // fog density
  arr[i++] = fogDensity;
  // budget (6 values, normalized by total)
  const total = Math.max(1, budget.atmosphere + budget.background + budget.midtones +
    budget.darkForms + budget.accents + budget.veil);
  arr[i++] = budget.atmosphere / total;
  arr[i++] = budget.background / total;
  arr[i++] = budget.midtones / total;
  arr[i++] = budget.darkForms / total;
  arr[i++] = budget.accents / total;
  arr[i++] = budget.veil / total;
  // class counts (8)
  arr[i++] = features.countSky;
  arr[i++] = features.countGround;
  arr[i++] = features.countHorizon;
  arr[i++] = features.countMass;
  arr[i++] = features.countVertical;
  arr[i++] = features.countAccent;
  arr[i++] = features.countReflection;
  arr[i++] = features.countFill;
  // depth counts (3)
  arr[i++] = features.countNear;
  arr[i++] = features.countMid;
  arr[i++] = features.countFar;
  return arr;
}
