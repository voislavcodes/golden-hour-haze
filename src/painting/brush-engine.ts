// Brush engine — incremental per-bristle capsule SDF dispatch with bristle bundle physics
// 48 selected bristle tips each render 1 capsule (prev→curr) per waypoint.
// Each pixel gets deposited exactly once — the frame its capsule advances over it.
// No mask. No snapshot. No path accumulation.

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getActiveKS, getBrushSlot, getActiveBrushSlot, getOilRemaining, getAnchorRemaining, depleteOil } from './palette.js';
import { getSurfaceHeightTexture } from '../surface/surface-material.js';
import { getMaterial } from '../surface/materials.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import { getSessionTime } from '../session/session-timer.js';
import {
  createBundle, updateBundle, dipBundle, wipeBundle,
  getAverageLoad, setSurfaceProperties,
  ensureBundle, getActiveBundle, setActiveBundle,
  resetPaths, commitPaths, hasDirtyPaths,
  snapTipOffsets, SELECTED_TIP_COUNT,
  type BristlePath,
} from './bristle-bundle.js';
import brushShader from '../shaders/brush/brush.wgsl';

type Vec2 = [number, number];
type SegPoint = { pos: Vec2; pressure: number; tiltX: number; tiltY: number };

let pipeline: GPUComputePipeline;
let uniformBuffer: GPUBuffer;
let segmentBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let auxLayout: GPUBindGroupLayout;
let grainSampler: GPUSampler;

// BrushParams: 96 bytes
// BristleSegment: 48 bytes × 48 = 2,304 bytes
const UNIFORM_SIZE = 96;
const SEGMENT_STRIDE = 48;  // bytes per BristleSegment
const SEGMENT_BUFFER_SIZE = SELECTED_TIP_COUNT * SEGMENT_STRIDE; // 2,304 bytes

let lastPos: Vec2 | null = null;
let lastPressure = 0;
let strokeStartLayers = 0;
let estimatedPeakLayers = 0;

// Hysteresis commit control — decouple physics rate from render rate
let strokeDispatched = false;
const BRISTLE_COMMIT = 0.4;    // commit when any bristle moves 0.4× its own radius
const BRISTLE_SUBDIVIDE = 1.0; // subdivide when any bristle would jump > 1× its radius

// Paint depletion state
let reservoir = 0.5;
let strokeDabCount = 0;
let lastFrameTime = 0;
let loadScale = 1.0;   // rag wipe reduces this; dip resets to 1.0

export function initBrushEngine() {
  const { device } = getGPU();

  paramLayout = device.createBindGroupLayout({
    label: 'brush-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });

  textureLayout = device.createBindGroupLayout({
    label: 'brush-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  auxLayout = device.createBindGroupLayout({
    label: 'brush-aux-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
    ],
  });

  grainSampler = device.createSampler({
    label: 'brush-grain-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  pipeline = createComputePipeline('brush-v11', device, {
    label: 'brush-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout, auxLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'brush-shader', code: brushShader }),
      entryPoint: 'main',
    },
  });

  uniformBuffer = device.createBuffer({
    label: 'brush-uniform',
    size: UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  segmentBuffer = device.createBuffer({
    label: 'brush-segments',
    size: SEGMENT_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  reloadBrush();
}

export function reloadBrush() {
  const slot = getBrushSlot(getActiveBrushSlot());
  const ks = getActiveKS();
  const scene = sceneStore.get();
  const load = scene.load;

  // Reset reservoir — proportional to load amount
  loadScale = 1.0;
  reservoir = load;

  // Init/dip the bristle bundle
  let bundle = getActiveBundle();
  if (!bundle) {
    bundle = createBundle(slot.bristleSeed, slot.age);
    setActiveBundle(bundle);
  }
  const mat = getMaterial(scene.surface.material);
  setSurfaceProperties(bundle, mat.friction, mat.tooth);
  dipBundle(bundle, ks.Kr, ks.Kg, ks.Kb, getOilRemaining(), getAnchorRemaining(), load);
}

/** Wipe brush on rag — reduces paint load + bundle tip loads (dry brush) */
export function wipeBrush() {
  const bundle = getActiveBundle();
  if (bundle) wipeBundle(bundle);
  loadScale *= 0.2;
  reservoir *= 0.2;
}

export function getReservoir(): number {
  // Blend between distance-based reservoir and bundle average load
  const bundle = getActiveBundle();
  const bundleLoad = bundle ? getAverageLoad(bundle) : reservoir;
  return Math.min(reservoir, bundleLoad);
}

function dist2d(a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function subdivideIfNeeded(prev: SegPoint, curr: SegPoint, maxLen: number): SegPoint[] {
  const dx = curr.pos[0] - prev.pos[0];
  const dy = curr.pos[1] - prev.pos[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= maxLen) {
    return [prev, curr];
  }
  const count = Math.ceil(dist / maxLen);
  const pts: SegPoint[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    pts.push({
      pos: [prev.pos[0] + dx * t, prev.pos[1] + dy * t],
      pressure: prev.pressure + (curr.pressure - prev.pressure) * t,
      tiltX: prev.tiltX + (curr.tiltX - prev.tiltX) * t,
      tiltY: prev.tiltY + (curr.tiltY - prev.tiltY) * t,
    });
  }
  return pts;
}

/** Pack 48 BristleSegment structs from dirty paths, dispatch + submit immediately.
 *  Each waypoint gets its own command buffer so writeBuffer data isn't overwritten
 *  by subsequent waypoints before the GPU reads it. */
function dispatchSegments(
  paths: BristlePath[],
  scene: ReturnType<typeof sceneStore.get>,
  slot: ReturnType<typeof getBrushSlot>,
  ks: { Kr: number; Kg: number; Kb: number },
  tStart: number = 0,
  tEnd: number = 1,
) {
  const { device } = getGPU();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  const sessionTime = getSessionTime();
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);

  // Pack segments and compute AABB
  const segData = new Float32Array(SELECTED_TIP_COUNT * 12); // 48 floats per segment (48 bytes / 4)
  let aabbMinX = Infinity, aabbMinY = Infinity;
  let aabbMaxX = -Infinity, aabbMaxY = -Infinity;
  let activeCount = 0;

  for (let bi = 0; bi < paths.length; bi++) {
    const path = paths[bi];
    if (!path.dirty || !path.prevPos || !path.currPos) continue;

    // Interpolate positions, radius, load for sub-capsule range [tStart, tEnd]
    const px = path.prevPos[0] + (path.currPos[0] - path.prevPos[0]) * tStart;
    const py = path.prevPos[1] + (path.currPos[1] - path.prevPos[1]) * tStart;
    const cx = path.prevPos[0] + (path.currPos[0] - path.prevPos[0]) * tEnd;
    const cy = path.prevPos[1] + (path.currPos[1] - path.prevPos[1]) * tEnd;
    const pr = path.prevRadius + (path.currRadius - path.prevRadius) * tStart;
    const cr = path.prevRadius + (path.currRadius - path.prevRadius) * tEnd;
    const pl = path.prevLoad + (path.currLoad - path.prevLoad) * tStart;
    const cl = path.prevLoad + (path.currLoad - path.prevLoad) * tEnd;

    const off = bi * 12;
    segData[off + 0] = px;    // prev_pos.x
    segData[off + 1] = py;    // prev_pos.y
    segData[off + 2] = cx;    // curr_pos.x
    segData[off + 3] = cy;    // curr_pos.y
    segData[off + 4] = pr;    // prev_radius
    segData[off + 5] = cr;    // curr_radius
    segData[off + 6] = pl;    // prev_load
    segData[off + 7] = cl;    // curr_load
    segData[off + 8] = path.ringNorm;     // ring_norm
    segData[off + 9] = path.colorKr;      // color_kr
    segData[off + 10] = path.colorKg;     // color_kg
    segData[off + 11] = path.colorKb;     // color_kb
    activeCount++;

    // Expand AABB from interpolated positions — 6× radius margin for paint spread
    const maxR = Math.max(pr, cr) * 6;
    aabbMinX = Math.min(aabbMinX, px - maxR, cx - maxR);
    aabbMinY = Math.min(aabbMinY, py - maxR, cy - maxR);
    aabbMaxX = Math.max(aabbMaxX, px + maxR, cx + maxR);
    aabbMaxY = Math.max(aabbMaxY, py + maxR, cy + maxR);
  }

  if (activeCount === 0) return;

  // Write uniform buffer (96 bytes)
  const ab = new ArrayBuffer(UNIFORM_SIZE);
  const f32 = new Float32Array(ab);
  const u32 = new Uint32Array(ab);
  f32[0] = aabbMinX;
  f32[1] = aabbMinY;
  f32[2] = aabbMaxX;
  f32[3] = aabbMaxY;
  f32[4] = ks.Kr;
  f32[5] = ks.Kg;
  f32[6] = ks.Kb;
  f32[7] = scene.thinners;
  f32[8] = scene.falloff;
  f32[9] = pigmentDensity;
  f32[10] = reservoir;
  f32[11] = slot.age;
  f32[12] = slot.bristleSeed;
  f32[13] = strokeStartLayers;
  f32[14] = scene.surface.absorption;
  f32[15] = sessionTime;
  f32[16] = scene.surface.drySpeed;
  u32[17] = SELECTED_TIP_COUNT;
  f32[18] = getOilRemaining();
  f32[19] = getAnchorRemaining();
  const mat = getMaterial(scene.surface.material);
  f32[20] = mat.tooth;
  device.queue.writeBuffer(uniformBuffer, 0, ab);

  // Upload segment buffer
  device.queue.writeBuffer(segmentBuffer, 0, segData);

  // Bind groups — reads from current accumPP.read, writes to accumPP.write
  const accumPP = getAccumPP();
  const statePP = getStatePP();

  const paramBG = device.createBindGroup({
    layout: paramLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: segmentBuffer } },
    ],
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
      { binding: 0, resource: getSurfaceHeightTexture().createView() },
      { binding: 1, resource: grainSampler },
      { binding: 2, resource: statePP.readView },
      { binding: 3, resource: statePP.writeView },
    ],
  });

  // Own encoder + immediate submit — ensures writeBuffer data is consumed
  // before the next waypoint overwrites it
  const encoder = device.createCommandEncoder({ label: 'brush-segment' });
  const pass = encoder.beginComputePass({ label: 'brush-segment-pass' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, paramBG);
  pass.setBindGroup(1, texBG);
  pass.setBindGroup(2, auxBG);
  pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  pass.end();
  device.queue.submit([encoder.finish()]);

  // Swap after submit — next waypoint reads the updated surface
  swapSurface();
}

export function beginStroke(x: number, y: number, pressure: number) {
  strokeStartLayers = estimatedPeakLayers;
  lastPos = [x, y];
  lastPressure = pressure;
  strokeDabCount = 0;
  strokeDispatched = false;
  lastFrameTime = performance.now() / 1000;

  // Reset bundle position for new stroke
  const slot = getBrushSlot(getActiveBrushSlot());
  let bundle = getActiveBundle();
  if (!bundle) {
    bundle = createBundle(slot.bristleSeed, slot.age);
    setActiveBundle(bundle);
  }
  bundle.lastPos = [x, y];
  bundle.springBackActive = false;
  bundle.springBackFrames = 0;
  // Snap splay to initial pressure target — no spring delay for first touch
  const initPSq = pressure * pressure;
  bundle.splay = initPSq * 0.85 + 0.15;
  bundle.splayVelocity = 0;

  // Snap tip offsets to match new splay — prevents first-frame capture at stale positions
  snapTipOffsets(bundle);

  // Reset per-bristle paths for new stroke
  resetPaths(bundle);

  const scene = sceneStore.get();
  const mat = getMaterial(scene.surface.material);
  setSurfaceProperties(bundle, mat.friction, mat.tooth);
}

export function endStroke() {
  const bundle = getActiveBundle();
  if (bundle) {
    if (hasDirtyPaths(bundle)) {
      // Flush remaining un-committed segment (< COMMIT_MIN distance)
      const scene = sceneStore.get();
      const slot = getBrushSlot(getActiveBrushSlot());
      const ks = getActiveKS();
      dispatchSegments(bundle.paths, scene, slot, ks);
      commitPaths(bundle);
    } else if (!strokeDispatched) {
      // Dab case: touch+lift with no movement — force zero-length capsule at prevPos
      for (const path of bundle.paths) {
        if (path.prevPos && !path.currPos) {
          path.currPos = [path.prevPos[0], path.prevPos[1]];
          path.currRadius = path.prevRadius;
          path.currLoad = path.prevLoad;
          path.dirty = true;
        }
      }
      if (hasDirtyPaths(bundle)) {
        const scene = sceneStore.get();
        const slot = getBrushSlot(getActiveBrushSlot());
        const ks = getActiveKS();
        dispatchSegments(bundle.paths, scene, slot, ks);
        commitPaths(bundle);
      }
    }
  }
  lastPos = null;
  strokeDispatched = false;
  depleteOil();
}

export function dispatchBrushDabs(_encoder: GPUCommandEncoder, x: number, y: number): boolean {
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;

  // Compute dt for bundle physics
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastFrameTime, 0.05);
  lastFrameTime = now;

  // Build waypoints with pressure from queued coalesced positions
  const waypoints: SegPoint[] = pointerQueue.length > 0
    ? pointerQueue.splice(0).map(p => ({
        pos: [p.x, p.y] as Vec2,
        pressure: p.pressure,
        tiltX: p.tiltX,
        tiltY: p.tiltY,
      }))
    : [{ pos: [x, y] as Vec2, pressure: ui.pressure || 0.5, tiltX: ui.tiltX || 0, tiltY: ui.tiltY || 0 }];

  // Build points — subdivide only on very fast strokes
  const maxSegLen = radius * 4.0;
  let points: SegPoint[] = [];
  for (const wp of waypoints) {
    if (lastPos) {
      const prevPt: SegPoint = { pos: lastPos, pressure: lastPressure, tiltX: 0, tiltY: 0 };
      const sub = subdivideIfNeeded(prevPt, wp, maxSegLen);
      points = points.concat(points.length === 0 ? sub : sub.slice(1));
    } else {
      points.push(wp);
    }
    lastPos = wp.pos;
    lastPressure = wp.pressure;
  }

  if (points.length === 0) return false;

  const ks = getActiveKS();
  const slot = getBrushSlot(getActiveBrushSlot());
  const bundle = ensureBundle(slot.bristleSeed, slot.age);

  // Advance bundle physics for each waypoint — this also sets currPos on paths
  const dtPerWp = waypoints.length > 1 ? dt / waypoints.length : dt;
  const w = getSurfaceWidth();
  const aspectCorrection = getSurfaceHeight() / w;

  // Compute frame distance FIRST so reservoir depletes before path recording
  const radiusPixels = Math.max(1, radius * w);
  let frameDist = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].pos[0] - points[i - 1].pos[0];
    const dy = points[i].pos[1] - points[i - 1].pos[1];
    frameDist += Math.sqrt(dx * dx + dy * dy) * w;
  }
  const frameDistBrushWidths = frameDist / radiusPixels;

  // Exponential decay reservoir
  const load = scene.load;
  const effectiveLoad = load * loadScale;
  if (effectiveLoad <= 0) {
    reservoir = 0;
  } else {
    const BASE_TRANSFER = 0.12;
    const isDryBrush = loadScale < 0.5;
    const transferMult = isDryBrush ? 2.5 : 1.0;
    const RESIDUAL_FLOOR = isDryBrush ? 0 : 0.02 * effectiveLoad;
    const avgPressure = points.reduce((sum, p) => sum + p.pressure, 0) / points.length;
    const splay = bundle.splay * (1.0 + bundle.age * 0.3);
    const transferRate = BASE_TRANSFER * transferMult
      * (0.5 + 0.5 * avgPressure)
      * (1.0 + scene.thinners * 0.3)
      * splay;
    const transferred = reservoir * transferRate * frameDistBrushWidths;
    reservoir = Math.max(RESIDUAL_FLOOR, reservoir - transferred);
  }

  // Bundle average load nudges reservoir when tips deplete
  const bundleLoad = getAverageLoad(bundle);
  if (bundleLoad < 0.5 && bundleLoad < reservoir) {
    reservoir = reservoir * 0.9 + bundleLoad * 0.1;
  }

  // Per-waypoint dispatch loop: physics always runs, rendering gated by bristle displacement
  let dispatched = false;
  for (const wp of waypoints) {
    // 1. Physics always runs — sets currPos for each bristle
    updateBundle(bundle, wp.pos, wp.pressure, wp.tiltX, wp.tiltY, dtPerWp, radius, aspectCorrection, reservoir);

    // 2. Seeding — if no dirty paths (prevPos null), commit to seed and continue
    if (!hasDirtyPaths(bundle)) {
      commitPaths(bundle);
      continue;
    }

    // 3. Max bristle displacement relative to its own radius —
    //    outer bristles with splay jumps trigger commits sooner than center bristles
    let maxRatio = 0;
    for (const path of bundle.paths) {
      if (path.dirty && path.prevPos && path.currPos && path.currRadius > 0) {
        const d = dist2d(path.prevPos, path.currPos);
        maxRatio = Math.max(maxRatio, d / path.currRadius);
      }
    }

    // 4. Below minimum — no bristle has moved far enough to create a visible gap
    if (maxRatio < BRISTLE_COMMIT) {
      continue;
    }

    // 5. Dispatch — subdivide if any bristle would jump more than its radius
    if (maxRatio > BRISTLE_SUBDIVIDE) {
      const steps = Math.ceil(maxRatio / BRISTLE_COMMIT);
      for (let s = 0; s < steps; s++) {
        dispatchSegments(bundle.paths, scene, slot, ks, s / steps, (s + 1) / steps);
      }
    } else {
      dispatchSegments(bundle.paths, scene, slot, ks);
    }
    dispatched = true;
    strokeDispatched = true;

    // 6. Commit — advances prevPos←currPos for all bristles
    commitPaths(bundle);
  }

  // Update stroke counters
  strokeDabCount += points.length;

  // Update CPU-side peak weight estimate
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);
  estimatedPeakLayers += pigmentDensity;

  return dispatched;
}
