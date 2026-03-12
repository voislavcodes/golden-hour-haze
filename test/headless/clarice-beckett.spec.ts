// Clarice Beckett recreation — foggy Melbourne street scene
// Precise shapes from reference: umbrella figure, ghost figures, poles, orange tram,
// hedge line, foreground bollards, wet road reflections.
// Uses oil medium for vivid tram accent. Lights first, darks last.
// Run: CHROME=1 npx playwright test test/headless/clarice-beckett.spec.ts

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/clarice-beckett');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function snap(page: any, name: string) {
  await page.evaluate(() => (window as any).__ghz.waitFrames(8));
  await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
  console.log(`  -> ${name}`);
}

async function setTonal(page: any, hue: number, value: number) {
  await page.evaluate((o: any) => {
    (window as any).__ghz.stores.scene.update((s: any) => {
      const tv = [...s.palette.tonalValues];
      tv[o.h] = o.v;
      return { palette: { ...s.palette, tonalValues: tv } };
    });
  }, { h: hue, v: value });
}

async function wipeRag(page: any) {
  await page.evaluate(() => (window as any).__ghz.wipeOnRag());
}

async function armOil(page: any) {
  await page.evaluate(() => (window as any).__ghz.toggleOil());
}

async function paint(page: any, pts: any[], opts: any) {
  await page.evaluate(async (o: any) => {
    await (window as any).__ghz.replayStroke(o.pts, o.opts);
  }, { pts, opts });
}

// --- Stroke shape helpers ---

// Horizontal stroke with subtle wobble
function H(y: number, x0: number, x1: number, p: number, n = 80): any[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x0 + (i / (n - 1)) * (x1 - x0),
    y: y + Math.sin(i * 0.31) * 0.002,
    pressure: p + Math.sin(i * 0.47) * 0.008,
  }));
}

// Vertical stroke with slight sway
function V(x: number, y0: number, y1: number, p: number, n = 35): any[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x + Math.sin(i * 0.37) * 0.001,
    y: y0 + (i / (n - 1)) * (y1 - y0),
    pressure: p + Math.sin(i * 0.53) * 0.008,
  }));
}

// Downward arc for umbrella dome — curves up then down
function umbrellaArc(cx: number, cy: number, rx: number, ry: number, p: number, n = 24): any[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const angle = Math.PI * t;
    return {
      x: cx - rx * Math.cos(angle),
      y: cy - ry * Math.sin(angle),
      pressure: p * (0.85 + 0.15 * Math.sin(Math.PI * t)),
    };
  });
}

// Tapered vertical — pressure fades from pStart to pEnd
function taperV(x: number, y0: number, y1: number, pStart: number, pEnd: number, n = 25): any[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x + Math.sin(i * 0.29) * 0.0008,
    y: y0 + (i / (n - 1)) * (y1 - y0),
    pressure: pStart + (pEnd - pStart) * (i / (n - 1)),
  }));
}

// Short dash mark
function dash(x: number, y: number, len: number, p: number): any[] {
  return [
    { x, y, pressure: p * 0.6 },
    { x, y: y + len * 0.3, pressure: p },
    { x, y: y + len * 0.7, pressure: p },
    { x, y: y + len, pressure: p * 0.4 },
  ];
}

// Fill area with horizontal strokes
async function fill(
  page: any, yStart: number, yEnd: number, x0: number, x1: number,
  opts: any, passes = 1
) {
  const bs = opts.brushSize || 0.10;
  const spacing = bs * 0.18;
  const rows = Math.ceil((yEnd - yStart) / spacing);
  const p = opts.pressure || 0.55;
  const n = Math.max(30, Math.round((x1 - x0) * 160));
  for (let pass = 0; pass < passes; pass++) {
    const off = pass * spacing * 0.4;
    for (let i = 0; i < rows; i++) {
      const y = yStart + i * spacing + off;
      if (y > yEnd) break;
      await paint(page, H(y, x0, x1, p, n), opts);
    }
  }
}

// Foggy Morning hues: 0=warm mist, 1=cool stone, 2=sage, 3=blue haze, 4=sand

test('Clarice Beckett — foggy Melbourne street', async ({ page }) => {
  test.setTimeout(600_000);

  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) { test.skip(); return; }
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });

  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(2); // Foggy Morning
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  });
  await snap(page, '00-blank.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 1: GROUND TONE — warm mist imprimatura, heavier coverage
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L1: Ground tone...');
  await setTonal(page, 0, 0.18);
  await fill(page, 0.0, 0.95, 0.0, 1.0, {
    brushSlot: 4, hueIndex: 0, brushSize: 0.18, thinners: 0.0, load: 0.92, pressure: 0.60,
  }, 4);

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 2: TONAL MAP — sky/road separation + horizon warmth
  // Road noticeably darker than sky. Horizon band visible.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L2: Tonal map...');
  // Road — mid-road zone, warm dark
  await setTonal(page, 4, 0.48);
  await fill(page, 0.48, 0.72, 0.0, 1.0, {
    brushSlot: 4, hueIndex: 4, brushSize: 0.14, thinners: 0.0, load: 0.92, pressure: 0.62,
  }, 4);
  // Foreground road — much darker, Beckett's wet pavement
  await setTonal(page, 1, 0.62);
  await fill(page, 0.68, 0.95, 0.0, 1.0, {
    brushSlot: 4, hueIndex: 1, brushSize: 0.14, thinners: 0.0, load: 0.92, pressure: 0.64,
  }, 5);
  // Very near foreground — darkest
  await setTonal(page, 1, 0.72);
  await fill(page, 0.82, 0.95, 0.0, 1.0, {
    brushSlot: 4, hueIndex: 1, brushSize: 0.14, thinners: 0.0, load: 0.90, pressure: 0.62,
  }, 3);
  // Horizon warm haze band — strong enough to read
  await setTonal(page, 4, 0.40);
  await fill(page, 0.24, 0.42, 0.0, 1.0, {
    brushSlot: 4, hueIndex: 4, brushSize: 0.08, thinners: 0.0, load: 0.80, pressure: 0.54,
  }, 3);
  // Pink warmth across horizon
  await setTonal(page, 0, 0.36);
  await fill(page, 0.24, 0.38, 0.0, 0.55, {
    brushSlot: 4, hueIndex: 0, brushSize: 0.06, thinners: 0.01, load: 0.68, pressure: 0.48,
  }, 2);
  await snap(page, '01-tone.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3: DISTANT TREES — warm blurs above hedge, broader + more visible
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L3: Distant trees...');
  await setTonal(page, 2, 0.48);
  // Tree masses above hedge line — soft shapes in the mist
  for (const [cx, w, yTop, yBot] of [
    [0.10, 0.12, 0.18, 0.34], [0.20, 0.16, 0.14, 0.34], [0.32, 0.10, 0.20, 0.34],
    [0.42, 0.08, 0.22, 0.34], [0.52, 0.12, 0.18, 0.34],
  ] as const) {
    await fill(page, yTop, yBot, cx - w / 2, cx + w / 2, {
      brushSlot: 2, hueIndex: 2, brushSize: 0.035, thinners: 0.02, load: 0.74, pressure: 0.50,
    }, 3);
  }
  // Slightly warmer tops for atmosphere
  await setTonal(page, 0, 0.40);
  for (const [cx, w] of [[0.20, 0.12], [0.10, 0.08], [0.42, 0.06]] as const) {
    await fill(page, 0.14, 0.22, cx - w / 2, cx + w / 2, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.030, thinners: 0.02, load: 0.58, pressure: 0.42,
    }, 2);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4: HEDGE — continuous dark band across full width
  // Beckett reference shows a strong horizontal band at 1/3 from top.
  // Denser left, irregular center, thins to right with gaps at poles.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L4: Hedge...');
  await wipeRag(page);
  await setTonal(page, 2, 0.68);
  // Full-width base — continuous band ensures hedge is always visible
  await fill(page, 0.36, 0.48, 0.0, 0.72, {
    brushSlot: 2, hueIndex: 2, brushSize: 0.032, thinners: 0.0, load: 0.94, pressure: 0.64,
  }, 3);
  // Left section — extra dense, taller
  await setTonal(page, 2, 0.72);
  await fill(page, 0.33, 0.49, 0.0, 0.30, {
    brushSlot: 2, hueIndex: 2, brushSize: 0.028, thinners: 0.0, load: 0.92, pressure: 0.62,
  }, 3);
  // Center build-up — thicken around ghost zone
  await fill(page, 0.37, 0.46, 0.30, 0.58, {
    brushSlot: 2, hueIndex: 2, brushSize: 0.022, thinners: 0.0, load: 0.86, pressure: 0.56,
  }, 3);
  // Right section — thinner, gap at pole positions
  await fill(page, 0.38, 0.45, 0.58, 0.61, {
    brushSlot: 2, hueIndex: 2, brushSize: 0.020, thinners: 0.0, load: 0.80, pressure: 0.52,
  }, 3);
  await fill(page, 0.38, 0.45, 0.64, 0.72, {
    brushSlot: 2, hueIndex: 2, brushSize: 0.020, thinners: 0.0, load: 0.80, pressure: 0.52,
  }, 3);
  // Darker base edge — whole hedge
  await setTonal(page, 2, 0.78);
  await fill(page, 0.45, 0.49, 0.0, 0.58, {
    brushSlot: 2, hueIndex: 2, brushSize: 0.014, thinners: 0.0, load: 0.88, pressure: 0.58,
  }, 3);
  // Top edge softening — lighter touches on upper boundary
  await setTonal(page, 2, 0.52);
  await fill(page, 0.34, 0.38, 0.0, 0.45, {
    brushSlot: 2, hueIndex: 2, brushSize: 0.020, thinners: 0.02, load: 0.62, pressure: 0.42,
  }, 2);
  await snap(page, '02-hedge.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5: GHOST FIGURES — graduated silhouettes in mist
  // Wider brush, more passes, extends above and below hedge.
  // Closest ghost is bold, farthest is a whisper.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L5: Ghosts...');
  await wipeRag(page);
  const ghosts: [number, number, number, number, number, number][] = [
    // [x, yTop, yBot, tonal, passes, brushSize]
    [0.38, 0.34, 0.55, 0.86, 5, 0.020],
    [0.44, 0.36, 0.53, 0.82, 4, 0.018],
    [0.50, 0.37, 0.51, 0.78, 3, 0.016],
    [0.55, 0.38, 0.50, 0.72, 2, 0.014],
    [0.59, 0.39, 0.49, 0.66, 2, 0.012],
  ];
  for (const [gx, gy0, gy1, tv, passes, bs] of ghosts) {
    await setTonal(page, 1, tv);
    // Main body — center + offset strokes for width
    for (let p = 0; p < passes; p++) {
      const off = (p % 3 - 1) * bs * 0.25; // left, center, right wobble
      await paint(page, taperV(gx + off, gy0, gy1, 0.60, 0.36, 18), {
        brushSlot: 1, hueIndex: 1, brushSize: bs, thinners: 0.0, load: 0.94,
      });
    }
    // Shoulders — wider mark near top
    if (passes >= 3) {
      for (let p = 0; p < 2; p++) {
        await paint(page, H(gy0 + 0.04, gx - bs * 0.8, gx + bs * 0.8, 0.46, 8), {
          brushSlot: 1, hueIndex: 1, brushSize: bs * 0.6, thinners: 0.0, load: 0.82,
        });
      }
    }
    // Head suggestion — tiny darker mark
    if (passes >= 3) {
      await paint(page, dash(gx, gy0, 0.025, 0.44), {
        brushSlot: 1, hueIndex: 1, brushSize: bs * 0.5, thinners: 0.0, load: 0.80,
      });
    }
  }
  await snap(page, '03-ghosts.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 6: TELEGRAPH POLES — thin verticals + cross-pieces
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L6: Poles...');
  await wipeRag(page);
  await setTonal(page, 1, 0.84);
  // Pole 1 — tallest, prominent
  for (let p = 0; p < 7; p++) {
    await paint(page, V(0.62, 0.02, 0.72, 0.56, 65), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.007, thinners: 0.0, load: 0.94,
    });
  }
  // Pole 2
  for (let p = 0; p < 6; p++) {
    await paint(page, V(0.67, 0.04, 0.68, 0.52, 58), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.006, thinners: 0.0, load: 0.90,
    });
  }
  // Pole 3 — faint, far right
  for (let p = 0; p < 3; p++) {
    await paint(page, V(0.72, 0.08, 0.62, 0.44, 48), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.005, thinners: 0.01, load: 0.78,
    });
  }
  // Cross-pieces / insulators on pole 1
  await setTonal(page, 1, 0.80);
  for (let p = 0; p < 3; p++) {
    await paint(page, H(0.06, 0.595, 0.645, 0.48, 10), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.006, thinners: 0.0, load: 0.86,
    });
  }
  // Insulator mark
  await setTonal(page, 1, 0.88);
  for (let p = 0; p < 2; p++) {
    await paint(page, dash(0.62, 0.055, 0.025, 0.52), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.007, thinners: 0.0, load: 0.90,
    });
  }
  // Cross-piece on pole 2
  await setTonal(page, 1, 0.76);
  for (let p = 0; p < 2; p++) {
    await paint(page, H(0.08, 0.650, 0.690, 0.42, 8), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.005, thinners: 0.0, load: 0.82,
    });
  }
  await snap(page, '04-poles.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 7: TRAM — dark frame + OIL VIVID orange center
  // Oil medium makes the warm accent saturated — the focal point.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L7: Tram...');
  await wipeRag(page);
  // Dark surround frame — tram body silhouette, larger
  await setTonal(page, 1, 0.80);
  await fill(page, 0.32, 0.54, 0.72, 0.92, {
    brushSlot: 3, hueIndex: 1, brushSize: 0.022, thinners: 0.0, load: 0.90, pressure: 0.60,
  }, 4);
  // Roof line — darker
  await setTonal(page, 1, 0.86);
  await fill(page, 0.32, 0.36, 0.74, 0.90, {
    brushSlot: 3, hueIndex: 1, brushSize: 0.014, thinners: 0.0, load: 0.88, pressure: 0.56,
  }, 3);
  // Windows / warm interior glow — OIL for saturation
  await wipeRag(page);
  await setTonal(page, 4, 0.42);
  for (let row = 0; row < 8; row++) {
    const y = 0.36 + row * 0.016;
    await armOil(page);
    await paint(page, H(y, 0.75, 0.88, 0.66, 18), {
      brushSlot: 3, hueIndex: 4, brushSize: 0.018, thinners: 0.0, load: 0.98,
    });
  }
  // Brighter warm center
  await setTonal(page, 0, 0.36);
  for (let row = 0; row < 5; row++) {
    const y = 0.38 + row * 0.016;
    await armOil(page);
    await paint(page, H(y, 0.77, 0.86, 0.62, 14), {
      brushSlot: 3, hueIndex: 0, brushSize: 0.016, thinners: 0.0, load: 0.96,
    });
  }
  // Warm halo around tram — foggy glow
  await setTonal(page, 4, 0.30);
  await fill(page, 0.30, 0.56, 0.68, 0.72, {
    brushSlot: 4, hueIndex: 4, brushSize: 0.04, thinners: 0.04, load: 0.52, pressure: 0.36,
  }, 2);
  await fill(page, 0.30, 0.56, 0.92, 0.98, {
    brushSlot: 4, hueIndex: 4, brushSize: 0.04, thinners: 0.04, load: 0.52, pressure: 0.36,
  }, 2);
  // Dark silhouette figure in front of tram
  await wipeRag(page);
  await setTonal(page, 1, 0.86);
  for (let p = 0; p < 4; p++) {
    await paint(page, taperV(0.78, 0.42, 0.53, 0.58, 0.42, 14), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.012, thinners: 0.0, load: 0.90,
    });
  }
  await snap(page, '05-tram.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 8: MAIN FIGURE — precise umbrella + narrow body + legs
  // The darkest, most defined element. Painted last.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L8: Figure...');
  await wipeRag(page);
  await setTonal(page, 1, 0.96);

  // Umbrella dome — multiple arc layers for solid dark mass
  for (let p = 0; p < 4; p++) {
    await paint(page, umbrellaArc(0.28, 0.30, 0.052, 0.032, 0.74, 22), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.022, thinners: 0.0, load: 1.0,
    });
    await paint(page, umbrellaArc(0.28, 0.31, 0.048, 0.024, 0.70, 20), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.020, thinners: 0.0, load: 1.0,
    });
    await paint(page, umbrellaArc(0.28, 0.32, 0.044, 0.018, 0.66, 18), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.018, thinners: 0.0, load: 0.98,
    });
  }
  // Fill umbrella center mass
  await fill(page, 0.29, 0.34, 0.24, 0.32, {
    brushSlot: 0, hueIndex: 1, brushSize: 0.018, thinners: 0.0, load: 1.0, pressure: 0.70,
  }, 2);
  // Umbrella bottom edge — strong horizontal line
  for (let p = 0; p < 4; p++) {
    await paint(page, H(0.340, 0.230, 0.330, 0.66, 18), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.012, thinners: 0.0, load: 0.96,
    });
  }

  // Body — solid dark column from umbrella to hem
  await setTonal(page, 1, 0.97);
  for (let p = 0; p < 6; p++) {
    await paint(page, taperV(0.276, 0.34, 0.58, 0.74, 0.62, 28), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.020, thinners: 0.0, load: 1.0,
    });
    await paint(page, taperV(0.284, 0.34, 0.58, 0.74, 0.62, 28), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.018, thinners: 0.0, load: 1.0,
    });
  }
  // Coat widening at hem
  for (let p = 0; p < 5; p++) {
    await paint(page, H(0.56, 0.250, 0.310, 0.64, 12), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.016, thinners: 0.0, load: 0.96,
    });
    await paint(page, H(0.57, 0.246, 0.314, 0.60, 12), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.014, thinners: 0.0, load: 0.94,
    });
    await paint(page, H(0.58, 0.248, 0.312, 0.58, 12), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.012, thinners: 0.0, load: 0.92,
    });
  }

  // Legs — two thin tapered lines
  await setTonal(page, 1, 0.98);
  for (let p = 0; p < 5; p++) {
    await paint(page, taperV(0.268, 0.58, 0.70, 0.62, 0.28, 18), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.008, thinners: 0.0, load: 0.96,
    });
    await paint(page, taperV(0.292, 0.58, 0.70, 0.62, 0.28, 18), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.008, thinners: 0.0, load: 0.96,
    });
  }
  // Feet — tiny dark marks
  for (let p = 0; p < 3; p++) {
    await paint(page, dash(0.267, 0.69, 0.02, 0.50), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.008, thinners: 0.0, load: 0.90,
    });
    await paint(page, dash(0.293, 0.69, 0.02, 0.50), {
      brushSlot: 0, hueIndex: 1, brushSize: 0.008, thinners: 0.0, load: 0.90,
    });
  }
  await snap(page, '06-figure.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 9: FOREGROUND BOLLARDS — small dark marks on road
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L9: Bollards...');
  await wipeRag(page);
  await setTonal(page, 1, 0.88);
  for (const bx of [0.32, 0.38, 0.44, 0.50, 0.56]) {
    for (let p = 0; p < 5; p++) {
      await paint(page, dash(bx, 0.62, 0.06, 0.54), {
        brushSlot: 1, hueIndex: 1, brushSize: 0.010, thinners: 0.0, load: 0.92,
      });
    }
  }
  await snap(page, '07-bollards.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 10: REFLECTIONS — elongated marks on wet road
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L10: Reflections...');
  // Figure reflection — longest, darkest, strong presence
  await setTonal(page, 1, 0.72);
  for (let p = 0; p < 6; p++) {
    await paint(page, taperV(0.28, 0.70, 0.92, 0.52, 0.16, 26), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.014, thinners: 0.0, load: 0.78,
    });
  }
  // Ghost reflections — bolder
  await setTonal(page, 1, 0.54);
  for (const [gx, gy] of [[0.38, 0.54], [0.44, 0.52], [0.50, 0.50], [0.55, 0.49]] as const) {
    for (let p = 0; p < 2; p++) {
      await paint(page, taperV(gx, gy, gy + 0.12, 0.34, 0.10, 12), {
        brushSlot: 1, hueIndex: 1, brushSize: 0.008, thinners: 0.03, load: 0.50,
      });
    }
  }
  // Pole reflections — long vertical streaks on wet road
  await setTonal(page, 1, 0.58);
  for (let p = 0; p < 4; p++) {
    await paint(page, taperV(0.62, 0.64, 0.92, 0.38, 0.10, 28), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.007, thinners: 0.01, load: 0.58,
    });
  }
  for (let p = 0; p < 3; p++) {
    await paint(page, taperV(0.67, 0.64, 0.88, 0.34, 0.08, 24), {
      brushSlot: 1, hueIndex: 1, brushSize: 0.006, thinners: 0.02, load: 0.50,
    });
  }
  // Bollard reflections — short streaks
  await setTonal(page, 1, 0.52);
  for (const bx of [0.32, 0.38, 0.44, 0.50, 0.56]) {
    for (let p = 0; p < 2; p++) {
      await paint(page, taperV(bx, 0.68, 0.80, 0.28, 0.08, 10), {
        brushSlot: 1, hueIndex: 1, brushSize: 0.005, thinners: 0.04, load: 0.38,
      });
    }
  }
  // Tram warm reflection on wet road — oil for saturation
  await setTonal(page, 4, 0.32);
  for (let p = 0; p < 3; p++) {
    await armOil(page);
    await paint(page, taperV(0.82, 0.56, 0.86, 0.36, 0.10, 24), {
      brushSlot: 3, hueIndex: 4, brushSize: 0.024, thinners: 0.02, load: 0.54,
    });
  }
  await snap(page, '08-reflections.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 11: SELECTIVE GLAZE — sky/road only, skip all darks
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L11: Glaze...');
  await wipeRag(page);
  // Atmospheric haze glaze — very thin, knocks back everything gently
  await setTonal(page, 0, 0.08);
  // Sky — gentle warm haze
  await fill(page, 0.0, 0.32, 0.0, 0.60, {
    brushSlot: 4, hueIndex: 0, brushSize: 0.14, thinners: 0.08, load: 0.26, pressure: 0.24,
  });
  // Road — very light glaze only in mid-road zone (avoid dark foreground)
  await setTonal(page, 4, 0.14);
  await fill(page, 0.54, 0.68, 0.0, 0.24, {
    brushSlot: 4, hueIndex: 4, brushSize: 0.12, thinners: 0.06, load: 0.24, pressure: 0.24,
  });
  await fill(page, 0.54, 0.68, 0.34, 0.60, {
    brushSlot: 4, hueIndex: 4, brushSize: 0.12, thinners: 0.06, load: 0.24, pressure: 0.24,
  });
  // Right-side sky behind tram — darker cool tone to push tram glow forward
  await setTonal(page, 3, 0.32);
  await fill(page, 0.0, 0.32, 0.58, 1.0, {
    brushSlot: 4, hueIndex: 3, brushSize: 0.10, thinners: 0.03, load: 0.48, pressure: 0.38,
  }, 3);

  await page.evaluate(() => (window as any).__ghz.waitFrames(20));
  await snap(page, 'final.png');

  // Diagnostics
  const pixels = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const w = ghz.getSurfaceDimensions().width;
    const h = ghz.getSurfaceDimensions().height;
    return {
      sky: await ghz.readAccumPixel(Math.round(w * 0.5), Math.round(h * 0.10)),
      hedge: await ghz.readAccumPixel(Math.round(w * 0.50), Math.round(h * 0.42)),
      figure: await ghz.readAccumPixel(Math.round(w * 0.28), Math.round(h * 0.48)),
      road: await ghz.readAccumPixel(Math.round(w * 0.45), Math.round(h * 0.65)),
      tram_glow: await ghz.readAccumPixel(Math.round(w * 0.81), Math.round(h * 0.41)),
      pole: await ghz.readAccumPixel(Math.round(w * 0.62), Math.round(h * 0.30)),
      ghost: await ghz.readAccumPixel(Math.round(w * 0.40), Math.round(h * 0.44)),
    };
  });
  console.log('\n--- Accumulation pixel values (K_r, K_g, K_b, weight) ---');
  for (const [name, vals] of Object.entries(pixels)) {
    const v = vals as number[];
    console.log(`  ${name}: K=(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}) weight=${v[3].toFixed(3)}`);
  }

  const fig = pixels.figure as number[];
  const figRatio = Math.min(...[fig[0], fig[1], fig[2]]) > 0
    ? Math.max(fig[0], fig[1], fig[2]) / Math.min(fig[0], fig[1], fig[2]) : 999;
  console.log(`  figure K ratio: ${figRatio.toFixed(2)} (< 2.0 = neutral)`);

  // Check tram warmth — K_r should be notably less than K_b (less red absorption = warmer)
  const tram = pixels.tram_glow as number[];
  console.log(`  tram warmth: K_r/K_b = ${(tram[0] / tram[2]).toFixed(2)} (< 0.8 = warm)`);

  console.log(`\nDone! Screenshots: ${OUTPUT_DIR}`);
});
