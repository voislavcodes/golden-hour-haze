// Clarice Beckett recreation — foggy Melbourne street scene
// Tonalist method (Meldrum/Beckett): tone is primary, color secondary.
// Mother color (warm cream-grey) permeates everything. 5 tones, narrow value range.
// Forms EMERGE from the dominant tone through layered tonal buildup.
// Figure built in 3 tonal layers (soft outer → medium → dark core) for soft edges.
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

async function armAnchor(page: any) {
  await page.evaluate(() => (window as any).__ghz.toggleAnchor());
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

// Dome-shaped fill for umbrella (elliptical boundary)
async function fillDome(
  page: any, cx: number, yTop: number, yBot: number,
  rx: number, opts: any, passes = 1
) {
  const bs = opts.brushSize || 0.02;
  const spacing = bs * 0.25;
  const ry = (yBot - yTop) / 2;
  const cy = yTop + ry;
  const rows = Math.ceil((yBot - yTop) / spacing);
  for (let pass = 0; pass < passes; pass++) {
    const off = pass * spacing * 0.35;
    for (let i = 0; i < rows; i++) {
      const y = yTop + i * spacing + off;
      if (y > yBot) break;
      const dy = (y - cy) / ry;
      const halfW = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
      if (halfW < bs * 0.5) continue;
      const x0 = cx - halfW * 1.05; // slight leftward bias
      const x1 = cx + halfW * 0.95;
      const n = Math.max(8, Math.round((x1 - x0) * 160));
      await paint(page, H(y, x0, x1, opts.pressure || 0.55, n), opts);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TONALIST METHOD (Meldrum/Beckett):
// 1. Establish dominant tone (mother color) — warm cream-grey EVERYWHERE
// 2. Add tonal variations within a narrow range — most values within 15%
// 3. Build forms from general to specific — large areas → small accents
// 4. Forms EMERGE from the tone, not placed ON it
// 5. Only the figure breaks significantly from the dominant tone
// 6. Color subordinate to tone — only the tram has chromatic character
// 7. Soft edges — forms dissolve into atmosphere (tone on tone layering)
// 8. Figure built in tonal layers: soft outer halo → medium → dark core
// ═══════════════════════════════════════════════════════════════════════════

test('Clarice Beckett — foggy Melbourne street', async ({ page }) => {
  test.setTimeout(600_000);

  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) { test.skip(); return; }
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });

  // --- Select Golden Hour, extract colors bent through its lens ---
  const refPath = path.resolve(__dirname, 'beckett-reference.png');
  const hasRef = fs.existsSync(refPath);

  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0); // Golden Hour
    await ghz.waitFrames(5);
  });

  if (hasRef) {
    const imageBytes = fs.readFileSync(refPath);
    const base64 = imageBytes.toString('base64');
    const extraction = await page.evaluate(async (b64: string) => {
      const ghz = (window as any).__ghz;
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      return await ghz.createMoodFromImage('Beckett Reference', blob, 0);
    }, base64);
    console.log(`Extracted OKLCH: [${extraction.colors.map((c: any) => `(L=${c.l.toFixed(2)} C=${c.c.toFixed(3)} H=${Math.round(c.h)})`).join(', ')}]`);

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

    await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      const moods = ghz.getAllMoods();
      ghz.selectMood(moods.length - 1);
      await ghz.waitFrames(10);
      await ghz.setPhase('paint');
      await ghz.waitFrames(10);
    });

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
    await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      await ghz.waitFrames(10);
      await ghz.setPhase('paint');
      await ghz.waitFrames(10);
    });
  }

  // --- Role mapping ---
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

  function hueDist(a: number, b: number) {
    let d = Math.abs(a - b); if (d > 180) d = 360 - d; return d;
  }
  const bentHues = hasRef
    ? await page.evaluate(() => {
        const ghz = (window as any).__ghz;
        const palette = ghz.stores.scene.get().palette;
        return palette.colors.map((c: any) => {
          const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
          const d = max - min;
          if (d < 0.001) return 0;
          let h = 0;
          if (max === c.r) h = ((c.g - c.b) / d) % 6;
          else if (max === c.g) h = (c.b - c.r) / d + 2;
          else h = (c.r - c.g) / d + 4;
          return ((h * 60) + 360) % 360;
        });
      })
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

  const HEDGE = pickByHue(99);
  const TRAM = pickByHue(45);
  const HORIZON = pickByHue(351);
  const DARK = pickByLum(false);
  const SKY = pickByLum(true);
  const roles = { SKY, HEDGE, DARK, HORIZON, TRAM };
  console.log('Role mapping:', JSON.stringify(roles));

  await snap(page, '00-blank.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 1: MOTHER COLOR — warm cream-grey permeating everything
  // This is the dominant tone that unifies the entire painting.
  // Thick, opaque, 3 passes. Sky and road nearly identical in value.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L1: Mother color...');
  await setTonal(page, HORIZON, 0.20);
  await fill(page, 0.0, 1.0, 0.0, 1.0, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.20, thinners: 0.0, load: 0.85, pressure: 0.55,
  }, 2);
  await snap(page, '01-mother.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 2: TONAL GRADATION — sky slightly darker at top, warm horizon band
  // All within the narrow value range. Road stays as mother color.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L2: Tonal gradation...');
  // Upper sky — notably darker (reference sky is dark warm grey, not white)
  await setTonal(page, SKY, 0.30);
  await fill(page, 0.0, 0.16, 0.0, 1.0, {
    brushSlot: 4, hueIndex: SKY, brushSize: 0.16, thinners: 0.0, load: 0.65, pressure: 0.48,
  });
  // Gradual transition into mid-sky
  await setTonal(page, SKY, 0.22);
  await fill(page, 0.08, 0.28, 0.0, 1.0, {
    brushSlot: 4, hueIndex: SKY, brushSize: 0.20, thinners: 0.01, load: 0.45, pressure: 0.36,
  });
  // Warm horizon band — subtle pink-brown glow
  await setTonal(page, HORIZON, 0.22);
  await fill(page, 0.28, 0.42, 0.0, 1.0, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.10, thinners: 0.01, load: 0.45, pressure: 0.36,
  });
  // Warmer center — where the light source would be (behind fog)
  await setTonal(page, HORIZON, 0.26);
  await fill(page, 0.30, 0.38, 0.10, 0.55, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.08, thinners: 0.01, load: 0.38, pressure: 0.32,
  });
  await snap(page, '02-gradation.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 3: HEDGE — barely visible olive-grey darkening, left side only
  // Should almost disappear into the atmosphere.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L3: Hedge...');
  await wipeRag(page);
  // Main hedge band
  await setTonal(page, HEDGE, 0.28);
  await fill(page, 0.38, 0.44, 0.0, 0.40, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.025, thinners: 0.04, load: 0.30, pressure: 0.26,
  });
  // Denser left section
  await setTonal(page, HEDGE, 0.34);
  await fill(page, 0.39, 0.44, 0.0, 0.20, {
    brushSlot: 2, hueIndex: HEDGE, brushSize: 0.020, thinners: 0.02, load: 0.36, pressure: 0.30,
  });
  // Distant trees above hedge — soft blobs
  await setTonal(page, HEDGE, 0.22);
  for (const [cx, yMid, w] of [
    [0.08, 0.30, 0.05], [0.16, 0.28, 0.05], [0.24, 0.29, 0.04], [0.32, 0.31, 0.03],
  ] as const) {
    await paint(page, H(yMid, cx - w, cx + w, 0.22, 10), {
      brushSlot: 2, hueIndex: HEDGE, brushSize: 0.030, thinners: 0.05, load: 0.20, pressure: 0.18,
    });
  }
  await snap(page, '03-hedge.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 4: GHOST FIGURES — barely darker than atmosphere
  // Warm grey, thin, dissolving. Should almost NOT be there.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L4: Ghosts...');
  await wipeRag(page);
  const ghosts: [number, number, number, number, number, number][] = [
    // [x, yTop, yBot, tonal, passes, brushSize]
    [0.42, 0.38, 0.52, 0.40, 2, 0.014],
    [0.49, 0.40, 0.50, 0.36, 2, 0.012],
    [0.54, 0.41, 0.48, 0.32, 1, 0.010],
  ];
  for (const [gx, gy0, gy1, tv, passes, bs] of ghosts) {
    await setTonal(page, HORIZON, tv);
    for (let p = 0; p < passes; p++) {
      const off = (p - 0.5) * bs * 0.2;
      await paint(page, taperV(gx + off, gy0, gy1, 0.30, 0.12, 14), {
        brushSlot: 1, hueIndex: HORIZON, brushSize: bs, thinners: 0.03, load: 0.34,
      });
    }
  }
  await snap(page, '04-ghosts.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 5: TELEGRAPH POLES — thin dark verticals with organic wobble
  // Short overlapping dabs to avoid bristle depletion.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L5: Poles...');
  await wipeRag(page);
  // Pole 1 — tallest, darkest
  await setTonal(page, HORIZON, 0.72);
  for (let seg = 0; seg < 14; seg++) {
    const y0 = 0.06 + seg * 0.044;
    const y1 = Math.min(0.66, y0 + 0.065);
    for (let p = 0; p < 2; p++) {
      await paint(page, V(0.61 + Math.sin(seg * 0.7) * 0.002, y0, y1, 0.50, 8), {
        brushSlot: 0, hueIndex: HORIZON, brushSize: 0.007, thinners: 0.0, load: 0.88,
      });
    }
  }
  // Pole 2
  await setTonal(page, HORIZON, 0.66);
  for (let seg = 0; seg < 11; seg++) {
    const y0 = 0.08 + seg * 0.048;
    const y1 = Math.min(0.62, y0 + 0.065);
    for (let p = 0; p < 2; p++) {
      await paint(page, V(0.67 + Math.sin(seg * 0.9) * 0.001, y0, y1, 0.44, 8), {
        brushSlot: 0, hueIndex: HORIZON, brushSize: 0.005, thinners: 0.0, load: 0.80,
      });
    }
  }
  // Pole 3 — thinnest
  await setTonal(page, HORIZON, 0.58);
  for (let seg = 0; seg < 8; seg++) {
    const y0 = 0.14 + seg * 0.052;
    const y1 = Math.min(0.56, y0 + 0.065);
    await paint(page, V(0.73 + Math.sin(seg * 1.1) * 0.001, y0, y1, 0.36, 8), {
      brushSlot: 0, hueIndex: HORIZON, brushSize: 0.004, thinners: 0.01, load: 0.62,
    });
  }
  await snap(page, '05-poles.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 6: BOLLARDS — small dark marks along the road edge
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L6: Bollards...');
  await wipeRag(page);
  await setTonal(page, HORIZON, 0.64);
  for (const bx of [0.36, 0.42, 0.48, 0.54]) {
    for (let p = 0; p < 3; p++) {
      await paint(page, dash(bx + p * 0.001, 0.54, 0.04, 0.44), {
        brushSlot: 0, hueIndex: HORIZON, brushSize: 0.008, thinners: 0.0, load: 0.66,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 7: FIGURE — darkest element, built in 3 tonal layers
  // Outer halo (medium grey) → middle (darker) → core (darkest)
  // Creates naturally soft edges through tonal layering.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L7: Figure...');
  await wipeRag(page);

  // --- Layer A: Medium tone — flat-topped dome + body ---
  // NOT elliptical — stacked rectangular fills that taper naturally
  await setTonal(page, HORIZON, 0.70);
  // Umbrella: flat crown, then tapering sides
  await fill(page, 0.24, 0.27, 0.220, 0.340, {
    brushSlot: 1, hueIndex: HORIZON, brushSize: 0.018, thinners: 0.0, load: 0.68, pressure: 0.48,
  });
  await fill(page, 0.27, 0.29, 0.235, 0.325, {
    brushSlot: 1, hueIndex: HORIZON, brushSize: 0.016, thinners: 0.0, load: 0.66, pressure: 0.46,
  });
  await fill(page, 0.29, 0.31, 0.255, 0.305, {
    brushSlot: 0, hueIndex: HORIZON, brushSize: 0.014, thinners: 0.0, load: 0.64, pressure: 0.44,
  });
  // Body — wide column
  for (let p = 0; p < 3; p++) {
    await paint(page, taperV(0.274 + p * 0.005, 0.31, 0.54, 0.52, 0.38, 24), {
      brushSlot: 0, hueIndex: HORIZON, brushSize: 0.014, thinners: 0.0, load: 0.68,
    });
  }

  // --- Layer B: Dark core ---
  await setTonal(page, HORIZON, 0.92);
  // Umbrella dark: narrower version of crown shape
  await fill(page, 0.25, 0.27, 0.235, 0.325, {
    brushSlot: 0, hueIndex: HORIZON, brushSize: 0.014, thinners: 0.0, load: 0.88, pressure: 0.60,
  }, 2);
  await fill(page, 0.27, 0.29, 0.250, 0.310, {
    brushSlot: 0, hueIndex: HORIZON, brushSize: 0.012, thinners: 0.0, load: 0.86, pressure: 0.58,
  });
  // Body dark core — narrow central column
  for (let p = 0; p < 5; p++) {
    await paint(page, taperV(0.276 + p * 0.002, 0.29, 0.53, 0.64, 0.48, 26), {
      brushSlot: 0, hueIndex: HORIZON, brushSize: 0.011, thinners: 0.0, load: 0.90,
    });
  }
  // Coat widening at hem
  for (let p = 0; p < 2; p++) {
    await paint(page, H(0.52, 0.258, 0.302, 0.52, 10), {
      brushSlot: 0, hueIndex: HORIZON, brushSize: 0.010, thinners: 0.0, load: 0.80,
    });
    await paint(page, H(0.53, 0.262, 0.298, 0.48, 8), {
      brushSlot: 0, hueIndex: HORIZON, brushSize: 0.008, thinners: 0.0, load: 0.76,
    });
  }
  // Legs — thin, dissolving into reflection
  await setTonal(page, HORIZON, 0.84);
  for (let p = 0; p < 3; p++) {
    await paint(page, taperV(0.272, 0.53, 0.62, 0.42, 0.14, 12), {
      brushSlot: 0, hueIndex: HORIZON, brushSize: 0.005, thinners: 0.0, load: 0.74,
    });
    await paint(page, taperV(0.288, 0.53, 0.62, 0.42, 0.14, 12), {
      brushSlot: 0, hueIndex: HORIZON, brushSize: 0.005, thinners: 0.0, load: 0.74,
    });
  }
  await snap(page, '06-figure.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 8: TRAM — small warm accent emerging from fog
  // The ONLY chromatic note. Soft edges, emerging not placed.
  // Warm glow first, then anchor+oil center.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L8: Tram...');
  await wipeRag(page);
  // Warm atmospheric glow around tram area
  await setTonal(page, TRAM, 0.24);
  await fill(page, 0.32, 0.50, 0.76, 0.94, {
    brushSlot: 4, hueIndex: TRAM, brushSize: 0.04, thinners: 0.04, load: 0.26, pressure: 0.22,
  });
  // Base warm fill — muted, no anchor
  await setTonal(page, TRAM, 0.38);
  await fill(page, 0.35, 0.47, 0.80, 0.90, {
    brushSlot: 3, hueIndex: TRAM, brushSize: 0.028, thinners: 0.01, load: 0.48, pressure: 0.38,
  });
  // Vivid center — anchor+oil, fill for uniform coverage
  await setTonal(page, TRAM, 0.44);
  // Each fill row needs anchor+oil re-armed, so do it row by row
  const tramBS = 0.024;
  const tramSpacing = tramBS * 0.20;
  for (let y = 0.37; y <= 0.45; y += tramSpacing) {
    await armAnchor(page);
    await armOil(page);
    await paint(page, H(y, 0.82, 0.88, 0.46, 14), {
      brushSlot: 2, hueIndex: TRAM, brushSize: tramBS, thinners: 0.0, load: 0.62,
    });
  }
  // Subtle dark structure hints
  await wipeRag(page);
  await setTonal(page, HORIZON, 0.60);
  await paint(page, H(0.34, 0.79, 0.91, 0.32, 14), {
    brushSlot: 0, hueIndex: HORIZON, brushSize: 0.005, thinners: 0.01, load: 0.48,
  });
  await paint(page, H(0.47, 0.79, 0.91, 0.30, 14), {
    brushSlot: 0, hueIndex: HORIZON, brushSize: 0.004, thinners: 0.01, load: 0.42,
  });
  await snap(page, '07-tram.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 9: REFLECTIONS — subtle vertical smears on wet road
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L9: Reflections...');
  // Figure reflection
  await setTonal(page, HORIZON, 0.46);
  for (let p = 0; p < 3; p++) {
    await paint(page, taperV(0.28 + p * 0.003, 0.62, 0.82, 0.32, 0.08, 20), {
      brushSlot: 1, hueIndex: HORIZON, brushSize: 0.008, thinners: 0.02, load: 0.38,
    });
  }
  // Pole reflections
  await setTonal(page, HORIZON, 0.38);
  await paint(page, taperV(0.61, 0.60, 0.78, 0.20, 0.04, 18), {
    brushSlot: 0, hueIndex: HORIZON, brushSize: 0.004, thinners: 0.03, load: 0.28,
  });
  await paint(page, taperV(0.67, 0.58, 0.74, 0.16, 0.04, 16), {
    brushSlot: 0, hueIndex: HORIZON, brushSize: 0.003, thinners: 0.03, load: 0.24,
  });
  // Tram reflection — warm vertical glow
  await setTonal(page, TRAM, 0.30);
  for (let p = 0; p < 2; p++) {
    await armAnchor(page);
    await armOil(page);
    await paint(page, taperV(0.85 + p * 0.004, 0.50, 0.72, 0.28, 0.06, 18), {
      brushSlot: 2, hueIndex: TRAM, brushSize: 0.014, thinners: 0.02, load: 0.36,
    });
  }
  await snap(page, '08-reflections.png');

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 10: ATMOSPHERIC VEIL — final fog unification
  // Thin warm glazes push everything back into the atmosphere.
  // This makes forms DISSOLVE into fog — the key tonalist effect.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('L10: Atmospheric veil...');
  await wipeRag(page);
  // Sky fog
  await setTonal(page, HORIZON, 0.06);
  await fill(page, 0.0, 0.22, 0.0, 1.0, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.16, thinners: 0.07, load: 0.12, pressure: 0.12,
  });
  // Mid-ground fog — LEFT of figure
  await setTonal(page, HORIZON, 0.08);
  await fill(page, 0.22, 0.56, 0.0, 0.21, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.10, thinners: 0.06, load: 0.12, pressure: 0.11,
  });
  // Mid-ground fog — between figure and poles
  await fill(page, 0.34, 0.56, 0.35, 0.58, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.10, thinners: 0.06, load: 0.12, pressure: 0.11,
  });
  // Road haze — avoid figure reflection (x=0.22-0.34) and tram (x>0.76)
  await setTonal(page, HORIZON, 0.06);
  await fill(page, 0.62, 0.90, 0.0, 0.20, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.14, thinners: 0.07, load: 0.10, pressure: 0.10,
  });
  await fill(page, 0.62, 0.90, 0.36, 0.74, {
    brushSlot: 4, hueIndex: HORIZON, brushSize: 0.14, thinners: 0.07, load: 0.10, pressure: 0.10,
  });

  await page.evaluate(() => (window as any).__ghz.waitFrames(20));
  await snap(page, 'final.png');

  // ── Diagnostics ─────────────────────────────────────────────────────────
  const pixels = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const w = ghz.getSurfaceDimensions().width;
    const h = ghz.getSurfaceDimensions().height;
    return {
      sky: await ghz.readAccumPixel(Math.round(w * 0.5), Math.round(h * 0.10)),
      horizon: await ghz.readAccumPixel(Math.round(w * 0.40), Math.round(h * 0.34)),
      hedge: await ghz.readAccumPixel(Math.round(w * 0.15), Math.round(h * 0.42)),
      figure: await ghz.readAccumPixel(Math.round(w * 0.28), Math.round(h * 0.40)),
      road: await ghz.readAccumPixel(Math.round(w * 0.45), Math.round(h * 0.65)),
      tram: await ghz.readAccumPixel(Math.round(w * 0.85), Math.round(h * 0.41)),
      pole: await ghz.readAccumPixel(Math.round(w * 0.61), Math.round(h * 0.30)),
      ghost: await ghz.readAccumPixel(Math.round(w * 0.42), Math.round(h * 0.45)),
    };
  });
  console.log('\n--- Accumulation pixel values (K_r, K_g, K_b, weight) ---');
  for (const [name, vals] of Object.entries(pixels)) {
    const v = vals as number[];
    console.log(`  ${name}: K=(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}) weight=${v[3].toFixed(3)}`);
  }

  const canvasPixels = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const canvas = document.querySelector('canvas')!;
    const w = canvas.width;
    const h = canvas.height;
    return {
      dims: { w, h },
      sky: await ghz.readCanvasPixel(Math.round(w * 0.5), Math.round(h * 0.10)),
      horizon: await ghz.readCanvasPixel(Math.round(w * 0.40), Math.round(h * 0.34)),
      figure: await ghz.readCanvasPixel(Math.round(w * 0.28), Math.round(h * 0.40)),
      tram: await ghz.readCanvasPixel(Math.round(w * 0.85), Math.round(h * 0.41)),
      road: await ghz.readCanvasPixel(Math.round(w * 0.45), Math.round(h * 0.65)),
    };
  });
  console.log(`\n--- Canvas readback (${(canvasPixels as any).dims.w}×${(canvasPixels as any).dims.h}, BGRA on macOS) ---`);
  for (const [name, vals] of Object.entries(canvasPixels)) {
    if (name === 'dims') continue;
    const v = vals as number[];
    console.log(`  ${name}: raw=(${v[0]}, ${v[1]}, ${v[2]}) → RGB(${v[2]}, ${v[1]}, ${v[0]})`);
  }

  const statePixels = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const w = ghz.getSurfaceDimensions().width;
    const h = ghz.getSurfaceDimensions().height;
    return {
      tram: await ghz.readStatePixel(Math.round(w * 0.85), Math.round(h * 0.41)),
      figure: await ghz.readStatePixel(Math.round(w * 0.28), Math.round(h * 0.40)),
    };
  });
  console.log('\n--- Paint state (time, thinners, oil, anchor) ---');
  for (const [name, vals] of Object.entries(statePixels)) {
    const v = vals as number[];
    console.log(`  ${name}: time=${v[0].toFixed(2)} thin=${v[1].toFixed(3)} oil=${v[2].toFixed(3)} anchor=${v[3].toFixed(3)}`);
  }

  console.log(`\nDone! Screenshots: ${OUTPUT_DIR}`);
});
