// Clarice Beckett recreation — foggy Melbourne street scene
// Extracts 5 hues from beckett-reference.png to create a custom mood,
// then paints using those colors. Falls back to Foggy Morning if no ref.
// Reference: high-key tonalist painting. Warm pink horizon, olive hedge band,
// dark umbrella figure, chunky ghost figures, vivid orange tram, bollards.
// Road is LIGHT (similar to sky). Lights first, darks last.
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

function H(y: number, x0: number, x1: number, p: number, n = 80): any[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x0 + (i / (n - 1)) * (x1 - x0),
    y: y + Math.sin(i * 0.31) * 0.002,
    pressure: p + Math.sin(i * 0.47) * 0.008,
  }));
}

function V(x: number, y0: number, y1: number, p: number, n = 35): any[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x + Math.sin(i * 0.37) * 0.001,
    y: y0 + (i / (n - 1)) * (y1 - y0),
    pressure: p + Math.sin(i * 0.53) * 0.008,
  }));
}

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

function taperV(x: number, y0: number, y1: number, pStart: number, pEnd: number, n = 25): any[] {
  return Array.from({ length: n }, (_, i) => ({
    x: x + Math.sin(i * 0.29) * 0.0008,
    y: y0 + (i / (n - 1)) * (y1 - y0),
    pressure: pStart + (pEnd - pStart) * (i / (n - 1)),
  }));
}

function dash(x: number, y: number, len: number, p: number): any[] {
  return [
    { x, y, pressure: p * 0.6 },
    { x, y: y + len * 0.3, pressure: p },
    { x, y: y + len * 0.7, pressure: p },
    { x, y: y + len, pressure: p * 0.4 },
  ];
}

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

  // --- Select Foggy Morning first, then extract colors bent through its lens ---
  const refPath = path.resolve(__dirname, 'beckett-reference.png');
  const hasRef = fs.existsSync(refPath);

  // 1. Select Foggy Morning mood first (index 2)
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(2); // Foggy Morning
    await ghz.waitFrames(5);
  });

  if (hasRef) {
    // 2. Extract from reference — colors are bent through Foggy Morning's lens
    const imageBytes = fs.readFileSync(refPath);
    const base64 = imageBytes.toString('base64');
    const extraction = await page.evaluate(async (b64: string) => {
      const ghz = (window as any).__ghz;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      return await ghz.createMoodFromImage('Beckett Reference', blob, 2);
    }, base64);
    console.log(`Extracted OKLCH: [${extraction.colors.map((c: any) => `(L=${c.l.toFixed(2)} C=${c.c.toFixed(3)} H=${Math.round(c.h)})`).join(', ')}]`);
    console.log(`Median chroma: ${extraction.medianChroma.toFixed(4)}, chromaScale: ${extraction.chromaScale.toFixed(2)}`);
    // Log palette colors (pre-apply, in-memory mood)
    const paletteInfo = await page.evaluate(() => {
      const ghz = (window as any).__ghz;
      const moods = ghz.getAllMoods();
      const mood = moods[moods.length - 1];
      return mood.piles.map((p: any, i: number) => ({
        hue: i,
        rgb: `(${(p.medium.r * 255).toFixed(0)}, ${(p.medium.g * 255).toFixed(0)}, ${(p.medium.b * 255).toFixed(0)})`,
      }));
    });
    for (const p of paletteInfo) console.log(`  Hue ${p.hue}: ${p.rgb}`);

    // 3. Select the new custom mood (last in list)
    // Use selectMood (not applyMood) to avoid loadCustomMoods() replacing bent piles
    await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      const moods = ghz.getAllMoods();
      ghz.selectMood(moods.length - 1);
      await ghz.waitFrames(10);
      await ghz.setPhase('paint');
      await ghz.waitFrames(10);
    });

    // Diagnostic: verify bend computation (now returns OKLCH, not RGB)
    const bendTest = await page.evaluate((extractedColors: any[]) => {
      const ghz = (window as any).__ghz;
      const moods = ghz.getAllMoods();
      const foggy = moods[2]; // Foggy Morning
      const lens = foggy?.lens ?? ghz.DEFAULT_LENS;
      const bentOklch = ghz.bendThroughMood(extractedColors, lens, foggy?.density ?? 0.4);
      return {
        lens,
        density: foggy?.density,
        bent: bentOklch.map((c: any, i: number) => ({
          i,
          oklch: `(L=${c.l.toFixed(2)} C=${c.c.toFixed(3)} H=${Math.round(c.h)})`,
        })),
      };
    }, extraction.colors);
    console.log('Foggy Morning lens:', JSON.stringify(bendTest.lens), 'density:', bendTest.density);
    for (const b of bendTest.bent) console.log(`  Bent ${b.i}: ${b.oklch}`);

    // Log palette after apply to verify persistence roundtrip
    const appliedPalette = await page.evaluate(() => {
      const ghz = (window as any).__ghz;
      const palette = ghz.stores.scene.get().palette;
      return palette.colors.map((c: any, i: number) => ({
        i, rgb: `(${(c.r * 255).toFixed(0)}, ${(c.g * 255).toFixed(0)}, ${(c.b * 255).toFixed(0)})`,
      }));
    });
    console.log('Applied palette:');
    for (const p of appliedPalette) console.log(`  Hue ${p.i}: ${p.rgb}`);
  } else {
    // Fall back to Foggy Morning
    await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      await ghz.waitFrames(10);
      await ghz.setPhase('paint');
      await ghz.waitFrames(10);
    });
  }

  // Map extracted OKLCH colors to painting roles using hue angles + lightness
  // Roles: SKY (lightest neutral), HORIZON (pink/mauve), HEDGE (green),
  //        TRAM (warm orange accent), DARK (coolest/darkest for figures)
  const extractionColors = hasRef
    ? (await page.evaluate(() => {
        const ghz = (window as any).__ghz;
        const palette = ghz.stores.scene.get().palette;
        return palette.colors.map((c: any, i: number) => {
          const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
          return { i, r: c.r, g: c.g, b: c.b, lum };
        });
      }))
    : Array.from({length: 5}, (_, i) => ({ i, r: 0.5, g: 0.5, b: 0.5, lum: 0.5 }));

  // Use OKLCH hue proximity for role assignment
  // Bent hue targets: TRAM ~45°, HORIZON ~351°, HEDGE ~99°, SKY ~72°, DARK ~153°
  function hueDist(a: number, b: number) {
    let d = Math.abs(a - b); if (d > 180) d = 360 - d; return d;
  }

  // Compute bent hues from extraction for matching
  const bentHues = hasRef
    ? [351, 99, 153, 45, 72]  // Bent hue targets for [Color0..4] after Foggy Morning bend
    : [0, 72, 144, 216, 288];

  const used = new Set<number>();
  function pickByHue(targetHue: number) {
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < 5; i++) {
      if (used.has(i)) continue;
      const d = hueDist(bentHues[i], targetHue);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    used.add(best);
    return best;
  }
  function pickByLum(wantLight: boolean) {
    let best = -1, bestScore = -Infinity;
    for (const c of extractionColors) {
      if (used.has(c.i)) continue;
      const score = wantLight ? c.lum : -c.lum;
      if (score > bestScore) { bestScore = score; best = c.i; }
    }
    used.add(best);
    return best;
  }

  // Priority order: HEDGE (green ~99°), TRAM (orange ~45°), HORIZON (pink ~351°), then SKY/DARK by lightness
  const HEDGE = pickByHue(99);
  const TRAM = pickByHue(45);
  const HORIZON = pickByHue(351);
  const DARK = pickByLum(false);  // darkest remaining
  const SKY = pickByLum(true);    // lightest remaining

  const roles = { SKY, HEDGE, DARK, HORIZON, TRAM };
  console.log('Role mapping:', JSON.stringify(roles));

  await snap(page, '00-blank.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 1: GROUND TONE — warm mist imprimatura
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L1: Ground tone...');
  await setTonal(page, SKY, 0.14);
  await fill(page, 0.0, 0.95, 0.0, 1.0, {
    brushSlot: 4, hueIndex: SKY, brushSize: 0.18, thinners: 0.0, load: 0.92, pressure: 0.60,
  }, 4);

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 2: ATMOSPHERE — warm pink horizon band + light road
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L2: Atmosphere...');
  // Horizon warm band — STRONG, full width, using HORIZON (pink) color
  await setTonal(page, HORIZON, 0.34);
  await fill(page, 0.22, 0.42, 0.0, 1.0, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.08, thinners: 0.0, load: 0.82, pressure: 0.56,
  }, 5);
  // Extra warm oil in horizon center
  await setTonal(page, HORIZON, 0.38);
  for (let row = 0; row < 6; row++) {
    const y = 0.26 + row * 0.02;
    await armOil(page);
    await paint(page, H(y, 0.0, 1.0, 0.48, 100), {
      brushSlot: 4, hueIndex: HORIZON, brushSize: 0.06, thinners: 0.0, load: 0.76,
    });
  }
  // Road — light, barely darker than sky
  await setTonal(page, SKY, 0.22);
  await fill(page, 0.52, 0.95, 0.0, 1.0, {
    brushSlot: 4, hueIndex: SKY, brushSize: 0.14, thinners: 0.0, load: 0.86, pressure: 0.56,
  }, 3);
  // Slight bottom darkening
  await setTonal(page, SKY, 0.30);
  await fill(page, 0.82, 0.95, 0.0, 1.0, {
    brushSlot: 4, hueIndex: SKY, brushSize: 0.12, thinners: 0.0, load: 0.78, pressure: 0.50,
  }, 2);
  await snap(page, '01-tone.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 3: DISTANT TREES — warm blurs above hedge
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L3: Distant trees...');
  await setTonal(page, HORIZON, 0.40);
  for (const [cx, w, yTop, yBot] of [
    [0.12, 0.10, 0.20, 0.36], [0.22, 0.16, 0.16, 0.36], [0.34, 0.10, 0.22, 0.36],
    [0.44, 0.08, 0.24, 0.36], [0.54, 0.10, 0.20, 0.36],
  ] as const) {
    await fill(page, yTop, yBot, cx - w / 2, cx + w / 2, {
      brushSlot: 2, hueIndex: HORIZON, brushSize: 0.032, thinners: 0.01, load: 0.72, pressure: 0.48,
    }, 3);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 4: HEDGE — olive-green band across full width
  // Beckett's hedge is olive/sage with visible green tint, NOT grey.
  // Strong continuous band at ~40% height. Denser left, thinner right.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L4: Hedge...');
  await wipeRag(page);
  await setTonal(page, HEDGE, 0.54);
  // Full-width base
  await fill(page, 0.37, 0.49, 0.0, 0.72, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.030, thinners: 0.0, load: 0.94, pressure: 0.64,
  }, 4);
  // Left section — extra dense, extends higher
  await setTonal(page, HEDGE, 0.58);
  await fill(page, 0.34, 0.50, 0.0, 0.32, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.026, thinners: 0.0, load: 0.92, pressure: 0.62,
  }, 3);
  // Center build-up
  await fill(page, 0.38, 0.48, 0.32, 0.58, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.024, thinners: 0.0, load: 0.88, pressure: 0.58,
  }, 3);
  // Right — thinner, with gaps at pole positions
  await fill(page, 0.39, 0.46, 0.58, 0.61, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.022, thinners: 0.0, load: 0.82, pressure: 0.54,
  }, 2);
  await fill(page, 0.39, 0.46, 0.64, 0.72, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.022, thinners: 0.0, load: 0.82, pressure: 0.54,
  }, 2);
  // Darker base edge
  await setTonal(page, HEDGE, 0.64);
  await fill(page, 0.46, 0.50, 0.0, 0.58, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.014, thinners: 0.0, load: 0.88, pressure: 0.58,
  }, 2);
  await snap(page, '02-hedge.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 5: GHOST FIGURES — chunky dark blobs in mist
  // Beckett's ghosts are WIDE, blob-like — not thin sticks.
  // Closest is boldest, farthest fades into hedge.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L5: Ghosts...');
  await wipeRag(page);
  const ghosts: [number, number, number, number, number, number][] = [
    // [x, yTop, yBot, tonal, passes, brushSize]
    [0.38, 0.34, 0.56, 0.92, 7, 0.024],
    [0.46, 0.36, 0.54, 0.88, 5, 0.022],
    [0.53, 0.37, 0.52, 0.82, 4, 0.018],
    [0.59, 0.38, 0.50, 0.76, 3, 0.014],
  ];
  for (const [gx, gy0, gy1, tv, passes, bs] of ghosts) {
    await setTonal(page, DARK, tv - 0.14);
    // Multiple offset strokes for width — creates a chunky blob, not a line
    for (let p = 0; p < passes; p++) {
      const off = (p % 3 - 1) * bs * 0.3;
      await paint(page, taperV(gx + off, gy0, gy1, 0.62, 0.38, 20), {
        brushSlot: 1, hueIndex: DARK, brushSize: bs, thinners: 0.0, load: 0.94,
      });
    }
    // Shoulders — horizontal marks near top
    if (passes >= 3) {
      for (let p = 0; p < 3; p++) {
        await paint(page, H(gy0 + 0.04, gx - bs, gx + bs, 0.48, 8), {
          brushSlot: 1, hueIndex: DARK, brushSize: bs * 0.7, thinners: 0.0, load: 0.84,
        });
      }
    }
  }
  await snap(page, '03-ghosts.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 6: TELEGRAPH POLES — thin verticals + cross-pieces
  // In Beckett: 2-3 poles in right portion, thin but visible.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L6: Poles...');
  await wipeRag(page);
  await setTonal(page, DARK, 0.68);
  // Pole 1 — tallest, prominent
  for (let p = 0; p < 6; p++) {
    await paint(page, V(0.63, 0.02, 0.72, 0.54, 62), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.007, thinners: 0.0, load: 0.94,
    });
  }
  // Pole 2 — slightly shorter
  for (let p = 0; p < 5; p++) {
    await paint(page, V(0.68, 0.04, 0.68, 0.50, 56), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.006, thinners: 0.0, load: 0.90,
    });
  }
  // Pole 3 — faint
  for (let p = 0; p < 3; p++) {
    await paint(page, V(0.73, 0.08, 0.62, 0.42, 46), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.005, thinners: 0.01, load: 0.78,
    });
  }
  // Cross-piece / insulator marks
  await setTonal(page, DARK, 0.72);
  for (let p = 0; p < 3; p++) {
    await paint(page, dash(0.63, 0.06, 0.025, 0.50), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.008, thinners: 0.0, load: 0.88,
    });
    await paint(page, dash(0.63, 0.10, 0.020, 0.46), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.007, thinners: 0.0, load: 0.84,
    });
  }
  await snap(page, '04-poles.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 7: TRAM — VIVID ORANGE rectangle with dark frame
  // This is THE focal color accent. Must be unmistakably orange.
  // Dark frame around, bright orange interior, warm halo in fog.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L7: Tram...');
  await wipeRag(page);
  // ORANGE INTERIOR FIRST — on clean surface for maximum K-M saturation
  // In K-M, paint is additive; orange MUST go on before the dark frame.
  // Tonal 0.44-0.50: medium value — dark enough that ACES tonemap preserves
  // color ratios (highlights get compressed, mid-tones keep saturation).
  // Beckett's tram IS medium value, not light.
  await setTonal(page, TRAM, 0.52);
  for (let pass = 0; pass < 4; pass++) {
    for (let row = 0; row < 12; row++) {
      const y = 0.33 + row * 0.015;
      await armOil(page);
      await paint(page, H(y, 0.76, 0.92, 0.68, 24), {
        brushSlot: 3, hueIndex: TRAM, brushSize: 0.022, thinners: 0.0, load: 1.0,
      });
    }
  }
  // Hottest center — thick warm paint with oil
  await setTonal(page, TRAM, 0.48);
  for (let pass = 0; pass < 3; pass++) {
    for (let row = 0; row < 8; row++) {
      const y = 0.35 + row * 0.016;
      await armOil(page);
      await paint(page, H(y, 0.78, 0.90, 0.64, 18), {
        brushSlot: 3, hueIndex: TRAM, brushSize: 0.018, thinners: 0.0, load: 1.0,
      });
    }
  }
  // Dark frame — ONLY edges, roof, bottom (NOT filling interior)
  await wipeRag(page);
  await setTonal(page, DARK, 0.72);
  // Roof
  await fill(page, 0.29, 0.34, 0.74, 0.94, {
    brushSlot: 3, hueIndex: DARK, brushSize: 0.016, thinners: 0.0, load: 0.92, pressure: 0.62,
  }, 3);
  // Bottom rail
  await fill(page, 0.50, 0.54, 0.74, 0.94, {
    brushSlot: 3, hueIndex: DARK, brushSize: 0.012, thinners: 0.0, load: 0.88, pressure: 0.56,
  }, 2);
  // Left edge
  for (let p = 0; p < 3; p++) {
    await paint(page, V(0.75, 0.30, 0.54, 0.58, 28), {
      brushSlot: 3, hueIndex: DARK, brushSize: 0.010, thinners: 0.0, load: 0.90,
    });
  }
  // Right edge
  for (let p = 0; p < 3; p++) {
    await paint(page, V(0.93, 0.30, 0.54, 0.56, 28), {
      brushSlot: 3, hueIndex: DARK, brushSize: 0.010, thinners: 0.0, load: 0.88,
    });
  }
  // Warm halo in fog around tram — use HORIZON (pink) for atmospheric glow
  await wipeRag(page);
  await setTonal(page, HORIZON, 0.22);
  await fill(page, 0.28, 0.56, 0.70, 0.75, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.04, thinners: 0.03, load: 0.48, pressure: 0.34,
  }, 2);
  await fill(page, 0.28, 0.56, 0.93, 1.0, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.04, thinners: 0.03, load: 0.48, pressure: 0.34,
  }, 2);
  // Dark silhouette figure in front of tram
  await wipeRag(page);
  await setTonal(page, DARK, 0.80);
  for (let p = 0; p < 5; p++) {
    await paint(page, taperV(0.78, 0.40, 0.54, 0.62, 0.42, 16), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.014, thinners: 0.0, load: 0.94,
    });
  }
  await snap(page, '05-tram.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 8: MAIN FIGURE — solid dark mass, umbrella merges into body
  // In Beckett, the figure is ONE continuous dark shape — no gap between
  // umbrella and body. Darkest element in the painting.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L8: Figure...');
  await wipeRag(page);
  await setTonal(page, DARK, 0.90);

  // Umbrella dome — solid arcs
  for (let p = 0; p < 5; p++) {
    await paint(page, umbrellaArc(0.28, 0.29, 0.055, 0.035, 0.78, 22), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.022, thinners: 0.0, load: 1.0,
    });
    await paint(page, umbrellaArc(0.28, 0.30, 0.050, 0.028, 0.74, 20), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.020, thinners: 0.0, load: 1.0,
    });
    await paint(page, umbrellaArc(0.28, 0.31, 0.045, 0.020, 0.70, 18), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.018, thinners: 0.0, load: 0.98,
    });
  }
  // Fill umbrella center — ensures solid mass, no holes
  await fill(page, 0.27, 0.33, 0.23, 0.33, {
    brushSlot: 0, hueIndex: DARK, brushSize: 0.018, thinners: 0.0, load: 1.0, pressure: 0.76,
  }, 4);

  // CONTINUOUS body from umbrella base to hem — NO GAP
  // Start at 0.33 (umbrella bottom) and go down to 0.58 (hem)
  await setTonal(page, DARK, 0.92);
  for (let p = 0; p < 6; p++) {
    await paint(page, taperV(0.277, 0.33, 0.58, 0.74, 0.64, 30), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.020, thinners: 0.0, load: 1.0,
    });
    await paint(page, taperV(0.283, 0.33, 0.58, 0.74, 0.64, 30), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.018, thinners: 0.0, load: 1.0,
    });
  }
  // Coat widening at hem
  for (let p = 0; p < 4; p++) {
    await paint(page, H(0.56, 0.252, 0.308, 0.64, 12), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.016, thinners: 0.0, load: 0.96,
    });
    await paint(page, H(0.57, 0.248, 0.312, 0.60, 12), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.014, thinners: 0.0, load: 0.94,
    });
  }

  // Legs — two thin tapered lines
  await setTonal(page, DARK, 0.92);
  for (let p = 0; p < 5; p++) {
    await paint(page, taperV(0.269, 0.58, 0.70, 0.62, 0.28, 18), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.008, thinners: 0.0, load: 0.96,
    });
    await paint(page, taperV(0.291, 0.58, 0.70, 0.62, 0.28, 18), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.008, thinners: 0.0, load: 0.96,
    });
  }
  // Feet
  for (let p = 0; p < 3; p++) {
    await paint(page, dash(0.268, 0.69, 0.02, 0.50), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.008, thinners: 0.0, load: 0.90,
    });
    await paint(page, dash(0.292, 0.69, 0.02, 0.50), {
      brushSlot: 0, hueIndex: DARK, brushSize: 0.008, thinners: 0.0, load: 0.90,
    });
  }
  await snap(page, '06-figure.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 9: BOLLARDS — chunky dark marks on road
  // Beckett's bollards are thick, not thin dashes.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L9: Bollards...');
  await wipeRag(page);
  await setTonal(page, DARK, 0.76);
  for (const bx of [0.35, 0.42, 0.49, 0.56, 0.62]) {
    for (let p = 0; p < 6; p++) {
      await paint(page, dash(bx, 0.58, 0.07, 0.56), {
        brushSlot: 1, hueIndex: DARK, brushSize: 0.012, thinners: 0.0, load: 0.94,
      });
    }
  }
  await snap(page, '07-bollards.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 10: REFLECTIONS — vertical smears on wet road
  // Figure reflection is a strong dark smear. Pole reflections are long thin
  // lines extending well into foreground. Bollard reflections are short.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L10: Reflections...');
  // Figure reflection — strong, long
  await setTonal(page, DARK, 0.58);
  for (let p = 0; p < 6; p++) {
    await paint(page, taperV(0.28, 0.70, 0.92, 0.52, 0.14, 26), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.014, thinners: 0.0, load: 0.80,
    });
  }
  // Ghost reflections
  await setTonal(page, DARK, 0.46);
  for (const [gx, gy] of [[0.38, 0.56], [0.46, 0.54], [0.53, 0.52]] as const) {
    for (let p = 0; p < 3; p++) {
      await paint(page, taperV(gx, gy, gy + 0.14, 0.36, 0.10, 14), {
        brushSlot: 1, hueIndex: DARK, brushSize: 0.010, thinners: 0.02, load: 0.54,
      });
    }
  }
  // Pole reflections — very long thin lines
  await setTonal(page, DARK, 0.44);
  for (let p = 0; p < 4; p++) {
    await paint(page, taperV(0.63, 0.62, 0.94, 0.36, 0.08, 30), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.006, thinners: 0.01, load: 0.56,
    });
  }
  for (let p = 0; p < 3; p++) {
    await paint(page, taperV(0.68, 0.62, 0.90, 0.30, 0.06, 26), {
      brushSlot: 1, hueIndex: DARK, brushSize: 0.005, thinners: 0.02, load: 0.48,
    });
  }
  // Bollard reflections — short smears
  await setTonal(page, DARK, 0.44);
  for (const bx of [0.35, 0.42, 0.49, 0.56, 0.62]) {
    for (let p = 0; p < 2; p++) {
      await paint(page, taperV(bx, 0.65, 0.78, 0.30, 0.08, 10), {
        brushSlot: 1, hueIndex: DARK, brushSize: 0.006, thinners: 0.03, load: 0.42,
      });
    }
  }
  // Tram warm reflection — oil for saturation, using TRAM (orange) color
  await setTonal(page, TRAM, 0.42);
  for (let p = 0; p < 5; p++) {
    await armOil(page);
    await paint(page, taperV(0.83, 0.56, 0.86, 0.48, 0.16, 24), {
      brushSlot: 3, hueIndex: TRAM, brushSize: 0.026, thinners: 0.0, load: 0.74,
    });
  }
  await snap(page, '08-reflections.png');

  // ═══════════════════════════════════════════════════════════════════════════
  // STAGE 11: GLAZE — minimal atmospheric unification
  // Very light, just to soften edges. Avoid overwriting darks.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('L11: Glaze...');
  await wipeRag(page);
  // Light warm haze across sky only
  await setTonal(page, SKY, 0.06);
  await fill(page, 0.0, 0.22, 0.0, 0.60, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.14, thinners: 0.08, load: 0.22, pressure: 0.22,
  });
  // Subtle cool tone in right sky to push tram forward
  await setTonal(page, DARK, 0.20);
  await fill(page, 0.0, 0.28, 0.58, 1.0, {
    brushSlot: 4, hueIndex: DARK, brushSize: 0.10, thinners: 0.04, load: 0.38, pressure: 0.32,
  }, 2);

  await page.evaluate(() => (window as any).__ghz.waitFrames(20));
  await snap(page, 'final.png');

  // Diagnostics
  const pixels = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const w = ghz.getSurfaceDimensions().width;
    const h = ghz.getSurfaceDimensions().height;
    return {
      sky: await ghz.readAccumPixel(Math.round(w * 0.5), Math.round(h * 0.10)),
      horizon: await ghz.readAccumPixel(Math.round(w * 0.3), Math.round(h * 0.30)),
      hedge: await ghz.readAccumPixel(Math.round(w * 0.50), Math.round(h * 0.43)),
      figure: await ghz.readAccumPixel(Math.round(w * 0.28), Math.round(h * 0.48)),
      road: await ghz.readAccumPixel(Math.round(w * 0.45), Math.round(h * 0.65)),
      tram_glow: await ghz.readAccumPixel(Math.round(w * 0.84), Math.round(h * 0.42)),
      pole: await ghz.readAccumPixel(Math.round(w * 0.63), Math.round(h * 0.30)),
      ghost: await ghz.readAccumPixel(Math.round(w * 0.38), Math.round(h * 0.45)),
      bollard: await ghz.readAccumPixel(Math.round(w * 0.49), Math.round(h * 0.62)),
    };
  });
  console.log('\n--- Accumulation pixel values (K_r, K_g, K_b, weight) ---');
  for (const [name, vals] of Object.entries(pixels)) {
    const v = vals as number[];
    console.log(`  ${name}: K=(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}) weight=${v[3].toFixed(3)}`);
  }

  // Canvas RGB readback — what the compositor actually displays
  // Use CANVAS dimensions (viewport), not surface dimensions (2048×2048)
  const canvasPixels = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const canvas = document.querySelector('canvas')!;
    const w = canvas.width;
    const h = canvas.height;
    return {
      dims: { w, h },
      sky: await ghz.readCanvasPixel(Math.round(w * 0.5), Math.round(h * 0.10)),
      horizon: await ghz.readCanvasPixel(Math.round(w * 0.3), Math.round(h * 0.30)),
      hedge: await ghz.readCanvasPixel(Math.round(w * 0.50), Math.round(h * 0.43)),
      figure: await ghz.readCanvasPixel(Math.round(w * 0.28), Math.round(h * 0.48)),
      tram_center: await ghz.readCanvasPixel(Math.round(w * 0.84), Math.round(h * 0.42)),
      tram_hot: await ghz.readCanvasPixel(Math.round(w * 0.84), Math.round(h * 0.38)),
      road: await ghz.readCanvasPixel(Math.round(w * 0.45), Math.round(h * 0.65)),
    };
  });
  console.log(`\n--- Canvas RGB (compositor output, canvas=${(canvasPixels as any).dims.w}×${(canvasPixels as any).dims.h}) ---`);
  for (const [name, vals] of Object.entries(canvasPixels)) {
    if (name === 'dims') continue;
    const v = vals as number[];
    console.log(`  ${name}: RGB(${v[0]}, ${v[1]}, ${v[2]}) A=${v[3]}`);
  }

  const fig = pixels.figure as number[];
  const figRatio = Math.min(...[fig[0], fig[1], fig[2]]) > 0
    ? Math.max(fig[0], fig[1], fig[2]) / Math.min(fig[0], fig[1], fig[2]) : 999;
  console.log(`  figure K ratio: ${figRatio.toFixed(2)} (< 2.0 = neutral)`);

  const tram = pixels.tram_glow as number[];
  console.log(`  tram warmth: K_r/K_b = ${(tram[0] / tram[2]).toFixed(2)} (< 0.8 = warm)`);

  // Horizon should be warm — K_r < K_b (less red absorption = warmer appearance)
  const hor = pixels.horizon as number[];
  console.log(`  horizon warmth: K_r/K_b = ${(hor[0] / hor[2]).toFixed(2)}`);

  console.log(`\nDone! Screenshots: ${OUTPUT_DIR}`);
});
