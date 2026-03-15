// Brush engine — per-bristle path SDF dispatch with snapshot re-render + bristle bundle physics
// 48 selected bristle tips trace individual capsule polylines on GPU.
// Real gaps emerge from physical spacing — no synthetic sinusoidal texture.
// Snapshot re-render: pre-stroke surface is saved, full stroke re-rendered each frame.

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getActiveKS, getBrushSlot, getActiveBrushSlot, getOilRemaining, getAnchorRemaining, depleteOil } from './palette.js';
import { getSurfaceHeightTexture } from '../surface/surface-material.js';
import { getMaterial } from '../surface/materials.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import { getSessionTime } from '../session/session-timer.js';
import { markDirty } from '../state/dirty-flags.js';
import {
  createBundle, updateBundle, dipBundle, wipeBundle,
  getAverageLoad, setSurfaceProperties,
  ensureBundle, getActiveBundle, setActiveBundle,
  resetPaths, trimPathsToTail,
  snapTipOffsets, SELECTED_TIP_COUNT,
  type BristlePath,
} from './bristle-bundle.js';
import brushShader from '../shaders/brush/brush.wgsl';

type Vec2 = [number, number];
type SegPoint = { pos: Vec2; pressure: number; tiltX: number; tiltY: number };

let pipeline: GPUComputePipeline;
let uniformBuffer: GPUBuffer;
let vertexBuffer: GPUBuffer;
let bristleInfoBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let auxLayout: GPUBindGroupLayout;
let grainSampler: GPUSampler;

// Stroke mask — prevents re-deposition across frames within a stroke
let maskTextures: [GPUTexture, GPUTexture] | null = null;
let maskIndex = 0;
let maskWidth = 0;
let maskHeight = 0;
let needMaskClear = true;

// BrushParams: 80 bytes
// BristleInfo: 48 bytes × 48 = 2,304 bytes
const UNIFORM_SIZE = 80;
const MAX_VERTICES = 4096;    // 48 bristles × 84 verts each
const VERTEX_STRIDE = 16;     // bytes per StrokeVertex (vec2f + f32 + f32)
const BRISTLE_INFO_STRIDE = 48; // bytes per BristleInfo
const BRISTLE_INFO_SIZE = SELECTED_TIP_COUNT * BRISTLE_INFO_STRIDE; // 2,304 bytes
const MAX_VERTS_PER_BRISTLE = 84;
const GHOST_COUNT = 3;

let lastPos: Vec2 | null = null;
let lastPressure = 0;
let lastRadius = 0;
let lastDirection: Vec2 = [1, 0];
let strokeSegIndex = 0;
let strokeStartLayers = 0;
let estimatedPeakLayers = 0;

// Paint depletion state
let reservoir = 0.5;
let strokeDabCount = 0;
let lastFrameTime = 0;
let loadScale = 1.0;   // rag wipe reduces this; dip resets to 1.0
let smoothedPressure = 0; // pressure envelope — asymmetric attack/release

// Snapshot re-render — save pre-stroke surface, re-render full stroke each frame
// Eliminates frame boundary ridges (no incremental K-M mixing nonlinearity)
let snapshotAccum: GPUTexture | null = null;
let snapshotState: GPUTexture | null = null;
let snapshotW = 0;
let snapshotH = 0;
let needSnapshotCapture = false;
type AABB = { minX: number; minY: number; maxX: number; maxY: number };
let strokeAABB: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

// Ghost state
let ghostAnchor: { pos: Vec2; pressure: number } | null = null;
let ghostPoints: { pos: Vec2; pressure: number }[] = [];
let ghostsPending = false;

export function initBrushEngine() {
  const { device } = getGPU();

  paramLayout = device.createBindGroupLayout({
    label: 'brush-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
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
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
    ],
  });

  grainSampler = device.createSampler({
    label: 'brush-grain-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  pipeline = createComputePipeline('brush-v9', device, {
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

  vertexBuffer = device.createBuffer({
    label: 'brush-vertices',
    size: MAX_VERTICES * VERTEX_STRIDE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  bristleInfoBuffer = device.createBuffer({
    label: 'brush-bristle-info',
    size: BRISTLE_INFO_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  reloadBrush();
}

/** Ensure mask textures exist and match surface dimensions */
function ensureMaskTextures() {
  const { device } = getGPU();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  if (maskTextures && maskWidth === w && maskHeight === h) return;

  if (maskTextures) {
    maskTextures[0].destroy();
    maskTextures[1].destroy();
  }

  const usage = GPUTextureUsage.TEXTURE_BINDING
              | GPUTextureUsage.STORAGE_BINDING
              | GPUTextureUsage.RENDER_ATTACHMENT;
  maskTextures = [
    device.createTexture({ label: 'brush-mask-0', size: [w, h], format: 'r32float', usage }),
    device.createTexture({ label: 'brush-mask-1', size: [w, h], format: 'r32float', usage }),
  ];
  maskWidth = w;
  maskHeight = h;
  maskIndex = 0;
  needMaskClear = false; // fresh textures are zero-initialized
}

/** Ensure snapshot textures exist and match surface dimensions */
function ensureSnapshotTextures() {
  const { device } = getGPU();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  if (snapshotAccum && snapshotW === w && snapshotH === h) return;

  if (snapshotAccum) snapshotAccum.destroy();
  if (snapshotState) snapshotState.destroy();

  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  snapshotAccum = device.createTexture({ label: 'snapshot-accum', size: [w, h], format: 'rgba16float', usage });
  snapshotState = device.createTexture({ label: 'snapshot-state', size: [w, h], format: 'rgba32float', usage });
  snapshotW = w;
  snapshotH = h;
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

function pressureRadius(base: number, pressure: number): number {
  return base * (0.3 + 0.7 * pressure);
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

/** Write per-bristle vertex + info buffers and dispatch compute.
 *  Reads from bundle.paths for per-bristle polylines. */
function dispatchBristlePaths(
  encoder: GPUCommandEncoder,
  paths: BristlePath[],
  scene: ReturnType<typeof sceneStore.get>,
  slot: ReturnType<typeof getBrushSlot>,
  ks: { Kr: number; Kg: number; Kb: number },
  label: string,
  aabb: AABB,
  useSnapshot = false,
) {
  // Count total verts across all bristles
  let totalVerts = 0;
  let activeBristles = 0;
  for (const path of paths) {
    if (path.count >= 2) {
      totalVerts += path.count;
      activeBristles++;
    }
  }
  if (totalVerts === 0 || activeBristles === 0) return;

  const { device } = getGPU();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  const sessionTime = getSessionTime();
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);

  ensureMaskTextures();

  // Capture pre-stroke snapshot on first dispatch of a stroke
  if (needSnapshotCapture && useSnapshot) {
    ensureSnapshotTextures();
    const accumPP = getAccumPP();
    const statePP = getStatePP();
    encoder.copyTextureToTexture(
      { texture: accumPP.read }, { texture: snapshotAccum! }, [w, h],
    );
    encoder.copyTextureToTexture(
      { texture: statePP.read }, { texture: snapshotState! }, [w, h],
    );
    needSnapshotCapture = false;
  }

  // Clear mask
  if (needMaskClear) {
    const clearPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: maskTextures![maskIndex].createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    clearPass.end();
    needMaskClear = false;
  }

  // Pack vertices into fixed-stride slots: 84 verts × 48 bristles
  const vertData = new Float32Array(MAX_VERTICES * 4);
  const infoData = new ArrayBuffer(BRISTLE_INFO_SIZE);
  const infoF32 = new Float32Array(infoData);
  const infoU32 = new Uint32Array(infoData);

  for (let bi = 0; bi < paths.length; bi++) {
    const path = paths[bi];
    const slotStart = bi * MAX_VERTS_PER_BRISTLE;
    const count = Math.min(path.count, MAX_VERTS_PER_BRISTLE);

    // Write vertices into fixed slot
    for (let vi = 0; vi < count; vi++) {
      const off = (slotStart + vi) * 4;
      if (off + 3 >= vertData.length) break;
      vertData[off] = path.positions[vi][0];
      vertData[off + 1] = path.positions[vi][1];
      vertData[off + 2] = path.radii[vi];
      vertData[off + 3] = path.loads[vi];
    }

    // Write BristleInfo (48 bytes = 12 floats/u32s)
    const infoOff = bi * 12; // 48 bytes / 4
    infoU32[infoOff + 0] = slotStart;       // offset
    infoU32[infoOff + 1] = count;            // count
    infoF32[infoOff + 2] = path.count >= 2 ? path.loads[path.count - 1] : 0; // load (latest)
    infoF32[infoOff + 3] = path.ringNorm;    // ring_norm
    infoF32[infoOff + 4] = path.aabb.minX;   // bb_min.x
    infoF32[infoOff + 5] = path.aabb.minY;   // bb_min.y
    infoF32[infoOff + 6] = path.aabb.maxX;   // bb_max.x
    infoF32[infoOff + 7] = path.aabb.maxY;   // bb_max.y
    infoF32[infoOff + 8] = path.colorKr;     // color_kr
    infoF32[infoOff + 9] = path.colorKg;     // color_kg
    infoF32[infoOff + 10] = path.colorKb;    // color_kb
    infoF32[infoOff + 11] = path.count >= 2 ? path.radii[path.count - 1] : 0; // bristle_radius
  }

  // Write uniform buffer (80 bytes)
  const ab = new ArrayBuffer(UNIFORM_SIZE);
  const f32 = new Float32Array(ab);
  const u32 = new Uint32Array(ab);
  f32[0] = aabb.minX;
  f32[1] = aabb.minY;
  f32[2] = aabb.maxX;
  f32[3] = aabb.maxY;
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
  u32[17] = SELECTED_TIP_COUNT;  // bristle_count (was vertex_count)
  f32[18] = getOilRemaining();
  f32[19] = getAnchorRemaining();
  device.queue.writeBuffer(uniformBuffer, 0, ab);

  // Upload buffers
  device.queue.writeBuffer(vertexBuffer, 0, vertData);
  device.queue.writeBuffer(bristleInfoBuffer, 0, infoData);

  // Bind groups — snapshot mode reads from pre-stroke snapshot
  const accumPP = getAccumPP();
  const statePP = getStatePP();
  const accumReadView = useSnapshot && snapshotAccum
    ? snapshotAccum.createView() : accumPP.readView;
  const stateReadView = useSnapshot && snapshotState
    ? snapshotState.createView() : statePP.readView;

  const paramBG = device.createBindGroup({
    layout: paramLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: vertexBuffer } },
      { binding: 2, resource: { buffer: bristleInfoBuffer } },
    ],
  });
  const texBG = device.createBindGroup({
    layout: textureLayout,
    entries: [
      { binding: 0, resource: accumReadView },
      { binding: 1, resource: accumPP.writeView },
    ],
  });
  const auxBG = device.createBindGroup({
    layout: auxLayout,
    entries: [
      { binding: 0, resource: getSurfaceHeightTexture().createView() },
      { binding: 1, resource: grainSampler },
      { binding: 2, resource: stateReadView },
      { binding: 3, resource: statePP.writeView },
      { binding: 4, resource: maskTextures![maskIndex].createView() },
      { binding: 5, resource: maskTextures![1 - maskIndex].createView() },
    ],
  });

  const pass = encoder.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, paramBG);
  pass.setBindGroup(1, texBG);
  pass.setBindGroup(2, auxBG);
  pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  pass.end();

  maskIndex = 1 - maskIndex;
  swapSurface();
}

export function beginStroke(x: number, y: number, pressure: number) {
  strokeStartLayers = estimatedPeakLayers;
  lastPos = [x, y];
  lastPressure = pressure;
  lastRadius = 0;
  strokeSegIndex = 0;
  strokeDabCount = 0;
  smoothedPressure = pressure; // start at actual pressure, not 0
  ghostsPending = false;
  needMaskClear = true;
  needSnapshotCapture = true;
  strokeAABB = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
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
        pressure: lastPressure * (1.0 - t * t),
      });
    }
    ghostsPending = true;
    markDirty('surface');
  }
  lastPos = null;
  depleteOil();
}

export function dispatchPendingGhosts(encoder: GPUCommandEncoder): boolean {
  if (!ghostsPending || !ghostAnchor) return false;
  ghostsPending = false;

  const scene = sceneStore.get();
  const slot = getBrushSlot(getActiveBrushSlot());
  const ks = getActiveKS();
  const bundle = getActiveBundle();

  if (!bundle) {
    ghostAnchor = null;
    ghostPoints = [];
    return false;
  }

  // For ghosts, extend each selected bristle path with tapered ghost vertices
  const chain = [ghostAnchor, ...ghostPoints];
  const baseSplay = bundle.splay * (1.0 + bundle.age * 0.3);
  const ui = uiStore.get();
  const spread = 1.0 + scene.thinners * 0.4;

  for (let si = 0; si < bundle.paths.length; si++) {
    const path = bundle.paths[si];
    if (path.count < 1) continue;

    const tip = bundle.tips[bundle.selectedTips[si]];

    for (let gi = 0; gi < chain.length; gi++) {
      const pt = chain[gi];
      const t = gi / chain.length;
      const splay = baseSplay * (1.0 - t * 0.5);
      const rBristle = (ui.brushSize / Math.sqrt(SELECTED_TIP_COUNT))
        * (1.1 - 0.2 * tip.ringNorm) * splay;

      // Ghost position: offset from center by tip's current offset (aspect-corrected)
      const ghostAspect = getSurfaceHeight() / getSurfaceWidth();
      const wx = pt.pos[0] + tip.currentOffset[0] * ui.brushSize * ghostAspect;
      const wy = pt.pos[1] + tip.currentOffset[1] * ui.brushSize;

      path.positions.push([wx, wy]);
      path.radii.push(Math.max(rBristle * (1.0 - t * 0.5), 0.0005));
      path.loads.push(tip.load * (1.0 - t));
      path.count++;

      // Update AABB
      path.aabb.minX = Math.min(path.aabb.minX, wx - rBristle);
      path.aabb.minY = Math.min(path.aabb.minY, wy - rBristle);
      path.aabb.maxX = Math.max(path.aabb.maxX, wx + rBristle);
      path.aabb.maxY = Math.max(path.aabb.maxY, wy + rBristle);
    }
  }

  // Compute ghost AABB for dispatch
  let ghostAABB: AABB = { ...strokeAABB };
  for (const pt of chain) {
    const maxR = ui.brushSize * spread * baseSplay;
    ghostAABB.minX = Math.min(ghostAABB.minX, pt.pos[0] - maxR);
    ghostAABB.minY = Math.min(ghostAABB.minY, pt.pos[1] - maxR);
    ghostAABB.maxX = Math.max(ghostAABB.maxX, pt.pos[0] + maxR);
    ghostAABB.maxY = Math.max(ghostAABB.maxY, pt.pos[1] + maxR);
  }

  dispatchBristlePaths(encoder, bundle.paths, scene, slot, ks, 'brush-ghost', ghostAABB);

  ghostAnchor = null;
  ghostPoints = [];
  return true;
}

export function dispatchBrushDabs(encoder: GPUCommandEncoder, x: number, y: number): boolean {
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

  // Advance bundle physics for each waypoint — this also appends to per-bristle paths
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

  // Advance bundle physics AFTER reservoir depletion — per-vertex loads reflect current reservoir
  for (const wp of waypoints) {
    updateBundle(bundle, wp.pos, wp.pressure, wp.tiltX, wp.tiltY, dtPerWp, radius, aspectCorrection, reservoir);
  }

  // Pressure smoothing for radius tracking
  for (let i = 0; i < points.length; i++) {
    const targetP = points[i].pressure;
    const rate = targetP > smoothedPressure ? 0.15 : 0.08;
    smoothedPressure += (targetP - smoothedPressure) * rate;
  }

  // Track direction for ghost segments
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].pos[0] - points[i - 1].pos[0];
    const dy = points[i].pos[1] - points[i - 1].pos[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.0001) {
      lastDirection = [dx / len, dy / len];
    }
  }

  // Update stroke counters
  const newSegs = strokeDabCount === 0 ? points.length : points.length - 1;
  strokeSegIndex += points.length;
  strokeDabCount += Math.max(1, newSegs);

  // Track last radius from brush width
  const spread = 1.0 + scene.thinners * 0.4;
  const splayCurrent = bundle.splay * (1.0 + bundle.age * 0.3);
  lastRadius = pressureRadius(radius, smoothedPressure) * spread * splayCurrent;

  // Expand stroke AABB from all paths
  for (const path of bundle.paths) {
    if (path.count > 0) {
      strokeAABB.minX = Math.min(strokeAABB.minX, path.aabb.minX);
      strokeAABB.minY = Math.min(strokeAABB.minY, path.aabb.minY);
      strokeAABB.maxX = Math.max(strokeAABB.maxX, path.aabb.maxX);
      strokeAABB.maxY = Math.max(strokeAABB.maxY, path.aabb.maxY);
    }
  }

  // Clear mask — each commit cycle starts fresh
  needMaskClear = true;

  // Dispatch current paths against snapshot
  dispatchBristlePaths(encoder, bundle.paths, scene, slot, ks, 'brush-stroke',
    strokeAABB, true);

  // Continuous commit — bake rendered result into snapshot, trim paths to trailing edge.
  // Paint is permanent the moment the brush moves past. Going back deposits new paint
  // on top of what's already committed — real physics.
  if (snapshotAccum) {
    const accumPP = getAccumPP();
    const statePP = getStatePP();
    const h = getSurfaceHeight();
    encoder.copyTextureToTexture(
      { texture: accumPP.read }, { texture: snapshotAccum }, [w, h],
    );
    encoder.copyTextureToTexture(
      { texture: statePP.read }, { texture: snapshotState! }, [w, h],
    );
    trimPathsToTail(bundle);
    strokeAABB = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const path of bundle.paths) {
      if (path.count > 0) {
        strokeAABB.minX = Math.min(strokeAABB.minX, path.aabb.minX);
        strokeAABB.minY = Math.min(strokeAABB.minY, path.aabb.minY);
        strokeAABB.maxX = Math.max(strokeAABB.maxX, path.aabb.maxX);
        strokeAABB.maxY = Math.max(strokeAABB.maxY, path.aabb.maxY);
      }
    }
  }

  // Update CPU-side peak weight estimate
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);
  estimatedPeakLayers += pigmentDensity;

  return true;
}
