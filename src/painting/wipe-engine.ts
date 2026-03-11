// Wipe engine — physical rag with directional smear, cloth contact, pressure sensitivity
// 96-byte WipeParams, cloth heightfield in bind group 2, rag contamination state

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getSurfaceHeightTexture } from '../surface/surface-material.js';
import { getClothHeightfieldTexture } from '../surface/cloth-heightfield.js';
import { getMaterial } from '../surface/materials.js';
import { getRagState, feedRag } from './rag-state.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import { getSessionTime } from '../session/session-timer.js';
import wipeShader from '../shaders/brush/wipe.wgsl';

type Vec2 = [number, number];

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let surfaceLayout: GPUBindGroupLayout;
let stateLayout: GPUBindGroupLayout;
let grainSampler: GPUSampler;

const PARAM_SIZE = 96; // bytes: 24 floats
let paramStride = 256;
const MAX_DABS_PER_FRAME = 256;

let lastPos: Vec2 | null = null;
let wipeDirection: Vec2 = [0, 0];
let wipeSpeed = 0;
let lastPressure = 0.5;

// Per-tool reservoir
let reservoir = 1.0;
let totalDistance = 0;

export function initWipeEngine() {
  const { device } = getGPU();

  paramStride = Math.max(PARAM_SIZE, device.limits.minUniformBufferOffsetAlignment);

  paramLayout = device.createBindGroupLayout({
    label: 'wipe-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: false } },
    ],
  });

  textureLayout = device.createBindGroupLayout({
    label: 'wipe-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  surfaceLayout = device.createBindGroupLayout({
    label: 'wipe-surface-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    ],
  });

  stateLayout = device.createBindGroupLayout({
    label: 'wipe-state-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
    ],
  });

  grainSampler = device.createSampler({
    label: 'wipe-grain-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  pipeline = createComputePipeline('wipe-v4', device, {
    label: 'wipe-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout, surfaceLayout, stateLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'wipe-shader', code: wipeShader }),
      entryPoint: 'main',
    },
  });

  paramBuffer = device.createBuffer({
    label: 'wipe-params',
    size: MAX_DABS_PER_FRAME * paramStride,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

function interpolateStroke(prev: Vec2, curr: Vec2, radius: number): Vec2[] {
  const dx = curr[0] - prev[0];
  const dy = curr[1] - prev[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = radius * 0.25;
  const count = Math.max(1, Math.ceil(dist / step));
  const points: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push([prev[0] + dx * t, prev[1] + dy * t]);
  }
  return points;
}

export function beginWipe(x: number, y: number, pressure: number = 0.5) {
  lastPos = [x, y];
  wipeDirection = [0, 0];
  wipeSpeed = 0;
  lastPressure = pressure;
  // Reset per-tool reservoir
  const load = sceneStore.get().load;
  reservoir = load > 0 ? 1.0 : 0;
  totalDistance = 0;
}

export function endWipe() {
  // Feed rag with approximation of lifted paint (active palette color as proxy)
  const scene = sceneStore.get();
  const palette = scene.palette;
  const activeColor = palette.colors[palette.activeIndex];
  const encounterFactor = 1.0 - reservoir;
  if (encounterFactor > 0.01) {
    feedRag(activeColor.r, activeColor.g, activeColor.b, encounterFactor);
  }
  lastPos = null;
  wipeDirection = [0, 0];
  wipeSpeed = 0;
}

export function dispatchWipeDabs(encoder: GPUCommandEncoder, x: number, y: number): boolean {
  const { device } = getGPU();
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;
  const sessionTime = getSessionTime();

  // Extract waypoints + average pressure from pointer queue
  let pressureSum = 0;
  let pressureCount = 0;
  const waypoints: Vec2[] = [];

  if (pointerQueue.length > 0) {
    const events = pointerQueue.splice(0);
    for (const p of events) {
      waypoints.push([p.x, p.y]);
      pressureSum += p.pressure;
      pressureCount++;
    }
  } else {
    waypoints.push([x, y]);
    pressureSum = lastPressure;
    pressureCount = 1;
  }

  const avgPressure = pressureCount > 0 ? pressureSum / pressureCount : 0.5;
  lastPressure = avgPressure;

  let points: Vec2[] = [];
  for (const wp of waypoints) {
    if (lastPos) {
      // Update wipe direction from movement (exponential smoothing)
      const dx = wp[0] - lastPos[0];
      const dy = wp[1] - lastPos[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0.001) {
        const newDirX = dx / len;
        const newDirY = dy / len;
        wipeDirection[0] = wipeDirection[0] * 0.7 + newDirX * 0.3;
        wipeDirection[1] = wipeDirection[1] * 0.7 + newDirY * 0.3;
        // Re-normalize
        const sLen = Math.sqrt(wipeDirection[0] * wipeDirection[0] + wipeDirection[1] * wipeDirection[1]);
        if (sLen > 0.001) {
          wipeDirection[0] /= sLen;
          wipeDirection[1] /= sLen;
        }
      }
      points = points.concat(interpolateStroke(lastPos, wp, radius));
    } else {
      points.push(wp);
    }
    lastPos = wp;
  }

  if (points.length === 0) return false;

  if (points.length > MAX_DABS_PER_FRAME) {
    points = points.slice(points.length - MAX_DABS_PER_FRAME);
  }

  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  // Accumulate pixel distance for depletion + speed tracking
  let framePixelDist = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const d = Math.sqrt(dx * dx + dy * dy) * w;
    totalDistance += d;
    framePixelDist += d;
  }

  // Normalized speed: pixel distance per dab / pixel radius
  const avgPixelDistPerDab = points.length > 1 ? framePixelDist / (points.length - 1) : 0;
  wipeSpeed = Math.min(1.0, avgPixelDistPerDab / (radius * w));

  // Update reservoir based on depletion curve
  const load = scene.load;
  if (load <= 0) {
    reservoir = 0;
  } else {
    const holdDistance = load * 400;
    const drainDistance = totalDistance - holdDistance;
    if (drainDistance > 0) {
      const drainRate = (1.0 - load) * 0.003 + 0.0002;
      reservoir = Math.exp(-drainRate * drainDistance);
    } else {
      reservoir = 1.0;
    }
  }

  const ghostRetention = 0.15;

  // Material residue floor
  const mat = getMaterial(scene.surface.material);
  const residueFloor = mat.residueFloor;

  // Pressure-derived smear: light = more smear, heavy = more lift
  const smearAmount = 0.6 + (0.15 - 0.6) * avgPressure; // mix(0.6, 0.15, pressure)

  // Rag state
  const rag = getRagState();

  // Cloth tiling: surface_dims / 256 — cloth repeats every ~256 surface pixels
  const clothScaleX = w / 256.0;
  const clothScaleY = h / 256.0;

  // Write all dab params before encoding dispatches
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const data = new Float32Array([
      pt[0], pt[1],                           // center [0,1]
      wipeDirection[0], wipeDirection[1],      // wipe_direction [2,3]
      radius,                                  // radius [4]
      scene.thinners,                          // thinners [5]
      reservoir,                               // strength [6]
      ghostRetention,                          // ghost_retention [7]
      sessionTime,                             // session_time [8]
      scene.surface.drySpeed,                  // surface_dry_speed [9]
      residueFloor,                            // residue_floor [10]
      smearAmount,                             // smear_amount [11]
      avgPressure,                             // pressure [12]
      rag.Kr, rag.Kg, rag.Kb,                 // rag_Kr/Kg/Kb [13,14,15]
      clothScaleX, clothScaleY,                // cloth_scale [16,17]
      rag.saturation,                          // rag_saturation [18]
      wipeSpeed,                               // wipe_speed [19]
      0, 0, 0, 0,                             // padding [20-23]
    ]);
    device.queue.writeBuffer(paramBuffer, i * paramStride, data);
  }

  // Create surface bind group once per dispatch batch (surface_height + sampler + cloth_height + cloth_sampler)
  const surfaceBG = device.createBindGroup({
    layout: surfaceLayout,
    entries: [
      { binding: 0, resource: getSurfaceHeightTexture().createView() },
      { binding: 1, resource: grainSampler },
      { binding: 2, resource: getClothHeightfieldTexture().createView() },
      { binding: 3, resource: grainSampler },
    ],
  });

  for (let i = 0; i < points.length; i++) {
    const accumPP = getAccumPP();
    const statePP = getStatePP();

    const paramBG = device.createBindGroup({
      layout: paramLayout,
      entries: [{ binding: 0, resource: { buffer: paramBuffer, offset: i * paramStride, size: PARAM_SIZE } }],
    });

    const texBG = device.createBindGroup({
      layout: textureLayout,
      entries: [
        { binding: 0, resource: accumPP.readView },
        { binding: 1, resource: accumPP.writeView },
      ],
    });

    const stateBG = device.createBindGroup({
      layout: stateLayout,
      entries: [
        { binding: 0, resource: statePP.readView },
        { binding: 1, resource: statePP.writeView },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'wipe-dab' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, paramBG);
    pass.setBindGroup(1, texBG);
    pass.setBindGroup(2, surfaceBG);
    pass.setBindGroup(3, stateBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    swapSurface();
  }

  return true;
}
