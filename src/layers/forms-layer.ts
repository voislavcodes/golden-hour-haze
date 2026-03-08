import { getGPU } from '../gpu/context.js';
import { allocTexture } from '../gpu/texture-pool.js';
import { createComputePipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import formsShader from '../shaders/forms/forms.wgsl';
import type { FormDef, TonalMapParams } from './layer-types.js';
import { MAX_FORMS, FORM_STRIDE } from './layer-types.js';

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let formStorageBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let paramBG: GPUBindGroup;
let textureBG: GPUBindGroup;
let currentWidth = 0;
let currentHeight = 0;

export function initFormsLayer() {
  const { device } = getGPU();

  paramLayout = device.createBindGroupLayout({
    label: 'forms-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });

  textureLayout = device.createBindGroupLayout({
    label: 'forms-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  pipeline = createComputePipeline('forms', device, {
    label: 'forms-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [getGlobalBindGroupLayout(device), paramLayout, textureLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'forms-shader', code: formsShader }),
      entryPoint: 'main',
    },
  });

  paramBuffer = device.createBuffer({
    label: 'forms-params',
    size: 32, // form_count, sun_angle, key_value, value_range, contrast, velvet, tonal_sort, tonal_enabled
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // 16 floats * 4 bytes = 64 bytes per form
  formStorageBuffer = device.createBuffer({
    label: 'forms-storage',
    size: MAX_FORMS * FORM_STRIDE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  paramBG = device.createBindGroup({
    label: 'forms-param-bg',
    layout: paramLayout,
    entries: [
      { binding: 0, resource: { buffer: paramBuffer } },
      { binding: 1, resource: { buffer: formStorageBuffer } },
    ],
  });
}

export function updateFormsTextures(width: number, height: number) {
  if (width === currentWidth && height === currentHeight) return;
  currentWidth = width;
  currentHeight = height;

  const { device } = getGPU();

  const formsTex = allocTexture('forms', 'rgba16float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  // Ensure dissolution mask exists
  allocTexture('dissolution', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  const depthTex = allocTexture('depth', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  const densityPP = allocTexture('forms-density-ref', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  textureBG = device.createBindGroup({
    label: 'forms-tex-bg',
    layout: textureLayout,
    entries: [
      { binding: 0, resource: depthTex.createView() },
      { binding: 1, resource: allocTexture('dissolution', 'r32float', width, height,
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING).createView() },
      { binding: 2, resource: densityPP.createView() },
      { binding: 3, resource: formsTex.createView() },
    ],
  });
}

export function writeFormsData(
  forms: FormDef[],
  palette: { r: number; g: number; b: number }[],
  sunAngle = 0.8,
  tonalMap: TonalMapParams = { enabled: true, valueRange: 0.8, keyValue: 0.5, contrast: 0.6 },
  velvet = 0.6,
  tonalSort = true,
) {
  const { device } = getGPU();

  // Tonal sort: render darkest forms first for K-M layering
  const toRender = tonalSort ? forms.slice().sort((a, b) => {
    const colA = palette[Math.min(a.colorIndex, palette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
    const colB = palette[Math.min(b.colorIndex, palette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
    return (0.2126 * colA.r + 0.7152 * colA.g + 0.0722 * colA.b)
         - (0.2126 * colB.r + 0.7152 * colB.g + 0.0722 * colB.b);
  }) : forms;

  const count = Math.min(toRender.length, MAX_FORMS);
  const headerData = new ArrayBuffer(32);
  const headerU32 = new Uint32Array(headerData);
  const headerF32 = new Float32Array(headerData);
  headerU32[0] = count;
  headerF32[1] = sunAngle;
  headerF32[2] = tonalMap.keyValue;
  headerF32[3] = tonalMap.valueRange;
  headerF32[4] = tonalMap.contrast;
  headerF32[5] = velvet;
  headerF32[6] = tonalSort ? 1.0 : 0.0;
  headerF32[7] = tonalMap.enabled ? 1.0 : 0.0;
  device.queue.writeBuffer(paramBuffer, 0, headerData);

  if (count === 0) return;

  const data = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    const f = toRender[i];
    const color = palette[Math.min(f.colorIndex, palette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
    const off = i * 16;
    data[off] = f.type;
    data[off + 1] = f.x;
    data[off + 2] = f.y;
    data[off + 3] = f.sizeX;
    data[off + 4] = f.sizeY;
    data[off + 5] = f.rotation;
    data[off + 6] = f.softness + f.dissolution * 0.3; // dissolution increases edge softness
    data[off + 7] = f.depth;
    data[off + 8] = color.r;
    data[off + 9] = color.g;
    data[off + 10] = color.b;
    data[off + 11] = f.opacity;
    data[off + 12] = f.strokeDirX ?? 0;
    data[off + 13] = f.strokeDirY ?? 0;
    // edge_seed: unique per-form hash based on position
    data[off + 14] = ((f.x * 127.1 + f.y * 311.7) % 1.0 + 1.0) % 1.0;
    data[off + 15] = 0; // _pad
  }
  device.queue.writeBuffer(formStorageBuffer, 0, data);
}

export function dispatchForms(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
  const pass = encoder.beginComputePass({ label: 'forms-compute-pass' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, globalBG);
  pass.setBindGroup(1, paramBG);
  pass.setBindGroup(2, textureBG);
  pass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  pass.end();
}
