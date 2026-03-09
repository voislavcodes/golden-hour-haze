// Forms layer — stamp-to-texture architecture
// Each form is stamped ONCE over its bounding box into persistent ping-pong textures
// No per-frame SDF loop. Undo/redo triggers full restamp (clear + replay all forms).

import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong, type PingPongTexture } from '../gpu/texture-pool.js';
import { createComputePipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import stampShader from '../shaders/forms/stamp.wgsl';
import clearShader from '../shaders/forms/clear.wgsl';
import type { FormDef, TonalMapParams, PaletteColor } from './layer-types.js';
import { sampleTonalColumn } from './tonal-column.js';

let stampPipeline: GPUComputePipeline;
let clearPipeline: GPUComputePipeline;

let stampParamBuffer: GPUBuffer;  // StampParams (64B)
let stampFormBuffer: GPUBuffer;   // FormData (64B)
let stampParamLayout: GPUBindGroupLayout;
let stampTexLayout: GPUBindGroupLayout;
let clearLayout: GPUBindGroupLayout;
let stampParamBG: GPUBindGroup;

let currentWidth = 0;
let currentHeight = 0;

// Persistent paint surface
let formsPP: PingPongTexture;
let accumPP: PingPongTexture;

// Pre-baked stroke noise texture (256x256 r8unorm)
let noiseTexture: GPUTexture;
let noiseSampler: GPUSampler;
let densitySampler: GPUSampler;

// Dissolution tracking
let dissolutionActive = false;

// Stamp tracking
let lastStampedIndex = 0;
let pendingFullRestamp = false;

// Cached params for restamping
let cachedPalette: PaletteColor[] = [];
let cachedSunAngle = 0.8;
let cachedTonalMap: TonalMapParams = { enabled: true, valueRange: 0.8, keyValue: 0.5, contrast: 0.6 };
let cachedVelvet = 0.6;
let cachedTonalSort = true;
let cachedBaseOpacity = 0.5;
let cachedFalloff = 0.7;
let cachedSunElevation = 0.15;
let cachedHorizonY = 0.5;

// CPU simplex noise for stamp texture generation
function simplexNoise2D(x: number, y: number): number {
  // Simple hash-based noise approximation for stamp texture
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  const m = Math.sin(x * 269.5 + y * 183.3) * 28947.8192;
  return (n - Math.floor(n) + m - Math.floor(m)) * 0.5 - 0.5;
}

function generateStampNoise(device: GPUDevice): GPUTexture {
  const size = 256;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x / size * 8.0;
      const fy = y / size * 8.0;
      const n = simplexNoise2D(fx, fy) * 0.5
              + simplexNoise2D(fx * 2.0 + 100, fy * 2.0 + 100) * 0.3
              + simplexNoise2D(fx * 4.0 + 200, fy * 4.0 + 200) * 0.2;
      data[y * size + x] = Math.floor(Math.max(0, Math.min(255, (n * 0.5 + 0.5) * 255)));
    }
  }

  const tex = device.createTexture({
    label: 'stamp-noise',
    size: { width: size, height: size },
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: size },
    { width: size, height: size },
  );

  return tex;
}

export function initFormsLayer() {
  const { device } = getGPU();

  // Generate stamp noise texture
  noiseTexture = generateStampNoise(device);

  noiseSampler = device.createSampler({
    label: 'stamp-noise-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });

  densitySampler = device.createSampler({
    label: 'forms-density-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
  });

  // Stamp pipeline
  stampParamLayout = device.createBindGroupLayout({
    label: 'stamp-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, // StampParams
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }, // FormData
    ],
  });

  stampTexLayout = device.createBindGroupLayout({
    label: 'stamp-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } }, // depth
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } }, // dissolution
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },              // density (half-res, filtered)
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },              // noise
      { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },                // noise sampler
      { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } }, // forms read
      { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } }, // accum read
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } }, // forms write
      { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } }, // accum write
      { binding: 9, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },                // density sampler
    ],
  });

  stampPipeline = createComputePipeline('stamp', device, {
    label: 'stamp-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), stampParamLayout, stampTexLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'stamp-shader', code: stampShader }),
      entryPoint: 'main',
    },
  });

  stampParamBuffer = device.createBuffer({
    label: 'stamp-params',
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  stampFormBuffer = device.createBuffer({
    label: 'stamp-form',
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  stampParamBG = device.createBindGroup({
    label: 'stamp-param-bg',
    layout: stampParamLayout,
    entries: [
      { binding: 0, resource: { buffer: stampParamBuffer } },
      { binding: 1, resource: { buffer: stampFormBuffer } },
    ],
  });

  // Clear pipeline
  clearLayout = device.createBindGroupLayout({
    label: 'clear-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  clearPipeline = createComputePipeline('clear', device, {
    label: 'clear-compute',
    layout: device.createPipelineLayout({ bindGroupLayouts: [clearLayout] }),
    compute: {
      module: device.createShaderModule({ label: 'clear-shader', code: clearShader }),
      entryPoint: 'main',
    },
  });
}

export function updateFormsTextures(width: number, height: number) {
  if (width === currentWidth && height === currentHeight) return;
  currentWidth = width;
  currentHeight = height;

  // Main forms output (for compositor)
  allocTexture('forms', 'rgba16float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);

  // Ensure dissolution mask exists
  allocTexture('dissolution', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);

  // Persistent paint surface ping-pong (COPY_DST needed for pre-stamp full-texture copy)
  formsPP = allocPingPong('forms-paint', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);

  accumPP = allocPingPong('forms-accum', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);

  // Resize invalidates paint — full restamp needed
  lastStampedIndex = 0;
  pendingFullRestamp = true;
}

export function writeFormsData(
  _forms: FormDef[],
  palette: { r: number; g: number; b: number }[],
  sunAngle = 0.8,
  tonalMap: TonalMapParams = { enabled: true, valueRange: 0.8, keyValue: 0.5, contrast: 0.6 },
  velvet = 0.6,
  tonalSort = true,
  baseOpacity = 0.5,
  falloff = 0.7,
  sunElevation = 0.15,
  horizonY = 0.5,
) {
  // Cache params for stamping (no longer writes GPU storage buffer)
  cachedPalette = palette as PaletteColor[];
  cachedSunAngle = sunAngle;
  cachedTonalMap = tonalMap;
  cachedVelvet = velvet;
  cachedTonalSort = tonalSort;
  cachedBaseOpacity = baseOpacity;
  cachedFalloff = falloff;
  cachedSunElevation = sunElevation;
  cachedHorizonY = horizonY;
}

function computeBBox(f: FormDef): { x: number; y: number; w: number; h: number } {
  const aspect = currentWidth / currentHeight;
  const margin = 1.3;

  if (f.type === 0) {
    // Circle
    const r = (f.sizeX + f.softness * 2) * margin;
    const cx = f.x * currentWidth;
    const cy = f.y * currentHeight;
    const rx = r * currentHeight; // aspect-correct radius in pixels
    const ry = r * currentHeight;
    return {
      x: Math.max(0, Math.floor(cx - rx)),
      y: Math.max(0, Math.floor(cy - ry)),
      w: Math.min(currentWidth, Math.ceil(cx + rx)) - Math.max(0, Math.floor(cx - rx)),
      h: Math.min(currentHeight, Math.ceil(cy + ry)) - Math.max(0, Math.floor(cy - ry)),
    };
  } else if (f.type === 3) {
    // Tapered capsule
    const startX = f.x * aspect;
    const startY = f.y;
    const endX = startX + Math.cos(f.rotation) * f.sizeX;
    const endY = startY + Math.sin(f.rotation) * f.sizeX;
    const maxR = Math.max(f.sizeY, f.sizeY * f.taper);
    const r = (maxR + f.softness * 2) * margin;

    const minX = (Math.min(startX, endX) - r) / aspect;
    const maxX_ = (Math.max(startX, endX) + r) / aspect;
    const minY = Math.min(startY, endY) - r;
    const maxY = Math.max(startY, endY) + r;

    const px0 = Math.max(0, Math.floor(minX * currentWidth));
    const py0 = Math.max(0, Math.floor(minY * currentHeight));
    const px1 = Math.min(currentWidth, Math.ceil(maxX_ * currentWidth));
    const py1 = Math.min(currentHeight, Math.ceil(maxY * currentHeight));

    return { x: px0, y: py0, w: px1 - px0, h: py1 - py0 };
  }

  // Fallback: full screen for box/line types
  return { x: 0, y: 0, w: currentWidth, h: currentHeight };
}

function writeStampParams(device: GPUDevice, bbox: { x: number; y: number; w: number; h: number }) {
  const edgeAtmo = 1.5 - Math.min(cachedSunElevation, 1.0) * 0.8;
  device.queue.writeBuffer(stampParamBuffer, 0, new Float32Array([
    currentWidth, currentHeight,
    bbox.x, bbox.y, bbox.w, bbox.h,
    cachedSunAngle,
    cachedTonalMap.keyValue,
    cachedTonalMap.valueRange,
    cachedTonalMap.contrast,
    cachedVelvet,
    cachedTonalMap.enabled ? 1.0 : 0.0,
    cachedBaseOpacity,
    cachedFalloff,
    edgeAtmo,
    cachedHorizonY,
  ]));
}

function writeFormData(device: GPUDevice, f: FormDef) {
  const baseColor = cachedPalette[Math.min(f.colorIndex, cachedPalette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
  const color = sampleTonalColumn(baseColor, f.paintedValue ?? 0.5);
  device.queue.writeBuffer(stampFormBuffer, 0, new Float32Array([
    f.type,
    f.x, f.y,
    f.sizeX, f.sizeY,
    f.rotation, f.softness, f.depth,
    color.r, color.g, color.b,
    f.opacity,
    f.strokeDirX ?? 0, f.strokeDirY ?? 0,
    ((f.x * 127.1 + f.y * 311.7) % 1.0 + 1.0) % 1.0, // edge_seed
    f.taper ?? 0,
  ]));
}

function createStampTexBG(device: GPUDevice): GPUBindGroup {
  const depthTex = allocTexture('depth', 'r32float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
  const dissolutionTex = allocTexture('dissolution', 'r32float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);

  const densityW = Math.ceil(currentWidth / 2);
  const densityH = Math.ceil(currentHeight / 2);
  const densityPP = allocPingPong('atmosphere-density', 'rgba16float', densityW, densityH);

  return device.createBindGroup({
    layout: stampTexLayout,
    entries: [
      { binding: 0, resource: depthTex.createView() },
      { binding: 1, resource: dissolutionTex.createView() },
      { binding: 2, resource: densityPP.readView },
      { binding: 3, resource: noiseTexture.createView() },
      { binding: 4, resource: noiseSampler },
      { binding: 5, resource: formsPP.readView },
      { binding: 6, resource: accumPP.readView },
      { binding: 7, resource: formsPP.writeView },
      { binding: 8, resource: accumPP.writeView },
      { binding: 9, resource: densitySampler },
    ],
  });
}

function stampOneForm(encoder: GPUCommandEncoder, f: FormDef, globalBG: GPUBindGroup) {
  const { device } = getGPU();

  const bbox = computeBBox(f);
  if (bbox.w <= 0 || bbox.h <= 0) return;

  // Copy full read → write so pixels outside the bbox are preserved after swap
  const size = { width: currentWidth, height: currentHeight };
  encoder.copyTextureToTexture({ texture: formsPP.read }, { texture: formsPP.write }, size);
  encoder.copyTextureToTexture({ texture: accumPP.read }, { texture: accumPP.write }, size);

  writeStampParams(device, bbox);
  writeFormData(device, f);

  const texBG = createStampTexBG(device);

  const pass = encoder.beginComputePass({ label: 'stamp-form' });
  pass.setPipeline(stampPipeline);
  pass.setBindGroup(0, globalBG);
  pass.setBindGroup(1, stampParamBG);
  pass.setBindGroup(2, texBG);
  pass.dispatchWorkgroups(Math.ceil(bbox.w / 8), Math.ceil(bbox.h / 8));
  pass.end();

  // Swap ping-pong after each stamp
  formsPP.swap();
  accumPP.swap();
}

function clearTextures(encoder: GPUCommandEncoder) {
  const { device } = getGPU();
  const clearBG = device.createBindGroup({
    layout: clearLayout,
    entries: [
      { binding: 0, resource: formsPP.writeView },
      { binding: 1, resource: accumPP.writeView },
    ],
  });

  const pass = encoder.beginComputePass({ label: 'clear-forms' });
  pass.setPipeline(clearPipeline);
  pass.setBindGroup(0, clearBG);
  pass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  pass.end();

  // Swap cleared to read position
  formsPP.swap();
  accumPP.swap();
}

export function requestFullRebake() {
  pendingFullRestamp = true;
}

export function requestBake() {
  // No-op in stamp architecture — forms are already persistent
}

export function setDissolutionActive(active: boolean) {
  dissolutionActive = active;
  if (active) {
    pendingFullRestamp = true;
  }
}

export function handlePendingBakes(_encoder: GPUCommandEncoder) {
  // No-op — baking is implicit in stamp architecture
}

export function dispatchForms(_encoder: GPUCommandEncoder, _globalBG: GPUBindGroup) {
  // No-op — use stampForms() instead
}

// New entry point: stamp new forms and handle restamps
export function stampForms(
  encoder: GPUCommandEncoder,
  globalBG: GPUBindGroup,
  forms: FormDef[],
) {
  if (currentWidth === 0 || currentHeight === 0) return;

  // During active dissolution, force full restamp each frame so dissolution mask is sampled live
  if (dissolutionActive) {
    pendingFullRestamp = true;
  }

  // Full restamp: clear + replay all forms
  if (pendingFullRestamp) {
    clearTextures(encoder);
    lastStampedIndex = 0;
    pendingFullRestamp = false;

    // Sort by luminance if tonal sort enabled
    let toStamp = forms;
    if (cachedTonalSort && forms.length > 0) {
      const lumOf = (f: FormDef) => {
        const base = cachedPalette[Math.min(f.colorIndex, cachedPalette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
        const c = sampleTonalColumn(base, f.paintedValue ?? 0.5);
        return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      };
      toStamp = [...forms].sort((a, b) => lumOf(a) - lumOf(b));
    }

    for (let i = 0; i < toStamp.length; i++) {
      stampOneForm(encoder, toStamp[i], globalBG);
    }
    lastStampedIndex = forms.length;
  } else {
    // Incremental: stamp only new forms
    for (let i = lastStampedIndex; i < forms.length; i++) {
      stampOneForm(encoder, forms[i], globalBG);
    }
    lastStampedIndex = forms.length;
  }

  // Copy paint surface to compositor-readable 'forms' texture
  const formsTex = allocTexture('forms', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);

  encoder.copyTextureToTexture(
    { texture: formsPP.read },
    { texture: formsTex },
    { width: currentWidth, height: currentHeight },
  );
}

export function getFormsTexture(): GPUTexture {
  return allocTexture('forms', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);
}

// For dissolution: force full restamp when dissolution ends
export function getBakedFormCount() {
  return lastStampedIndex;
}
