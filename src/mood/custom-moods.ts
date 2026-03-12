// Custom mood persistence — save/load user-created moods from localStorage

import type { Mood, MoodPile } from './moods.js';
import { DEFAULT_COMPLEMENT, MOODS } from './moods.js';
import { huesToMoodPiles, oklchToPile, type OklchColor } from './oklch.js';

const STORAGE_KEY = 'ghz-custom-moods';

interface StoredCustomMood {
  name: string;
  hues?: number[];         // legacy: 5 OKLCH hue angles
  colors?: OklchColor[];   // new: 5 full OKLCH values
  density: number;
  warmth: number;
  defaultSurface: string;
}

let customMoods: Mood[] = [];

/** Load custom moods from localStorage on startup */
export function loadCustomMoods() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const stored: StoredCustomMood[] = JSON.parse(raw);
    customMoods = stored.map(s => hydrateCustomMood(s));
  } catch {
    customMoods = [];
  }
}

/** Save custom moods to localStorage */
function persistCustomMoods() {
  const stored: StoredCustomMood[] = customMoods.map(m => {
    const colors = (m as any)._colors as OklchColor[] | undefined;
    const base: StoredCustomMood = {
      name: m.name,
      density: m.density,
      warmth: m.warmth,
      defaultSurface: m.defaultSurface,
    };
    if (colors) {
      base.colors = colors;
    } else {
      base.hues = (m as any)._hues ?? [0, 72, 144, 216, 288];
    }
    return base;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

/** Convert stored data to a full Mood object */
function hydrateCustomMood(s: StoredCustomMood): Mood {
  // If stored with full OKLCH colors, generate piles from them
  const piles: MoodPile[] = s.colors
    ? s.colors.map(c => oklchToPile(c))
    : huesToMoodPiles(s.hues ?? [0, 72, 144, 216, 288]);

  const mood: Mood & { _hues?: number[]; _colors?: OklchColor[] } = {
    name: s.name,
    description: 'Custom mood',
    density: s.density,
    sunAngle: 1.28,
    sunElevation: 0.15,
    horizonY: 0.5,
    warmth: s.warmth,
    piles,
    defaultSurface: s.defaultSurface,
  };
  if (s.colors) mood._colors = s.colors;
  if (s.hues) mood._hues = s.hues;
  return mood;
}

/** Get all available moods (built-in + custom) */
export function getAllMoods(): Mood[] {
  return [...MOODS, ...customMoods];
}

/** Get only custom moods */
export function getCustomMoods(): Mood[] {
  return customMoods;
}

/** Add a new custom mood from 5 hue angles (manual slider path).
 *  chromaScale (0-1, default 1) reduces palette saturation for muted images. */
export function addCustomMood(name: string, hues: number[], density = 0.4, warmth = 0.0, chromaScale = 1): Mood {
  const piles = huesToMoodPiles(hues, chromaScale);
  const mood: Mood & { _hues: number[]; _chromaScale: number } = {
    name,
    description: 'Custom mood',
    density,
    sunAngle: 1.28,
    sunElevation: 0.15,
    horizonY: 0.5,
    warmth,
    piles,
    defaultSurface: 'board',
    _hues: hues,
    _chromaScale: chromaScale,
  };
  customMoods.push(mood);
  persistCustomMoods();
  return mood;
}

/** Add a custom mood from photo extraction — bent OKLCH colors stored directly (no lossy roundtrip) */
export function addCustomMoodFromExtraction(
  name: string,
  bentPiles: MoodPile[],
  bentOklch: OklchColor[],
  density = 0.4,
  warmth = 0.0,
): Mood {
  const mood: Mood & { _colors: OklchColor[] } = {
    name,
    description: 'Custom mood',
    density, warmth,
    sunAngle: 1.28,
    sunElevation: 0.15,
    horizonY: 0.5,
    piles: bentPiles,
    defaultSurface: 'board',
    complement: DEFAULT_COMPLEMENT,
    _colors: bentOklch,
  };
  customMoods.push(mood);
  persistCustomMoods();
  return mood;
}

/** Remove a custom mood by name */
export function removeCustomMood(name: string) {
  customMoods = customMoods.filter(m => m.name !== name);
  persistCustomMoods();
}

/** Create a mood from extracted photo hues (K-means result) */
export function addMoodFromPhotoHues(name: string, hues: number[]): Mood {
  return addCustomMood(name, hues, 0.35, 0.0);
}
