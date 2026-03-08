import { getGPU } from '../gpu/context.js';
import { allocTexture } from '../gpu/texture-pool.js';
import { createComputePipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import depthShader from '../shaders/depth/depth-field.wgsl';
import type { DepthFieldParams } from './layer-types.js';

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let layerLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;
let paramBindGroup: GPUBindGroup;
let textureBindGroup: GPUBindGroup;
let currentWidth = 0;
let currentHeight = 0;

export function initDepthLayer() {
  const { device } = getGPU();

  layerLayout = device.createBindGroupLayout({
    label: 'depth-params-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  textureLayout = device.createBindGroupLayout({
    label: 'depth-texture-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    label: 'depth-pipeline-layout',
    bindGroupLayouts: [getGlobalBindGroupLayout(device), layerLayout, textureLayout],
  });

  pipeline = createComputePipeline('depth', device, {
    label: 'depth-compute',
    layout: pipelineLayout,
    compute: {
      module: device.createShaderModule({ label: 'depth-shader', code: depthShader }),
      entryPoint: 'main',
    },
  });

  // 32 bytes header + 8 * 16 = 128 bytes control points = 160 bytes
  paramBuffer = device.createBuffer({
    label: 'depth-params',
    size: 160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  paramBindGroup = device.createBindGroup({
    label: 'depth-param-bg',
    layout: layerLayout,
    entries: [{ binding: 0, resource: { buffer: paramBuffer } }],
  });
}

export function updateDepthTexture(width: number, height: number) {
  if (width === currentWidth && height === currentHeight) return;
  currentWidth = width;
  currentHeight = height;

  const tex = allocTexture('depth', 'r32float', width, height,
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);

  const { device } = getGPU();
  textureBindGroup = device.createBindGroup({
    label: 'depth-texture-bg',
    layout: textureLayout,
    entries: [{ binding: 0, resource: tex.createView() }],
  });
}

export function writeDepthParams(params: DepthFieldParams) {
  const { device } = getGPU();
  const data = new Float32Array(40); // 160 / 4
  data[0] = params.nearPlane;
  data[1] = params.farPlane;
  data[2] = params.noiseScale;
  data[3] = params.noiseStrength;
  // control_count as u32
  new Uint32Array(data.buffer)[4] = params.controlCount;
  // padding at 5,6,7
  // control points start at offset 8 (byte 32)
  for (let i = 0; i < Math.min(params.controlCount, 16); i++) {
    data[8 + i * 2] = params.controlPoints[i * 2];
    data[8 + i * 2 + 1] = params.controlPoints[i * 2 + 1];
  }
  device.queue.writeBuffer(paramBuffer, 0, data);
}

export function dispatchDepth(encoder: GPUCommandEncoder, globalBG: GPUBindGroup) {
  const pass = encoder.beginComputePass({ label: 'depth-compute-pass' });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, globalBG);
  pass.setBindGroup(1, paramBindGroup);
  pass.setBindGroup(2, textureBindGroup);
  pass.dispatchWorkgroups(Math.ceil(currentWidth / 8), Math.ceil(currentHeight / 8));
  pass.end();
}
