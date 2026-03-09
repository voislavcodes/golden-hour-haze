// Noise LUT generation — pre-baked tiling noise textures
// Replaces per-frame FBM in density + per-frame hash noise in grain

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-manager.js';
import noiseLutShader from '../shaders/atmosphere/noise-lut-gen.wgsl';
import grainLutShader from '../shaders/atmosphere/grain-lut-gen.wgsl';

const NOISE_LUT_SIZE = 256;
const GRAIN_LUT_SIZE = 512;

let noiseLutPipeline: GPUComputePipeline;
let grainLutPipeline: GPUComputePipeline;

let noiseLutTexture: GPUTexture;
let grainLutTexture: GPUTexture;

let noiseLutParamBuffer: GPUBuffer;
let grainLutParamBuffer: GPUBuffer;

let noiseLutLayout: GPUBindGroupLayout;
let grainLutLayout: GPUBindGroupLayout;

let noiseLutSampler: GPUSampler;

let lastTurbulence = -1;
let lastGrainScale = -1;
let lastGrainAngle = -999;

let noiseLutDirty = true;
let grainLutDirty = true;

export function initNoiseLut() {
  const { device } = getGPU();

  // Noise LUT pipeline
  noiseLutLayout = device.createBindGroupLayout({
    label: 'noise-lut-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  noiseLutPipeline = createComputePipeline('noise-lut-gen', device, {
    label: 'noise-lut-gen-compute',
    layout: device.createPipelineLayout({ bindGroupLayouts: [noiseLutLayout] }),
    compute: {
      module: device.createShaderModule({ label: 'noise-lut-gen-shader', code: noiseLutShader }),
      entryPoint: 'main',
    },
  });

  noiseLutParamBuffer = device.createBuffer({
    label: 'noise-lut-params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  noiseLutTexture = device.createTexture({
    label: 'noise-lut',
    size: { width: NOISE_LUT_SIZE, height: NOISE_LUT_SIZE },
    format: 'rgba16float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });

  // Grain LUT pipeline
  grainLutLayout = device.createBindGroupLayout({
    label: 'grain-lut-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r8unorm' } },
    ],
  });

  grainLutPipeline = createComputePipeline('grain-lut-gen', device, {
    label: 'grain-lut-gen-compute',
    layout: device.createPipelineLayout({ bindGroupLayouts: [grainLutLayout] }),
    compute: {
      module: device.createShaderModule({ label: 'grain-lut-gen-shader', code: grainLutShader }),
      entryPoint: 'main',
    },
  });

  grainLutParamBuffer = device.createBuffer({
    label: 'grain-lut-params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  grainLutTexture = device.createTexture({
    label: 'grain-lut',
    size: { width: GRAIN_LUT_SIZE, height: GRAIN_LUT_SIZE },
    format: 'r8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });

  // Repeat-mode sampler for LUT sampling
  noiseLutSampler = device.createSampler({
    label: 'noise-lut-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
}

export function updateNoiseLutParams(turbulence: number) {
  if (turbulence === lastTurbulence) return;
  lastTurbulence = turbulence;
  noiseLutDirty = true;
}

export function updateGrainLutParams(scale: number, angle: number) {
  if (scale === lastGrainScale && angle === lastGrainAngle) return;
  lastGrainScale = scale;
  lastGrainAngle = angle;
  grainLutDirty = true;
}

export function generateLutsIfDirty(encoder: GPUCommandEncoder) {
  const { device } = getGPU();

  if (noiseLutDirty) {
    device.queue.writeBuffer(noiseLutParamBuffer, 0, new Float32Array([
      lastTurbulence, 0, 0, 0,
    ]));

    const bg = device.createBindGroup({
      layout: noiseLutLayout,
      entries: [
        { binding: 0, resource: { buffer: noiseLutParamBuffer } },
        { binding: 1, resource: noiseLutTexture.createView() },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'noise-lut-gen' });
    pass.setPipeline(noiseLutPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(NOISE_LUT_SIZE / 8), Math.ceil(NOISE_LUT_SIZE / 8));
    pass.end();

    noiseLutDirty = false;
  }

  if (grainLutDirty) {
    device.queue.writeBuffer(grainLutParamBuffer, 0, new Float32Array([
      lastGrainScale, lastGrainAngle, 0, 0,
    ]));

    const bg = device.createBindGroup({
      layout: grainLutLayout,
      entries: [
        { binding: 0, resource: { buffer: grainLutParamBuffer } },
        { binding: 1, resource: grainLutTexture.createView() },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'grain-lut-gen' });
    pass.setPipeline(grainLutPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(GRAIN_LUT_SIZE / 8), Math.ceil(GRAIN_LUT_SIZE / 8));
    pass.end();

    grainLutDirty = false;
  }
}

export function getNoiseLutTexture(): GPUTexture {
  return noiseLutTexture;
}

export function getGrainLutTexture(): GPUTexture {
  return grainLutTexture;
}

export function getNoiseLutSampler(): GPUSampler {
  return noiseLutSampler;
}
