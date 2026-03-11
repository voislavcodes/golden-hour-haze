// Cloth contact heightfield — 64x64 procedural cloth texture for rag wipe
// Follows surface-material.ts pattern (init / generateIfDirty / get)

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import clothShader from '../shaders/surface/cloth-heightfield-gen.wgsl';

const CLOTH_SIZE = 64;
const PARAM_SIZE = 16; // 4 floats

let pipeline: GPUComputePipeline;
let texture: GPUTexture;
let paramBuffer: GPUBuffer;
let layout: GPUBindGroupLayout;
let dirty = true;
let currentSeed = 42.0;

export function initClothHeightfield() {
  const { device } = getGPU();

  layout = device.createBindGroupLayout({
    label: 'cloth-heightfield-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
    ],
  });

  pipeline = createComputePipeline('cloth-heightfield-gen', device, {
    label: 'cloth-heightfield-gen-compute',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: {
      module: device.createShaderModule({ label: 'cloth-heightfield-gen-shader', code: clothShader }),
      entryPoint: 'main',
    },
  });

  paramBuffer = device.createBuffer({
    label: 'cloth-heightfield-params',
    size: PARAM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  texture = device.createTexture({
    label: 'cloth-heightfield',
    size: { width: CLOTH_SIZE, height: CLOTH_SIZE },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });
}

export function setClothSeed(seed: number) {
  if (seed !== currentSeed) {
    currentSeed = seed;
    dirty = true;
  }
}

export function generateClothHeightfieldIfDirty(encoder: GPUCommandEncoder): boolean {
  if (!dirty) return false;

  const { device } = getGPU();

  const data = new Float32Array([
    currentSeed,  // seed
    1.0,          // crumple_scale
    20.0,         // weave_freq
    0.0,          // _pad
  ]);
  device.queue.writeBuffer(paramBuffer, 0, data);

  const bg = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: paramBuffer } },
      { binding: 1, resource: texture.createView() },
    ],
  });

  const pass = encoder.beginComputePass({ label: 'cloth-heightfield-gen' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(CLOTH_SIZE / 8), Math.ceil(CLOTH_SIZE / 8));
  pass.end();

  dirty = false;
  return true;
}

export function getClothHeightfieldTexture(): GPUTexture {
  return texture;
}
