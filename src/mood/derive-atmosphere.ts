// Derive atmosphere parameters from mood definition
// Replaces TIME dial + ATMOSPHERE orb entirely

import type { Mood } from './moods.js';
import type { AtmosphereParams } from '../state/scene-state.js';

export function deriveAtmosphere(mood: Mood): AtmosphereParams {
  // Grain: derived from density — denser = less grain variation
  const grain = Math.max(0.1, 0.5 - mood.density * 0.4);

  // Scatter: proportional to density
  const scatter = mood.density * 0.8 + 0.2;

  return {
    density: mood.density,
    warmth: mood.warmth,
    grain,
    scatter,
    driftX: 0,
    driftY: 0,
    driftSpeed: 0,
    turbulence: 0,
    grainAngle: 0,
    grainDepth: 0.5,
  };
}
