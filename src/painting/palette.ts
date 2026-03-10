// 15-pile palette + per-slot brush contamination
// Each mood provides 5 hues × 3 values (light/medium/dark)
// Brush slots carry residue from previous colors

import { sceneStore } from '../state/scene-state.js';
import { MOODS, type KColor, type MoodPile } from '../mood/moods.js';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rgbToReflectance(c: KColor): KColor {
  const r = clamp(c.r, 0.001, 0.999);
  const g = clamp(c.g, 0.001, 0.999);
  const b = clamp(c.b, 0.001, 0.999);
  return { r: r * r, g: g * g, b: b * b };
}

function ksFromReflectance(r: number): number {
  return (1 - r) * (1 - r) / (2 * r);
}

function reflectanceFromKS(ks: number): number {
  return 1 + ks - Math.sqrt(ks * ks + 2 * ks);
}

export function kmMixCPU(c1: KColor, c2: KColor, t: number): KColor {
  const r1 = rgbToReflectance(c1);
  const r2 = rgbToReflectance(c2);

  const ks1r = ksFromReflectance(r1.r), ks1g = ksFromReflectance(r1.g), ks1b = ksFromReflectance(r1.b);
  const ks2r = ksFromReflectance(r2.r), ks2g = ksFromReflectance(r2.g), ks2b = ksFromReflectance(r2.b);

  const ksr = ks1r + (ks2r - ks1r) * t;
  const ksg = ks1g + (ks2g - ks1g) * t;
  const ksb = ks1b + (ks2b - ks1b) * t;

  return {
    r: Math.sqrt(clamp(reflectanceFromKS(ksr), 0, 1)),
    g: Math.sqrt(clamp(reflectanceFromKS(ksg), 0, 1)),
    b: Math.sqrt(clamp(reflectanceFromKS(ksb), 0, 1)),
  };
}

/** Convert an RGB color to per-channel K-M absorption coefficients */
export function rgbToKS(color: KColor): { Kr: number; Kg: number; Kb: number } {
  const rr = Math.max(color.r * color.r, 0.001);
  const rg = Math.max(color.g * color.g, 0.001);
  const rb = Math.max(color.b * color.b, 0.001);
  return {
    Kr: (1 - rr) * (1 - rr) / (2 * rr),
    Kg: (1 - rg) * (1 - rg) / (2 * rg),
    Kb: (1 - rb) * (1 - rb) / (2 * rb),
  };
}

// --- Per-slot brush contamination ---

export interface BrushSlot {
  residueK: KColor;     // residue color on the brush
  residueAmount: number; // 0-1, how much residue
  age: number;           // 0=new, 0.5=worn, 1.0=old
  bristleSeed: number;   // random per session
}

const NUM_BRUSH_SLOTS = 5;
const brushSlots: BrushSlot[] = Array.from({ length: NUM_BRUSH_SLOTS }, () => ({
  residueK: { r: 0, g: 0, b: 0 },
  residueAmount: 0,
  age: 0,
  bristleSeed: Math.random(),
}));

// Active pile index (0-14 for the 15 piles in the 5×3 grid)
let activePileIndex = 0;
// Active brush size slot (0-4, maps to brush sizes)
let activeBrushSlot = 0;

export function setActivePile(index: number) {
  activePileIndex = clamp(index, 0, 14);
}

export function getActivePile(): number {
  return activePileIndex;
}

export function setActiveBrushSlot(slot: number) {
  activeBrushSlot = clamp(slot, 0, NUM_BRUSH_SLOTS - 1);
}

export function getActiveBrushSlot(): number {
  return activeBrushSlot;
}

export function getBrushSlot(index: number): BrushSlot {
  return brushSlots[clamp(index, 0, NUM_BRUSH_SLOTS - 1)];
}

export function setBrushSlotAge(index: number, age: number) {
  brushSlots[clamp(index, 0, NUM_BRUSH_SLOTS - 1)].age = age;
}

export function setBrushSlotSeed(index: number, seed: number) {
  brushSlots[clamp(index, 0, NUM_BRUSH_SLOTS - 1)].bristleSeed = seed;
}

/** Wipe brush on rag — reduce residue to 15% */
export function wipeOnRag() {
  const slot = brushSlots[activeBrushSlot];
  slot.residueAmount *= 0.15;
}

/** Get the current mood's piles */
export function getMoodPiles(): MoodPile[] {
  const moodName = sceneStore.get().mood;
  const mood = MOODS.find(m => m.name === moodName);
  return mood?.piles ?? MOODS[0].piles;
}

/** Get a specific pile color from the 15-pile grid */
export function getPileColor(pileIndex: number): KColor {
  const piles = getMoodPiles();
  const hueIdx = Math.floor(pileIndex / 3);
  const valueIdx = pileIndex % 3; // 0=light, 1=medium, 2=dark
  const pile = piles[clamp(hueIdx, 0, piles.length - 1)];
  return valueIdx === 0 ? pile.light : valueIdx === 1 ? pile.medium : pile.dark;
}

/**
 * Dip brush — set active color from pile, apply contamination, reload reservoir.
 * The dipped color mixes with existing brush residue.
 */
export function dipBrush(pileIndex: number) {
  activePileIndex = clamp(pileIndex, 0, 14);
  const pileColor = getPileColor(activePileIndex);
  const slot = brushSlots[activeBrushSlot];

  // Mix pile color with existing residue (contamination)
  if (slot.residueAmount > 0.05) {
    slot.residueK = kmMixCPU(pileColor, slot.residueK, slot.residueAmount * 0.3);
  } else {
    slot.residueK = { ...pileColor };
  }
  slot.residueAmount = Math.min(1.0, slot.residueAmount + 0.3);
}

/**
 * Get active palette K-M coefficients for the brush shader.
 * Reads from 15-pile mood system + per-slot contamination.
 */
export function getActiveKS(): { Kr: number; Kg: number; Kb: number; color: KColor } {
  const pileColor = getPileColor(activePileIndex);
  const slot = brushSlots[activeBrushSlot];

  // Apply contamination
  let finalColor: KColor;
  if (slot.residueAmount > 0.05) {
    finalColor = kmMixCPU(pileColor, slot.residueK, slot.residueAmount * 0.15);
  } else {
    finalColor = pileColor;
  }

  const ks = rgbToKS(finalColor);
  return { ...ks, color: finalColor };
}
