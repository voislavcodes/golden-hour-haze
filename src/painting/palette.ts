// 5-hue tonal column palette + per-slot brush contamination
// Each mood provides 5 base hues; continuous tonal value (0=light, 1=dark) per swatch
// Brush slots carry residue from previous colors

import { sceneStore } from '../state/scene-state.js';
import { sessionStore } from '../session/session-state.js';
import { DEFAULT_COMPLEMENT, type KColor, type ComplementConfig } from '../mood/moods.js';
import { getAllMoods } from '../mood/custom-moods.js';

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

// --- Oil medium state ---

let oilArmed = false;
let oilRemaining = 0;
const OIL_TRANSFER_RATE = 0.5;

export function isOilArmed(): boolean { return oilArmed; }
export function getOilRemaining(): number { return oilRemaining; }

export function toggleOil() {
  oilArmed = !oilArmed;
  document.dispatchEvent(new CustomEvent('oil-changed'));
}

export function depleteOil() {
  oilRemaining *= (1 - OIL_TRANSFER_RATE);
  if (oilRemaining < 0.01) oilRemaining = 0;
}

// --- Anchor chroma unlock state ---

let anchorArmed = false;
let anchorRemaining = 0;

export function isAnchorArmed(): boolean { return anchorArmed; }
export function getAnchorRemaining(): number { return anchorRemaining; }

export function toggleAnchor() {
  anchorArmed = !anchorArmed;
  document.dispatchEvent(new CustomEvent('anchor-changed'));
}

// --- Tonal column sampling ---

function lerpColor(a: KColor, b: KColor, t: number): KColor {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function saturateAndDarken(c: KColor, amount: number): KColor {
  const max = Math.max(c.r, c.g, c.b);
  const factor = 1 - amount;
  return {
    r: c.r * factor * (c.r / Math.max(max, 0.001)),
    g: c.g * factor * (c.g / Math.max(max, 0.001)),
    b: c.b * factor * (c.b / Math.max(max, 0.001)),
  };
}

export const WARM_WHITE: KColor = { r: 0.95, g: 0.93, b: 0.88 };

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function computeNeutralTarget(color: KColor, warmth: number): KColor {
  const ref = rgbToReflectance(color);
  const kr = ksFromReflectance(ref.r);
  const kg = ksFromReflectance(ref.g);
  const kb = ksFromReflectance(ref.b);
  const kAvg = (kr + kg + kb) / 3;
  // warmth > 0.5 = warm neutral (less red absorption, more blue absorption)
  const shift = (warmth - 0.5) * 0.3;
  return {
    r: Math.sqrt(clamp(reflectanceFromKS(Math.max(0, kAvg * (1 - shift))), 0, 1)),
    g: Math.sqrt(clamp(reflectanceFromKS(Math.max(0, kAvg)), 0, 1)),
    b: Math.sqrt(clamp(reflectanceFromKS(Math.max(0, kAvg * (1 + shift))), 0, 1)),
  };
}

export function sampleTonalColumn(baseColor: KColor, value: number, complement?: ComplementConfig): KColor {
  // value 0.0 = lightest (warm white tinted with hue)
  // value 0.5 = base color (mood's medium)
  // value 1.0 = darkest (saturated dark pigment)
  let color: KColor;
  if (value < 0.5) {
    const t = value * 2.0;
    color = lerpColor(WARM_WHITE, baseColor, t);
  } else {
    const t = (value - 0.5) * 2.0;
    const darkEnd = saturateAndDarken(baseColor, 0.7);
    color = lerpColor(baseColor, darkEnd, t);
  }
  // Complement neutralization in dark zone
  if (complement && value > complement.onset) {
    const blend = smoothstep(complement.onset, complement.full, value) * complement.strength;
    const neutral = computeNeutralTarget(color, complement.warmth);
    color = kmMixCPU(color, neutral, blend);
  }
  return color;
}

// --- Per-slot brush contamination ---

export interface BrushSlot {
  residueK: KColor;     // residue color on the brush
  residueAmount: number; // 0-1, how much residue
  age: number;           // 0=new, 0.5=worn, 1.0=old
  bristleSeed: number;   // random per session
}

export const BRUSH_SLOT_NAMES = ['Detail', 'Small', 'Medium', 'Large', 'Wash'] as const;
export const BRUSH_SLOT_SIZES = [0.012, 0.025, 0.05, 0.10, 0.20] as const;

const NUM_BRUSH_SLOTS = 5;
const brushSlots: BrushSlot[] = Array.from({ length: NUM_BRUSH_SLOTS }, () => ({
  residueK: { r: 0, g: 0, b: 0 },
  residueAmount: 0,
  age: 0,
  bristleSeed: Math.random(),
}));

// Active hue index (0-4 for the 5 tonal columns)
let activeHueIndex = 0;
// Active brush size slot (0-4, maps to brush sizes)
let activeBrushSlot = 0;

export function setActiveHue(index: number) {
  activeHueIndex = clamp(index, 0, 4);
}

export function getActiveHue(): number {
  return activeHueIndex;
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
  oilRemaining = 0;
  anchorRemaining = 0;
}

export function getActiveComplement(): ComplementConfig {
  const moodIndex = sessionStore.get().moodIndex ?? 0;
  const moods = getAllMoods();
  const mood = moods[moodIndex];
  return mood?.complement ?? DEFAULT_COMPLEMENT;
}

/** Get color at current tonal value for a hue index */
function getColorAtValue(hueIndex: number): KColor {
  const palette = sceneStore.get().palette;
  const baseColor = palette.colors[clamp(hueIndex, 0, palette.colors.length - 1)];
  const value = palette.tonalValues[clamp(hueIndex, 0, palette.tonalValues.length - 1)];
  return sampleTonalColumn(baseColor, value, getActiveComplement());
}

/**
 * Dip brush — set active color from tonal column, apply contamination, reload reservoir.
 * The dipped color mixes with existing brush residue.
 */
export function dipBrush(hueIndex: number) {
  activeHueIndex = clamp(hueIndex, 0, 4);
  const color = getColorAtValue(activeHueIndex);
  const slot = brushSlots[activeBrushSlot];

  // Mix pile color with existing residue (contamination)
  if (slot.residueAmount > 0.05) {
    slot.residueK = kmMixCPU(color, slot.residueK, slot.residueAmount * 0.3);
  } else {
    slot.residueK = { ...color };
  }
  slot.residueAmount = Math.min(1.0, slot.residueAmount + 0.3);

  if (oilArmed) {
    oilRemaining = 1.0;
    oilArmed = false;
    document.dispatchEvent(new CustomEvent('oil-changed'));
  }

  if (anchorArmed) {
    anchorRemaining = 1.0;
    anchorArmed = false;
    document.dispatchEvent(new CustomEvent('anchor-changed'));
  } else {
    anchorRemaining = 0;
  }
}

/** Sync brush slot ages and seeds from session store into runtime slots */
export function syncBrushSlotsFromSession() {
  const { brushAges, bristleSeeds } = sessionStore.get();
  for (let i = 0; i < NUM_BRUSH_SLOTS; i++) {
    brushSlots[i].age = brushAges[i] ?? 0;
    brushSlots[i].bristleSeed = bristleSeeds[i] ?? Math.random();
  }
}

/**
 * Get active palette K-M coefficients for the brush shader.
 * Reads from tonal column system + per-slot contamination.
 */
export function getActiveKS(): { Kr: number; Kg: number; Kb: number; color: KColor } {
  const color = getColorAtValue(activeHueIndex);
  const slot = brushSlots[activeBrushSlot];

  // Apply contamination
  let finalColor: KColor;
  if (slot.residueAmount > 0.05) {
    finalColor = kmMixCPU(color, slot.residueK, slot.residueAmount * 0.15);
  } else {
    finalColor = color;
  }

  const ks = rgbToKS(finalColor);
  return { ...ks, color: finalColor };
}

/** Simulate compositor pipeline for UI preview: K-M → reflectance → gamma → tonemap → sRGB */
export function previewColor(c: KColor, anchored: boolean): KColor {
  const ks = rgbToKS(c);
  const gamma = anchored ? 0.85 : 0.65;
  let r = Math.pow(clamp(reflectanceFromKS(ks.Kr), 0, 1), gamma);
  let g = Math.pow(clamp(reflectanceFromKS(ks.Kg), 0, 1), gamma);
  let b = Math.pow(clamp(reflectanceFromKS(ks.Kb), 0, 1), gamma);
  // ACES Narkowicz tonemap (same for both paths — gamma does the chroma work)
  r = (r * (r * 2.51 + 0.03)) / (r * (r * 2.43 + 0.59) + 0.14);
  g = (g * (g * 2.51 + 0.03)) / (g * (g * 2.43 + 0.59) + 0.14);
  b = (b * (b * 2.51 + 0.03)) / (b * (b * 2.43 + 0.59) + 0.14);
  const toSrgb = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return { r: clamp(toSrgb(r), 0, 1), g: clamp(toSrgb(g), 0, 1), b: clamp(toSrgb(b), 0, 1) };
}
