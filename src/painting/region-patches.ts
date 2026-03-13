// Region Patch Extraction — extract 16×16 RGB patches for ML classifier input
// Crops region's bounding box from full-res image, bilinear downsamples to 16×16.

import type { Region } from './region-analysis.js';

const PATCH_SIZE = 16;

/** Bilinear sample from ImageData at fractional coordinates */
function bilinearSample(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  fx: number,
  fy: number,
): [number, number, number] {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const dx = fx - x0;
  const dy = fy - y0;

  const w00 = (1 - dx) * (1 - dy);
  const w10 = dx * (1 - dy);
  const w01 = (1 - dx) * dy;
  const w11 = dx * dy;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  return [
    (data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11) / 255,
    (data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11) / 255,
    (data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11) / 255,
  ];
}

/**
 * Extract a 16×16×3 RGB patch from the full-resolution image for the given region.
 * Returns 768 floats in CHW order (3 channels × 16 × 16) for ONNX input.
 * If aspect ratio > 4, crops to square at centroid.
 */
export function extractPatch(
  imageData: ImageData,
  region: Region,
  cols: number,
  rows: number,
): Float32Array {
  const { width, height, data } = imageData;
  const cellW = width / cols;
  const cellH = height / rows;

  // Map region bbox to pixel coordinates
  let px0 = region.boundingBox.x0 * cellW;
  let py0 = region.boundingBox.y0 * cellH;
  let px1 = (region.boundingBox.x1 + 1) * cellW;
  let py1 = (region.boundingBox.y1 + 1) * cellH;

  // If extreme aspect, crop to square at centroid
  const bw = px1 - px0;
  const bh = py1 - py0;
  if (bh > 0 && bw > 0 && (bh / bw > 4 || bw / bh > 4)) {
    const side = Math.min(bw, bh);
    const cx = (px0 + px1) / 2;
    const cy = (py0 + py1) / 2;
    px0 = cx - side / 2;
    py0 = cy - side / 2;
    px1 = cx + side / 2;
    py1 = cy + side / 2;
  }

  // Clamp to image bounds
  px0 = Math.max(0, px0);
  py0 = Math.max(0, py0);
  px1 = Math.min(width, px1);
  py1 = Math.min(height, py1);

  const cropW = px1 - px0;
  const cropH = py1 - py0;

  // CHW format: [R plane 16×16, G plane 16×16, B plane 16×16]
  const patch = new Float32Array(3 * PATCH_SIZE * PATCH_SIZE);

  for (let py = 0; py < PATCH_SIZE; py++) {
    for (let px = 0; px < PATCH_SIZE; px++) {
      const srcX = px0 + (px / (PATCH_SIZE - 1)) * (cropW - 1);
      const srcY = py0 + (py / (PATCH_SIZE - 1)) * (cropH - 1);
      const [r, g, b] = bilinearSample(data, width, height, srcX, srcY);

      patch[0 * PATCH_SIZE * PATCH_SIZE + py * PATCH_SIZE + px] = r; // R channel
      patch[1 * PATCH_SIZE * PATCH_SIZE + py * PATCH_SIZE + px] = g; // G channel
      patch[2 * PATCH_SIZE * PATCH_SIZE + py * PATCH_SIZE + px] = b; // B channel
    }
  }

  return patch;
}
