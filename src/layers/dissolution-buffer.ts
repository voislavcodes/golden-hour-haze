// CPU-side dissolution buffer: stamps circular patches, flushes dirty region to GPU

let buffer: Float32Array | null = null;
let width = 0;
let height = 0;
let dirtyRect: { x0: number; y0: number; x1: number; y1: number } | null = null;

let _dissModified = false;

export function resizeDissolutionBuffer(w: number, h: number) {
  width = w;
  height = h;
  buffer = new Float32Array(w * h);
  dirtyRect = null;
  _dissModified = false;
}

export function stampDissolve(
  normX: number,
  normY: number,
  normRadius: number,
  pressure: number,
  strength: number,
) {
  if (!buffer) return;

  const cx = normX * width;
  const cy = normY * height;
  const r = normRadius * height; // radius in pixels (normalized to height)

  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));

  const rSq = r * r;
  const scale = pressure * strength * 0.15;

  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    const dySq = dy * dy;
    const row = py * width;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const distSq = dx * dx + dySq;
      if (distSq >= rSq) continue;
      const t = 1 - Math.sqrt(distSq) / r; // 0..1
      const influence = t * t; // quadratic falloff
      const idx = row + px;
      buffer[idx] = Math.min(1, buffer[idx] + influence * scale);
    }
  }

  // Expand dirty rect
  if (dirtyRect) {
    dirtyRect.x0 = Math.min(dirtyRect.x0, x0);
    dirtyRect.y0 = Math.min(dirtyRect.y0, y0);
    dirtyRect.x1 = Math.max(dirtyRect.x1, x1);
    dirtyRect.y1 = Math.max(dirtyRect.y1, y1);
  } else {
    dirtyRect = { x0, y0, x1, y1 };
  }

  _dissModified = true;
}

export function flushDissolution(device: GPUDevice, texture: GPUTexture) {
  if (!buffer || !dirtyRect) return;

  const { x0, y0, x1, y1 } = dirtyRect;
  const regionW = x1 - x0 + 1;
  const regionH = y1 - y0 + 1;

  // Extract sub-rect into contiguous buffer
  const sub = new Float32Array(regionW * regionH);
  for (let row = 0; row < regionH; row++) {
    const srcOff = (y0 + row) * width + x0;
    sub.set(buffer.subarray(srcOff, srcOff + regionW), row * regionW);
  }

  device.queue.writeTexture(
    { texture, origin: { x: x0, y: y0 } },
    sub.buffer,
    { bytesPerRow: regionW * 4 },
    { width: regionW, height: regionH },
  );

  dirtyRect = null;
}

export function snapshotDissolution(): Float32Array | null {
  return buffer ? new Float32Array(buffer) : null;
}

export function restoreDissolution(snapshot: Float32Array) {
  if (!buffer || snapshot.length !== buffer.length) return;
  buffer.set(snapshot);
  // Mark entire buffer dirty
  dirtyRect = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
}

export function clearDissolution() {
  if (!buffer) return;
  buffer.fill(0);
  dirtyRect = { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  _dissModified = false;
}

export function isDissolutionModified(): boolean {
  return _dissModified;
}

export function resetDissolutionModified() {
  _dissModified = false;
}
