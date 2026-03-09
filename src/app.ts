import { getGPU, onResize } from './gpu/context.js';
import {
  getGlobalBindGroupLayout,
  createGlobalUniformBuffer,
  writeGlobalUniforms,
  createGlobalBindGroup,
} from './gpu/bind-groups.js';
import { startLoop } from './gpu/frame-loop.js';
import { initDepthLayer, updateDepthTexture, writeDepthParams, dispatchDepth } from './layers/depth-layer.js';
import { initPaletteLayer, writePaletteData } from './layers/palette-layer.js';
import {
  initAtmosphereLayer,
  updateAtmosphereTextures,
  writeAtmosphereParams,
  writeScatterParams,
  dispatchAtmosphere,
} from './layers/atmosphere-layer.js';
import {
  initFormsLayer,
  updateFormsTextures,
  writeFormsData,
  dispatchForms,
  requestBake,
  requestFullRebake,
  handlePendingBakes,
  setDissolutionActive,
} from './layers/forms-layer.js';
import {
  initLightLayer,
  updateLightTextures,
  writeLightData,
  dispatchLight,
} from './layers/light-layer.js';
import {
  initCompositor,
  updateCompositorTextures,
  rebuildCompositorBindGroup,
  renderComposite,
  writeCompositorParams,
} from './layers/compositor.js';
import { initUILayer, renderUI } from './layers/ui-layer.js';
import { sceneStore, goldenFactor } from './state/scene-state.js';
import { uiStore } from './state/ui-state.js';

// Register web components (side-effect imports)
import './controls/toolbar.js';
import './controls/canvas-overlay.js';
import './controls/atmosphere-orb.js';
import './controls/time-dial.js';
import './controls/mood-ring.js';
import './controls/depth-puppet.js';
import './controls/light-wells.js';
import './controls/echo-slider.js';
import './controls/dissolve-brush.js';
import './controls/ghost-strokes.js';
import './controls/palette-brush.js';
import './controls/drift-field.js';
import './controls/anchor-control.js';
import './controls/velvet-slider.js';
import './controls/gravity-slider.js';
import './controls/horizon-control.js';
import { initPointerInput } from './input/pointer.js';
import { initGestureInput } from './input/gesture.js';
import { initKeyboardInput } from './input/keyboard.js';
import {
  updateStrokeMetrics,
  metricsToModifiers,
  resetStrokeTracking,
} from './input/pressure.js';
import { getTexture } from './gpu/texture-pool.js';
import type { FormDef } from './layers/layer-types.js';
import { pushHistory } from './state/history.js';
import {
  resizeDissolutionBuffer,
  stampDissolve,
  flushDissolution,
} from './layers/dissolution-buffer.js';

let globalUniformBuffer: GPUBuffer;
let globalBindGroup: GPUBindGroup;

export function initApp() {
  const gpu = getGPU();
  const { device, canvas, width, height } = gpu;

  // Global uniforms
  const globalLayout = getGlobalBindGroupLayout(device);
  globalUniformBuffer = createGlobalUniformBuffer(device);
  globalBindGroup = createGlobalBindGroup(device, globalLayout, globalUniformBuffer);

  // Init all layers
  initDepthLayer();
  initPaletteLayer();
  initAtmosphereLayer();
  initFormsLayer();
  initLightLayer();
  initCompositor();
  initUILayer();

  // Allocate textures at initial size
  allocateAllTextures(width, height);

  // Write initial state
  const scene = sceneStore.get();
  writeDepthParams(scene.depth);
  writePaletteData(scene.palette);
  writeAtmosphereParams(scene.atmosphere, scene.horizonY);
  writeScatterParams(scene.sunAngle, scene.sunElevation, scene.sunAzimuth, scene.horizonY);
  writeFormsData(scene.forms, scene.palette.colors, scene.sunAngle, scene.tonalMap, scene.velvet, scene.tonalSort, scene.gravity, scene.baseOpacity, scene.falloff, scene.sunElevation, scene.horizonY);
  writeLightData(scene.lights, 32, scene.sunElevation);
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
    sunAzimuthBias: (scene.sunAzimuth - 0.5) * 2.0,
  });

  // Input
  initPointerInput(canvas);
  initGestureInput(canvas, (gesture) => {
    // Pinch controls atmosphere grain, rotation controls grain angle
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

  // Handle form placement on click
  setupFormPlacement(canvas);

  // Wire dissolve brush — stamp into per-pixel dissolution buffer
  let dissolving = false;
  document.addEventListener('dissolve-stroke', ((e: CustomEvent) => {
    const stroke = e.detail as { x: number; y: number; radius: number; pressure: number };
    const ds = uiStore.get().dissolveStrength;
    if (!dissolving) {
      dissolving = true;
      setDissolutionActive(true);
      // Force re-write so baked_count=0 reaches the GPU
      const s = sceneStore.get();
      writeFormsData(s.forms, s.palette.colors, s.sunAngle, s.tonalMap, s.velvet, s.tonalSort, s.gravity, s.baseOpacity, s.falloff, s.sunElevation, s.horizonY);
    }
    stampDissolve(stroke.x, stroke.y, stroke.radius, stroke.pressure, ds);
  }) as EventListener);

  document.addEventListener('dissolve-stroke-end', () => {
    if (!dissolving) return;
    dissolving = false;
    setDissolutionActive(false);
    // Full rebake captures dissolution into baked texture; future rebakes
    // also use baked_count=0 so dissolution_mask is always applied from scratch
    requestFullRebake();
    const s = sceneStore.get();
    writeFormsData(s.forms, s.palette.colors, s.sunAngle, s.tonalMap, s.velvet, s.tonalSort, s.gravity, s.baseOpacity, s.falloff, s.sunElevation, s.horizonY);
    pushHistory();
  });

  // Track previous state for detecting global param changes / undo
  let prevSunAngle = scene.sunAngle;
  let prevSunElevation = scene.sunElevation;
  let prevSunAzimuth = scene.sunAzimuth;
  let prevTonalMap = scene.tonalMap;
  let prevVelvet = scene.velvet;
  let prevGravity = scene.gravity;
  let prevTonalSort = scene.tonalSort;
  let prevEcho = scene.echo;
  let prevBaseOpacity = scene.baseOpacity;
  let prevFalloff = scene.falloff;
  let prevHorizonY = scene.horizonY;
  let prevPaletteColors = scene.palette.colors;
  let prevForms = scene.forms;
  let prevFormsLen = scene.forms.length;

  // React to state changes
  sceneStore.subscribe((state) => {
    writeDepthParams(state.depth);
    writeAtmosphereParams(state.atmosphere, state.horizonY);
    writeScatterParams(state.sunAngle, state.sunElevation, state.sunAzimuth, state.horizonY);
    writePaletteData(state.palette);
    writeFormsData(state.forms, state.palette.colors, state.sunAngle, state.tonalMap, state.velvet, state.tonalSort, state.gravity, state.baseOpacity, state.falloff, state.sunElevation, state.horizonY);
    writeLightData(state.lights, 32, state.sunElevation);
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
      sunAzimuthBias: (state.sunAzimuth - 0.5) * 2.0,
    });

    // Detect global param changes → full rebake
    if (state.sunAngle !== prevSunAngle ||
        state.sunElevation !== prevSunElevation ||
        state.sunAzimuth !== prevSunAzimuth ||
        state.tonalMap !== prevTonalMap ||
        state.velvet !== prevVelvet ||
        state.gravity !== prevGravity ||
        state.tonalSort !== prevTonalSort ||
        state.echo !== prevEcho ||
        state.baseOpacity !== prevBaseOpacity ||
        state.falloff !== prevFalloff ||
        state.horizonY !== prevHorizonY ||
        state.palette.colors !== prevPaletteColors) {
      requestFullRebake();
    }

    // Detect undo/redo: forms array shrinks or elements differ (not just append)
    if (state.forms !== prevForms) {
      const isAppend = state.forms.length > prevFormsLen &&
        state.forms.length > 0 && prevForms.length > 0 &&
        state.forms[prevFormsLen - 1] === prevForms[prevFormsLen - 1];
      if (!isAppend) {
        requestFullRebake();
      }
    }

    prevSunAngle = state.sunAngle;
    prevSunElevation = state.sunElevation;
    prevSunAzimuth = state.sunAzimuth;
    prevTonalMap = state.tonalMap;
    prevVelvet = state.velvet;
    prevGravity = state.gravity;
    prevTonalSort = state.tonalSort;
    prevEcho = state.echo;
    prevBaseOpacity = state.baseOpacity;
    prevFalloff = state.falloff;
    prevHorizonY = state.horizonY;
    prevPaletteColors = state.palette.colors;
    prevForms = state.forms;
    prevFormsLen = state.forms.length;
  });

  // Also react to UI state changes (grayscale toggle)
  uiStore.subscribe((ui) => {
    const state = sceneStore.get();
    const gf = goldenFactor(state.sunElevation);
    writeCompositorParams({
      shadowChroma: state.shadowChroma,
      grayscale: ui.grayscalePreview ? 1.0 : 0.0,
      anchorX: state.anchor?.x ?? 0.5,
      anchorY: state.anchor?.y ?? 0.5,
      anchorBoost: state.anchor?.chromaBoost ?? 0,
      anchorFalloff: state.anchor ? state.anchor.muteFalloff : 999.0,
      sunGradeWarmth: gf * 0.8 - 0.1,
      sunGradeIntensity: 0.3 + gf * 0.4,
      sunAzimuthBias: (state.sunAzimuth - 0.5) * 2.0,
    });
  });

  // Handle resize
  onResize((w, h) => {
    allocateAllTextures(w, h);
  });

  // Start render loop
  startLoop((dt, elapsed) => {
    renderFrame(dt, elapsed);
  });
}

function allocateAllTextures(width: number, height: number) {
  updateDepthTexture(width, height);
  updateAtmosphereTextures(width, height);
  updateFormsTextures(width, height);
  updateLightTextures(width, height);
  updateCompositorTextures(width, height);
  resizeDissolutionBuffer(width, height);
}

function renderFrame(dt: number, elapsed: number) {
  const gpu = getGPU();
  const { device, context, width, height } = gpu;
  const ui = uiStore.get();

  // Update global uniforms
  writeGlobalUniforms(device, globalUniformBuffer, width, height, elapsed, dt, ui.mouseX, ui.mouseY, gpu.dpr);

  // Get canvas texture for this frame
  const canvasTexture = context.getCurrentTexture();
  const targetView = canvasTexture.createView();

  // Create command encoder — all passes in one encoder
  const encoder = device.createCommandEncoder({ label: 'frame-encoder' });

  // Flush dissolution buffer to GPU before forms dispatch
  const dissolveTex = getTexture('dissolution');
  if (dissolveTex) flushDissolution(device, dissolveTex);

  // Pass order: depth → atmosphere → forms → light → bloom → composite
  dispatchDepth(encoder, globalBindGroup);
  dispatchAtmosphere(encoder, globalBindGroup);
  dispatchForms(encoder, globalBindGroup);
  handlePendingBakes(encoder);
  dispatchLight(encoder, globalBindGroup);

  // Rebuild compositor bind group to get latest texture views
  rebuildCompositorBindGroup();
  renderComposite(encoder, targetView, globalBindGroup);

  // UI overlay (after composite, uses load op to preserve scene)
  renderUI(encoder, targetView, globalBindGroup);

  // Submit
  device.queue.submit([encoder.finish()]);
}

function setupFormPlacement(_canvas: HTMLCanvasElement) {
  let wasDown = false;
  let lastFormX = 0;
  let lastFormY = 0;
  let lastFormSize = 0;

  uiStore.subscribe((ui) => {
    if (ui.activeTool === 'form' && ui.mouseDown) {
      const scene = sceneStore.get();
      const spacing = 0.012;

      const dx = ui.mouseX - lastFormX;
      const dy = ui.mouseY - lastFormY;
      const aspect = window.innerWidth / window.innerHeight;
      const adx = dx * aspect;
      const ady = dy;
      const aDist = Math.sqrt(adx * adx + ady * ady);

      if (!wasDown || aDist >= spacing) {
        const metrics = updateStrokeMetrics(ui.mouseX, ui.mouseY, ui.pressure, performance.now());
        const mods = metricsToModifiers(metrics, ui.brushSize);

        const echo = scene.echo;
        const opacity = 0.3 + echo * 0.7;
        const formRadius = mods.size;
        // Form brush: soft atmospheric edges, decisive but not hard
        const softness = formRadius * 0.8;

        if (!wasDown) pushHistory();

        let newForm: FormDef;

        if (!wasDown || aDist < 0.001) {
          // Initial click: circle stamp
          lastFormSize = formRadius;
          newForm = {
            type: 0,
            x: ui.mouseX,
            y: ui.mouseY,
            sizeX: formRadius,
            sizeY: formRadius,
            rotation: mods.rotation,
            softness,
            depth: ui.mouseY,
            colorIndex: scene.palette.activeIndex,
            opacity,
            dissolution: 0,
            strokeDirX: metrics.dirX,
            strokeDirY: metrics.dirY,
            taper: 0,
          };
        } else {
          // Drag: tapered capsule (type=3)
          const angle = Math.atan2(ady, adx);
          const dist = Math.sqrt(dx * dx + dy * dy);
          const startR = lastFormSize;
          const endR = formRadius;
          const taper = startR > 0.0001 ? endR / startR : 1.0;

          newForm = {
            type: 3, // tapered capsule
            x: lastFormX,
            y: lastFormY,
            sizeX: aDist,
            sizeY: startR,   // start radius
            rotation: angle,
            softness,
            depth: (lastFormY + ui.mouseY) / 2,
            colorIndex: scene.palette.activeIndex,
            opacity,
            dissolution: 0,
            strokeDirX: dx / dist,
            strokeDirY: dy / dist,
            taper,
          };
          lastFormSize = endR;
        }

        sceneStore.set({ forms: [...scene.forms, newForm] });
        lastFormX = ui.mouseX;
        lastFormY = ui.mouseY;
      }
    }

    if (!ui.mouseDown && wasDown) {
      resetStrokeTracking();
      if (ui.activeTool === 'form') {
        requestBake();
      }
    }

    if (ui.mouseDown && !wasDown && ui.activeTool === 'light') {
      pushHistory();
      const scene = sceneStore.get();
      sceneStore.set({
        lights: [
          ...scene.lights,
          {
            x: ui.mouseX,
            y: ui.mouseY,
            depth: ui.mouseY * 0.5,
            intensity: 1.5,
            radius: ui.brushSize * 5,
            colorR: 1.0,
            colorG: 0.85,
            colorB: 0.6,
            scatter: 0.8,
            scaleX: 1.0,
            scaleY: 1.0,
            rotation: 0,
          },
        ],
      });
    }

    wasDown = ui.mouseDown;
  });
}
