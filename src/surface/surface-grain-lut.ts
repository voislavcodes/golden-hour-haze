// Surface grain LUT — pre-baked surface texture for painting ground
// Follows noise-lut.ts pattern: init, update params, generate if dirty

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import surfaceGrainShader from '../shaders/surface/surface-grain-lut-gen.wgsl';

const SURFACE_LUT_SIZE = 512;

let pipeline: GPUComputePipeline;
let texture: GPUTexture;
let paramBuffer: GPUBuffer;
let layout: GPUBindGroupLayout;

let lastGrainSize = -1;
let lastDirectionality = -1;
let lastMode = -1;
let dirty = true;

export function initSurfaceGrainLut() {
  const { device } = getGPU();

  layout = device.createBindGroupLayout({
    label: 'surface-grain-lut-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
    ],
  });

  pipeline = createComputePipeline('surface-grain-lut-gen', device, {
    label: 'surface-grain-lut-gen-compute',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: {
      module: device.createShaderModule({ label: 'surface-grain-lut-gen-shader', code: surfaceGrainShader }),
      entryPoint: 'main',
    },
  });

  paramBuffer = device.createBuffer({
    label: 'surface-grain-lut-params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  texture = device.createTexture({
    label: 'surface-grain-lut',
    size: { width: SURFACE_LUT_SIZE, height: SURFACE_LUT_SIZE },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
}

export function updateSurfaceGrainParams(grainSize: number, directionality: number, mode: number) {
  if (grainSize === lastGrainSize && directionality === lastDirectionality && mode === lastMode) return;
  lastGrainSize = grainSize;
  lastDirectionality = directionality;
  lastMode = mode;
  dirty = true;
}

export function generateSurfaceGrainIfDirty(encoder: GPUCommandEncoder): boolean {
  if (!dirty) return false;

  const { device } = getGPU();

  // Pack params: grain_size (f32), directionality (f32), seed (f32), mode (u32)
  const buf = new ArrayBuffer(16);
  const floats = new Float32Array(buf);
  const uints = new Uint32Array(buf);
  floats[0] = lastGrainSize;
  floats[1] = lastDirectionality;
  floats[2] = 42.0; // fixed seed for consistency
  uints[3] = lastMode;

  device.queue.writeBuffer(paramBuffer, 0, buf);

  const bg = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: paramBuffer } },
      { binding: 1, resource: texture.createView() },
    ],
  });

  const pass = encoder.beginComputePass({ label: 'surface-grain-lut-gen' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(SURFACE_LUT_SIZE / 8), Math.ceil(SURFACE_LUT_SIZE / 8));
  pass.end();

  dirty = false;
  return true;
}

export function getSurfaceGrainTexture(): GPUTexture {
  return texture;
}
