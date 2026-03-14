// Photo extraction — extract 5 dominant colors from a dropped image via K-means in OKLab space
// Chroma-weighted: vivid colors get oversampled so they always claim a cluster,
// even in nearly-monochrome images (like tonalist paintings).

import { rgbToOklab, oklabToOklch, type OklchColor } from './oklch.js';

export interface ExtractionResult {
  colors: OklchColor[];   // 5 OKLCH cluster centers (sorted by chroma, vivid first)
  medianChroma: number;   // median chroma of sampled pixels (0-0.4)
  chromaScale: number;    // suggested chroma scale for pile generation (0-1)
}

// Seeded PRNG (mulberry32) for deterministic K-means
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Extract 5 OKLCH colors from an image file.
 *  Returns full OKLCH values + chroma info so muted images produce muted palettes. */
export async function extractHuesFromImage(file: File): Promise<OklchColor[]>;
export async function extractHuesFromImage(file: File, detailed: true): Promise<ExtractionResult>;
export async function extractHuesFromImage(file: File, detailed?: boolean): Promise<OklchColor[] | ExtractionResult> {
  const bitmap = await createImageBitmap(file);

  // Downsample to max 64x64 for speed
  const maxDim = 64;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, w, h);
  const pixels = imageData.data;

  // Collect pixel colors as OKLab [L, a, b] with chroma
  const raw: { lab: [number, number, number]; chroma: number }[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum > 0.05 && lum < 0.95) {
      const [L, a, bk] = rgbToOklab(r, g, b);
      const chroma = Math.sqrt(a * a + bk * bk);
      raw.push({ lab: [L, a, bk], chroma });
    }
  }

  const fallbackColors: OklchColor[] = [
    { l: 0.55, c: 0.05, h: 0 },
    { l: 0.55, c: 0.05, h: 72 },
    { l: 0.55, c: 0.05, h: 144 },
    { l: 0.55, c: 0.05, h: 216 },
    { l: 0.55, c: 0.05, h: 288 },
  ];
  if (raw.length < 5) {
    return detailed ? { colors: fallbackColors, medianChroma: 0.05, chromaScale: 0.33 } : fallbackColors;
  }

  // Compute median chroma for the image
  const chromas = raw.map(p => p.chroma).sort((a, b) => a - b);
  const medianChroma = chromas[Math.floor(chromas.length / 2)];
  // Scale: 0.15 chroma = full saturation (1.0), 0.01 = very muted (0.33)
  const chromaScale = Math.min(1, Math.max(0.33, medianChroma / 0.15));

  // Chroma-weighted sampling: oversample chromatic pixels proportional to image saturation.
  // Vivid images (chromaScale=1): 24× weight for chromatic pixels (accents claim clusters).
  // Muted images (chromaScale=0.33): 4× weight — preserves neutral character while still
  // letting any chromatic accent claim a cluster.
  const maxChroma = Math.max(...raw.map(p => p.chroma), 0.01);
  const chromaWeight = 3 + 20 * chromaScale; // 3-23× based on image saturation
  const samples: [number, number, number][] = [];
  for (const p of raw) {
    const weight = 1 + chromaWeight * (p.chroma / maxChroma);
    const copies = Math.round(weight);
    for (let c = 0; c < copies; c++) {
      samples.push(p.lab);
    }
  }

  // Seed PRNG from pixel data for deterministic results
  let seed = w * 7919 + h * 6271;
  for (let i = 0; i < Math.min(pixels.length, 256); i += 4) {
    seed = (seed * 31 + pixels[i]) | 0;
  }
  const rng = mulberry32(seed);

  // K-means clustering with 5 centers in OKLab space
  const centers = kMeans(samples, 5, 30, rng);

  // Convert cluster centers from OKLab to OKLCH, sorted by chroma (most vivid first)
  const colorsWithChroma = centers.map(c => {
    const lch = oklabToOklch(c[0], c[1], c[2]);
    return { lch, chroma: lch.c };
  });
  colorsWithChroma.sort((a, b) => b.chroma - a.chroma);

  // Boost cluster chromas — K-means averaging dampens chroma significantly.
  // Boost scales with image saturation: vivid images get full 3× recovery,
  // muted images (tonalist paintings) get lighter boost to preserve mutedness.
  const chromaBoost = 1.5 + 1.5 * chromaScale; // 1.5× for muted → 3.0× for vivid
  const chromaCap = 0.08 + 0.12 * chromaScale;  // 0.08 for muted → 0.20 for vivid
  for (const cc of colorsWithChroma) {
    cc.lch.c = Math.min(cc.lch.c * chromaBoost, chromaCap);
    cc.chroma = cc.lch.c;
  }

  // Deduplicate: if two hues are within 15° of each other, spread the second one
  const colors = colorsWithChroma.map(c => c.lch);
  const hues = colors.map(c => c.h);
  for (let i = 1; i < hues.length; i++) {
    for (let j = 0; j < i; j++) {
      let diff = Math.abs(hues[i] - hues[j]);
      if (diff > 180) diff = 360 - diff;
      if (diff < 15) {
        // Push this hue away — find the largest gap in the existing hues
        const sorted = [...hues.slice(0, i)].sort((a, b) => a - b);
        sorted.push(sorted[0] + 360); // wrap-around
        let bestGap = 0, bestMid = 0;
        for (let k = 0; k < sorted.length - 1; k++) {
          const gap = sorted[k + 1] - sorted[k];
          if (gap > bestGap) {
            bestGap = gap;
            bestMid = (sorted[k] + gap / 2) % 360;
          }
        }
        hues[i] = bestMid;
        colors[i] = { ...colors[i], h: bestMid };
        break;
      }
    }
  }

  if (detailed) {
    return { colors, medianChroma, chromaScale };
  }
  return colors;
}

function kMeans(
  points: [number, number, number][],
  k: number,
  iterations: number,
  rng: () => number,
): [number, number, number][] {
  // Initialize centers with k-means++ seeding
  const centers: [number, number, number][] = [];
  centers.push(points[Math.floor(rng() * points.length)]);

  for (let c = 1; c < k; c++) {
    const dists = points.map(p => {
      let minD = Infinity;
      for (const center of centers) {
        const d = dist2(p, center);
        if (d < minD) minD = d;
      }
      return minD;
    });
    const total = dists.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (let i = 0; i < points.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centers.push([...points[i]]);
        break;
      }
    }
    if (centers.length <= c) {
      centers.push(points[Math.floor(rng() * points.length)]);
    }
  }

  // Iterate
  for (let iter = 0; iter < iterations; iter++) {
    const clusters: [number, number, number][][] = Array.from({ length: k }, () => []);

    for (const p of points) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(p, centers[c]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      clusters[bestIdx].push(p);
    }

    for (let c = 0; c < k; c++) {
      if (clusters[c].length === 0) continue;
      const sum: [number, number, number] = [0, 0, 0];
      for (const p of clusters[c]) {
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
      }
      const n = clusters[c].length;
      centers[c] = [sum[0] / n, sum[1] / n, sum[2] / n];
    }
  }

  return centers;
}

function dist2(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}
