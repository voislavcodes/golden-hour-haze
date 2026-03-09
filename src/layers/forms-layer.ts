import { getGPU } from '../gpu/context.js';
import { allocTexture, allocPingPong, type PingPongTexture } from '../gpu/texture-pool.js';
import { createComputePipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import formsShader from '../shaders/forms/forms.wgsl';
import glazeShader from '../shaders/forms/glaze.wgsl';
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

// Bake state — completed strokes baked into persistent texture
let bakedFormCount = 0;
let pendingBake = false;
let pendingFullRebake = false;
let currentTotalFormCount = 0;
let bakedPP: PingPongTexture;

// Dissolution active — forces baked_count=0 to recompute all forms with dissolution mask
let dissolutionActive = false;

// Tonal accumulation — tracks paint density for diminishing returns
let accumPP: PingPongTexture;
let liveTex: GPUTexture;

// Glaze bake pipeline
let glazePipeline: GPUComputePipeline;
let glazeParamLayout: GPUBindGroupLayout;
let glazeTexLayout: GPUBindGroupLayout;
let glazeParamBuffer: GPUBuffer;
let glazeParamBG: GPUBindGroup;

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
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
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
    size: 64, // 16 floats: form_count, sun_angle, key_value, value_range, contrast, velvet, tonal_sort, tonal_enabled, base_opacity, pad, baked_count, falloff, edge_atmosphere, horizon_y, pad*2
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

  // Glaze bake pipeline
  glazeParamLayout = device.createBindGroupLayout({
    label: 'glaze-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  glazeTexLayout = device.createBindGroupLayout({
    label: 'glaze-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  glazePipeline = createComputePipeline('glaze', device, {
    label: 'glaze-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [glazeParamLayout, glazeTexLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'glaze-shader', code: glazeShader }),
      entryPoint: 'main',
    },
  });

  glazeParamBuffer = device.createBuffer({
    label: 'glaze-params',
    size: 16, // GlazeParams: is_clear + 3 padding u32
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  glazeParamBG = device.createBindGroup({
    label: 'glaze-param-bg',
    layout: glazeParamLayout,
    entries: [
      { binding: 0, resource: { buffer: glazeParamBuffer } },
    ],
  });
}

export function updateFormsTextures(width: number, height: number) {
  if (width === currentWidth && height === currentHeight) return;
  currentWidth = width;
  currentHeight = height;

  const { device } = getGPU();

  const formsTex = allocTexture('forms', 'rgba16float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);

  // Ensure dissolution mask exists (COPY_DST for CPU writeTexture)
  allocTexture('dissolution', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);

  const depthTex = allocTexture('depth', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  const densityPP = allocTexture('forms-density-ref', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  // Baked strokes ping-pong
  bakedPP = allocPingPong('forms-baked', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC);

  // Accumulation buffer — RGB reserved, A = layer weight for diminishing returns
  accumPP = allocPingPong('forms-accum', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING);

  // Live forms contribution only (written by forms shader, read by glaze bake)
  liveTex = allocTexture('forms-live', 'rgba16float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  textureBG = device.createBindGroup({
    label: 'forms-tex-bg',
    layout: textureLayout,
    entries: [
      { binding: 0, resource: depthTex.createView() },
      { binding: 1, resource: allocTexture('dissolution', 'r32float', width, height,
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST).createView() },
      { binding: 2, resource: densityPP.createView() },
      { binding: 3, resource: formsTex.createView() },
      { binding: 4, resource: bakedPP.readView },
      { binding: 5, resource: accumPP.readView },
      { binding: 6, resource: liveTex.createView() },
    ],
  });

  // Resize invalidates baked content — full rebake needed
  bakedFormCount = 0;
  pendingFullRebake = true;
}

export function writeFormsData(
  forms: FormDef[],
  palette: { r: number; g: number; b: number }[],
  sunAngle = 0.8,
  tonalMap: TonalMapParams = { enabled: true, valueRange: 0.8, keyValue: 0.5, contrast: 0.6 },
  velvet = 0.6,
  tonalSort = true,
  baseOpacity = 0.5,
  falloff = 0.7,
  sunElevation = 0.15,
  horizonY = 0.5,
) {
  const { device } = getGPU();

  // Sort baked and live partitions independently for tonal sort
  const lumOf = (f: FormDef) => {
    const c = palette[Math.min(f.colorIndex, palette.length - 1)] ?? { r: 0.5, g: 0.5, b: 0.5 };
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  };
  const cmpLum = (a: FormDef, b: FormDef) => lumOf(a) - lumOf(b);

  let toRender: FormDef[];
  if (tonalSort) {
    const baked = forms.slice(0, bakedFormCount).sort(cmpLum);
    const live = forms.slice(bakedFormCount).sort(cmpLum);
    toRender = baked.concat(live);
  } else {
    toRender = forms;
  }

  const count = Math.min(toRender.length, MAX_FORMS);
  currentTotalFormCount = count;
  // edge_atmosphere: golden hour (low elev) = soft, midday (high elev) = crisp
  const edgeAtmo = 1.5 - Math.min(sunElevation, 1.0) * 0.8;
  const headerData = new ArrayBuffer(64);
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
  headerF32[8] = baseOpacity;
  headerF32[9] = 0.0; // pad (was gravity)
  // Always evaluate ALL forms when live strokes exist — ensures proper
  // inter-stroke blending instead of independent edge boundaries
  const hasLiveForms = count > bakedFormCount;
  headerU32[10] = (pendingFullRebake || dissolutionActive || hasLiveForms) ? 0 : bakedFormCount;
  headerF32[11] = falloff;
  headerF32[12] = edgeAtmo;
  headerF32[13] = horizonY;
  // 14, 15 = padding (already 0)
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
    data[off + 6] = f.softness;
    data[off + 7] = f.depth;
    data[off + 8] = color.r;
    data[off + 9] = color.g;
    data[off + 10] = color.b;
    data[off + 11] = f.opacity;
    data[off + 12] = f.strokeDirX ?? 0;
    data[off + 13] = f.strokeDirY ?? 0;
    // edge_seed: unique per-form hash based on position
    data[off + 14] = ((f.x * 127.1 + f.y * 311.7) % 1.0 + 1.0) % 1.0;
    data[off + 15] = f.taper ?? 0;
  }
  device.queue.writeBuffer(formStorageBuffer, 0, data);
}

function rebuildFormsTextureBG() {
  const { device } = getGPU();
  const formsTex = allocTexture('forms', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);
  const depthTex = allocTexture('depth', 'r32float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
  const densityPP = allocTexture('forms-density-ref', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT);

  textureBG = device.createBindGroup({
    label: 'forms-tex-bg',
    layout: textureLayout,
    entries: [
      { binding: 0, resource: depthTex.createView() },
      { binding: 1, resource: allocTexture('dissolution', 'r32float', currentWidth, currentHeight,
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST).createView() },
      { binding: 2, resource: densityPP.createView() },
      { binding: 3, resource: formsTex.createView() },
      { binding: 4, resource: bakedPP.readView },
      { binding: 5, resource: accumPP.readView },
      { binding: 6, resource: liveTex.createView() },
    ],
  });
}

function bakeCurrentForms(encoder: GPUCommandEncoder, isClear: boolean) {
  const { device } = getGPU();

  // 1. Write glaze params (is_clear flag)
  device.queue.writeBuffer(glazeParamBuffer, 0, new Uint32Array([isClear ? 1 : 0, 0, 0, 0]));

  // 2. Rebuild glaze texture bind group (live_tex read, accum.read, accum.write)
  const glazeTexBG = device.createBindGroup({
    layout: glazeTexLayout,
    entries: [
      { binding: 0, resource: liveTex.createView() },
      { binding: 1, resource: accumPP.readView },
      { binding: 2, resource: accumPP.writeView },
    ],
  });

  // 3. Dispatch glaze compute — merges live contribution into accumulation weight
  const pass = encoder.beginComputePass({ label: 'glaze-bake' });
  pass.setPipeline(glazePipeline);
  pass.setBindGroup(0, glazeParamBG);
  pass.setBindGroup(1, glazeTexBG);
  pass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  pass.end();
  accumPP.swap();

  // 4. Copy forms output → baked (visual seeding for next frame)
  const formsTex = allocTexture('forms', 'rgba16float', currentWidth, currentHeight,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);

  encoder.copyTextureToTexture(
    { texture: formsTex },
    { texture: bakedPP.write },
    { width: currentWidth, height: currentHeight },
  );
  bakedPP.swap();

  // 5. Rebuild bind groups to pick up swapped views
  rebuildFormsTextureBG();
  bakedFormCount = currentTotalFormCount;
}

export function requestBake() {
  pendingBake = true;
}

export function requestFullRebake() {
  pendingFullRebake = true;
}

export function setDissolutionActive(active: boolean) {
  dissolutionActive = active;
}

export function getBakedFormCount() {
  return bakedFormCount;
}

export function handlePendingBakes(encoder: GPUCommandEncoder) {
  if (pendingFullRebake) {
    bakeCurrentForms(encoder, true);
    pendingFullRebake = false;
    pendingBake = false;
  } else if (pendingBake) {
    bakeCurrentForms(encoder, true);
    pendingBake = false;
  }
}

export function dispatchForms(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
  // When no live forms and no pending rebake, copy baked→output instead of dispatching compute
  const liveCount = currentTotalFormCount - bakedFormCount;
  if (liveCount === 0 && !pendingFullRebake && !pendingBake && !dissolutionActive && bakedFormCount > 0) {
    const formsTex = allocTexture('forms', 'rgba16float', currentWidth, currentHeight,
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);
    encoder.copyTextureToTexture(
      { texture: bakedPP.read },
      { texture: formsTex },
      { width: currentWidth, height: currentHeight },
    );
    return;
  }

  const pass = encoder.beginComputePass({ label: 'forms-compute-pass' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, globalBG);
  pass.setBindGroup(1, paramBG);
  pass.setBindGroup(2, textureBG);
  pass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  pass.end();
}
