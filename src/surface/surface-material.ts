// Surface material generator — procedural height + color textures
// Replaces surface-grain-lut.ts with 4-material system

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getMaterial } from './materials.js';
import type { SurfaceParams } from '../state/scene-state.js';
import surfaceMaterialShader from '../shaders/surface/surface-material-gen.wgsl';

const SURFACE_SIZE = 512;
const PARAM_SIZE = 48; // bytes, 16-byte aligned

let pipeline: GPUComputePipeline;
let heightTexture: GPUTexture;
let colorTexture: GPUTexture;
let paramBuffer: GPUBuffer;
let layout: GPUBindGroupLayout;

let lastMaterial = '';
let lastGrainScale = -1;
let lastGrainSize = -1;
let lastTone = -1;
let lastSeed = -1;
let dirty = true;

export function initSurfaceMaterial() {
  const { device } = getGPU();

  layout = device.createBindGroupLayout({
    label: 'surface-material-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
    ],
  });

  pipeline = createComputePipeline('surface-material-gen', device, {
    label: 'surface-material-gen-compute',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: {
      module: device.createShaderModule({ label: 'surface-material-gen-shader', code: surfaceMaterialShader }),
      entryPoint: 'main',
    },
  });

  paramBuffer = device.createBuffer({
    label: 'surface-material-params',
    size: PARAM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const texUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

  heightTexture = device.createTexture({
    label: 'surface-height',
    size: { width: SURFACE_SIZE, height: SURFACE_SIZE },
    format: 'rgba8unorm',
    usage: texUsage,
  });

  colorTexture = device.createTexture({
    label: 'surface-color',
    size: { width: SURFACE_SIZE, height: SURFACE_SIZE },
    format: 'rgba8unorm',
    usage: texUsage,
  });
}

export function updateSurfaceMaterialParams(surface: SurfaceParams) {
  if (surface.material === lastMaterial &&
      surface.grainScale === lastGrainScale &&
      surface.grainSize === lastGrainSize &&
      surface.tone === lastTone &&
      surface.seed === lastSeed) return;

  lastMaterial = surface.material;
  lastGrainScale = surface.grainScale;
  lastGrainSize = surface.grainSize;
  lastTone = surface.tone;
  lastSeed = surface.seed;
  dirty = true;
}

export function generateSurfaceMaterialIfDirty(encoder: GPUCommandEncoder): boolean {
  if (!dirty) return false;

  const { device } = getGPU();
  const mat = getMaterial(lastMaterial as any || 'board');

  // Pack params: 48 bytes
  const buf = new ArrayBuffer(PARAM_SIZE);
  const f32 = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  f32[0] = lastGrainScale;        // grain_scale
  f32[1] = lastTone;              // tone
  f32[2] = lastSeed;              // seed
  u32[3] = mat.mode;              // material (u32)
  f32[4] = mat.colorLight[0];     // color_light.r
  f32[5] = mat.colorLight[1];     // color_light.g
  f32[6] = mat.colorLight[2];     // color_light.b
  f32[7] = lastGrainSize;         // grain_size
  f32[8] = mat.colorDark[0];      // color_dark.r
  f32[9] = mat.colorDark[1];      // color_dark.g
  f32[10] = mat.colorDark[2];     // color_dark.b
  f32[11] = 0;                    // _pad1

  device.queue.writeBuffer(paramBuffer, 0, buf);

  const bg = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: paramBuffer } },
      { binding: 1, resource: heightTexture.createView() },
      { binding: 2, resource: colorTexture.createView() },
    ],
  });

  const pass = encoder.beginComputePass({ label: 'surface-material-gen' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(SURFACE_SIZE / 8), Math.ceil(SURFACE_SIZE / 8));
  pass.end();

  dirty = false;
  return true;
}

export function getSurfaceHeightTexture(): GPUTexture {
  return heightTexture;
}

export function getSurfaceColorTexture(): GPUTexture {
  return colorTexture;
}
