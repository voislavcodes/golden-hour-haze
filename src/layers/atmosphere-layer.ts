import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong } from '../gpu/texture-pool.js';
import { createComputePipeline, createRenderPipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import densityShader from '../shaders/atmosphere/density.wgsl';
import scatterShader from '../shaders/atmosphere/scatter.wgsl';
import { getNoiseLutTexture, getNoiseLutSampler } from './noise-lut.js';
import type { AtmosphereParams } from './layer-types.js';

let densityPipeline: GPUComputePipeline;
let scatterPipeline: GPURenderPipeline;

let atmosphereParamBuffer: GPUBuffer;
let scatterParamBuffer: GPUBuffer;

let atmosphereParamLayout: GPUBindGroupLayout;
let scatterParamLayout: GPUBindGroupLayout;

let densityTextureLayout: GPUBindGroupLayout;
let scatterTextureLayout: GPUBindGroupLayout;

let atmosphereParamBG: GPUBindGroup;
let scatterParamBG: GPUBindGroup;
let densityTextureBG: GPUBindGroup;
let scatterTextureBG: GPUBindGroup;

let sampler: GPUSampler;
let currentWidth = 0;
let currentHeight = 0;
// Half-res density dimensions
let densityWidth = 0;
let densityHeight = 0;

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
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },       // noise LUT
      { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },          // noise repeat sampler
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
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  atmosphereParamBG = device.createBindGroup({
    label: 'atmo-param-bg',
    layout: atmosphereParamLayout,
    entries: [{ binding: 0, resource: { buffer: atmosphereParamBuffer } }],
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
    size: 32,
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

  // Half-res density
  densityWidth = Math.ceil(width / 2);
  densityHeight = Math.ceil(height / 2);

  const { device } = getGPU();

  const pp = allocPingPong('atmosphere-density', 'rgba16float', densityWidth, densityHeight,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  const depthTex = allocTexture('depth', 'r32float', width, height,
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
      { binding: 4, resource: getNoiseLutTexture().createView() },
      { binding: 5, resource: getNoiseLutSampler() },
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
  const pp = allocPingPong('atmosphere-density', 'rgba16float', densityWidth, densityHeight);
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
      { binding: 4, resource: getNoiseLutTexture().createView() },
      { binding: 5, resource: getNoiseLutSampler() },
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

export function writeAtmosphereParams(params: AtmosphereParams, horizonY = 0.5) {
  const { device } = getGPU();
  const humidity = params.density * (1 - Math.abs(params.warmth)) * 0.8;
  const data = new Float32Array([
    params.density, params.warmth, params.grain, params.scatter,
    params.driftX, params.driftY, params.driftSpeed, params.turbulence,
    humidity, params.grainDepth, horizonY, 0,
  ]);
  device.queue.writeBuffer(atmosphereParamBuffer, 0, data);
}

export function writeScatterParams(sunAngle: number, sunElevation: number, horizonY = 0.5) {
  const { device } = getGPU();
  device.queue.writeBuffer(scatterParamBuffer, 0, new Float32Array([
    sunAngle, sunElevation, 1.0, 0.0,
    horizonY, 0, 0, 0,
  ]));
}

export function dispatchDensity(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
  const densityPass = encoder.beginComputePass({ label: 'density-pass' });
  densityPass.setPipeline(densityPipeline);
  densityPass.setBindGroup(0, globalBG);
  densityPass.setBindGroup(1, atmosphereParamBG);
  densityPass.setBindGroup(2, densityTextureBG);
  densityPass.dispatchWorkgroups(Math.ceil(densityWidth / 8), Math.ceil(densityHeight / 8));
  densityPass.end();

  // Swap ping-pong after density write
  const pp = allocPingPong('atmosphere-density', 'rgba16float', densityWidth, densityHeight);
  pp.swap();
  rebuildDensityBindGroup();
}

export function dispatchScatter(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
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

/** Legacy combined dispatch */
export function dispatchAtmosphere(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
  dispatchDensity(encoder, globalBG);
  dispatchScatter(encoder, globalBG);
}
