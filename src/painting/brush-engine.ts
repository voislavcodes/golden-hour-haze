// Brush engine — stroke interpolation + compute shader dispatch
// Writes K-M pigment into the accumulation surface

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, swapAccum, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getActiveKS } from './palette.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import brushShader from '../shaders/brush/brush.wgsl';

type Vec2 = [number, number];

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;

const PARAM_SIZE = 64; // bytes per dab
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

  pipeline = createComputePipeline('brush', device, {
    label: 'brush-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'brush-shader', code: brushShader }),
      entryPoint: 'main',
    },
  });

  // Pre-allocate buffer large enough for many dabs per frame
  // Each dab needs PARAM_SIZE bytes, aligned to paramStride
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
  const softness = scene.velvet * radius;
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  // Accumulate pixel distance for paint depletion
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    totalDistance += Math.sqrt(dx * dx + dy * dy) * w;
  }

  // Update reservoir based on depletion curve
  // Reservoir starts at 1.0 (full opacity), load controls how fast it drains.
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

  // Write ALL dab params to the buffer at unique offsets BEFORE encoding dispatches.
  // This is critical: queue.writeBuffer writes are coalesced before submit(),
  // so writing to the same offset would make all dispatches see only the last dab.
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const data = new Float32Array([
      pt[0], pt[1],    // center
      radius,           // radius
      softness,         // softness
      ks.Kr, ks.Kg, ks.Kb, // palette_K (vec3f — per-channel K-M absorption)
      0,                // pad
      scene.baseOpacity,    // base_opacity
      scene.falloff,        // falloff
      scene.echo,           // echo
      strokeStartLayers,    // stroke_start_layers
      reservoir,            // reservoir
      0, 0, 0,              // padding to 64 bytes
    ]);
    device.queue.writeBuffer(paramBuffer, i * paramStride, data);
  }

  // Encode dispatches — each reads from its own offset in the param buffer
  for (let i = 0; i < points.length; i++) {
    const accumPP = getAccumPP();

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

    const pass = encoder.beginComputePass({ label: 'brush-dab' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, paramBG);
    pass.setBindGroup(1, texBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    swapAccum();
  }

  // Update CPU-side peak weight estimate (rough: ~1 full-opacity dab's worth per frame)
  estimatedPeakLayers += scene.baseOpacity;

  return true;
}
