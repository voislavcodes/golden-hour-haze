import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong } from '../gpu/texture-pool.js';
import { createComputePipeline, createRenderPipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import densityShader from '../shaders/atmosphere/density.wgsl';
import grainShader from '../shaders/atmosphere/grain.wgsl';
import scatterShader from '../shaders/atmosphere/scatter.wgsl';
import type { AtmosphereParams } from './layer-types.js';

let densityPipeline: GPUComputePipeline;
let grainPipeline: GPUComputePipeline;
let scatterPipeline: GPURenderPipeline;

let atmosphereParamBuffer: GPUBuffer;
let grainParamBuffer: GPUBuffer;
let scatterParamBuffer: GPUBuffer;

let atmosphereParamLayout: GPUBindGroupLayout;
let grainParamLayout: GPUBindGroupLayout;
let scatterParamLayout: GPUBindGroupLayout;

let densityTextureLayout: GPUBindGroupLayout;
let grainTextureLayout: GPUBindGroupLayout;
let scatterTextureLayout: GPUBindGroupLayout;

let atmosphereParamBG: GPUBindGroup;
let grainParamBG: GPUBindGroup;
let scatterParamBG: GPUBindGroup;
let densityTextureBG: GPUBindGroup;
let grainTextureBG: GPUBindGroup;
let scatterTextureBG: GPUBindGroup;

let sampler: GPUSampler;
let currentWidth = 0;
let currentHeight = 0;

export function initAtmosphereLayer() {
  const { device } = getGPU();

  sampler = device.createSampler({
    label: 'atmo-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // --- Density compute ---
  atmosphereParamLayout = device.createBindGroupLayout({
    label: 'atmo-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  densityTextureLayout = device.createBindGroupLayout({
    label: 'density-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  densityPipeline = createComputePipeline('density', device, {
    label: 'density-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), atmosphereParamLayout, densityTextureLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'density-shader', code: densityShader }),
      entryPoint: 'main',
    },
  });

  atmosphereParamBuffer = device.createBuffer({
    label: 'atmo-params',
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  atmosphereParamBG = device.createBindGroup({
    label: 'atmo-param-bg',
    layout: atmosphereParamLayout,
    entries: [{ binding: 0, resource: { buffer: atmosphereParamBuffer } }],
  });

  // --- Grain compute ---
  grainParamLayout = device.createBindGroupLayout({
    label: 'grain-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  grainTextureLayout = device.createBindGroupLayout({
    label: 'grain-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
    ],
  });

  grainPipeline = createComputePipeline('grain', device, {
    label: 'grain-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), grainParamLayout, grainTextureLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'grain-shader', code: grainShader }),
      entryPoint: 'main',
    },
  });

  grainParamBuffer = device.createBuffer({
    label: 'grain-params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  grainParamBG = device.createBindGroup({
    label: 'grain-param-bg',
    layout: grainParamLayout,
    entries: [{ binding: 0, resource: { buffer: grainParamBuffer } }],
  });

  // --- Scatter render ---
  scatterParamLayout = device.createBindGroupLayout({
    label: 'scatter-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  scatterTextureLayout = device.createBindGroupLayout({
    label: 'scatter-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const scatterModule = device.createShaderModule({ label: 'scatter-shader', code: scatterShader });
  scatterPipeline = createRenderPipeline('scatter', device, {
    label: 'scatter-render',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), scatterParamLayout, scatterTextureLayout],
    }),
    vertex: { module: scatterModule, entryPoint: 'vs_main' },
    fragment: {
      module: scatterModule,
      entryPoint: 'fs_main',
      targets: [{ format: 'rgba16float' }],
    },
    primitive: { topology: 'triangle-list' },
  });

  scatterParamBuffer = device.createBuffer({
    label: 'scatter-params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  scatterParamBG = device.createBindGroup({
    label: 'scatter-param-bg',
    layout: scatterParamLayout,
    entries: [{ binding: 0, resource: { buffer: scatterParamBuffer } }],
  });
}

export function updateAtmosphereTextures(width: number, height: number) {
  if (width === currentWidth && height === currentHeight) return;
  currentWidth = width;
  currentHeight = height;

  const { device } = getGPU();

  const pp = allocPingPong('atmosphere-density', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  const depthTex = allocTexture('depth', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  const grainTex = allocTexture('grain', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  allocTexture('scatter', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  densityTextureBG = device.createBindGroup({
    label: 'density-tex-bg',
    layout: densityTextureLayout,
    entries: [
      { binding: 0, resource: pp.readView },
      { binding: 1, resource: depthTex.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: pp.writeView },
    ],
  });

  grainTextureBG = device.createBindGroup({
    label: 'grain-tex-bg',
    layout: grainTextureLayout,
    entries: [
      { binding: 0, resource: depthTex.createView() },
      { binding: 1, resource: grainTex.createView() },
    ],
  });

  scatterTextureBG = device.createBindGroup({
    label: 'scatter-tex-bg',
    layout: scatterTextureLayout,
    entries: [
      { binding: 0, resource: pp.readView },
      { binding: 1, resource: depthTex.createView() },
      { binding: 2, resource: sampler },
    ],
  });
}

export function rebuildDensityBindGroup() {
  const { device } = getGPU();
  const pp = allocPingPong('atmosphere-density', 'rgba16float', currentWidth, currentHeight);
  const depthTex = allocTexture('depth', 'r32float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  densityTextureBG = device.createBindGroup({
    label: 'density-tex-bg',
    layout: densityTextureLayout,
    entries: [
      { binding: 0, resource: pp.readView },
      { binding: 1, resource: depthTex.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: pp.writeView },
    ],
  });

  // Update scatter to read from new ping texture
  scatterTextureBG = device.createBindGroup({
    label: 'scatter-tex-bg',
    layout: scatterTextureLayout,
    entries: [
      { binding: 0, resource: pp.readView },
      { binding: 1, resource: depthTex.createView() },
      { binding: 2, resource: sampler },
    ],
  });
}

export function writeAtmosphereParams(params: AtmosphereParams) {
  const { device } = getGPU();
  const data = new Float32Array([
    params.density, params.warmth, params.grain, params.scatter,
    params.driftX, params.driftY, params.driftSpeed, params.turbulence,
  ]);
  device.queue.writeBuffer(atmosphereParamBuffer, 0, data);

  // Grain params
  device.queue.writeBuffer(grainParamBuffer, 0, new Float32Array([
    params.grain, 1.0 + params.grain * 3.0, 0, 0,
  ]));
}

export function writeScatterParams(sunAngle: number, sunElevation: number) {
  const { device } = getGPU();
  device.queue.writeBuffer(scatterParamBuffer, 0, new Float32Array([
    sunAngle, sunElevation, 1.0, 0,
  ]));
}

export function dispatchAtmosphere(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
  // 1. Density compute (ping → pong)
  const densityPass = encoder.beginComputePass({ label: 'density-pass' });
  densityPass.setPipeline(densityPipeline);
  densityPass.setBindGroup(0, globalBG);
  densityPass.setBindGroup(1, atmosphereParamBG);
  densityPass.setBindGroup(2, densityTextureBG);
  densityPass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  densityPass.end();

  // Swap ping-pong after density write
  const pp = allocPingPong('atmosphere-density', 'rgba16float', currentWidth, currentHeight);
  pp.swap();
  rebuildDensityBindGroup();

  // 2. Grain compute
  const grainPass = encoder.beginComputePass({ label: 'grain-pass' });
  grainPass.setPipeline(grainPipeline);
  grainPass.setBindGroup(0, globalBG);
  grainPass.setBindGroup(1, grainParamBG);
  grainPass.setBindGroup(2, grainTextureBG);
  grainPass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  grainPass.end();

  // 3. Scatter render pass
  const scatterTex = allocTexture('scatter', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  const scatterPass = encoder.beginRenderPass({
    label: 'scatter-pass',
    colorAttachments: [{
      view: scatterTex.createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    }],
  });
  scatterPass.setPipeline(scatterPipeline);
  scatterPass.setBindGroup(0, globalBG);
  scatterPass.setBindGroup(1, scatterParamBG);
  scatterPass.setBindGroup(2, scatterTextureBG);
  scatterPass.draw(3);
  scatterPass.end();
}
