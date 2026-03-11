// V2 App orchestrator — frame loop, dirty flags, all system wiring
// Paint surface + atmosphere + compositor. Lights/undo removed in v2 redesign.

import { getGPU, onResize, resizeArtboard } from './gpu/context.js';
import {
  getGlobalBindGroupLayout,
  createGlobalUniformBuffer,
  writeGlobalUniforms,
  createGlobalBindGroup,
} from './gpu/bind-groups.js';
import { startLoop } from './gpu/frame-loop.js';

// Painting
import { initSurface, resizeSurface, clearSurface } from './painting/surface.js';
import { initBrushEngine, beginStroke, endStroke, dispatchBrushDabs, dispatchPendingGhosts, reloadBrush } from './painting/brush-engine.js';
import { initScrapeEngine, beginScrape, endScrape, dispatchScrapeDabs } from './painting/scrape-engine.js';
import { initWipeEngine, beginWipe, endWipe, dispatchWipeDabs } from './painting/wipe-engine.js';
import { resetRag } from './painting/rag-state.js';

// Surface texture
import { initSurfaceMaterial, updateSurfaceMaterialParams, generateSurfaceMaterialIfDirty } from './surface/surface-material.js';
import { initClothHeightfield, setClothSeed, generateClothHeightfieldIfDirty } from './surface/cloth-heightfield.js';
import { MATERIALS } from './surface/materials.js';

// Atmosphere
import { initNoiseLut, updateNoiseLutParams, updateGrainLutParams, generateLutsIfDirty } from './atmosphere/noise-lut.js';
import {
  initAtmosphere,
  updateAtmosphereTextures,
  writeAtmosphereParams,
  writeScatterParams,
  dispatchDensity,
  dispatchScatter,
} from './atmosphere/atmosphere.js';

// Compositor
import {
  initCompositor,
  updateCompositorTextures,
  rebuildCompositorBindGroup,
  renderComposite,
  writeCompositorParams,
  updateCompositorSessionTime,
} from './compositor/compositor.js';

// State
import { sceneStore } from './state/scene-state.js';
import { uiStore, pointerQueue } from './state/ui-state.js';
import { markDirty, isDirty, clearDirty, isAnyDirty, markAllDirty } from './state/dirty-flags.js';

// Palette
import { syncBrushSlotsFromSession, setActiveBrushSlot, BRUSH_SLOT_SIZES } from './painting/palette.js';

// Register web components (side-effect imports)
import './controls/toolbar.js';
import './controls/canvas-overlay.js';
import './controls/palette-panel.js';
import './controls/material-selector.js';
import './controls/export-button.js';
import './controls/load-slider.js';
import './controls/thinners-slider.js';
import './controls/session-bar.js';
import './controls/prepare-panel.js';
import './controls/brush-selector.js';
import './controls/artboard-selector.js';

// Session
import { startSessionTimer, resetSessionTimer, getSessionTime } from './session/session-timer.js';
import { sessionStore } from './session/session-state.js';
import { artboardStore } from './state/artboard-state.js';

// Input
import { initPointerInput } from './input/pointer.js';
import { initKeyboardInput } from './input/keyboard.js';

let globalUniformBuffer: GPUBuffer;
let globalBindGroup: GPUBindGroup;
let compositorBGDirty = true;

function updateSurroundColor() {
  const container = document.getElementById('canvas-container');
  if (!container) return;
  const { material } = sceneStore.get().surface;
  const [r, g, b] = MATERIALS[material].colorLight;
  // Slightly darker than the material's lightest tone
  const darken = 0.99;
  const cr = Math.round(r * darken * 255);
  const cg = Math.round(g * darken * 255);
  const cb = Math.round(b * darken * 255);
  container.style.background = `rgb(${cr}, ${cg}, ${cb})`;
}

// Stroke state
let strokeActive = false;
let strokeTool: 'form' | 'scrape' | 'wipe' | null = null;

export function initApp() {
  const gpu = getGPU();
  const { device, canvas, width, height } = gpu;

  // Global uniforms
  const globalLayout = getGlobalBindGroupLayout(device);
  globalUniformBuffer = createGlobalUniformBuffer(device);
  globalBindGroup = createGlobalBindGroup(device, globalLayout, globalUniformBuffer);

  // Init all systems
  initNoiseLut();
  initSurfaceMaterial();
  initAtmosphere();
  initSurface(width, height);
  initBrushEngine();
  initScrapeEngine();
  initWipeEngine();
  initClothHeightfield();
  initCompositor();

  // Write initial LUT params before texture allocation
  const scene = sceneStore.get();
  updateNoiseLutParams(scene.atmosphere.turbulence);
  updateGrainLutParams(1.0 + scene.atmosphere.grain * 3.0, scene.atmosphere.grainAngle);
  updateSurfaceMaterialParams(scene.surface);
  setClothSeed(scene.surface.seed);

  // Allocate textures at initial size
  allocateAllTextures(width, height);

  // Write initial state
  writeAtmosphereParams(scene.atmosphere, scene.horizonY);
  writeScatterParams(scene.sunAngle, scene.sunElevation, scene.horizonY);
  writeCompositorParams({
    shadowChroma: scene.shadowChroma,
    grayscale: uiStore.get().grayscalePreview ? 1.0 : 0.0,
    grainIntensity: scene.atmosphere.grain,
    grainAngle: scene.atmosphere.grainAngle,
    grainDepth: scene.atmosphere.grainDepth,
    grainScale: 1.0 + scene.atmosphere.grain * 3.0,
    surfaceIntensity: scene.surface.intensity,
    sessionTime: getSessionTime(),
    surfaceDrySpeed: scene.surface.drySpeed,
  });

  // Set initial surround color
  updateSurroundColor();

  // Input
  initPointerInput(canvas);
  initKeyboardInput();

  // Brush slot → palette sync
  syncBrushSlotsFromSession();
  setActiveBrushSlot(uiStore.get().activeBrushSlot);

  uiStore.select(
    (s) => s.activeBrushSlot,
    (slot) => {
      setActiveBrushSlot(slot);
      uiStore.set({ brushSize: BRUSH_SLOT_SIZES[slot] });
    }
  );

  sessionStore.select(
    (s) => s.phase,
    (phase) => {
      if (phase === 'test') {
        // Resize artboard if dimensions changed during prepare
        const ab = artboardStore.get();
        const gpu = getGPU();
        if (ab.width !== gpu.width || ab.height !== gpu.height) {
          resizeArtboard(ab.width, ab.height);
        }
      }
      if (phase === 'test' || phase === 'paint') {
        syncBrushSlotsFromSession();
      }
    }
  );

  // Session flow
  startSessionTimer();
  document.addEventListener('start-painting', () => {
    clearSurface();
    resetSessionTimer();
    resetRag();
    markAllDirty();
    compositorBGDirty = true;
  });
  document.addEventListener('new-painting', () => {
    clearSurface();
    resetSessionTimer();
    resetRag();
    markAllDirty();
    compositorBGDirty = true;
  });

  // Painting interaction
  setupPaintingInteraction();

  // Track previous state for selective change detection
  let prevAtmosphere = scene.atmosphere;
  let prevSunAngle = scene.sunAngle;
  let prevSunElevation = scene.sunElevation;
  let prevHorizonY = scene.horizonY;
  let prevShadowChroma = scene.shadowChroma;
  let prevSurface = scene.surface;
  let prevLoad = scene.load;

  sceneStore.subscribe((state) => {
    if (state.load !== prevLoad) {
      reloadBrush();
      prevLoad = state.load;
    }

    if (state.atmosphere !== prevAtmosphere || state.horizonY !== prevHorizonY) {
      writeAtmosphereParams(state.atmosphere, state.horizonY);
      updateNoiseLutParams(state.atmosphere.turbulence);
      updateGrainLutParams(1.0 + state.atmosphere.grain * 3.0, state.atmosphere.grainAngle);
      markDirty('density');
      markDirty('composite');
    }

    if (state.sunAngle !== prevSunAngle || state.sunElevation !== prevSunElevation || state.horizonY !== prevHorizonY) {
      writeScatterParams(state.sunAngle, state.sunElevation, state.horizonY);
      markDirty('scatter');
    }

    if (state.surface !== prevSurface) {
      updateSurfaceMaterialParams(state.surface);
      updateSurroundColor();
      markDirty('composite');
    }

    if (state.shadowChroma !== prevShadowChroma ||
        state.atmosphere !== prevAtmosphere ||
        state.surface !== prevSurface) {
      writeCompositorParams({
        shadowChroma: state.shadowChroma,
        grayscale: uiStore.get().grayscalePreview ? 1.0 : 0.0,
        grainIntensity: state.atmosphere.grain,
        grainAngle: state.atmosphere.grainAngle,
        grainDepth: state.atmosphere.grainDepth,
        grainScale: 1.0 + state.atmosphere.grain * 3.0,
        surfaceIntensity: state.surface.intensity,
        sessionTime: getSessionTime(),
        surfaceDrySpeed: state.surface.drySpeed,
      });
      markDirty('composite');
    }

    prevAtmosphere = state.atmosphere;
    prevSunAngle = state.sunAngle;
    prevSunElevation = state.sunElevation;
    prevHorizonY = state.horizonY;
    prevShadowChroma = state.shadowChroma;
    prevSurface = state.surface;
  });

  uiStore.subscribe((_ui) => {
    const state = sceneStore.get();
    writeCompositorParams({
      shadowChroma: state.shadowChroma,
      grayscale: _ui.grayscalePreview ? 1.0 : 0.0,
      grainIntensity: state.atmosphere.grain,
      grainAngle: state.atmosphere.grainAngle,
      grainDepth: state.atmosphere.grainDepth,
      grainScale: 1.0 + state.atmosphere.grain * 3.0,
      surfaceIntensity: state.surface.intensity,
      sessionTime: getSessionTime(),
      surfaceDrySpeed: state.surface.drySpeed,
    });
    markDirty('composite');
  });

  // Handle resize
  onResize((w, h) => {
    allocateAllTextures(w, h);
    resizeSurface(w, h);
    markAllDirty();
    compositorBGDirty = true;
  });

  // Trigger initial render
  markAllDirty();
  compositorBGDirty = true;

  // Start render loop
  startLoop((dt, elapsed) => {
    renderFrame(dt, elapsed);
  });
}

function allocateAllTextures(width: number, height: number) {
  updateAtmosphereTextures(width, height);
  updateCompositorTextures(width, height);
}

function setupPaintingInteraction() {
  let wasDown = false;

  uiStore.subscribe((ui) => {
    const isBrush = ui.activeTool === 'form';
    const isScrape = ui.activeTool === 'scrape';
    const isWipe = ui.activeTool === 'wipe';
    const isPaintTool = isBrush || isScrape || isWipe;

    if (isPaintTool && ui.mouseDown && !wasDown) {
      // Flush stale pointer positions accumulated before stroke began
      pointerQueue.length = 0;

      strokeActive = true;
      strokeTool = isBrush ? 'form' : isScrape ? 'scrape' : 'wipe';

      if (isBrush) {
        beginStroke(ui.mouseX, ui.mouseY, ui.pressure || 0.5);
      } else if (isScrape) {
        beginScrape(ui.mouseX, ui.mouseY);
      } else {
        beginWipe(ui.mouseX, ui.mouseY, ui.pressure || 0.5);
      }
    }

    // Note: surface dirty is driven directly by renderFrame checking strokeActive,
    // not by this subscriber — avoids microtask timing gaps

    if (!ui.mouseDown && wasDown && strokeActive) {
      // Stroke end
      if (strokeTool === 'form') {
        endStroke();
      } else if (strokeTool === 'scrape') {
        endScrape();
      } else {
        endWipe();
      }
      strokeActive = false;
      strokeTool = null;
    }

    wasDown = ui.mouseDown;
  });
}

let lastDryingUpdate = 0;
let lastStrokeTime = 0;

function renderFrame(dt: number, elapsed: number) {
  const gpu = getGPU();
  const { device, context, width, height } = gpu;
  const ui = uiStore.get();

  // Active stroke: always render (don't depend on dirty flag from microtask subscriber)
  const strokeNeedsDispatch = strokeActive && ui.mouseDown;
  if (strokeNeedsDispatch) {
    markDirty('surface');
    lastStrokeTime = getSessionTime();
  }

  // Adaptive drying update — per-frame while drying active, ramp to 0.5s intervals
  const sessionTime = getSessionTime();
  const sincePaint = sessionTime - lastStrokeTime;
  const dryingInterval = Math.min(0.5, Math.max(0, sincePaint - 60) * 0.01);
  if (sessionTime - lastDryingUpdate > dryingInterval) {
    lastDryingUpdate = sessionTime;
    updateCompositorSessionTime(sessionTime);
    markDirty('composite');
    compositorBGDirty = true;
  }

  // Full frame skip when nothing is dirty
  if (!isAnyDirty()) return;

  // Update global uniforms
  writeGlobalUniforms(device, globalUniformBuffer, width, height, elapsed, dt, ui.mouseX, ui.mouseY, gpu.dpr);

  const canvasTexture = context.getCurrentTexture();
  const targetView = canvasTexture.createView();
  const encoder = device.createCommandEncoder({ label: 'frame-encoder' });

  // Generate noise LUTs if dirty
  generateLutsIfDirty(encoder);

  // Generate surface grain LUT if dirty
  if (generateSurfaceMaterialIfDirty(encoder)) {
    compositorBGDirty = true;
  }

  // Generate cloth heightfield if dirty
  generateClothHeightfieldIfDirty(encoder);

  if (isDirty('density')) {
    dispatchDensity(encoder, globalBindGroup);
    clearDirty('density');
    compositorBGDirty = true;
  }

  if (isDirty('grain')) {
    clearDirty('grain');
    compositorBGDirty = true;
  }

  if (isDirty('scatter')) {
    dispatchScatter(encoder, globalBindGroup);
    clearDirty('scatter');
    compositorBGDirty = true;
  }

  // Painting surface — dispatch brush/scrape/wipe dabs during active stroke
  if (isDirty('surface')) {
    let painted = false;
    if (strokeActive && ui.mouseDown) {
      if (strokeTool === 'form') {
        painted = dispatchBrushDabs(encoder, ui.mouseX, ui.mouseY);
      } else if (strokeTool === 'scrape') {
        painted = dispatchScrapeDabs(encoder, ui.mouseX, ui.mouseY);
      } else if (strokeTool === 'wipe') {
        painted = dispatchWipeDabs(encoder, ui.mouseX, ui.mouseY);
      }
    }
    // Lift-off ghost taper (runs once after stroke ends)
    if (dispatchPendingGhosts(encoder)) {
      painted = true;
    }
    clearDirty('surface');
    if (painted) {
      compositorBGDirty = true;
    }
  }

  if (isDirty('composite')) {
    if (compositorBGDirty) {
      rebuildCompositorBindGroup();
      compositorBGDirty = false;
    }
    renderComposite(encoder, targetView, globalBindGroup);
    clearDirty('composite');
  }

  device.queue.submit([encoder.finish()]);
}
