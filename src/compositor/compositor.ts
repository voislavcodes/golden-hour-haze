// V3 Compositor — reads sky + paint surface + paint state, outputs final frame
// Light wells and bloom removed in v2. Paint state (drying) added in v3.

import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong } from '../gpu/texture-pool.js';
import { createRenderPipeline } from '../gpu/pipeline-cache.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import { getReadTexture, getStateReadTexture } from '../painting/surface.js';
import { getGrainLutTexture, getNoiseLutSampler } from '../atmosphere/noise-lut.js';
import { getSurfaceHeightTexture, getSurfaceColorTexture } from '../surface/surface-material.js';
import type { CompositorParams } from '../state/scene-state.js';
import compositeShader from '../shaders/composite/composite.wgsl';

let pipeline: GPURenderPipeline;
let textureLayout: GPUBindGroupLayout;
let compositorParamLayout: GPUBindGroupLayout;
let textureBG: GPUBindGroup;
let compositorParamBG: GPUBindGroup;
let compositorParamBuffer: GPUBuffer;
let sampler: GPUSampler;
let currentWidth = 0;
let currentHeight = 0;

export function initCompositor() {
  const { device, format } = getGPU();

  sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  // Texture layout: density, scatter, grain_lut, accum, tex_sampler, grain_sampler, surface_lut, paint_state
  textureLayout = device.createBindGroupLayout({
    label: 'composite-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // density
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // scatter
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // grain LUT
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // accum (paint surface)
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },     // tex sampler
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },     // grain repeat sampler
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // surface grain LUT
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },  // paint state
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // surface color
    ],
  });

  compositorParamLayout = device.createBindGroupLayout({
    label: 'compositor-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  compositorParamBuffer = device.createBuffer({
    label: 'compositor-params',
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  compositorParamBG = device.createBindGroup({
    label: 'compositor-param-bg',
    layout: compositorParamLayout,
    entries: [
      { binding: 0, resource: { buffer: compositorParamBuffer } },
    ],
  });

  const mod = device.createShaderModule({ label: 'composite-shader', code: compositeShader });
  pipeline = createRenderPipeline('composite-v4', device, {
    label: 'composite-render',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), textureLayout, compositorParamLayout],
    }),
    vertex: { module: mod, entryPoint: 'vs_main' },
    fragment: {
      module: mod,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
  });
}

export function updateCompositorTextures(width: number, height: number) {
  if (width === currentWidth && height === currentHeight) return;
  currentWidth = width;
  currentHeight = height;
  rebuildCompositorBindGroup();
}

export function rebuildCompositorBindGroup() {
  const { device } = getGPU();

  const densityW = Math.ceil(currentWidth / 2);
  const densityH = Math.ceil(currentHeight / 2);
  const densityPP = allocPingPong('atmosphere-density', 'rgba16float', densityW, densityH);

  const scatterTex = allocTexture('scatter', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  const grainLut = getGrainLutTexture();
  const grainSampler = getNoiseLutSampler();

  const accumTex = getReadTexture();
  const stateTex = getStateReadTexture();

  textureBG = device.createBindGroup({
    label: 'composite-tex-bg',
    layout: textureLayout,
    entries: [
      { binding: 0, resource: densityPP.readView },
      { binding: 1, resource: scatterTex.createView() },
      { binding: 2, resource: grainLut.createView() },
      { binding: 3, resource: accumTex.createView() },
      { binding: 4, resource: sampler },
      { binding: 5, resource: grainSampler },
      { binding: 6, resource: getSurfaceHeightTexture().createView() },
      { binding: 7, resource: stateTex.createView() },
      { binding: 8, resource: getSurfaceColorTexture().createView() },
    ],
  });
}

export function writeCompositorParams(params: CompositorParams) {
  const { device } = getGPU();
  device.queue.writeBuffer(compositorParamBuffer, 0, new Float32Array([
    params.shadowChroma,
    params.grayscale,
    params.grainIntensity ?? 0,
    params.grainAngle ?? 0,
    params.grainDepth ?? 0.5,
    params.grainScale ?? 4.0,
    params.surfaceIntensity ?? 0,
    params.sessionTime ?? 0,
    params.surfaceDrySpeed ?? 1.0,
    0, 0, 0, 0, 0, 0, 0,
  ]));
}

export function updateCompositorSessionTime(sessionTime: number) {
  const { device } = getGPU();
  // Write just the session_time field at offset 7*4=28 bytes
  device.queue.writeBuffer(compositorParamBuffer, 28, new Float32Array([sessionTime]));
}

export function renderComposite(encoder: GPUCommandEncoder, targetView: GPUTextureView, globalBG: GPUBindGroup) {
  const pass = encoder.beginRenderPass({
    label: 'composite-pass',
    colorAttachments: [{
      view: targetView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, globalBG);
  pass.setBindGroup(1, textureBG);
  pass.setBindGroup(2, compositorParamBG);
  pass.draw(3);
  pass.end();
}
