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

export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PaletteState {
  colors: PaletteColor[];
  activeIndex: number;
  activeTonalIndex: number;  // 0-4 Meldrum row (0=white, 2=mid, 4=black)
  tonalValues: number[];  // per-swatch value, 0=light 1=dark, default 0.5
}

export type MaterialType = 'board' | 'canvas' | 'paper' | 'gesso';

export interface SurfaceParams {
  material: MaterialType;
  tone: number;           // 0–1 (light → dark within material range)
  grainScale: number;     // 0–1 roughness (smooth → rough texture depth)
  grainSize: number;      // 0–1 (fine → coarse, narrow per-material range)
  seed: number;           // random per session
  intensity: number;      // 0–0.2 (grain visibility in compositor)
  absorption: number;     // derived from material
  drySpeed: number;       // derived from material
}

export interface CompositorParams {
  shadowChroma: number;
  grayscale: number;
  grainIntensity?: number;
  grainAngle?: number;
  grainDepth?: number;
  grainScale?: number;
  surfaceIntensity?: number;
  sessionTime?: number;
  surfaceDrySpeed?: number;
}

// --- V2 Scene State ---

export interface SceneState {
  mood: string;           // mood name
  sunAngle: number;
  sunElevation: number;
  atmosphere: AtmosphereParams;
  surface: SurfaceParams;
  horizonY: number;
  palette: PaletteState;
  thinners: number;     // 0-1, master physics variable
  load: number;         // 0-1, paint reservoir amount
  falloff: number;      // 0.5-0.9, diminishing returns per layer (default 0.7)
  shadowChroma: number; // 0-1, color-in-shadow intensity
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
  activeTonalIndex: 2,
  tonalValues: [0.5, 0.5, 0.5, 0.5, 0.5],
};

export const sceneStore = createStore<SceneState>({
  mood: 'Golden Hour',
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
    material: 'board' as const,
    tone: 0.3,
    grainScale: 0.5,
    grainSize: 0.5,
    seed: Math.random() * 1000,
    intensity: 0.08,
    absorption: 0.15,
    drySpeed: 1.0,
  },
  palette: defaultPalette,
  sunAngle: 1.28,
  sunElevation: 0.15,
  horizonY: 0.5,
  thinners: 0.25,
  load: 0.5,
  shadowChroma: 0.4,
  falloff: 0.7,
});
