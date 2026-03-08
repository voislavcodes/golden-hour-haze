import { getGPU } from '../gpu/context.js';
import type { PaletteState } from './layer-types.js';
import { MAX_PALETTE_COLORS } from './layer-types.js';

let paletteBuffer: GPUBuffer;

export function initPaletteLayer() {
  const { device } = getGPU();

  // 8 colors * 4 floats (RGBA) * 4 bytes = 128 bytes + 16 header
  paletteBuffer = device.createBuffer({
    label: 'palette-buffer',
    size: 144,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

export function writePaletteData(palette: PaletteState) {
  const { device } = getGPU();
  const data = new Float32Array(36); // 144 / 4

  // Header: active index, color count, pad, pad
  data[0] = palette.activeIndex;
  data[1] = palette.colors.length;
  data[2] = 0;
  data[3] = 0;

  // Colors
  for (let i = 0; i < Math.min(palette.colors.length, MAX_PALETTE_COLORS); i++) {
    const c = palette.colors[i];
    data[4 + i * 4] = c.r;
    data[4 + i * 4 + 1] = c.g;
    data[4 + i * 4 + 2] = c.b;
    data[4 + i * 4 + 3] = c.a;
  }

  device.queue.writeBuffer(paletteBuffer, 0, data);
}

export function getPaletteBuffer(): GPUBuffer {
  return paletteBuffer;
}
