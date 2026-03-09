import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong } from '../gpu/texture-pool.js';
import { createRenderPipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import compositeShader from '../shaders/composite/composite.wgsl';
import { getBloomTexture } from './light-layer.js';
import { getGrainLutTexture, getNoiseLutSampler } from './noise-lut.js';
import type { CompositorParams } from './layer-types.js';

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

  textureLayout = device.createBindGroupLayout({
    label: 'composite-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, // depth
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // density
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // scatter
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // grain LUT (was grain compute texture)
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // forms
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // light
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // bloom
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },     // grain repeat sampler
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
    size: 48, // 12 floats
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
  pipeline = createRenderPipeline('composite', device, {
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

  const depthTex = allocTexture('depth', 'r32float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  // Density is half-res — allocPingPong returns existing at half dimensions
  const densityW = Math.ceil(currentWidth / 2);
  const densityH = Math.ceil(currentHeight / 2);
  const densityPP = allocPingPong('atmosphere-density', 'rgba16float', densityW, densityH);

  const scatterTex = allocTexture('scatter', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  const formsTex = allocTexture('forms', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
  const lightTex = allocTexture('light-scatter', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  // Bloom may not exist yet — use a fallback 1x1 texture
  let bloomTex = getBloomTexture();
  if (!bloomTex) {
    bloomTex = device.createTexture({
      label: 'bloom-fallback',
      size: { width: 1, height: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  // Grain LUT texture (pre-baked tiling grain)
  const grainLut = getGrainLutTexture();
  // Repeat sampler for grain LUT
  const grainSampler = getNoiseLutSampler();

  textureBG = device.createBindGroup({
    label: 'composite-tex-bg',
    layout: textureLayout,
    entries: [
      { binding: 0, resource: depthTex.createView() },
      { binding: 1, resource: densityPP.readView },
      { binding: 2, resource: scatterTex.createView() },
      { binding: 3, resource: grainLut.createView() },
      { binding: 4, resource: formsTex.createView() },
      { binding: 5, resource: lightTex.createView() },
      { binding: 6, resource: bloomTex.createView() },
      { binding: 7, resource: sampler },
      { binding: 8, resource: grainSampler },
    ],
  });
}

export function writeCompositorParams(params: CompositorParams) {
  const { device } = getGPU();
  device.queue.writeBuffer(compositorParamBuffer, 0, new Float32Array([
    params.shadowChroma,
    params.grayscale,
    params.anchorX,
    params.anchorY,
    params.anchorBoost,
    params.anchorFalloff,
    params.sunGradeWarmth,
    params.sunGradeIntensity,
    params.grainIntensity ?? 0,
    params.grainAngle ?? 0,
    params.grainDepth ?? 0.5,
    params.grainScale ?? 4.0,
  ]));
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
