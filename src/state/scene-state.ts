import { createStore } from './store.js';
import type { AtmosphereParams, DepthFieldParams, FormDef, LightDef, PaletteState } from '../layers/layer-types.js';

export interface SceneState {
  depth: DepthFieldParams;
  atmosphere: AtmosphereParams;
  forms: FormDef[];
  lights: LightDef[];
  palette: PaletteState;
  sunAngle: number; // radians, drives time-of-day
  sunElevation: number;
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
  },
  forms: [],
  lights: [],
  palette: defaultPalette,
  sunAngle: 0.8, // ~golden hour angle
  sunElevation: 0.15,
});
