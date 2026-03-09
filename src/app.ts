// V2 App orchestrator — frame loop, dirty flags, all system wiring
// No forms, no SDF, no bake. Paint surface + atmosphere + lights + compositor.

import { getGPU, onResize } from './gpu/context.js';
import {
  getGlobalBindGroupLayout,
  createGlobalUniformBuffer,
  writeGlobalUniforms,
  createGlobalBindGroup,
} from './gpu/bind-groups.js';
import { startLoop } from './gpu/frame-loop.js';

// Painting
import { initSurface, resizeSurface } from './painting/surface.js';
import { initBrushEngine, beginStroke, endStroke, dispatchBrushDabs, reloadBrush } from './painting/brush-engine.js';
import { initScrapeEngine, beginScrape, endScrape, dispatchScrapeDabs } from './painting/scrape-engine.js';
import { initWipeEngine, beginWipe, endWipe, dispatchWipeDabs } from './painting/wipe-engine.js';
import { pushSnapshot, undo, redo } from './painting/undo.js';

// Surface texture
import { initSurfaceGrainLut, updateSurfaceGrainParams, generateSurfaceGrainIfDirty } from './surface/surface-grain-lut.js';

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

// Lights
import {
  initLightLayer,
  updateLightTextures,
  writeLightData,
  dispatchLight,
} from './light/light-layer.js';

// Compositor
import {
  initCompositor,
  updateCompositorTextures,
  rebuildCompositorBindGroup,
  renderComposite,
  writeCompositorParams,
} from './compositor/compositor.js';

// State
import { sceneStore, goldenFactor } from './state/scene-state.js';
import { uiStore, pointerQueue } from './state/ui-state.js';
import { markDirty, isDirty, clearDirty, isAnyDirty, markAllDirty } from './state/dirty-flags.js';

// Register web components (side-effect imports)
import './controls/toolbar.js';
import './controls/canvas-overlay.js';
import './controls/atmosphere-orb.js';
import './controls/time-dial.js';
import './controls/palette-panel.js';
import './controls/echo-slider.js';
import './controls/drift-field.js';
import './controls/anchor-control.js';
import './controls/velvet-slider.js';
import './controls/horizon-control.js';
import './controls/light-wells.js';
import './controls/surface-pad.js';
import './controls/export-button.js';
import './controls/load-slider.js';

// Input
import { initPointerInput } from './input/pointer.js';
import { initGestureInput } from './input/gesture.js';
import { initKeyboardInput } from './input/keyboard.js';

let globalUniformBuffer: GPUBuffer;
let globalBindGroup: GPUBindGroup;
let compositorBGDirty = true;

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
  initSurfaceGrainLut();
  initAtmosphere();
  initSurface(width, height);
  initBrushEngine();
  initScrapeEngine();
  initWipeEngine();
  initLightLayer();
  initCompositor();

  // Write initial LUT params before texture allocation
  const scene = sceneStore.get();
  updateNoiseLutParams(scene.atmosphere.turbulence);
  updateGrainLutParams(1.0 + scene.atmosphere.grain * 3.0, scene.atmosphere.grainAngle);
  updateSurfaceGrainParams(scene.surface.grainSize, scene.surface.directionality, scene.surface.mode === 'woodblock' ? 1 : 0);

  // Allocate textures at initial size
  allocateAllTextures(width, height);

  // Write initial state
  writeAtmosphereParams(scene.atmosphere, scene.horizonY);
  writeScatterParams(scene.sunAngle, scene.sunElevation, scene.horizonY);
  writeLightData(scene.lights, scene.sunElevation, scene.palette.colors);
  const gf = goldenFactor(scene.sunElevation);
  writeCompositorParams({
    shadowChroma: scene.shadowChroma,
    grayscale: uiStore.get().grayscalePreview ? 1.0 : 0.0,
    anchorX: scene.anchor?.x ?? 0.5,
    anchorY: scene.anchor?.y ?? 0.5,
    anchorBoost: scene.anchor?.chromaBoost ?? 0,
    anchorFalloff: scene.anchor ? scene.anchor.muteFalloff : 999.0,
    sunGradeWarmth: gf * 0.8 - 0.1,
    sunGradeIntensity: 0.3 + gf * 0.4,
    grainIntensity: scene.atmosphere.grain,
    grainAngle: scene.atmosphere.grainAngle,
    grainDepth: scene.atmosphere.grainDepth,
    grainScale: 1.0 + scene.atmosphere.grain * 3.0,
    surfaceIntensity: scene.surface.intensity,
  });

  // Input
  initPointerInput(canvas);
  initGestureInput(canvas, (gesture) => {
    if (gesture.active) {
      sceneStore.update((s) => ({
        atmosphere: {
          ...s.atmosphere,
          grain: Math.max(0, Math.min(1, s.atmosphere.grain * gesture.pinchScale)),
          grainAngle: s.atmosphere.grainAngle + gesture.rotation,
        },
      }));
    }
  });
  initKeyboardInput();

  // Undo/redo keyboard handler
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        performUndo();
      } else if (e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        performRedo();
      }
    }
  });

  // Painting interaction
  setupPaintingInteraction();

  // Track previous state for selective change detection
  let prevAtmosphere = scene.atmosphere;
  let prevSunAngle = scene.sunAngle;
  let prevSunElevation = scene.sunElevation;
  let prevHorizonY = scene.horizonY;
  let prevLights = scene.lights;
  let prevShadowChroma = scene.shadowChroma;
  let prevAnchor = scene.anchor;
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

    if (state.lights !== prevLights || state.sunElevation !== prevSunElevation) {
      writeLightData(state.lights, state.sunElevation, state.palette.colors);
      markDirty('light');
    }

    if (state.surface !== prevSurface) {
      updateSurfaceGrainParams(state.surface.grainSize, state.surface.directionality, state.surface.mode === 'woodblock' ? 1 : 0);
      markDirty('composite');
    }

    if (state.shadowChroma !== prevShadowChroma ||
        state.anchor !== prevAnchor ||
        state.sunElevation !== prevSunElevation ||
        state.atmosphere !== prevAtmosphere ||
        state.surface !== prevSurface) {
      const gf = goldenFactor(state.sunElevation);
      writeCompositorParams({
        shadowChroma: state.shadowChroma,
        grayscale: uiStore.get().grayscalePreview ? 1.0 : 0.0,
        anchorX: state.anchor?.x ?? 0.5,
        anchorY: state.anchor?.y ?? 0.5,
        anchorBoost: state.anchor?.chromaBoost ?? 0,
        anchorFalloff: state.anchor ? state.anchor.muteFalloff : 999.0,
        sunGradeWarmth: gf * 0.8 - 0.1,
        sunGradeIntensity: 0.3 + gf * 0.4,
        grainIntensity: state.atmosphere.grain,
        grainAngle: state.atmosphere.grainAngle,
        grainDepth: state.atmosphere.grainDepth,
        grainScale: 1.0 + state.atmosphere.grain * 3.0,
        surfaceIntensity: state.surface.intensity,
      });
      markDirty('composite');
    }

    prevAtmosphere = state.atmosphere;
    prevSunAngle = state.sunAngle;
    prevSunElevation = state.sunElevation;
    prevHorizonY = state.horizonY;
    prevLights = state.lights;
    prevShadowChroma = state.shadowChroma;
    prevAnchor = state.anchor;
    prevSurface = state.surface;
  });

  uiStore.subscribe((_ui) => {
    const state = sceneStore.get();
    const gf = goldenFactor(state.sunElevation);
    writeCompositorParams({
      shadowChroma: state.shadowChroma,
      grayscale: _ui.grayscalePreview ? 1.0 : 0.0,
      anchorX: state.anchor?.x ?? 0.5,
      anchorY: state.anchor?.y ?? 0.5,
      anchorBoost: state.anchor?.chromaBoost ?? 0,
      anchorFalloff: state.anchor ? state.anchor.muteFalloff : 999.0,
      sunGradeWarmth: gf * 0.8 - 0.1,
      sunGradeIntensity: 0.3 + gf * 0.4,
      grainIntensity: state.atmosphere.grain,
      grainAngle: state.atmosphere.grainAngle,
      grainDepth: state.atmosphere.grainDepth,
      grainScale: 1.0 + state.atmosphere.grain * 3.0,
      surfaceIntensity: state.surface.intensity,
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

  // Start render loop
  startLoop((dt, elapsed) => {
    renderFrame(dt, elapsed);
  });
}

function allocateAllTextures(width: number, height: number) {
  updateAtmosphereTextures(width, height);
  updateLightTextures(width, height);
  updateCompositorTextures(width, height);
}

function performUndo() {
  const { device } = getGPU();
  const encoder = device.createCommandEncoder({ label: 'undo-encoder' });
  if (undo(encoder)) {
    device.queue.submit([encoder.finish()]);
    markDirty('surface');
    compositorBGDirty = true;
  }
}

function performRedo() {
  const { device } = getGPU();
  const encoder = device.createCommandEncoder({ label: 'redo-encoder' });
  if (redo(encoder)) {
    device.queue.submit([encoder.finish()]);
    markDirty('surface');
    compositorBGDirty = true;
  }
}

function setupPaintingInteraction() {
  let wasDown = false;

  uiStore.subscribe((ui) => {
    const isBrush = ui.activeTool === 'form';
    const isScrape = ui.activeTool === 'scrape';
    const isWipe = ui.activeTool === 'wipe';
    const isPaintTool = isBrush || isScrape || isWipe;

    if (isPaintTool && ui.mouseDown && !wasDown) {
      // Stroke begin — push undo snapshot
      const { device } = getGPU();
      const encoder = device.createCommandEncoder({ label: 'snapshot-encoder' });
      pushSnapshot(encoder);
      device.queue.submit([encoder.finish()]);

      // Flush stale pointer positions accumulated before stroke began
      pointerQueue.length = 0;

      strokeActive = true;
      strokeTool = isBrush ? 'form' : isScrape ? 'scrape' : 'wipe';

      if (isBrush) {
        beginStroke(ui.mouseX, ui.mouseY);
      } else if (isScrape) {
        beginScrape(ui.mouseX, ui.mouseY);
      } else {
        beginWipe(ui.mouseX, ui.mouseY);
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

function renderFrame(dt: number, elapsed: number) {
  const gpu = getGPU();
  const { device, context, width, height } = gpu;
  const ui = uiStore.get();

  // Drift animation marks density dirty
  const scene = sceneStore.get();
  const drifting = scene.atmosphere.driftSpeed > 0 &&
    (scene.atmosphere.driftX !== 0 || scene.atmosphere.driftY !== 0);
  if (drifting) {
    markDirty('density');
  }

  // Active stroke: always render (don't depend on dirty flag from microtask subscriber)
  const strokeNeedsDispatch = strokeActive && ui.mouseDown;
  if (strokeNeedsDispatch) {
    markDirty('surface');
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
  if (generateSurfaceGrainIfDirty(encoder)) {
    compositorBGDirty = true;
  }

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
    clearDirty('surface');
    if (painted) {
      compositorBGDirty = true;
    }
  }

  if (isDirty('light')) {
    if (scene.lights.length > 0) {
      dispatchLight(encoder, globalBindGroup);
    }
    clearDirty('light');
    compositorBGDirty = true;
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
