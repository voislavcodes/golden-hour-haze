import { createStore } from './store.js';

// --- V2 Type Definitions ---

export interface AtmosphereParams {
  density: number;       // 0-1
  warmth: number;        // -1 to 1 (cool to warm)
  grain: number;         // 0-1 grain intensity
  scatter: number;       // 0-1 scatter amount
  driftX: number;        // drift field direction
  driftY: number;
  driftSpeed: number;
  turbulence: number;    // 0-1
  grainAngle: number;    // radians, rotates grain texture
  grainDepth: number;    // 0-1, grain persistence with depth
}

export interface LightDef {
  x: number;             // 0-1
  y: number;             // 0-1
  coreRadius: number;    // default 0.02
  bloomRadius: number;   // default 0.08
  intensity: number;     // 0.05-1.0, default 0.6
  aspectRatio: number;   // 1.0=circle, >1=tall, <1=wide
  rotation: number;      // radians
  paletteSlot: number;   // -1=auto from TIME, 0-4=locked
  colorR: number;        // resolved color (computed before GPU upload)
  colorG: number;
  colorB: number;
  depth: number;         // 0.5 default
}

export interface AnchorPoint {
  x: number;
  y: number;
  chromaBoost: number;
  muteFalloff: number;
}

export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PaletteState {
  colors: PaletteColor[];
  activeIndex: number;
  tonalValues: number[];  // per-swatch value, 0=light 1=dark, default 0.5
}

export interface SurfaceParams {
  grainSize: number;        // 0-1, fine→coarse (X axis)
  directionality: number;   // 0-1, isotropic→directional (Y axis)
  intensity: number;        // 0-0.2, texture visibility
  mode: 'standard' | 'woodblock';
}

export interface CompositorParams {
  shadowChroma: number;
  grayscale: number;
  anchorX: number;
  anchorY: number;
  anchorBoost: number;
  anchorFalloff: number;
  sunGradeWarmth: number;
  sunGradeIntensity: number;
  grainIntensity?: number;
  grainAngle?: number;
  grainDepth?: number;
  grainScale?: number;
  surfaceIntensity?: number;
}

export const MAX_LIGHTS = 16;

// --- V2 Scene State ---

export interface SceneState {
  sunAngle: number;
  sunElevation: number;
  atmosphere: AtmosphereParams;
  surface: SurfaceParams;
  horizonY: number;
  palette: PaletteState;
  lights: LightDef[];
  velvet: number;       // 0-1, brush edge softness
  echo: number;         // 0-1, surface color pickup
  baseOpacity: number;  // 0.1-1.0, default 0.5
  falloff: number;      // 0.5-0.9, diminishing returns per layer (default 0.7)
  anchor: AnchorPoint | null;
  shadowChroma: number; // 0-1, color-in-shadow intensity
}

/** Derive sun elevation from dial angle */
export function sunElevationFromAngle(angle: number): number {
  return Math.sin(angle - Math.PI / 2) * 0.35 + 0.25;
}

/** Golden hour factor: 0 at noon, 1 at golden hour */
export function goldenFactor(sunElevation: number): number {
  return Math.max(0, 1.0 - Math.min(1.0, Math.max(0, sunElevation) * 2.5));
}

/** Auto light color from TIME (sun elevation) */
export function autoColorFromTime(sunElevation: number): { r: number; g: number; b: number } {
  const gf = goldenFactor(sunElevation);
  return {
    r: 0.9 + gf * 0.1,
    g: 0.75 + (1 - gf) * 0.2,
    b: 0.5 + (1 - gf) * 0.45,
  };
}

const defaultPalette: PaletteState = {
  colors: [
    { r: 0.95, g: 0.65, b: 0.25, a: 1 }, // warm gold
    { r: 0.85, g: 0.35, b: 0.20, a: 1 }, // burnt orange
    { r: 0.55, g: 0.30, b: 0.45, a: 1 }, // muted purple
    { r: 0.20, g: 0.35, b: 0.55, a: 1 }, // twilight blue
    { r: 0.80, g: 0.75, b: 0.60, a: 1 }, // warm cream
  ],
  activeIndex: 0,
  tonalValues: [0.5, 0.5, 0.5, 0.5, 0.5],
};

export const sceneStore = createStore<SceneState>({
  atmosphere: {
    density: 0.5,
    warmth: 0.3,
    grain: 0.4,
    scatter: 0.6,
    driftX: 0.1,
    driftY: 0.05,
    driftSpeed: 0.3,
    turbulence: 0.4,
    grainAngle: 0,
    grainDepth: 0.5,
  },
  surface: {
    grainSize: 0.3,
    directionality: 0.7,
    intensity: 0.08,
    mode: 'standard',
  },
  lights: [],
  palette: defaultPalette,
  sunAngle: 1.28,
  sunElevation: sunElevationFromAngle(1.28),
  horizonY: 0.5,
  echo: 0.0,
  anchor: null,
  velvet: 0.5,
  shadowChroma: 0.4,
  baseOpacity: 0.5,
  falloff: 0.7,
});
