// Brush engine — single-pass polyline SDF dispatch with stroke mask
// Writes K-M pigment into the accumulation surface
// Stroke mask (r32float ping-pong) tracks max geometric alpha per pixel
// within a stroke — only the incremental delta deposits paint, eliminating
// inter-frame overlap ridges.

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getActiveKS, getBrushSlot, getActiveBrushSlot, getOilRemaining, depleteOil } from './palette.js';
import { getSurfaceHeightTexture } from '../surface/surface-material.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import { getSessionTime } from '../session/session-timer.js';
import { markDirty } from '../state/dirty-flags.js';
import brushShader from '../shaders/brush/brush.wgsl';

type Vec2 = [number, number];
type SegPoint = { pos: Vec2; pressure: number };

let pipeline: GPUComputePipeline;
let uniformBuffer: GPUBuffer;
let vertexBuffer: GPUBuffer;
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

const UNIFORM_SIZE = 80;    // bytes — BrushParams struct
const MAX_VERTICES = 4096;
const VERTEX_STRIDE = 16;   // bytes per StrokeVertex (vec2f + f32 + pad)
const TOUCH_RAMP_SEGS = 5;
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
let lastReservoir = 1.0;
let totalDistance = 0;
let strokeDabCount = 0;

// Cumulative polyline — grows over the entire stroke lifetime
// Each frame re-renders the full stroke from a pre-stroke snapshot
type BakedVert = { pos: Vec2; radius: number; reservoir: number };
let cumulativeVerts: BakedVert[] = [];

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
let ghostAnchor: SegPoint | null = null;
let ghostPoints: SegPoint[] = [];
let ghostsPending = false;

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

  pipeline = createComputePipeline('brush-v6', device, {
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
  const load = sceneStore.get().load;
  reservoir = load > 0 ? 1.0 : 0;
  lastReservoir = reservoir;
  totalDistance = 0;
}

export function getReservoir(): number {
  return reservoir;
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
  needMaskClear = true;
  needSnapshotCapture = true;
  cumulativeVerts = [];
  strokeAABB = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
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

/** Write uniform + vertex buffers and dispatch a single compute pass.
 *  useSnapshot: read from pre-stroke snapshot instead of current accum/state.
 *  This re-renders the full stroke from scratch each frame, eliminating
 *  incremental K-M mixing nonlinearity that causes dab ridges. */
function dispatchPolyline(
  encoder: GPUCommandEncoder,
  verts: { pos: Vec2; radius: number; reservoir: number }[],
  scene: ReturnType<typeof sceneStore.get>,
  slot: ReturnType<typeof getBrushSlot>,
  ks: { Kr: number; Kg: number; Kb: number },
  label: string,
  aabb?: AABB,
  useSnapshot = false,
) {
  if (verts.length === 0) return;

  const { device } = getGPU();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  const sessionTime = getSessionTime();
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);

  // Ensure mask textures exist
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

  // Clear mask — snapshot mode clears every frame (delta = alpha, not incremental)
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

  // Clamp vertex count to buffer capacity
  const vertexCount = Math.min(verts.length, MAX_VERTICES);

  // AABB for early pixel rejection
  let bbMinX: number, bbMinY: number, bbMaxX: number, bbMaxY: number;
  if (aabb) {
    bbMinX = aabb.minX;
    bbMinY = aabb.minY;
    bbMaxX = aabb.maxX;
    bbMaxY = aabb.maxY;
  } else {
    bbMinX = Infinity; bbMinY = Infinity;
    bbMaxX = -Infinity; bbMaxY = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const v = verts[i];
      bbMinX = Math.min(bbMinX, v.pos[0] - v.radius);
      bbMinY = Math.min(bbMinY, v.pos[1] - v.radius);
      bbMaxX = Math.max(bbMaxX, v.pos[0] + v.radius);
      bbMaxY = Math.max(bbMaxY, v.pos[1] + v.radius);
    }
  }

  // Write uniform buffer (80 bytes) — mixed f32/u32
  const ab = new ArrayBuffer(UNIFORM_SIZE);
  const f32 = new Float32Array(ab);
  const u32 = new Uint32Array(ab);
  f32[0] = bbMinX;                      // bb_min.x
  f32[1] = bbMinY;                      // bb_min.y
  f32[2] = bbMaxX;                      // bb_max.x
  f32[3] = bbMaxY;                      // bb_max.y
  f32[4] = ks.Kr;                       // palette_K.x  (offset 16)
  f32[5] = ks.Kg;                       // palette_K.y
  f32[6] = ks.Kb;                       // palette_K.z
  f32[7] = scene.thinners;              // thinners     (offset 28)
  f32[8] = scene.falloff;               // falloff      (offset 32)
  f32[9] = pigmentDensity;              // pigment_density
  f32[10] = reservoir;                  // reservoir
  f32[11] = slot.age;                   // age
  f32[12] = slot.bristleSeed;           // bristle_seed  (offset 48)
  f32[13] = strokeStartLayers;          // stroke_start_layers
  f32[14] = scene.surface.absorption;   // surface_absorption
  f32[15] = sessionTime;                // session_time   (offset 60)
  f32[16] = scene.surface.drySpeed;     // surface_dry_speed (offset 64)
  u32[17] = vertexCount;                // vertex_count   (offset 68)
  f32[18] = getOilRemaining();           // oil_remaining
  f32[19] = 0;                          // _pad
  device.queue.writeBuffer(uniformBuffer, 0, ab);

  // Write vertex buffer
  const vertData = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const v = verts[i];
    const off = i * 4;
    vertData[off] = v.pos[0];
    vertData[off + 1] = v.pos[1];
    vertData[off + 2] = v.radius;
    vertData[off + 3] = v.reservoir;
  }
  device.queue.writeBuffer(vertexBuffer, 0, vertData);

  // Create bind groups — snapshot mode reads from pre-stroke snapshot
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

  // Single dispatch
  const pass = encoder.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, paramBG);
  pass.setBindGroup(1, texBG);
  pass.setBindGroup(2, auxBG);
  pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  pass.end();

  // Swap mask and surface
  maskIndex = 1 - maskIndex;
  swapSurface();
}

export function dispatchPendingGhosts(encoder: GPUCommandEncoder): boolean {
  if (!ghostsPending || !ghostAnchor) return false;
  ghostsPending = false;

  const scene = sceneStore.get();
  const slot = getBrushSlot(getActiveBrushSlot());
  const ks = getActiveKS();
  const ui = uiStore.get();

  const spread = 1.0 + scene.thinners * 0.4;
  const splay = 1.0 + slot.age * 0.3;

  // Build vertices: anchor + ghost points
  const chain = [ghostAnchor, ...ghostPoints];
  const verts: { pos: Vec2; radius: number; reservoir: number }[] = chain.map(pt => ({
    pos: pt.pos,
    radius: pressureRadius(ui.brushSize, pt.pressure) * spread * splay,
    reservoir: reservoir,
  }));

  dispatchPolyline(encoder, verts, scene, slot, ks, 'brush-ghost');

  ghostAnchor = null;
  ghostPoints = [];
  return true;
}

export function dispatchBrushDabs(encoder: GPUCommandEncoder, x: number, y: number): boolean {
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;

  // Build waypoints with pressure from queued coalesced positions
  const waypoints: SegPoint[] = pointerQueue.length > 0
    ? pointerQueue.splice(0).map(p => ({ pos: [p.x, p.y] as Vec2, pressure: p.pressure }))
    : [{ pos: [x, y] as Vec2, pressure: ui.pressure || 0.5 }];

  // Build points from pointer events — subdivide only on very fast strokes
  const maxSegLen = radius * 4.0;
  let points: SegPoint[] = [];
  for (const wp of waypoints) {
    if (lastPos) {
      const prevPt: SegPoint = { pos: lastPos, pressure: lastPressure };
      const sub = subdivideIfNeeded(prevPt, wp, maxSegLen);
      points = points.concat(points.length === 0 ? sub : sub.slice(1));
    } else {
      points.push(wp);
    }
    lastPos = wp.pos;
    lastPressure = wp.pressure;
  }

  if (points.length === 0) return false;

  if (points.length > MAX_VERTICES) {
    points = points.slice(points.length - MAX_VERTICES);
  }

  const ks = getActiveKS();
  const slot = getBrushSlot(getActiveBrushSlot());

  // Accumulate pixel distance for paint depletion
  const w = getSurfaceWidth();
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

  // Build StrokeVertex array with pre-baked radii and per-vertex reservoir
  const spread = 1.0 + scene.thinners * 0.4;
  const splay = 1.0 + slot.age * 0.3;
  const verts: { pos: Vec2; radius: number; reservoir: number }[] = [];

  for (let i = 0; i < points.length; i++) {
    const taper = 0.3 + 0.7 * Math.min(1.0, (strokeSegIndex + i) / TOUCH_RAMP_SEGS);
    const r = pressureRadius(radius, points[i].pressure) * taper * spread * splay;
    // Interpolate reservoir from lastReservoir (overlap point) to current reservoir
    const t = points.length > 1 ? i / (points.length - 1) : 1.0;
    const vertRes = lastReservoir + (reservoir - lastReservoir) * t;
    verts.push({ pos: points[i].pos, radius: r, reservoir: vertRes });
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
  if (verts.length > 0) {
    lastRadius = verts[verts.length - 1].radius;
  }

  // Self-intersection detection — if new vertices are near old ones (far back
  // in the polyline), the SDF would pick the wrong segment and erase paint.
  // Auto-commit: bake current result into snapshot so old segments leave the SDF.
  const SELF_INTERSECT_GAP = 20;
  let commitNeeded = false;
  if (cumulativeVerts.length > SELF_INTERSECT_GAP && verts.length > 0) {
    const checkEnd = cumulativeVerts.length - SELF_INTERSECT_GAP;
    outer:
    for (const nv of verts) {
      for (let i = 0; i < checkEnd; i += 4) {
        const ov = cumulativeVerts[i];
        const threshold = nv.radius + ov.radius;
        const dx = nv.pos[0] - ov.pos[0];
        const dy = nv.pos[1] - ov.pos[1];
        if (dx * dx + dy * dy < threshold * threshold) {
          commitNeeded = true;
          break outer;
        }
      }
    }
  }

  // Auto-commit before self-intersection corrupts the SDF
  if (commitNeeded && snapshotAccum) {
    const accumPP = getAccumPP();
    const statePP = getStatePP();
    const h = getSurfaceHeight();
    encoder.copyTextureToTexture(
      { texture: accumPP.read }, { texture: snapshotAccum }, [w, h],
    );
    encoder.copyTextureToTexture(
      { texture: statePP.read }, { texture: snapshotState! }, [w, h],
    );
    // Keep last 2 verts for tangent continuity at the junction
    cumulativeVerts = cumulativeVerts.slice(-2);
    strokeAABB = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const v of cumulativeVerts) {
      strokeAABB.minX = Math.min(strokeAABB.minX, v.pos[0] - v.radius);
      strokeAABB.minY = Math.min(strokeAABB.minY, v.pos[1] - v.radius);
      strokeAABB.maxX = Math.max(strokeAABB.maxX, v.pos[0] + v.radius);
      strokeAABB.maxY = Math.max(strokeAABB.maxY, v.pos[1] + v.radius);
    }
  }

  // Accumulate into cumulative polyline — one continuous stroke
  if (cumulativeVerts.length === 0) {
    cumulativeVerts = [...verts];
  } else if (verts.length > 0) {
    // First new vert is at lastPos junction (same as cumulativeVerts tail) — skip it
    cumulativeVerts.push(...verts.slice(1));
  }

  // Hard cap — safety net
  if (cumulativeVerts.length > MAX_VERTICES) {
    cumulativeVerts = cumulativeVerts.slice(0, MAX_VERTICES);
  }

  // Expand cumulative stroke AABB with new vertices
  for (const v of verts) {
    strokeAABB.minX = Math.min(strokeAABB.minX, v.pos[0] - v.radius);
    strokeAABB.minY = Math.min(strokeAABB.minY, v.pos[1] - v.radius);
    strokeAABB.maxX = Math.max(strokeAABB.maxX, v.pos[0] + v.radius);
    strokeAABB.maxY = Math.max(strokeAABB.maxY, v.pos[1] + v.radius);
  }

  // Clear mask every frame — re-render from scratch (delta = alpha, not incremental)
  needMaskClear = true;

  // Dispatch full cumulative polyline against pre-stroke snapshot
  dispatchPolyline(encoder, cumulativeVerts, scene, slot, ks, 'brush-stroke',
    strokeAABB, true);
  lastReservoir = reservoir;

  // Update CPU-side peak weight estimate
  const pigmentDensity = Math.pow(1.0 - scene.thinners * 0.9, 1.5);
  estimatedPeakLayers += pigmentDensity;

  return true;
}
