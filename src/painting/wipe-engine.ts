// Wipe engine — rag removal from the accumulation surface
// Omnidirectional, grain-aware, patchy cloth texture, per-tool reservoir
// Phase 6: paint state tracking for wetness-modulated wiping

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getSurfaceHeightTexture } from '../surface/surface-material.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import { getSessionTime } from '../session/session-timer.js';
import wipeShader from '../shaders/brush/wipe.wgsl';

type Vec2 = [number, number];

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let grainLayout: GPUBindGroupLayout;
let stateLayout: GPUBindGroupLayout;
let grainSampler: GPUSampler;

const PARAM_SIZE = 48; // bytes: 12 floats
let paramStride = 256;
const MAX_DABS_PER_FRAME = 256;

let lastPos: Vec2 | null = null;

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

  grainLayout = device.createBindGroupLayout({
    label: 'wipe-grain-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
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

  pipeline = createComputePipeline('wipe-v3', device, {
    label: 'wipe-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout, grainLayout, stateLayout],
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

export function beginWipe(x: number, y: number) {
  lastPos = [x, y];
  // Reset per-tool reservoir
  const load = sceneStore.get().load;
  reservoir = load > 0 ? 1.0 : 0;
  totalDistance = 0;
}

export function endWipe() {
  lastPos = null;
}

export function dispatchWipeDabs(encoder: GPUCommandEncoder, x: number, y: number): boolean {
  const { device } = getGPU();
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;
  const sessionTime = getSessionTime();

  const waypoints: Vec2[] = pointerQueue.length > 0
    ? pointerQueue.splice(0).map(p => [p.x, p.y] as Vec2)
    : [[x, y]];

  let points: Vec2[] = [];
  for (const wp of waypoints) {
    if (lastPos) {
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

  // Accumulate pixel distance for depletion
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    totalDistance += Math.sqrt(dx * dx + dy * dy) * w;
  }

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
  const patchiness = 0.6;

  // Write all dab params before encoding dispatches
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const data = new Float32Array([
      pt[0], pt[1],    // center
      radius,           // radius
      scene.thinners,   // thinners
      reservoir,        // strength
      ghostRetention,   // ghost_retention
      patchiness,       // patchiness
      sessionTime,      // session_time
      scene.surface.drySpeed, // surface_dry_speed
      0, 0, 0,          // padding
    ]);
    device.queue.writeBuffer(paramBuffer, i * paramStride, data);
  }

  // Create grain bind group once per dispatch batch
  const grainBG = device.createBindGroup({
    layout: grainLayout,
    entries: [
      { binding: 0, resource: getSurfaceHeightTexture().createView() },
      { binding: 1, resource: grainSampler },
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
    pass.setBindGroup(2, grainBG);
    pass.setBindGroup(3, stateBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    swapSurface();
  }

  return true;
}
