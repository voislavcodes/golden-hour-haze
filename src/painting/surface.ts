// Accumulation + paint state texture management — the painting surface
// Accum: rgba16float — R=K_r, G=K_g, B=K_b, A=paint_weight
// State: rg32float  — R=session_time_painted, G=thinners_at_paint_time

import { getGPU } from '../gpu/context.js';
import { allocPingPong, destroyPingPong, type PingPongTexture } from '../gpu/texture-pool.js';

const USAGE = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;

let accumPP: PingPongTexture;
let statePP: PingPongTexture;
let surfaceWidth = 0;
let surfaceHeight = 0;

export function initSurface(width: number, height: number) {
  surfaceWidth = width;
  surfaceHeight = height;
  accumPP = allocPingPong('accum', 'rgba16float', width, height, USAGE);
  statePP = allocPingPong('paint-state', 'rg32float', width, height, USAGE);
}

export function getAccumPP(): PingPongTexture {
  return accumPP;
}

export function getStatePP(): PingPongTexture {
  return statePP;
}

export function getReadTexture(): GPUTexture {
  return accumPP.read;
}

export function getStateReadTexture(): GPUTexture {
  return statePP.read;
}

/** Swap BOTH accum and state textures in lockstep */
export function swapSurface() {
  accumPP.swap();
  statePP.swap();
}

export function getSurfaceWidth(): number {
  return surfaceWidth;
}

export function getSurfaceHeight(): number {
  return surfaceHeight;
}

/** Clear both accumulation and paint state textures (wipe canvas clean) */
export function clearSurface() {
  destroyPingPong('accum');
  destroyPingPong('paint-state');
  accumPP = allocPingPong('accum', 'rgba16float', surfaceWidth, surfaceHeight, USAGE);
  statePP = allocPingPong('paint-state', 'rg32float', surfaceWidth, surfaceHeight, USAGE);
}

export function resizeSurface(width: number, height: number) {
  if (width === surfaceWidth && height === surfaceHeight) return;

  const { device } = getGPU();
  const oldW = surfaceWidth;
  const oldH = surfaceHeight;

  // Save current painting to temp textures before allocPingPong destroys old ones
  const tempAccum = device.createTexture({
    label: 'accum-resize-temp',
    size: { width: oldW, height: oldH },
    format: 'rgba16float',
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
  const tempState = device.createTexture({
    label: 'state-resize-temp',
    size: { width: oldW, height: oldH },
    format: 'rg32float',
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
  const enc1 = device.createCommandEncoder({ label: 'resize-save' });
  enc1.copyTextureToTexture(
    { texture: accumPP.read },
    { texture: tempAccum },
    { width: oldW, height: oldH },
  );
  enc1.copyTextureToTexture(
    { texture: statePP.read },
    { texture: tempState },
    { width: oldW, height: oldH },
  );
  device.queue.submit([enc1.finish()]);

  // Allocate new textures (destroys old ones internally)
  surfaceWidth = width;
  surfaceHeight = height;
  accumPP = allocPingPong('accum', 'rgba16float', width, height, USAGE);
  statePP = allocPingPong('paint-state', 'rg32float', width, height, USAGE);

  // Copy old content back, clamped to the overlapping region
  const copyW = Math.min(oldW, width);
  const copyH = Math.min(oldH, height);
  const enc2 = device.createCommandEncoder({ label: 'resize-restore' });
  enc2.copyTextureToTexture(
    { texture: tempAccum },
    { texture: accumPP.read },
    { width: copyW, height: copyH },
  );
  enc2.copyTextureToTexture(
    { texture: tempState },
    { texture: statePP.read },
    { width: copyW, height: copyH },
  );
  device.queue.submit([enc2.finish()]);

  tempAccum.destroy();
  tempState.destroy();
}
