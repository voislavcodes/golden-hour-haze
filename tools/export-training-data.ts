// Export Training Data — generates labeled patches from reference images
// Run: npx tsx tools/export-training-data.ts
//
// Reads images from training-images/ (or test/headless/beckett-reference*.{png,webp})
// For each: analyze tonal structure → extract regions → classify heuristically → extract patches
// Augmentation: horizontal flip × 3 grid resolutions = 6× per image
// Output: tools/training-data/patches.bin + tools/training-data/labels.json

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.resolve(__dirname, 'training-data');
const TRAINING_DIR = path.resolve(PROJECT_ROOT, 'training-images');
const TEST_DIR = path.resolve(PROJECT_ROOT, 'test/headless');

// We need to provide ImageData polyfill for Node
class ImageDataPolyfill {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as any).ImageData = ImageDataPolyfill;
}

// Dynamic imports — these are pure math, no DOM needed
const RESOLUTIONS: [number, number][] = [
  [30, 22],
  [40, 30],
  [60, 45],
];

const REGION_CLASSES = ['sky', 'ground', 'horizon', 'mass', 'vertical', 'accent', 'reflection', 'fill'] as const;

interface LabelEntry {
  imageFile: string;
  regionId: number;
  classification: string;
  confidence: number;
  resolution: string;
  flipped: boolean;
  features: number[];
}

async function loadImage(filePath: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  // Use sharp or canvas for image loading — try dynamic import
  try {
    const sharp = await import('sharp');
    const img = sharp.default(filePath);
    const meta = await img.metadata();
    const raw = await img.removeAlpha().ensureAlpha().raw().toBuffer();
    return {
      data: new Uint8ClampedArray(raw),
      width: meta.width!,
      height: meta.height!,
    };
  } catch {
    // Fallback: try canvas
    try {
      const { createCanvas, loadImage: loadImg } = await import('canvas');
      const image = await loadImg(filePath);
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, image.width, image.height);
      return {
        data: new Uint8ClampedArray(imageData.data),
        width: image.width,
        height: image.height,
      };
    } catch {
      throw new Error(
        `Cannot load image: ${filePath}\n` +
        `Install either 'sharp' or 'canvas' package:\n` +
        `  npm install -D sharp\n` +
        `  # or\n` +
        `  npm install -D canvas`
      );
    }
  }
}

function downsampleImageCPU(
  data: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): ImageDataPolyfill {
  const result = new Uint8ClampedArray(dstW * dstH * 4);
  const cellW = srcW / dstW;
  const cellH = srcH / dstH;

  for (let row = 0; row < dstH; row++) {
    for (let col = 0; col < dstW; col++) {
      const x0 = Math.floor(col * cellW);
      const y0 = Math.floor(row * cellH);
      const x1 = Math.floor((col + 1) * cellW);
      const y1 = Math.floor((row + 1) * cellH);

      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * srcW + px) * 4;
          rSum += data[i];
          gSum += data[i + 1];
          bSum += data[i + 2];
          count++;
        }
      }
      const di = (row * dstW + col) * 4;
      result[di] = Math.round(rSum / count);
      result[di + 1] = Math.round(gSum / count);
      result[di + 2] = Math.round(bSum / count);
      result[di + 3] = 255;
    }
  }
  return new ImageDataPolyfill(result, dstW, dstH);
}

function flipHorizontal(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcI = (y * width + x) * 4;
      const dstI = (y * width + (width - 1 - x)) * 4;
      result[dstI] = data[srcI];
      result[dstI + 1] = data[srcI + 1];
      result[dstI + 2] = data[srcI + 2];
      result[dstI + 3] = data[srcI + 3];
    }
  }
  return result;
}

// Extract 16×16 patch from source image at region bbox
function extractPatchCPU(
  data: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  cols: number,
  rows: number,
): Float32Array {
  const PATCH_SIZE = 16;
  const cellW = srcW / cols;
  const cellH = srcH / rows;

  let px0 = bbox.x0 * cellW;
  let py0 = bbox.y0 * cellH;
  let px1 = (bbox.x1 + 1) * cellW;
  let py1 = (bbox.y1 + 1) * cellH;

  // Aspect crop
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

  px0 = Math.max(0, px0);
  py0 = Math.max(0, py0);
  px1 = Math.min(srcW, px1);
  py1 = Math.min(srcH, py1);

  const cropW = px1 - px0;
  const cropH = py1 - py0;
  const patch = new Float32Array(3 * PATCH_SIZE * PATCH_SIZE);

  for (let py = 0; py < PATCH_SIZE; py++) {
    for (let px = 0; px < PATCH_SIZE; px++) {
      const srcX = Math.min(Math.floor(px0 + (px / (PATCH_SIZE - 1)) * (cropW - 1)), srcW - 1);
      const srcY = Math.min(Math.floor(py0 + (py / (PATCH_SIZE - 1)) * (cropH - 1)), srcH - 1);
      const i = (srcY * srcW + srcX) * 4;

      patch[0 * PATCH_SIZE * PATCH_SIZE + py * PATCH_SIZE + px] = data[i] / 255;
      patch[1 * PATCH_SIZE * PATCH_SIZE + py * PATCH_SIZE + px] = data[i + 1] / 255;
      patch[2 * PATCH_SIZE * PATCH_SIZE + py * PATCH_SIZE + px] = data[i + 2] / 255;
    }
  }
  return patch;
}

async function main() {
  console.log('=== Training Data Export ===\n');

  // Import pure-math modules
  // We need to handle the rgbToOklab import from the source
  const oklchPath = path.resolve(PROJECT_ROOT, 'src/mood/oklch.ts');
  if (!fs.existsSync(oklchPath)) {
    console.error('Cannot find oklch.ts — run from project root');
    process.exit(1);
  }

  // Since these are TS files with imports, we rely on tsx to resolve them
  const { rgbToOklab } = await import('../src/mood/oklch.js');

  // Find reference images
  const imageFiles: string[] = [];

  // Check training-images/ first
  if (fs.existsSync(TRAINING_DIR)) {
    const files = fs.readdirSync(TRAINING_DIR);
    for (const f of files) {
      if (/\.(png|jpg|jpeg|webp)$/i.test(f)) {
        imageFiles.push(path.join(TRAINING_DIR, f));
      }
    }
  }

  // Also use test/headless beckett references
  if (fs.existsSync(TEST_DIR)) {
    const files = fs.readdirSync(TEST_DIR);
    for (const f of files) {
      if (/^beckett-reference.*\.(png|webp)$/i.test(f)) {
        imageFiles.push(path.join(TEST_DIR, f));
      }
    }
  }

  if (imageFiles.length === 0) {
    console.error('No training images found in training-images/ or test/headless/');
    process.exit(1);
  }

  console.log(`Found ${imageFiles.length} images:`);
  for (const f of imageFiles) console.log(`  ${path.basename(f)}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allPatches: Float32Array[] = [];
  const labels: LabelEntry[] = [];
  const CHROMA_ACCENT_THRESHOLD = 0.06;
  const CHROMA_NEUTRAL_THRESHOLD = 0.02;

  for (const imgFile of imageFiles) {
    console.log(`\nProcessing: ${path.basename(imgFile)}`);
    let imgData: { data: Uint8ClampedArray; width: number; height: number };

    try {
      imgData = await loadImage(imgFile);
    } catch (e: any) {
      console.warn(`  Skipping (load failed): ${e.message}`);
      continue;
    }

    console.log(`  Size: ${imgData.width}×${imgData.height}`);

    // Process at each resolution, with and without flip
    for (const [cols, rows] of RESOLUTIONS) {
      for (const flip of [false, true]) {
        const srcData = flip
          ? flipHorizontal(imgData.data, imgData.width, imgData.height)
          : imgData.data;

        // Downsample to grid
        const gridData = downsampleImageCPU(srcData, imgData.width, imgData.height, cols, rows);

        // Analyze tonal structure inline (pure math — avoid import issues)
        const cells: any[][] = [];
        const allL: number[] = [];
        for (let r = 0; r < rows; r++) {
          const rowCells: any[] = [];
          for (let c = 0; c < cols; c++) {
            const i = (r * cols + c) * 4;
            const rv = gridData.data[i] / 255;
            const gv = gridData.data[i + 1] / 255;
            const bv = gridData.data[i + 2] / 255;
            const [L, a, bk] = rgbToOklab(rv, gv, bv);
            const chroma = Math.sqrt(a * a + bk * bk);
            let hue = Math.atan2(bk, a) * 180 / Math.PI;
            if (hue < 0) hue += 360;
            allL.push(L);
            rowCells.push({
              gridX: c, gridY: r,
              labL: L, chroma, hue,
              assignedHueIndex: 0,
              meldrumIndex: 2, // MID default
            });
          }
          cells.push(rowCells);
        }

        allL.sort((a, b) => a - b);
        const motherTone = allL[Math.floor(allL.length / 2)];

        // Simple quantization: L → 5 meldrum bins
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const L = cells[r][c].labL;
            if (L > 0.85) cells[r][c].meldrumIndex = 0; // WHITE
            else if (L > 0.65) cells[r][c].meldrumIndex = 1; // LIGHT
            else if (L > 0.45) cells[r][c].meldrumIndex = 2; // MID
            else if (L > 0.25) cells[r][c].meldrumIndex = 3; // DARK
            else cells[r][c].meldrumIndex = 4; // BLACK
          }
        }

        // BFS flood fill for regions
        const visited = new Uint8Array(rows * cols);
        const regions: any[] = [];

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (visited[r * cols + c]) continue;
            const mIdx = cells[r][c].meldrumIndex;
            const regionCells: { gridX: number; gridY: number }[] = [];
            const queue: [number, number][] = [[r, c]];
            visited[r * cols + c] = 1;

            while (queue.length > 0) {
              const [qr, qc] = queue.pop()!;
              regionCells.push({ gridX: qc, gridY: qr });
              for (const [nr, nc] of [[qr - 1, qc], [qr + 1, qc], [qr, qc - 1], [qr, qc + 1]] as [number, number][]) {
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                if (visited[nr * cols + nc]) continue;
                if (cells[nr][nc].meldrumIndex !== mIdx) continue;
                visited[nr * cols + nc] = 1;
                queue.push([nr, nc]);
              }
            }

            if (regionCells.length < 3) continue; // skip tiny

            // Compute region stats
            let x0 = cols, y0_r = rows, x1 = 0, y1 = 0;
            let sumX = 0, sumY = 0, maxChroma = 0;
            for (const { gridX, gridY } of regionCells) {
              if (gridX < x0) x0 = gridX;
              if (gridX > x1) x1 = gridX;
              if (gridY < y0_r) y0_r = gridY;
              if (gridY > y1) y1 = gridY;
              sumX += gridX;
              sumY += gridY;
              if (cells[gridY][gridX].chroma > maxChroma) {
                maxChroma = cells[gridY][gridX].chroma;
              }
            }

            const bboxW = x1 - x0 + 1;
            const bboxH = y1 - y0_r + 1;

            regions.push({
              id: regions.length,
              cells: regionCells,
              meldrumIndex: mIdx,
              maxChroma,
              boundingBox: { x0, y0: y0_r, x1, y1 },
              areaFraction: regionCells.length / (cols * rows),
              aspectRatio: bboxW > 0 ? bboxH / bboxW : 1,
              centroid: {
                x: (sumX / regionCells.length) / cols,
                y: (sumY / regionCells.length) / rows,
              },
            });
          }
        }

        // Detect horizon
        const rowAvgL: number[] = [];
        for (let r = 0; r < rows; r++) {
          let sum = 0;
          for (let c = 0; c < cols; c++) sum += cells[r][c].labL;
          rowAvgL.push(sum / cols);
        }
        const startRow = Math.floor(rows * 0.2);
        const endRow = Math.floor(rows * 0.6);
        let maxDrop = 0, horizonRow = Math.floor(rows * 0.4);
        for (let r = startRow; r < endRow; r++) {
          const drop = rowAvgL[r] - rowAvgL[r + 1];
          if (drop > maxDrop) { maxDrop = drop; horizonRow = r; }
        }
        if (maxDrop < 0.03) horizonRow = Math.floor(rows * 0.4);

        const normalizedHorizon = horizonRow / rows;

        // Classify each region (heuristic — matches region-classify-heuristic.ts)
        for (const region of regions) {
          const f = region;
          const bboxW = f.boundingBox.x1 - f.boundingBox.x0 + 1;
          const bboxH = f.boundingBox.y1 - f.boundingBox.y0 + 1;
          const bboxTop = f.boundingBox.y0 / rows;
          const bboxBot = f.boundingBox.y1 / rows;
          let cls = 'fill', conf = 0.4;

          // 1. Vertical: tall + dark (before accent so poles aren't misclassified)
          if (f.aspectRatio >= 2.0 && f.meldrumIndex >= 3) { cls = 'vertical'; conf = 0.85; }
          // 2. Accent: high chroma AND small area only
          else if (f.maxChroma > 0.08 && f.areaFraction < 0.03) { cls = 'accent'; conf = 0.90; }
          // 3. Sky: above horizon, any tone
          else if (f.centroid.y < normalizedHorizon && f.areaFraction > 0.01 && bboxBot < normalizedHorizon + 0.15) { cls = 'sky'; conf = 0.85; }
          // 4. Horizon: straddles horizon, wide
          else if (bboxTop <= normalizedHorizon && bboxBot >= normalizedHorizon && bboxW > 2 * bboxH) { cls = 'horizon'; conf = 0.70; }
          // 5. Mass: dark, compact, not huge
          else if (f.meldrumIndex >= 3 && f.aspectRatio < 2.5 && f.areaFraction < 0.15) { cls = 'mass'; conf = 0.75; }
          // 6. Reflection: lower half, tallish, mid-dark
          else if (f.centroid.y > 0.55 && f.aspectRatio > 1.3 && f.meldrumIndex >= 2) { cls = 'reflection'; conf = 0.60; }
          // 7. Ground: below horizon
          else if (f.centroid.y > normalizedHorizon + 0.05 && f.areaFraction > 0.01) { cls = 'ground'; conf = 0.80; }
          // 8. Position fallback
          else if (f.centroid.y < normalizedHorizon) { cls = 'sky'; conf = 0.50; }
          else if (f.centroid.y > normalizedHorizon) { cls = 'ground'; conf = 0.50; }

          region.classification = cls;
          region.confidence = conf;

          // Extract patch
          const patch = extractPatchCPU(
            srcData, imgData.width, imgData.height,
            region.boundingBox, cols, rows,
          );

          allPatches.push(patch);
          labels.push({
            imageFile: path.basename(imgFile),
            regionId: region.id,
            classification: cls,
            confidence: conf,
            resolution: `${cols}x${rows}`,
            flipped: flip,
            features: [
              region.centroid.x,
              region.centroid.y,
              region.aspectRatio,
              region.areaFraction,
              region.meldrumIndex / 4,
              region.maxChroma,
            ],
          });
        }

        console.log(`  ${cols}×${rows} ${flip ? 'flipped' : 'normal'}: ${regions.length} regions`);
      }
    }
  }

  // Write patches as flat binary
  const PATCH_SIZE = 16;
  const FLOATS_PER_PATCH = 3 * PATCH_SIZE * PATCH_SIZE;
  const patchBuffer = new Float32Array(allPatches.length * FLOATS_PER_PATCH);
  for (let i = 0; i < allPatches.length; i++) {
    patchBuffer.set(allPatches[i], i * FLOATS_PER_PATCH);
  }

  const patchPath = path.join(OUTPUT_DIR, 'patches.bin');
  fs.writeFileSync(patchPath, Buffer.from(patchBuffer.buffer));

  const labelsPath = path.join(OUTPUT_DIR, 'labels.json');
  fs.writeFileSync(labelsPath, JSON.stringify({
    count: labels.length,
    patchSize: PATCH_SIZE,
    channels: 3,
    classes: [...REGION_CLASSES],
    entries: labels,
  }, null, 2));

  // Summary
  const classCounts: Record<string, number> = {};
  for (const l of labels) {
    classCounts[l.classification] = (classCounts[l.classification] || 0) + 1;
  }

  console.log(`\n=== Export Complete ===`);
  console.log(`Total samples: ${labels.length}`);
  console.log(`Patch file: ${patchPath} (${(patchBuffer.byteLength / 1024).toFixed(0)} KB)`);
  console.log(`Labels file: ${labelsPath}`);
  console.log('Class distribution:', classCounts);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
