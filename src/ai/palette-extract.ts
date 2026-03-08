export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Extract a dominant color palette from image data using k-means clustering.
 *
 * @param imageData - Source ImageData (RGBA uint8)
 * @param k - Number of palette colors to extract (default 5)
 * @param maxIterations - Maximum k-means iterations (default 20)
 * @returns Array of dominant colors, sorted by frequency
 */
export function extractPalette(
  imageData: ImageData,
  k = 5,
  maxIterations = 20,
): RGBA[] {
  const { data, width, height } = imageData;
  const pixelCount = width * height;

  // Sample pixels to keep performance reasonable for large images
  const maxSamples = 10000;
  const step = Math.max(1, Math.floor(pixelCount / maxSamples));
  const samples: [number, number, number][] = [];

  for (let i = 0; i < pixelCount; i += step) {
    const offset = i * 4;
    const a = data[offset + 3];
    // Skip fully transparent pixels
    if (a < 10) continue;
    samples.push([data[offset], data[offset + 1], data[offset + 2]]);
  }

  if (samples.length === 0) {
    return [{ r: 0, g: 0, b: 0, a: 1 }];
  }

  // Initialize centroids by sampling evenly spaced pixels
  const centroids: [number, number, number][] = [];
  const spacing = Math.max(1, Math.floor(samples.length / k));
  for (let i = 0; i < k; i++) {
    const idx = Math.min(i * spacing, samples.length - 1);
    centroids.push([...samples[idx]]);
  }

  // Assignment storage
  const assignments = new Uint32Array(samples.length);
  const counts = new Uint32Array(k);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;

    // Assign each sample to nearest centroid
    for (let i = 0; i < samples.length; i++) {
      const [sr, sg, sb] = samples[i];
      let bestDist = Infinity;
      let bestIdx = 0;

      for (let c = 0; c < centroids.length; c++) {
        const dr = sr - centroids[c][0];
        const dg = sg - centroids[c][1];
        const db = sb - centroids[c][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = c;
        }
      }

      if (assignments[i] !== bestIdx) {
        assignments[i] = bestIdx;
        changed = true;
      }
    }

    if (!changed) break;

    // Recompute centroids
    const sums = new Float64Array(k * 3);
    counts.fill(0);

    for (let i = 0; i < samples.length; i++) {
      const c = assignments[i];
      const base = c * 3;
      sums[base] += samples[i][0];
      sums[base + 1] += samples[i][1];
      sums[base + 2] += samples[i][2];
      counts[c]++;
    }

    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      const base = c * 3;
      centroids[c][0] = sums[base] / counts[c];
      centroids[c][1] = sums[base + 1] / counts[c];
      centroids[c][2] = sums[base + 2] / counts[c];
    }
  }

  // Sort by frequency (descending)
  const indexed = centroids.map((c, i) => ({ c, count: counts[i] }));
  indexed.sort((a, b) => b.count - a.count);

  return indexed.map(({ c }) => ({
    r: c[0] / 255,
    g: c[1] / 255,
    b: c[2] / 255,
    a: 1,
  }));
}
