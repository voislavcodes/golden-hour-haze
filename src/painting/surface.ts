// Accumulation texture management — the painting surface
// rgba16float: R=K_r, G=K_g, B=K_b, A=paint_weight

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
  surfaceWidth = width;
  surfaceHeight = height;
  accumPP = allocPingPong('accum', 'rgba16float', width, height,
    GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST);
}
