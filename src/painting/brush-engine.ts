// Brush engine — stroke interpolation + compute shader dispatch
// Writes K-M pigment into the accumulation surface
// Phase 6: thinners-driven, grain-aware, paint state tracking, 64-byte struct

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getActiveKS, getBrushSlot, getActiveBrushSlot } from './palette.js';
import { getSurfaceGrainTexture } from '../surface/surface-grain-lut.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import { getSessionTime } from '../session/session-timer.js';
import brushShader from '../shaders/brush/brush.wgsl';

type Vec2 = [number, number];

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let auxLayout: GPUBindGroupLayout;  // grain + paint state
let grainSampler: GPUSampler;

const PARAM_SIZE = 64; // bytes per dab (16 floats)
let paramStride = 256; // aligned stride, set at init from device limits
const MAX_DABS_PER_FRAME = 256;

let lastPos: Vec2 | null = null;
let strokeStartLayers = 0;   // snapshot of estimated peak weight when stroke began
let estimatedPeakLayers = 0;  // running CPU-side estimate of heaviest pixel weight

// Paint depletion state
let reservoir = 0.5;
let totalDistance = 0;

export function initBrushEngine() {
  const { device } = getGPU();

  paramStride = Math.max(PARAM_SIZE, device.limits.minUniformBufferOffsetAlignment);

  paramLayout = device.createBindGroupLayout({
    label: 'brush-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: false } },
    ],
  });

  textureLayout = device.createBindGroupLayout({
    label: 'brush-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  // Auxiliary bind group: grain LUT + sampler + paint state read/write
  auxLayout = device.createBindGroupLayout({
    label: 'brush-aux-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } },
    ],
  });

  grainSampler = device.createSampler({
    label: 'brush-grain-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  pipeline = createComputePipeline('brush-v3', device, {
    label: 'brush-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout, auxLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'brush-shader', code: brushShader }),
      entryPoint: 'main',
    },
  });

  // Pre-allocate buffer large enough for many dabs per frame
  paramBuffer = device.createBuffer({
    label: 'brush-params',
    size: MAX_DABS_PER_FRAME * paramStride,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  reloadBrush();
}

export function reloadBrush() {
  const load = sceneStore.get().load;
  reservoir = load > 0 ? 1.0 : 0;
  totalDistance = 0;
}

export function getReservoir(): number {
  return reservoir;
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

export function beginStroke(x: number, y: number) {
  strokeStartLayers = estimatedPeakLayers;
  lastPos = [x, y];
}

export function endStroke() {
  lastPos = null;
}

export function dispatchBrushDabs(encoder: GPUCommandEncoder, x: number, y: number): boolean {
  const { device } = getGPU();
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;

  // Build waypoints from queued coalesced positions, falling back to current position
  const waypoints: Vec2[] = pointerQueue.length > 0
    ? pointerQueue.splice(0).map(p => [p.x, p.y] as Vec2)
    : [[x, y]];

  // Interpolate through all waypoints for a continuous stroke
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

  // Cap dabs per frame to buffer capacity
  if (points.length > MAX_DABS_PER_FRAME) {
    points = points.slice(points.length - MAX_DABS_PER_FRAME);
  }

  const ks = getActiveKS();
  const slot = getBrushSlot(getActiveBrushSlot());
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  const sessionTime = getSessionTime();

  // Thinners-derived pigment density
  const pigmentDensity = 1.0 - scene.thinners * 0.85;

  // Accumulate pixel distance for paint depletion
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
    const holdDistance = load * 500;
    const drainDistance = totalDistance - holdDistance;
    if (drainDistance > 0) {
      const drainRate = (1.0 - load) * 0.002 + 0.00015;
      reservoir = Math.exp(-drainRate * drainDistance);
    } else {
      reservoir = 1.0;
    }
  }

  // Write ALL dab params to the buffer at unique offsets BEFORE encoding dispatches.
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const data = new Float32Array([
      pt[0], pt[1],           // center
      radius,                  // radius
      scene.thinners,          // thinners
      ks.Kr, ks.Kg, ks.Kb,    // palette_K
      pigmentDensity,          // pigment_density
      scene.falloff,           // falloff
      reservoir,               // reservoir
      slot.age,                // age
      slot.bristleSeed,        // bristle_seed
      scene.surface.absorption, // surface_absorption
      sessionTime,             // session_time
      scene.surface.drySpeed,  // surface_dry_speed
      strokeStartLayers,       // stroke_start_layers
    ]);
    device.queue.writeBuffer(paramBuffer, i * paramStride, data);
  }

  // Encode dispatches — each reads from its own offset in the param buffer
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

    const auxBG = device.createBindGroup({
      layout: auxLayout,
      entries: [
        { binding: 0, resource: getSurfaceGrainTexture().createView() },
        { binding: 1, resource: grainSampler },
        { binding: 2, resource: statePP.readView },
        { binding: 3, resource: statePP.writeView },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'brush-dab' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, paramBG);
    pass.setBindGroup(1, texBG);
    pass.setBindGroup(2, auxBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    swapSurface();
  }

  // Update CPU-side peak weight estimate
  estimatedPeakLayers += pigmentDensity;

  return true;
}
