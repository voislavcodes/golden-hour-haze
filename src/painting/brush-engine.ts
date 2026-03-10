// Brush engine — capsule segment dispatch + compute shader
// Writes K-M pigment into the accumulation surface
// Capsule segments between consecutive points with pressure-varying radius
// Touch-down ramp + lift-off ghost taper

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getActiveKS, getBrushSlot, getActiveBrushSlot } from './palette.js';
import { getSurfaceGrainTexture } from '../surface/surface-grain-lut.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import { getSessionTime } from '../session/session-timer.js';
import { markDirty } from '../state/dirty-flags.js';
import brushShader from '../shaders/brush/brush.wgsl';

type Vec2 = [number, number];
type SegPoint = { pos: Vec2; pressure: number };

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let auxLayout: GPUBindGroupLayout;  // grain + paint state
let grainSampler: GPUSampler;

const PARAM_SIZE = 80; // bytes per segment (20 floats)
let paramStride = 256; // aligned stride, set at init from device limits
const MAX_DABS_PER_FRAME = 256;
const TOUCH_RAMP_SEGS = 5;
const GHOST_COUNT = 3;

let lastPos: Vec2 | null = null;
let lastPressure = 0;
let lastRadius = 0;          // effective radius of last segment end, for ghost sizing
let lastDirection: Vec2 = [1, 0];
let strokeSegIndex = 0;
let strokeStartLayers = 0;   // snapshot of estimated peak weight when stroke began
let estimatedPeakLayers = 0;  // running CPU-side estimate of heaviest pixel weight

// Paint depletion state
let reservoir = 0.5;
let totalDistance = 0;
let strokeDabCount = 0;

// Ghost state — populated in endStroke(), consumed in dispatchPendingGhosts()
let ghostAnchor: SegPoint | null = null;
let ghostPoints: SegPoint[] = [];
let ghostsPending = false;

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

  pipeline = createComputePipeline('brush-v4', device, {
    label: 'brush-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout, auxLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'brush-shader', code: brushShader }),
      entryPoint: 'main',
    },
  });

  // Pre-allocate buffer large enough for many segments per frame
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

function pressureRadius(base: number, pressure: number): number {
  return base * (0.3 + 0.7 * pressure);
}

function interpolateSegPoints(prev: SegPoint, curr: SegPoint, radius: number): SegPoint[] {
  const dx = curr.pos[0] - prev.pos[0];
  const dy = curr.pos[1] - prev.pos[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = radius * 0.5;  // wider spacing for capsule segments (was 0.25 for circles)
  const count = Math.max(1, Math.ceil(dist / step));
  const pts: SegPoint[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    pts.push({
      pos: [prev.pos[0] + dx * t, prev.pos[1] + dy * t],
      pressure: prev.pressure + (curr.pressure - prev.pressure) * t,
    });
  }
  return pts;
}

export function beginStroke(x: number, y: number, pressure: number) {
  strokeStartLayers = estimatedPeakLayers;
  lastPos = [x, y];
  lastPressure = pressure;
  lastRadius = 0;
  strokeSegIndex = 0;
  strokeDabCount = 0;
  ghostsPending = false;
}

export function endStroke() {
  if (lastPos && lastRadius > 0) {
    const dir = lastDirection;
    ghostAnchor = { pos: [...lastPos] as Vec2, pressure: lastPressure };
    ghostPoints = [];
    for (let i = 1; i <= GHOST_COUNT; i++) {
      const t = i / GHOST_COUNT;
      ghostPoints.push({
        pos: [
          lastPos[0] + dir[0] * lastRadius * 0.4 * i,
          lastPos[1] + dir[1] * lastRadius * 0.4 * i,
        ],
        pressure: lastPressure * (1.0 - t * t),  // quadratic taper to near-zero
      });
    }
    ghostsPending = true;
    // markDirty ensures renderFrame enters the surface block next frame
    // to dispatch ghosts, even though strokeActive is already false
    markDirty('surface');
  }
  lastPos = null;
}

export function dispatchPendingGhosts(encoder: GPUCommandEncoder): boolean {
  if (!ghostsPending || !ghostAnchor) return false;
  ghostsPending = false;

  const { device } = getGPU();
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const ks = getActiveKS();
  const slot = getBrushSlot(getActiveBrushSlot());
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  const sessionTime = getSessionTime();
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);

  // Build segment chain: anchor -> ghost[0] -> ghost[1] -> ghost[2]
  const chain = [ghostAnchor, ...ghostPoints];

  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1];
    const curr = chain[i];
    const startR = pressureRadius(ui.brushSize, prev.pressure);
    const endR = pressureRadius(ui.brushSize, curr.pressure);

    const data = new Float32Array([
      prev.pos[0], prev.pos[1],          // seg_start
      curr.pos[0], curr.pos[1],          // seg_end
      startR, endR,                       // start_radius, end_radius
      scene.thinners, pigmentDensity,    // thinners, pigment_density
      ks.Kr, ks.Kg, ks.Kb,              // palette_K
      scene.falloff,                     // falloff
      reservoir,                         // reservoir (continues from stroke)
      slot.age, slot.bristleSeed,        // age, bristle_seed
      strokeStartLayers,                 // stroke_start_layers
      scene.surface.absorption,          // surface_absorption
      sessionTime, scene.surface.drySpeed, // session_time, surface_dry_speed
      0,                                 // _pad
    ]);
    device.queue.writeBuffer(paramBuffer, 0, data);

    const accumPP = getAccumPP();
    const statePP = getStatePP();
    const paramBG = device.createBindGroup({
      layout: paramLayout,
      entries: [{ binding: 0, resource: { buffer: paramBuffer, offset: 0, size: PARAM_SIZE } }],
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
    const pass = encoder.beginComputePass({ label: 'brush-ghost' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, paramBG);
    pass.setBindGroup(1, texBG);
    pass.setBindGroup(2, auxBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    swapSurface();
  }

  ghostAnchor = null;
  ghostPoints = [];
  return true;
}

export function dispatchBrushDabs(encoder: GPUCommandEncoder, x: number, y: number): boolean {
  const { device } = getGPU();
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;

  // Build waypoints with pressure from queued coalesced positions
  const waypoints: SegPoint[] = pointerQueue.length > 0
    ? pointerQueue.splice(0).map(p => ({ pos: [p.x, p.y] as Vec2, pressure: p.pressure }))
    : [{ pos: [x, y] as Vec2, pressure: ui.pressure || 0.5 }];

  // Interpolate through all waypoints for a continuous stroke
  let points: SegPoint[] = [];
  for (const wp of waypoints) {
    if (lastPos) {
      const prevPt: SegPoint = { pos: lastPos, pressure: lastPressure };
      points = points.concat(interpolateSegPoints(prevPt, wp, radius));
    } else {
      points.push(wp);
    }
    lastPos = wp.pos;
    lastPressure = wp.pressure;
  }

  if (points.length === 0) return false;

  // Cap segments per frame to buffer capacity
  if (points.length > MAX_DABS_PER_FRAME) {
    points = points.slice(points.length - MAX_DABS_PER_FRAME);
  }

  const ks = getActiveKS();
  const slot = getBrushSlot(getActiveBrushSlot());
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  const sessionTime = getSessionTime();

  // Thinners-derived pigment density
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);

  // Accumulate pixel distance for paint depletion
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].pos[0] - points[i - 1].pos[0];
    const dy = points[i].pos[1] - points[i - 1].pos[1];
    totalDistance += Math.sqrt(dx * dx + dy * dy) * w;
  }

  // Update reservoir based on depletion curve
  const load = scene.load;
  if (load <= 0) {
    reservoir = 0;
  } else {
    const radiusPixels = radius * w;
    const holdDistance = load * radiusPixels * 15;
    const drainDistance = totalDistance - holdDistance;
    if (drainDistance > 0) {
      const drainRate = (1.0 - load) * 0.001 + 0.00015;
      reservoir = Math.exp(-drainRate * drainDistance);
    } else {
      reservoir = 1.0;
    }
  }

  // Compute per-point taper and effective radius
  // Touch-down taper: ramp from 0.3 to 1.0 over first TOUCH_RAMP_SEGS segments
  const pointRadii: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const taper = 0.3 + 0.7 * Math.min(1.0, (strokeSegIndex + i) / TOUCH_RAMP_SEGS);
    pointRadii.push(pressureRadius(radius, points[i].pressure) * taper);
  }

  // Build segments as consecutive point pairs
  // For the first point of the stroke (no previous), emit a degenerate capsule (start == end)
  const segments: Array<{
    startPos: Vec2; endPos: Vec2;
    startR: number; endR: number;
  }> = [];

  if (strokeDabCount === 0 && points.length > 0) {
    // Very first point: degenerate capsule (circle)
    segments.push({
      startPos: points[0].pos, endPos: points[0].pos,
      startR: pointRadii[0], endR: pointRadii[0],
    });
  }

  for (let i = 1; i < points.length; i++) {
    const prevPt = points[i - 1];
    const pt = points[i];
    segments.push({
      startPos: prevPt.pos, endPos: pt.pos,
      startR: pointRadii[i - 1], endR: pointRadii[i],
    });

    // Track direction for ghost segments
    const dx = pt.pos[0] - prevPt.pos[0];
    const dy = pt.pos[1] - prevPt.pos[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.0001) {
      lastDirection = [dx / len, dy / len];
    }
  }

  // Update stroke counters
  const newSegs = strokeDabCount === 0 ? points.length : points.length - 1;
  strokeSegIndex += points.length;
  strokeDabCount += Math.max(1, newSegs);
  if (pointRadii.length > 0) {
    lastRadius = pointRadii[pointRadii.length - 1];
  }

  if (segments.length === 0) return false;

  // Write ALL segment params to the buffer BEFORE encoding dispatches
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const data = new Float32Array([
      seg.startPos[0], seg.startPos[1],   // 0-1: seg_start
      seg.endPos[0], seg.endPos[1],       // 2-3: seg_end
      seg.startR, seg.endR,               // 4-5: start_radius, end_radius
      scene.thinners, pigmentDensity,     // 6-7: thinners, pigment_density
      ks.Kr, ks.Kg, ks.Kb,               // 8-10: palette_K (byte 32, 16-aligned)
      scene.falloff,                      // 11: falloff
      reservoir,                          // 12: reservoir
      slot.age,                           // 13: age
      slot.bristleSeed,                   // 14: bristle_seed
      strokeStartLayers,                  // 15: stroke_start_layers
      scene.surface.absorption,           // 16: surface_absorption
      sessionTime,                        // 17: session_time
      scene.surface.drySpeed,             // 18: surface_dry_speed
      0,                                  // 19: _pad
    ]);
    device.queue.writeBuffer(paramBuffer, i * paramStride, data);
  }

  // Encode dispatches — each reads from its own offset in the param buffer
  for (let i = 0; i < segments.length; i++) {
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

    const pass = encoder.beginComputePass({ label: 'brush-segment' });
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
