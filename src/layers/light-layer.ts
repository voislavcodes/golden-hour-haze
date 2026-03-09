import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong } from '../gpu/texture-pool.js';
import { createComputePipeline, createRenderPipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import lightScatterShader from '../shaders/light/light-scatter.wgsl';
import bloomShader from '../shaders/light/bloom.wgsl';
import type { LightDef, PaletteColor } from './layer-types.js';
import { MAX_LIGHTS } from './layer-types.js';
import { autoColorFromTime } from '../state/scene-state.js';

let scatterPipeline: GPUComputePipeline;
let bloomPipeline: GPURenderPipeline;

let lightParamBuffer: GPUBuffer;
let lightStorageBuffer: GPUBuffer;

let scatterParamLayout: GPUBindGroupLayout;
let scatterTextureLayout: GPUBindGroupLayout;
let bloomLayout: GPUBindGroupLayout;

let scatterParamBG: GPUBindGroup;
let scatterTextureBG: GPUBindGroup;

let bloomSampler: GPUSampler;

// Bloom mip chain
const BLOOM_MIPS = 3;
let bloomTextures: GPUTexture[] = [];
// bloomBindGroups created dynamically per-frame
let bloomParamBuffers: GPUBuffer[] = [];

let currentWidth = 0;
let currentHeight = 0;

// Sun-driven bloom params (updated by writeLightData)
let bloomThreshold = 0.8;
let bloomWarmth = [1.0, 1.0, 1.0];
let bloomIntensity = 1.0;

export function initLightLayer() {
  const { device } = getGPU();

  bloomSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  });

  // --- Scatter compute ---
  scatterParamLayout = device.createBindGroupLayout({
    label: 'light-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });

  scatterTextureLayout = device.createBindGroupLayout({
    label: 'light-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  scatterPipeline = createComputePipeline('light-scatter', device, {
    label: 'light-scatter-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), scatterParamLayout, scatterTextureLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'light-scatter-shader', code: lightScatterShader }),
      entryPoint: 'main',
    },
  });

  lightParamBuffer = device.createBuffer({
    label: 'light-params',
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  lightStorageBuffer = device.createBuffer({
    label: 'light-storage',
    size: MAX_LIGHTS * 48, // 12 floats * 4 bytes
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  scatterParamBG = device.createBindGroup({
    label: 'light-param-bg',
    layout: scatterParamLayout,
    entries: [
      { binding: 0, resource: { buffer: lightParamBuffer } },
      { binding: 1, resource: { buffer: lightStorageBuffer } },
    ],
  });

  // --- Bloom render ---
  bloomLayout = device.createBindGroupLayout({
    label: 'bloom-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });

  const bloomModule = device.createShaderModule({ label: 'bloom-shader', code: bloomShader });
  bloomPipeline = createRenderPipeline('bloom', device, {
    label: 'bloom-render',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bloomLayout],
    }),
    vertex: { module: bloomModule, entryPoint: 'vs_main' },
    fragment: {
      module: bloomModule,
      entryPoint: 'fs_main',
      targets: [{ format: 'rgba16float' }],
    },
    primitive: { topology: 'triangle-list' },
  });

  // Create bloom param buffers (32 bytes each for warmth + intensity)
  for (let i = 0; i < BLOOM_MIPS * 2 + 1; i++) {
    bloomParamBuffers.push(device.createBuffer({
      label: `bloom-params-${i}`,
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
  }
}

export function updateLightTextures(width: number, height: number) {
  if (width === currentWidth && height === currentHeight) return;
  currentWidth = width;
  currentHeight = height;

  const { device } = getGPU();

  // Light scatter output
  const scatterTex = allocTexture('light-scatter', 'rgba16float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  const depthTex = allocTexture('depth', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
  const formsTex = allocTexture('forms', 'rgba16float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  // Reference to atmosphere density (half-res) for scatter read
  const densityW = Math.ceil(width / 2);
  const densityH = Math.ceil(height / 2);
  const densityPP = allocPingPong('atmosphere-density', 'rgba16float', densityW, densityH);

  scatterTextureBG = device.createBindGroup({
    label: 'light-tex-bg',
    layout: scatterTextureLayout,
    entries: [
      { binding: 0, resource: densityPP.readView },
      { binding: 1, resource: depthTex.createView() },
      { binding: 2, resource: formsTex.createView() },
      { binding: 3, resource: scatterTex.createView() },
    ],
  });

  // Create bloom mip chain
  for (const tex of bloomTextures) tex.destroy();
  bloomTextures = [];
  // bind groups recreated per-frame

  let mipW = Math.max(1, Math.floor(width / 2));
  let mipH = Math.max(1, Math.floor(height / 2));

  for (let i = 0; i < BLOOM_MIPS; i++) {
    const tex = device.createTexture({
      label: `bloom-mip-${i}`,
      size: { width: mipW, height: mipH },
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    bloomTextures.push(tex);
    mipW = Math.max(1, Math.floor(mipW / 2));
    mipH = Math.max(1, Math.floor(mipH / 2));
  }
}

export function writeLightData(lights: LightDef[], sunElevation = 0.15, paletteColors?: PaletteColor[]) {
  const { device } = getGPU();
  const count = Math.min(lights.length, MAX_LIGHTS);

  const gf = Math.max(0, 1.0 - Math.min(1.0, Math.max(0, sunElevation) * 2.5));

  // Derive bloom character from golden factor
  bloomThreshold = 0.8 - gf * 0.3;
  bloomWarmth = [1.0 + gf * 0.2, 1.0 - gf * 0.1, 1.0 - gf * 0.3];
  bloomIntensity = 1.0 + gf * 0.3;

  const header = new ArrayBuffer(32);
  const u32 = new Uint32Array(header);
  const f32 = new Float32Array(header);
  u32[0] = count;
  f32[1] = sunElevation;
  // f32[2..7] = padding (already 0)
  device.queue.writeBuffer(lightParamBuffer, 0, header);

  if (count === 0) return;

  // Resolve auto color from TIME
  const autoColor = autoColorFromTime(sunElevation);

  const data = new Float32Array(count * 12);
  for (let i = 0; i < count; i++) {
    const l = lights[i];
    const off = i * 12;

    // Resolve color: auto from TIME or locked to palette slot
    let r = l.colorR, g = l.colorG, b = l.colorB;
    if (l.paletteSlot < 0) {
      r = autoColor.r;
      g = autoColor.g;
      b = autoColor.b;
    } else if (paletteColors && l.paletteSlot < paletteColors.length) {
      const pc = paletteColors[Math.floor(l.paletteSlot)];
      r = pc.r;
      g = pc.g;
      b = pc.b;
    }

    data[off] = l.x;
    data[off + 1] = l.y;
    data[off + 2] = l.coreRadius;
    data[off + 3] = l.bloomRadius;
    data[off + 4] = l.intensity;
    data[off + 5] = l.aspectRatio;
    data[off + 6] = l.rotation;
    data[off + 7] = l.paletteSlot;
    data[off + 8] = r;
    data[off + 9] = g;
    data[off + 10] = b;
    data[off + 11] = l.depth;
  }
  device.queue.writeBuffer(lightStorageBuffer, 0, data);
}

function createBloomBG(device: GPUDevice, inputTex: GPUTexture, paramBuf: GPUBuffer): GPUBindGroup {
  return device.createBindGroup({
    layout: bloomLayout,
    entries: [
      { binding: 0, resource: { buffer: paramBuf } },
      { binding: 1, resource: inputTex.createView() },
      { binding: 2, resource: bloomSampler },
    ],
  });
}

export function dispatchLight(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
  const { device } = getGPU();

  // 1. Light scatter compute
  const scatterPass = encoder.beginComputePass({ label: 'light-scatter-pass' });
  scatterPass.setPipeline(scatterPipeline);
  scatterPass.setBindGroup(0, globalBG);
  scatterPass.setBindGroup(1, scatterParamBG);
  scatterPass.setBindGroup(2, scatterTextureBG);
  scatterPass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  scatterPass.end();

  // 2. Bloom chain
  if (bloomTextures.length === 0) return;

  const scatterTex = allocTexture('light-scatter', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  // Threshold + first downsample
  let prevTex = scatterTex;
  let bufIdx = 0;

  // Downsample chain
  for (let i = 0; i < bloomTextures.length; i++) {
    const target = bloomTextures[i];
    const passType = i === 0 ? 0.0 : 1.0; // threshold for first, downsample for rest
    const tw = 1.0 / prevTex.width;
    const th = 1.0 / prevTex.height;

    device.queue.writeBuffer(bloomParamBuffers[bufIdx], 0,
      new Float32Array([tw, th, bloomThreshold, passType, bloomWarmth[0], bloomWarmth[1], bloomWarmth[2], bloomIntensity]));

    const bg = createBloomBG(device, prevTex, bloomParamBuffers[bufIdx]);

    const pass = encoder.beginRenderPass({
      label: `bloom-down-${i}`,
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(bloomPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();

    prevTex = target;
    bufIdx++;
  }

  // Upsample chain
  for (let i = bloomTextures.length - 2; i >= 0; i--) {
    const source = bloomTextures[i + 1];
    const target = bloomTextures[i];
    const tw = 1.0 / source.width;
    const th = 1.0 / source.height;

    device.queue.writeBuffer(bloomParamBuffers[bufIdx], 0,
      new Float32Array([tw, th, 0, 2.0, bloomWarmth[0], bloomWarmth[1], bloomWarmth[2], bloomIntensity]));

    const bg = createBloomBG(device, source, bloomParamBuffers[bufIdx]);

    const pass = encoder.beginRenderPass({
      label: `bloom-up-${i}`,
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'load',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(bloomPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();

    bufIdx++;
  }
}

export function getBloomTexture(): GPUTexture | undefined {
  return bloomTextures[0];
}
