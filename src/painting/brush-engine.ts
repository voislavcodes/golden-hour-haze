// Brush engine — stroke interpolation + compute shader dispatch
// Writes K-M pigment into the accumulation surface

import { getGPU } from '../gpu/context.js';
import { createComputePipeline } from '../gpu/pipeline-cache.js';
import { getAccumPP, swapAccum, getSurfaceWidth, getSurfaceHeight } from './surface.js';
import { getActiveKS } from './palette.js';
import { sceneStore } from '../state/scene-state.js';
import { uiStore, pointerQueue } from '../state/ui-state.js';
import brushShader from '../shaders/brush/brush.wgsl';

type Vec2 = [number, number];

let pipeline: GPUComputePipeline;
let paramBuffer: GPUBuffer;
let paramLayout: GPUBindGroupLayout;
let textureLayout: GPUBindGroupLayout;

let lastPos: Vec2 | null = null;

export function initBrushEngine() {
  const { device } = getGPU();

  paramLayout = device.createBindGroupLayout({
    label: 'brush-param-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  textureLayout = device.createBindGroupLayout({
    label: 'brush-tex-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    ],
  });

  pipeline = createComputePipeline('brush', device, {
    label: 'brush-compute',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [paramLayout, textureLayout],
    }),
    compute: {
      module: device.createShaderModule({ label: 'brush-shader', code: brushShader }),
      entryPoint: 'main',
    },
  });

  // BrushParams: center(2f) + radius(f) + softness(f) + palette_K(3f) + pad + palette_S(3f) + pad + base_opacity(f) + falloff(f) + echo(f) + pad = 64 bytes
  paramBuffer = device.createBuffer({
    label: 'brush-params',
    size: 64,
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

export function beginStroke(x: number, y: number) {
  lastPos = [x, y];
}

export function endStroke() {
  lastPos = null;
}

export function dispatchBrushDabs(encoder: GPUCommandEncoder, x: number, y: number) {
  const { device } = getGPU();
  const scene = sceneStore.get();
  const ui = uiStore.get();
  const radius = ui.brushSize;

  // Build waypoints from queued coalesced positions, falling back to current position
  const waypoints: Vec2[] = pointerQueue.length > 0
    ? pointerQueue.splice(0).map(p => [p.x, p.y] as Vec2)
    : [[x, y]];

  // Interpolate through all waypoints for a continuous stroke
  let points: Vec2[] = [];
  for (const wp of waypoints) {
    if (lastPos) {
      points = points.concat(interpolateStroke(lastPos, wp, radius));
    } else {
      points.push(wp);
    }
    lastPos = wp;
  }

  const ks = getActiveKS();
  const softness = scene.velvet * radius;
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  for (const pt of points) {
    // Write brush params
    const data = new Float32Array([
      pt[0], pt[1],    // center
      radius,           // radius
      softness,         // softness
      ks.Kr, ks.Kg, ks.Kb, // palette_K (vec3f — per-channel K-M absorption)
      0,                // pad
      1.0, 1.0, 1.0,   // palette_S (vec3f — always 1.0 in simplified model)
      0,                // pad
      scene.baseOpacity, // base_opacity
      scene.falloff,     // falloff
      scene.echo,        // echo
      0,                // pad
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

    // Dispatch over full texture (bbox optimization would need offset in shader)
    const pass = encoder.beginComputePass({ label: 'brush-dab' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, paramBG);
    pass.setBindGroup(1, texBG);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();

    // Swap after each dab for correctness
    swapAccum();
  }
}
