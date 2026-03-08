export interface TextureSynthParams {
  width: number;
  height: number;
  seed?: number;
  scale?: number;
  octaves?: number;
}

/**
 * Attempt seeded PRNG for deterministic texture output.
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a procedural texture as RGBA float data.
 *
 * Placeholder: produces a multi-octave value noise field.
 * Will be replaced by ONNX-based neural texture synthesis.
 */
export async function generateTexture(params: TextureSynthParams): Promise<Float32Array> {
  const { width, height, seed = 42, scale = 4.0, octaves = 4 } = params;
  const data = new Float32Array(width * height * 4);
  const rand = mulberry32(seed);

  // Pre-generate a small noise grid for interpolation
  const gridSize = 64;
  const grid = new Float32Array(gridSize * gridSize);
  for (let i = 0; i < grid.length; i++) {
    grid[i] = rand();
  }

  function sampleGrid(x: number, y: number): number {
    const gx = ((x % gridSize) + gridSize) % gridSize;
    const gy = ((y % gridSize) + gridSize) % gridSize;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;

    const nx = (ix + 1) % gridSize;
    const ny = (iy + 1) % gridSize;

    const a = grid[iy * gridSize + ix];
    const b = grid[iy * gridSize + nx];
    const c = grid[ny * gridSize + ix];
    const d = grid[ny * gridSize + nx];

    // Smooth interpolation
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  function fbm(px: number, py: number): number {
    let value = 0;
    let amplitude = 0.5;
    let frequency = scale;
    for (let o = 0; o < octaves; o++) {
      value += amplitude * sampleGrid(px * frequency, py * frequency);
      frequency *= 2;
      amplitude *= 0.5;
    }
    return value;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const ny = y / height;
      const v = fbm(nx * gridSize, ny * gridSize);
      const idx = (y * width + x) * 4;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 1.0;
    }
  }

  return data;
}
