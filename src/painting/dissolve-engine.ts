// Dissolve engine — subtract paint from the accumulation surface

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, swapAccum, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore } from '../state/ui-state.js';
import dissolveShader from '../shaders/brush/dissolve.wgsl';

type Vec2 = [number, number];

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;

let lastPos: Vec2 | null = null;

export function initDissolveEngine() {
  const { device } = getGPU();

  paramLayout = device.createBindGroupLayout({
    label: 'dissolve-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  textureLayout = device.createBindGroupLayout({
    label: 'dissolve-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  pipeline = createComputePipeline('dissolve', device, {
    label: 'dissolve-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'dissolve-shader', code: dissolveShader }),
      entryPoint: 'main',
    },
  });

  // DissolveParams: center(2f) + radius(f) + softness(f) + dissolve_strength(f) + pad(3f) = 32 bytes
  paramBuffer = device.createBuffer({
    label: 'dissolve-params',
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

function interpolateStroke(prev: Vec2, curr: Vec2, radius: number): Vec2[] {
  const dx = curr[0] - prev[0];
  const dy = curr[1] - prev[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = radius * 0.25;
  const count = Math.max(1, Math.ceil(dist / step));
  const points: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push([prev[0] + dx * t, prev[1] + dy * t]);
  }
  return points;
}

export function beginDissolve(x: number, y: number) {
  lastPos = [x, y];
}

export function endDissolve() {
  lastPos = null;
}

export function dispatchDissolveDabs(encoder: GPUCommandEncoder, x: number, y: number) {
  const { device } = getGPU();
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;

  const curr: Vec2 = [x, y];
  const points = lastPos ? interpolateStroke(lastPos, curr, radius) : [curr];
  lastPos = curr;

  const softness = scene.velvet * radius;
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  for (const pt of points) {
    const data = new Float32Array([
      pt[0], pt[1],       // center
      radius,              // radius
      softness,            // softness
      ui.dissolveStrength, // dissolve_strength
      0, 0, 0,             // padding
    ]);
    device.queue.writeBuffer(paramBuffer, 0, data);

    const accumPP = getAccumPP();

    const paramBG = device.createBindGroup({
      layout: paramLayout,
      entries: [{ binding: 0, resource: { buffer: paramBuffer } }],
    });

    const texBG = device.createBindGroup({
      layout: textureLayout,
      entries: [
        { binding: 0, resource: accumPP.readView },
        { binding: 1, resource: accumPP.writeView },
      ],
    });

    const pass = encoder.beginComputePass({ label: 'dissolve-dab' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, paramBG);
    pass.setBindGroup(1, texBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    swapAccum();
  }
}
