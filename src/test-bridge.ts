// Test bridge — exposes app internals for headless Playwright testing
// Only loaded when ?test is in the URL (see main.ts)

import { sceneStore, type MaterialType } from './state/scene-state.js';
import { sessionStore } from './session/session-state.js';
import { uiStore, pointerQueue, type Tool } from './state/ui-state.js';
import { markAllDirty } from './state/dirty-flags.js';
import { getAllMoods, loadCustomMoods } from './mood/custom-moods.js';
import { deriveAtmosphere } from './mood/derive-atmosphere.js';
import { getMaterial } from './surface/materials.js';
import { syncBrushSlotsFromSession, setActiveBrushSlot } from './painting/palette.js';
import { clearSurface } from './painting/surface.js';
import { resetSessionTimer } from './session/session-timer.js';

export interface StrokePoint {
  x: number;       // 0-1 normalized
  y: number;       // 0-1 normalized
  pressure: number; // 0-1
  tiltX?: number;
  tiltY?: number;
}

export interface StrokeOptions {
  tool?: Tool;
  brushSlot?: number;
  hueIndex?: number;
  brushSize?: number;
  thinners?: number;
  load?: number;
}

function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    function tick() {
      if (++count >= n) resolve();
      else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function applyMood(index: number) {
  loadCustomMoods();
  const moods = getAllMoods();
  if (index >= moods.length) return;

  const mood = moods[index];
  const atmosphere = deriveAtmosphere(mood);
  const materialType = (mood.defaultSurface || 'board') as MaterialType;
  const mat = getMaterial(materialType);

  sessionStore.set({ moodIndex: index });
  sceneStore.update((s) => ({
    mood: mood.name,
    atmosphere,
    sunAngle: mood.sunAngle,
    sunElevation: mood.sunElevation,
    horizonY: mood.horizonY,
    surface: {
      ...s.surface,
      material: materialType,
      absorption: mat.absorption,
      drySpeed: mat.drySpeed,
    },
    palette: {
      colors: mood.piles.map(p => ({ r: p.medium.r, g: p.medium.g, b: p.medium.b, a: 1 })),
      activeIndex: 0,
      tonalValues: [0.5, 0.5, 0.5, 0.5, 0.5],
    },
  }));
  markAllDirty();
}

async function setPhase(phase: 'test' | 'paint') {
  const current = sessionStore.get().phase;

  if (current === 'prepare' && (phase === 'test' || phase === 'paint')) {
    sessionStore.set({ phase: 'test' });
    syncBrushSlotsFromSession();
    await waitFrames(5);
  }

  if (phase === 'paint' && sessionStore.get().phase === 'test') {
    sessionStore.set({
      phase: 'paint',
      bristleSeeds: Array.from({ length: 5 }, () => Math.random()),
    });
    clearSurface();
    resetSessionTimer();
    syncBrushSlotsFromSession();
    markAllDirty();
    await waitFrames(5);
  }
}

async function replayStroke(points: StrokePoint[], options: StrokeOptions = {}) {
  if (points.length < 2) return;

  const {
    tool = 'form',
    brushSlot = 2,
    hueIndex,
    brushSize,
    thinners,
    load,
  } = options;

  // Configure tool and brush
  uiStore.set({ activeTool: tool });
  if (brushSlot !== undefined) {
    uiStore.set({ activeBrushSlot: brushSlot });
    setActiveBrushSlot(brushSlot);
  }
  if (brushSize !== undefined) {
    uiStore.set({ brushSize });
  }
  if (hueIndex !== undefined) {
    sceneStore.update(s => ({
      palette: { ...s.palette, activeIndex: hueIndex },
    }));
  }
  if (thinners !== undefined) {
    sceneStore.set({ thinners });
  }
  if (load !== undefined) {
    sceneStore.set({ load });
  }

  await waitFrames(2);

  // Begin stroke with first point
  const p0 = points[0];
  pointerQueue.length = 0;
  uiStore.set({
    mouseX: p0.x,
    mouseY: p0.y,
    mouseDown: true,
    pressure: p0.pressure,
    tiltX: p0.tiltX || 0,
    tiltY: p0.tiltY || 0,
  });
  await waitFrames(2);

  // Feed points in batches — 5 per frame for smooth interpolation
  const batchSize = 5;
  for (let i = 1; i < points.length; i += batchSize) {
    const end = Math.min(i + batchSize, points.length);
    for (let j = i; j < end; j++) {
      const p = points[j];
      pointerQueue.push({
        x: p.x,
        y: p.y,
        pressure: p.pressure,
        tiltX: p.tiltX || 0,
        tiltY: p.tiltY || 0,
      });
    }
    const last = points[end - 1];
    uiStore.set({
      mouseX: last.x,
      mouseY: last.y,
      pressure: last.pressure,
      tiltX: last.tiltX || 0,
      tiltY: last.tiltY || 0,
    });
    await waitFrames(1);
  }

  // End stroke — let ghost taper complete
  uiStore.set({ mouseDown: false, pressure: 0 });
  await waitFrames(5);
}

// Expose on window
const bridge = {
  ready: true,
  applyMood,
  setPhase,
  replayStroke,
  waitFrames,

  // Direct store access
  stores: { scene: sceneStore, session: sessionStore, ui: uiStore },
  pointerQueue,

  // Convenience setters
  setThinners: (v: number) => sceneStore.set({ thinners: v }),
  setLoad: (v: number) => sceneStore.set({ load: v }),
  setBrushSize: (v: number) => uiStore.set({ brushSize: v }),
  setBrushSlot: (slot: number) => {
    uiStore.set({ activeBrushSlot: slot });
    setActiveBrushSlot(slot);
  },
  setHueIndex: (i: number) => sceneStore.update(s => ({
    palette: { ...s.palette, activeIndex: i },
  })),
  setTool: (t: Tool) => uiStore.set({ activeTool: t }),
};

(window as any).__ghz = bridge;
console.log('[GHZ Test Bridge] Ready');
