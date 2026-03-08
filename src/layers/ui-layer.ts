import { getGPU } from '../gpu/context.js';
import { createRenderPipeline } from '../gpu/pipeline-manager.js';
import { getGlobalBindGroupLayout } from '../gpu/bind-groups.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';
import orbShader from '../shaders/ui/orb.wgsl';
import dialShader from '../shaders/ui/dial.wgsl';

// Uniform buffer sizes (must be multiples of 16 for alignment)
const ORB_UNIFORM_SIZE = 32; // vec4f rect + f32 density + f32 warmth + 2x pad
const DIAL_UNIFORM_SIZE = 32; // vec4f rect + f32 sun_angle + f32 sun_elevation + 2x pad

let orbPipeline: GPURenderPipeline;
let dialPipeline: GPURenderPipeline;

let orbUniformBuffer: GPUBuffer;
let dialUniformBuffer: GPUBuffer;

let orbBindGroupLayout: GPUBindGroupLayout;
let dialBindGroupLayout: GPUBindGroupLayout;

let orbBindGroup: GPUBindGroup;
let dialBindGroup: GPUBindGroup;

// UI element placement (pixels from bottom-right)
const ORB_SIZE = 80;
const DIAL_SIZE = 80;
const MARGIN = 16;
const GAP = 12;

export function initUILayer(): void {
  const { device, format } = getGPU();
  const globalLayout = getGlobalBindGroupLayout(device);

  // --- Orb pipeline ---
  orbBindGroupLayout = device.createBindGroupLayout({
    label: 'orb-uniform-layout',
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    }],
  });

  orbUniformBuffer = device.createBuffer({
    label: 'orb-uniforms',
    size: ORB_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  orbBindGroup = device.createBindGroup({
    label: 'orb-bind-group',
    layout: orbBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: orbUniformBuffer } }],
  });

  const orbModule = device.createShaderModule({ label: 'orb-shader', code: orbShader });
  orbPipeline = createRenderPipeline('ui-orb', device, {
    label: 'orb-render',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [globalLayout, orbBindGroupLayout],
    }),
    vertex: { module: orbModule, entryPoint: 'vs_main' },
    fragment: {
      module: orbModule,
      entryPoint: 'fs_main',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });

  // --- Dial pipeline ---
  dialBindGroupLayout = device.createBindGroupLayout({
    label: 'dial-uniform-layout',
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    }],
  });

  dialUniformBuffer = device.createBuffer({
    label: 'dial-uniforms',
    size: DIAL_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  dialBindGroup = device.createBindGroup({
    label: 'dial-bind-group',
    layout: dialBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: dialUniformBuffer } }],
  });

  const dialModule = device.createShaderModule({ label: 'dial-shader', code: dialShader });
  dialPipeline = createRenderPipeline('ui-dial', device, {
    label: 'dial-render',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [globalLayout, dialBindGroupLayout],
    }),
    vertex: { module: dialModule, entryPoint: 'vs_main' },
    fragment: {
      module: dialModule,
      entryPoint: 'fs_main',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });
}

function writeOrbUniforms(width: number, height: number): void {
  const { device } = getGPU();
  const scene = sceneStore.get();

  // Position: bottom-right corner
  const x = width - MARGIN - DIAL_SIZE - GAP - ORB_SIZE;
  const y = height - MARGIN - ORB_SIZE;

  const data = new Float32Array([
    x, y, ORB_SIZE, ORB_SIZE,        // rect
    scene.atmosphere.density,          // density
    scene.atmosphere.warmth,           // warmth
    0, 0,                              // padding
  ]);
  device.queue.writeBuffer(orbUniformBuffer, 0, data);
}

function writeDialUniforms(width: number, height: number): void {
  const { device } = getGPU();
  const scene = sceneStore.get();

  // Position: bottom-right corner, right of orb
  const x = width - MARGIN - DIAL_SIZE;
  const y = height - MARGIN - DIAL_SIZE;

  const data = new Float32Array([
    x, y, DIAL_SIZE, DIAL_SIZE,  // rect
    scene.sunAngle,               // sun_angle
    scene.sunElevation,           // sun_elevation
    0, 0,                         // padding
  ]);
  device.queue.writeBuffer(dialUniformBuffer, 0, data);
}

/**
 * Render UI overlay elements. Call after the compositor pass.
 * Uses load op 'load' to preserve the composited scene underneath.
 */
export function renderUI(
  encoder: GPUCommandEncoder,
  targetView: GPUTextureView,
  globalBG: GPUBindGroup,
): void {
  const ui = uiStore.get();
  if (!ui.showUI) return;

  const { width, height } = getGPU();

  writeOrbUniforms(width, height);
  writeDialUniforms(width, height);

  const pass = encoder.beginRenderPass({
    label: 'ui-overlay-pass',
    colorAttachments: [{
      view: targetView,
      loadOp: 'load',
      storeOp: 'store',
    }],
  });

  // Draw orb
  pass.setPipeline(orbPipeline);
  pass.setBindGroup(0, globalBG);
  pass.setBindGroup(1, orbBindGroup);
  pass.draw(3);

  // Draw dial
  pass.setPipeline(dialPipeline);
  pass.setBindGroup(0, globalBG);
  pass.setBindGroup(1, dialBindGroup);
  pass.draw(3);

  pass.end();
}
