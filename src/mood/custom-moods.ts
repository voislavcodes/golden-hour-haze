// Custom mood persistence — save/load user-created moods from localStorage

import type { Mood } from './moods.js';
import { MOODS } from './moods.js';
import { huesToMoodPiles } from './oklch.js';

const STORAGE_KEY = 'ghz-custom-moods';

interface StoredCustomMood {
  name: string;
  hues: number[];  // 5 OKLCH hue angles
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
  const stored: StoredCustomMood[] = customMoods.map(m => ({
    name: m.name,
    hues: (m as any)._hues ?? [0, 72, 144, 216, 288],
    density: m.density,
    warmth: m.warmth,
    defaultSurface: m.defaultSurface,
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

/** Convert stored data to a full Mood object */
function hydrateCustomMood(s: StoredCustomMood): Mood {
  const piles = huesToMoodPiles(s.hues);
  const mood: Mood & { _hues: number[] } = {
    name: s.name,
    description: 'Custom mood',
    density: s.density,
    sunAngle: 1.28,
    sunElevation: 0.15,
    horizonY: 0.5,
    warmth: s.warmth,
    piles,
    defaultSurface: s.defaultSurface,
    _hues: s.hues,
  };
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

/** Add a new custom mood from 5 hue angles */
export function addCustomMood(name: string, hues: number[], density = 0.4, warmth = 0.0): Mood {
  const piles = huesToMoodPiles(hues);
  const mood: Mood & { _hues: number[] } = {
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
