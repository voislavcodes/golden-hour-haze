// Accumulation texture management — the painting surface
// rgba16float: R=K_r, G=K_g, B=K_b, A=paint_weight

import { getGPU } from '../gpu/context.js';
import { allocPingPong, type PingPongTexture } from '../gpu/texture-pool.js';

let accumPP: PingPongTexture;
let surfaceWidth = 0;
let surfaceHeight = 0;

export function initSurface(width: number, height: number) {
  surfaceWidth = width;
  surfaceHeight = height;
  accumPP = allocPingPong('accum', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);
}

export function getAccumPP(): PingPongTexture {
  return accumPP;
}

export function getReadTexture(): GPUTexture {
  return accumPP.read;
}

export function getWriteTexture(): GPUTexture {
  return accumPP.write;
}

export function swapAccum() {
  accumPP.swap();
}

export function getSurfaceWidth(): number {
  return surfaceWidth;
}

export function getSurfaceHeight(): number {
  return surfaceHeight;
}

export function resizeSurface(width: number, height: number) {
  if (width === surfaceWidth && height === surfaceHeight) return;

  const { device } = getGPU();
  const oldW = surfaceWidth;
  const oldH = surfaceHeight;
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;

  // Save current painting to a temp texture before allocPingPong destroys old ones
  const tempTex = device.createTexture({
    label: 'accum-resize-temp',
    size: { width: oldW, height: oldH },
    format: 'rgba16float',
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
  const enc1 = device.createCommandEncoder({ label: 'resize-save' });
  enc1.copyTextureToTexture(
    { texture: accumPP.read },
    { texture: tempTex },
    { width: oldW, height: oldH },
  );
  device.queue.submit([enc1.finish()]);

  // Allocate new textures (destroys old ones internally)
  surfaceWidth = width;
  surfaceHeight = height;
  accumPP = allocPingPong('accum', 'rgba16float', width, height, usage);

  // Copy old content back, clamped to the overlapping region
  const copyW = Math.min(oldW, width);
  const copyH = Math.min(oldH, height);
  const enc2 = device.createCommandEncoder({ label: 'resize-restore' });
  enc2.copyTextureToTexture(
    { texture: tempTex },
    { texture: accumPP.read },
    { width: copyW, height: copyH },
  );
  device.queue.submit([enc2.finish()]);

  tempTex.destroy();
}
