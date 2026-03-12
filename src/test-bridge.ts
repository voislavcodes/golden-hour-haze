// Test bridge — exposes app internals for headless Playwright testing
// Only loaded when ?test is in the URL (see main.ts)

import { sceneStore, type MaterialType } from './state/scene-state.js';
import { sessionStore } from './session/session-state.js';
import { uiStore, pointerQueue, type Tool } from './state/ui-state.js';
import { markAllDirty } from './state/dirty-flags.js';
import { getAllMoods, loadCustomMoods } from './mood/custom-moods.js';
import { deriveAtmosphere } from './mood/derive-atmosphere.js';
import { getMaterial } from './surface/materials.js';
import { syncBrushSlotsFromSession, setActiveBrushSlot, setBrushSlotAge, dipBrush, wipeOnRag, toggleOil, sampleTonalColumn, getActiveComplement } from './painting/palette.js';
import { clearSurface, getSurfaceWidth, getSurfaceHeight } from './painting/surface.js';
import { getActiveBundle, getAverageLoad, resetActiveBundle } from './painting/bristle-bundle.js';
import { reloadBrush } from './painting/brush-engine.js';
import { resetSessionTimer } from './session/session-timer.js';
import { DEFAULT_COMPLEMENT } from './mood/moods.js';
import { getGPU } from './gpu/context.js';
import { getTexture } from './gpu/texture-pool.js';
import { getReadTexture, getStateReadTexture } from './painting/surface.js';
// Note: getSurfaceWidth/Height imported above with clearSurface

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
      if (++count >= n) {
        // Wait for GPU queue to finish processing the last frame
        getGPU().device.queue.onSubmittedWorkDone().then(resolve);
      } else {
        requestAnimationFrame(tick);
      }
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
    dipBrush(hueIndex);
    reloadBrush();
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
  markAllDirty();
  await waitFrames(5);
}

/** Read a pixel from a named pool texture via GPU readback (rgba16float → float32). */
async function readTexturePixel(name: string, x: number, y: number): Promise<number[]> {
  const { device } = getGPU();
  const tex = getTexture(name);
  if (!tex) return [-1, -1, -1, -1];

  // rgba16float = 8 bytes per pixel, bytesPerRow must be 256-aligned
  const bytesPerPixel = 8;
  const bytesPerRow = 256;
  const readBuffer = device.createBuffer({
    size: bytesPerRow,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Ensure fresh render
  markAllDirty();
  await new Promise<void>(resolve => {
    requestAnimationFrame(() => {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: tex, origin: { x, y, z: 0 } },
        { buffer: readBuffer, bytesPerRow },
        { width: 1, height: 1 },
      );
      device.queue.submit([encoder.finish()]);
      device.queue.onSubmittedWorkDone().then(() => resolve());
    });
  });

  await readBuffer.mapAsync(GPUMapMode.READ);
  const f16 = new Uint16Array(readBuffer.getMappedRange(0, bytesPerPixel));
  // Convert float16 to float32
  const result = Array.from(f16).map(f16ToF32);
  readBuffer.unmap();
  readBuffer.destroy();
  return result;
}

function f16ToF32(h: number): number {
  const sign = (h >> 15) & 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign ? -0 : 0;
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity);
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

/** Read a pixel from the canvas via offscreen copy (adds COPY_SRC to canvas config). */
async function readCanvasPixel(x: number, y: number): Promise<number[]> {
  const { device, context, format } = getGPU();

  // Reconfigure canvas with COPY_SRC so we can read back
  context.configure({ device, format, alphaMode: 'premultiplied',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });

  const bytesPerRow = 256;
  const readBuffer = device.createBuffer({
    size: bytesPerRow,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  markAllDirty();
  await new Promise<void>(resolve => {
    requestAnimationFrame(() => {
      // Frame loop's tick already rendered. Same frame → same getCurrentTexture.
      const canvasTexture = context.getCurrentTexture();
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: canvasTexture, origin: { x, y, z: 0 } },
        { buffer: readBuffer, bytesPerRow },
        { width: 1, height: 1 },
      );
      device.queue.submit([encoder.finish()]);
      device.queue.onSubmittedWorkDone().then(() => resolve());
    });
  });

  // Restore original config
  context.configure({ device, format, alphaMode: 'premultiplied' });

  await readBuffer.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(readBuffer.getMappedRange(0, 4));
  const result = [data[0], data[1], data[2], data[3]];
  readBuffer.unmap();
  readBuffer.destroy();
  return result;
}

/** Sanity check: write known data to a texture and read it back */
async function testReadback(): Promise<number[]> {
  const { device } = getGPU();
  const tex = device.createTexture({
    size: { width: 1, height: 1 },
    format: 'rgba16float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
  // float16: 1.0=0x3C00, 0.5=0x3800, 0.25=0x3400, 0.125=0x3000
  const data = new Uint16Array([0x3C00, 0x3800, 0x3400, 0x3000]);
  device.queue.writeTexture(
    { texture: tex }, data, { bytesPerRow: 8 }, { width: 1, height: 1 },
  );
  const bytesPerRow = 256;
  const readBuffer = device.createBuffer({
    size: bytesPerRow,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: tex }, { buffer: readBuffer, bytesPerRow }, { width: 1, height: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readBuffer.mapAsync(GPUMapMode.READ);
  const f16 = new Uint16Array(readBuffer.getMappedRange(0, 8));
  const result = Array.from(f16).map(f16ToF32);
  readBuffer.unmap();
  readBuffer.destroy();
  tex.destroy();
  return result;
}

// Expose on window
const bridge = {
  ready: true,
  applyMood,
  setPhase,
  replayStroke,
  waitFrames,
  readCanvasPixel,
  readTexturePixel,
  testReadback,
  markAllDirty,
  getTexture,
  getTextureInfo: (name: string) => {
    const tex = getTexture(name);
    if (!tex) return null;
    return { width: tex.width, height: tex.height, format: tex.format, usage: tex.usage, label: tex.label };
  },
  getDevice: () => getGPU().device,
  getAccumTexture: () => getReadTexture(),
  getStateTexture: () => getStateReadTexture(),

  /** Read pixel from accum surface (K_r, K_g, K_b, paint_weight) */
  async readAccumPixel(x: number, y: number): Promise<number[]> {
    const { device } = getGPU();
    const tex = getReadTexture();
    const bytesPerPixel = 8; // rgba16float
    const bytesPerRow = 256;
    const readBuffer = device.createBuffer({
      size: bytesPerRow,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    markAllDirty();
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: tex, origin: { x, y, z: 0 } },
          { buffer: readBuffer, bytesPerRow },
          { width: 1, height: 1 },
        );
        device.queue.submit([encoder.finish()]);
        device.queue.onSubmittedWorkDone().then(() => resolve());
      });
    });
    await readBuffer.mapAsync(GPUMapMode.READ);
    const f16 = new Uint16Array(readBuffer.getMappedRange(0, bytesPerPixel));
    const result = Array.from(f16).map(f16ToF32);
    readBuffer.unmap();
    readBuffer.destroy();
    return result;
  },

  /** Render one frame with GPU error scope to catch validation errors */
  async renderWithErrorCheck() {
    const { device } = getGPU();
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    markAllDirty();
    await waitFrames(1);
    const oomError = await device.popErrorScope();
    const valError = await device.popErrorScope();
    return {
      validation: valError ? valError.message : null,
      outOfMemory: oomError ? oomError.message : null,
    };
  },

  // Tonal column sampling
  sampleTonalColumn,
  getActiveComplement,
  DEFAULT_COMPLEMENT,

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
  wipeOnRag,
  toggleOil,

  // --- Brush physics testing ---

  getSurfaceDimensions: () => ({ width: getSurfaceWidth(), height: getSurfaceHeight() }),

  setBrushAge: (slot: number, age: number) => {
    setBrushSlotAge(slot, age);
    resetActiveBundle();
    reloadBrush();
  },

  getBundleState: () => {
    const bundle = getActiveBundle();
    if (!bundle) return null;
    return {
      splay: bundle.splay,
      contactPressure: bundle.contactPressure,
      averageLoad: getAverageLoad(bundle),
      age: bundle.age,
      stiffness: bundle.stiffness,
      recoveryRate: bundle.recoveryRate,
    };
  },

  /** Batch read a horizontal line of pixels from the accumulation texture */
  async readAccumLine(y: number, xStart: number, count: number): Promise<number[][]> {
    const { device } = getGPU();
    const tex = getReadTexture();
    const bytesPerPixel = 8; // rgba16float
    const dataSize = count * bytesPerPixel;
    const bytesPerRow = Math.ceil(dataSize / 256) * 256;

    const readBuffer = device.createBuffer({
      size: bytesPerRow,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    markAllDirty();
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: tex, origin: { x: xStart, y, z: 0 } },
          { buffer: readBuffer, bytesPerRow },
          { width: count, height: 1 },
        );
        device.queue.submit([encoder.finish()]);
        device.queue.onSubmittedWorkDone().then(() => resolve());
      });
    });

    await readBuffer.mapAsync(GPUMapMode.READ);
    const f16 = new Uint16Array(readBuffer.getMappedRange(0, dataSize));
    const result: number[][] = [];
    for (let i = 0; i < count; i++) {
      result.push([
        f16ToF32(f16[i * 4]),
        f16ToF32(f16[i * 4 + 1]),
        f16ToF32(f16[i * 4 + 2]),
        f16ToF32(f16[i * 4 + 3]),
      ]);
    }
    readBuffer.unmap();
    readBuffer.destroy();
    return result;
  },
};

(window as any).__ghz = bridge;
console.log('[GHZ Test Bridge] Ready');
