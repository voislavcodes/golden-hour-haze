import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong } from '../gpu/texture-pool.js';
import { createRenderPipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import compositeShader from '../shaders/composite/composite.wgsl';
import { getBloomTexture } from './light-layer.js';

let pipeline: GPURenderPipeline;
let textureLayout: GPUBindGroupLayout;
let textureBG: GPUBindGroup;
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
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, // grain
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // forms
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // light
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },  // bloom
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const mod = device.createShaderModule({ label: 'composite-shader', code: compositeShader });
  pipeline = createRenderPipeline('composite', device, {
    label: 'composite-render',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), textureLayout],
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
  const densityPP = allocPingPong('atmosphere-density', 'rgba16float', currentWidth, currentHeight);
  const scatterTex = allocTexture('scatter', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);
  const grainTex = allocTexture('grain', 'r32float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
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

  textureBG = device.createBindGroup({
    label: 'composite-tex-bg',
    layout: textureLayout,
    entries: [
      { binding: 0, resource: depthTex.createView() },
      { binding: 1, resource: densityPP.readView },
      { binding: 2, resource: scatterTex.createView() },
      { binding: 3, resource: grainTex.createView() },
      { binding: 4, resource: formsTex.createView() },
      { binding: 5, resource: lightTex.createView() },
      { binding: 6, resource: bloomTex.createView() },
      { binding: 7, resource: sampler },
    ],
  });
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
  pass.draw(3);
  pass.end();
}
