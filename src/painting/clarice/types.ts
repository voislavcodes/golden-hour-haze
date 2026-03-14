// Shared types for the Clarice hierarchical organism architecture

export type DepthClass = 'near' | 'mid' | 'far';
export type StrokeType = 'horizontal-wash' | 'vertical-stroke' | 'clustered-dabs' | 'single-dab' | 'arc';
export type RecipeClass =
  | 'figure-umbrella' | 'figure-standing' | 'pole-simple' | 'pole-crossbar'
  | 'tree-rounded' | 'tree-spread' | 'hedge-band' | 'vehicle-body'
  | 'building-block' | 'atmospheric-wash';
export type CompositionClass =
  | 'lonely-figure' | 'street-scene' | 'seascape'
  | 'twilight-glow' | 'intimate-scene' | 'abstract-masses';
export type FocalType = 'point' | 'figure' | 'band' | 'distributed';
export type EdgeType = 'sharp' | 'soft' | 'none';

export interface ColorAnalysis {
  regionId: number;
  avgL: number;
  avgChroma: number;
  avgHue: number;
  nearestHueIndex: number;
  chromatic: boolean;
}

export interface AccentResult {
  regionId: number;
  isAccent: boolean;
  intensity: number;
}

export interface EdgeResult {
  regionA: number;
  regionB: number;
  edgeType: EdgeType;
}

export interface FocalPoint {
  x: number;
  y: number;
  type: FocalType;
}

export interface LayerBudget {
  atmosphere: number;
  background: number;
  midtones: number;
  darkForms: number;
  accents: number;
  veil: number;
}

export interface RefinedParams {
  thinners: number;
  load: number;
  pressure: number;
  brushSize: number;
  brushSlot: number;
}

export interface ConductorDecisions {
  restraint: number;
  focalDensity: number;
  veilStrength: number;
  bareCanvasThreshold: number;
  darkSoftening: number;
  accentTiming: number;
  interRegionBleed: number;
}

export interface SceneFeatures {
  countSky: number;
  countGround: number;
  countHorizon: number;
  countMass: number;
  countVertical: number;
  countAccent: number;
  countReflection: number;
  countFill: number;
  avgYVerticals: number;
  spreadYVerticals: number;
  avgYMasses: number;
  spreadYMasses: number;
  countNear: number;
  countMid: number;
  countFar: number;
  ratioSharp: number;
  ratioSoft: number;
  hasAccent: number;
  accentX: number;
  accentY: number;
  accentChroma: number;
  totalDarkArea: number;
  totalLightArea: number;
  darkToLightRatio: number;
  horizonY: number;
  verticalCount: number;
  massCount: number;
  skyAreaFraction: number;
  groundAreaFraction: number;
  avgChroma: number;
  chromaRange: number;
  dominantHueAngle: number;
}

export interface TissueContext {
  hueIndex: number;
  meldrumIndex: number;
  useOil: boolean;
  useAnchor: boolean;
}
