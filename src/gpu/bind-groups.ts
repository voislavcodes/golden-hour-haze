/**
 * 3-tier bind group layout system:
 * Group 0: Global uniforms (resolution, time, mouse, DPR)
 * Group 1: Per-layer params (atmosphere, form buffer, light buffer)
 * Group 2: Texture inputs (variable per pass)
 */

let globalLayout: GPUBindGroupLayout | null = null;

// 64 bytes: vec2f resolution, f32 time, f32 dt, vec2f mouse, f32 dpr, f32 pad
export const GLOBAL_UNIFORM_SIZE = 32;

export function getGlobalBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  if (!globalLayout) {
    globalLayout = device.createBindGroupLayout({
      label: 'global-bind-group-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });
  }
  return globalLayout;
}

export function createGlobalUniformBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({
    label: 'global-uniforms',
    size: GLOBAL_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export function writeGlobalUniforms(
  device: GPUDevice,
  buffer: GPUBuffer,
  width: number,
  height: number,
  time: number,
  dt: number,
  mouseX: number,
  mouseY: number,
  dpr: number
) {
  const data = new Float32Array([width, height, time, dt, mouseX, mouseY, dpr, 0]);
  device.queue.writeBuffer(buffer, 0, data);
}

export function createGlobalBindGroup(
  device: GPUDevice,
  layout: GPUBindGroupLayout,
  buffer: GPUBuffer
): GPUBindGroup {
  return device.createBindGroup({
    label: 'global-bind-group',
    layout,
    entries: [{ binding: 0, resource: { buffer } }],
  });
}
