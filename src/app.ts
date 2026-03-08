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
} from './layers/compositor.js';
import { initUILayer, renderUI } from './layers/ui-layer.js';
import { sceneStore } from './state/scene-state.js';
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
import { initPointerInput } from './input/pointer.js';
import { initGestureInput } from './input/gesture.js';
import { initKeyboardInput } from './input/keyboard.js';
import {
  updateStrokeMetrics,
  metricsToModifiers,
  resetStrokeTracking,
} from './input/pressure.js';
import type { FormDef } from './layers/layer-types.js';

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
  writeAtmosphereParams(scene.atmosphere);
  writeScatterParams(scene.sunAngle, scene.sunElevation);
  writeFormsData(scene.forms, scene.palette.colors);
  writeLightData(scene.lights, 32);

  // Input
  initPointerInput(canvas);
  initGestureInput(canvas, (gesture) => {
    // Pinch controls atmosphere grain
    if (gesture.active) {
      sceneStore.update((s) => ({
        atmosphere: {
          ...s.atmosphere,
          grain: Math.max(0, Math.min(1, s.atmosphere.grain * gesture.pinchScale)),
        },
      }));
    }
  });
  initKeyboardInput();

  // Handle form placement on click
  setupFormPlacement(canvas);

  // React to state changes
  sceneStore.subscribe((state) => {
    writeDepthParams(state.depth);
    writeAtmosphereParams(state.atmosphere);
    writeScatterParams(state.sunAngle, state.sunElevation);
    writePaletteData(state.palette);
    writeFormsData(state.forms, state.palette.colors);
    writeLightData(state.lights, 32);
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

  // Pass order: depth → atmosphere → forms → light → bloom → composite
  dispatchDepth(encoder, globalBindGroup);
  dispatchAtmosphere(encoder, globalBindGroup);
  dispatchForms(encoder, globalBindGroup);
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

  uiStore.subscribe((ui) => {
    if (ui.mouseDown && !wasDown && ui.activeTool === 'form') {
      const scene = sceneStore.get();
      const metrics = updateStrokeMetrics(ui.mouseX, ui.mouseY, ui.pressure, performance.now());
      const mods = metricsToModifiers(metrics);

      const newForm: FormDef = {
        type: 0, // circle
        x: ui.mouseX,
        y: ui.mouseY,
        sizeX: mods.size,
        sizeY: mods.size,
        rotation: mods.rotation,
        softness: mods.softness,
        depth: ui.mouseY, // depth from vertical position
        colorIndex: scene.palette.activeIndex,
        opacity: 0.8,
        dissolution: 0,
      };

      sceneStore.set({ forms: [...scene.forms, newForm] });
      resetStrokeTracking();
    }

    if (ui.mouseDown && !wasDown && ui.activeTool === 'light') {
      const scene = sceneStore.get();
      sceneStore.set({
        lights: [
          ...scene.lights,
          {
            x: ui.mouseX,
            y: ui.mouseY,
            depth: ui.mouseY * 0.5,
            intensity: 1.5,
            radius: 0.3,
            colorR: 1.0,
            colorG: 0.85,
            colorB: 0.6,
            scatter: 0.8,
          },
        ],
      });
    }

    wasDown = ui.mouseDown;
  });
}
