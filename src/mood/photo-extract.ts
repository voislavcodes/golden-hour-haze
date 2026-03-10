// Photo extraction — extract 5 dominant hues from a dropped image via K-means
// Runs synchronously on a downsampled canvas (no Web Worker needed for small images)

/** Extract 5 OKLCH hue angles from an image file */
export async function extractHuesFromImage(file: File): Promise<number[]> {
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

  // Collect pixel colors as [r, g, b] in 0-1 range, skip near-black/white
  const samples: [number, number, number][] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum > 0.05 && lum < 0.95) {
      samples.push([r, g, b]);
    }
  }

  if (samples.length < 5) {
    return [0, 72, 144, 216, 288]; // fallback evenly-spaced hues
  }

  // K-means clustering with 5 centers
  const k = 5;
  const centers = kMeans(samples, k, 20);

  // Convert cluster centers to OKLCH hues
  return centers.map(c => rgbToOklchHue(c[0], c[1], c[2]));
}

function kMeans(points: [number, number, number][], k: number, iterations: number): [number, number, number][] {
  // Initialize centers with k-means++ seeding
  const centers: [number, number, number][] = [];
  centers.push(points[Math.floor(Math.random() * points.length)]);

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
    let r = Math.random() * total;
    for (let i = 0; i < points.length; i++) {
      r -= dists[i];
      if (r <= 0) {
        centers.push([...points[i]]);
        break;
      }
    }
    if (centers.length <= c) {
      centers.push(points[Math.floor(Math.random() * points.length)]);
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

function rgbToOklchHue(r: number, g: number, b: number): number {
  // sRGB -> linear
  const lr = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  const lg = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  const lb = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

  // Linear sRGB -> Oklab
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bk = 0.0259040371 * l_ - 0.7827717662 * m_ + 0.7568667491 * s_;

  // Oklab -> OKLCH hue
  let h = Math.atan2(bk, a) * 180 / Math.PI;
  if (h < 0) h += 360;
  return h;
}
