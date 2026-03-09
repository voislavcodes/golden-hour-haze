import { createStore } from './store.js';
import type { AtmosphereParams, DepthFieldParams, FormDef, LightDef, PaletteState, TonalMapParams, AnchorPoint } from '../layers/layer-types.js';

export interface SceneState {
  depth: DepthFieldParams;
  atmosphere: AtmosphereParams;
  forms: FormDef[];
  lights: LightDef[];
  palette: PaletteState;
  sunAngle: number; // radians, drives time-of-day
  sunElevation: number;
  horizonY: number; // 0-1, vertical horizon position (0=top, 1=bottom)
  echo: number; // 0-1, stroke coherence (controls form opacity/softness)
  tonalMap: TonalMapParams;
  anchor: AnchorPoint | null;
  velvet: number; // 0-1, surface smoothness
  tonalSort: boolean; // sort forms dark-to-light for K-M mixing
  shadowChroma: number; // 0-1, color-in-shadow intensity
  baseOpacity: number; // 0.1-1.0, glazing base opacity per stroke (default 0.5)
  falloff: number; // 0.5-0.9, diminishing returns per accumulated layer (default 0.7)
  orbPresets: (AtmosphereParams | null)[];
}

/** Derive sun elevation from dial angle. Shaped sine: golden hour → low, noon → high, night → negative */
export function sunElevationFromAngle(angle: number): number {
  return Math.sin(angle - Math.PI / 2) * 0.35 + 0.25;
}

/** Compute golden hour factor from sun elevation (0 at noon, 1 at golden hour, clamped for night) */
export function goldenFactor(sunElevation: number): number {
  return Math.max(0, 1.0 - Math.min(1.0, Math.max(0, sunElevation) * 2.5));
}

/** Derive auto light color from TIME (sun elevation). Golden → warm amber, blue hour → cool blue. */
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
};

export const sceneStore = createStore<SceneState>({
  depth: {
    nearPlane: 0.0,
    farPlane: 1.0,
    noiseScale: 2.0,
    noiseStrength: 0.3,
    controlPoints: new Float32Array(32), // 16 xy pairs
    controlCount: 0,
  },
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
  forms: [],
  lights: [],
  palette: defaultPalette,
  sunAngle: 1.28, // ~golden hour angle
  sunElevation: sunElevationFromAngle(1.28),
  horizonY: 0.5,
  echo: 0.5,
  tonalMap: { enabled: false, valueRange: 0.8, keyValue: 0.5, contrast: 0.6 },
  anchor: null,
  velvet: 0.6,
  tonalSort: true,
  shadowChroma: 0.4,
  baseOpacity: 0.5,
  falloff: 0.7,
  orbPresets: [null, null, null, null],
});
