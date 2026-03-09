// Canvas snapshot undo/redo system
// Full GPU texture copies — instant swap, no replay

import { getGPU } from '../gpu/context.js';
import { getAccumPP, swapAccum, getSurfaceWidth, getSurfaceHeight } from './surface.js';

interface UndoEntry {
  accumTexture: GPUTexture;
  timestamp: number;
}

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
const MAX_UNDO = 30;

function createSnapshot(): GPUTexture {
  const { device } = getGPU();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  return device.createTexture({
    label: 'undo-snapshot',
    size: { width: w, height: h },
    format: 'rgba16float',
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
}

/** Call before each stroke begins — snapshot current surface */
export function pushSnapshot(encoder: GPUCommandEncoder) {
  const accumPP = getAccumPP();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  const snapshot = createSnapshot();
  encoder.copyTextureToTexture(
    { texture: accumPP.read },
    { texture: snapshot },
    { width: w, height: h }
  );

  undoStack.push({ accumTexture: snapshot, timestamp: Date.now() });

  if (undoStack.length > MAX_UNDO) {
    const oldest = undoStack.shift()!;
    oldest.accumTexture.destroy();
  }

  // New stroke clears redo stack
  for (const entry of redoStack) {
    entry.accumTexture.destroy();
  }
  redoStack.length = 0;
}

/** Undo: restore previous surface snapshot */
export function undo(encoder: GPUCommandEncoder): boolean {
  const entry = undoStack.pop();
  if (!entry) return false;

  const accumPP = getAccumPP();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  // Save current state for redo
  const currentSnapshot = createSnapshot();
  encoder.copyTextureToTexture(
    { texture: accumPP.read },
    { texture: currentSnapshot },
    { width: w, height: h }
  );
  redoStack.push({ accumTexture: currentSnapshot, timestamp: Date.now() });

  // Restore undo snapshot
  encoder.copyTextureToTexture(
    { texture: entry.accumTexture },
    { texture: accumPP.write },
    { width: w, height: h }
  );
  swapAccum();

  entry.accumTexture.destroy();
  return true;
}

/** Redo: restore next surface snapshot */
export function redo(encoder: GPUCommandEncoder): boolean {
  const entry = redoStack.pop();
  if (!entry) return false;

  const accumPP = getAccumPP();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  // Save current state for undo
  const currentSnapshot = createSnapshot();
  encoder.copyTextureToTexture(
    { texture: accumPP.read },
    { texture: currentSnapshot },
    { width: w, height: h }
  );
  undoStack.push({ accumTexture: currentSnapshot, timestamp: Date.now() });

  // Restore redo snapshot
  encoder.copyTextureToTexture(
    { texture: entry.accumTexture },
    { texture: accumPP.write },
    { width: w, height: h }
  );
  swapAccum();

  entry.accumTexture.destroy();
  return true;
}

export function destroyUndoSystem() {
  for (const entry of undoStack) entry.accumTexture.destroy();
  for (const entry of redoStack) entry.accumTexture.destroy();
  undoStack.length = 0;
  redoStack.length = 0;
}
