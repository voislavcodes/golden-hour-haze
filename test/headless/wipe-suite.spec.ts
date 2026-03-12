// Wipe test suite — systematic evaluation of wipe tool behavior
// Tests from ghh-wipe-test-suite.md
// Run: npx playwright test test/headless/wipe-suite.spec.ts

import { test } from '@playwright/test';
import { lineStroke, arcStroke, pressureSteady } from './strokes.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/wipe-suite');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function screenshot(page: any, name: string) {
  await page.evaluate(() => (window as any).__ghz.waitFrames(8));
  await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
  console.log(`  -> ${name}`);
}

async function setupFreshSession(page: any) {
  await page.goto('/?test');
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0); // Golden Hour, board surface
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  });
}

/** Paint a horizontal band with multiple passes for dense coverage */
async function paintBand(page: any, y: number, hueIndex: number, opts: {
  thinners?: number; load?: number; brushSize?: number; xStart?: number; xEnd?: number; passes?: number;
} = {}) {
  const { thinners = 0.15, load = 0.9, brushSize = 0.07, xStart = 0.1, xEnd = 0.9, passes = 3 } = opts;
  for (let pass = 0; pass < passes; pass++) {
    await page.evaluate(async (o: any) => {
      const ghz = (window as any).__ghz;
      await ghz.replayStroke(
        Array.from({ length: 80 }, (_, i) => ({
          x: o.xStart + (i / 79) * (o.xEnd - o.xStart),
          y: o.y + (o.pass - 1) * 0.012,
          pressure: 0.65,
        })),
        { brushSlot: 3, hueIndex: o.hueIndex, brushSize: o.brushSize, thinners: o.thinners, load: o.load }
      );
    }, { y, hueIndex, thinners, load, brushSize, xStart, xEnd, pass });
  }
}

async function readAccum(page: any, x: number, y: number): Promise<number[]> {
  return page.evaluate(async (c: any) => {
    return await (window as any).__ghz.readAccumPixel(c.x, c.y);
  }, { x, y });
}

function fmtAccum(v: number[]) { return v.map(n => n.toFixed(4)).join(', '); }

// ─── Test 1: Baseline ───────────────────────────────────────────────

test('01: baseline — current wipe behavior', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  console.log('Painting thick burnt orange band...');
  await paintBand(page, 0.5, 1, { thinners: 0.2, load: 0.9 });
  await screenshot(page, '01a-paint.png');

  const before = await readAccum(page, 960, 540);
  console.log(`  Before: [${fmtAccum(before)}]`);

  console.log('Wiping vertically through center...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 60 }, (_, i) => ({
        x: 0.5, y: 0.35 + (i / 59) * 0.3, pressure: 0.6,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.7 }
    );
  });
  await screenshot(page, '01b-wipe.png');

  const after = await readAccum(page, 960, 540);
  console.log(`  After:  [${fmtAccum(after)}]`);
  console.log(`  Weight delta: ${(before[3] - after[3]).toFixed(4)} (${((1 - after[3]/before[3]) * 100).toFixed(1)}% removed)`);
});

// ─── Test 2: Wipe Direction ─────────────────────────────────────────

test('02: wipe direction — horizontal vs vertical', async ({ page }) => {
  test.setTimeout(120_000);

  // 2a: Horizontal wipe across horizontal stroke
  await setupFreshSession(page);
  console.log('2a: Paint + horizontal wipe...');
  await paintBand(page, 0.5, 1, { thinners: 0.2, load: 0.9 });
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 60 }, (_, i) => ({
        x: 0.25 + (i / 59) * 0.5, y: 0.5, pressure: 0.6,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.7 }
    );
  });
  await screenshot(page, '02a-horizontal-wipe.png');
  const hAccum = await readAccum(page, 960, 540);
  console.log(`  H-wipe accum: [${fmtAccum(hAccum)}]`);

  // 2b: Vertical wipe across horizontal stroke (fresh session)
  await setupFreshSession(page);
  console.log('2b: Paint + vertical wipe...');
  await paintBand(page, 0.5, 1, { thinners: 0.2, load: 0.9 });
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 60 }, (_, i) => ({
        x: 0.5, y: 0.35 + (i / 59) * 0.3, pressure: 0.6,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.7 }
    );
  });
  await screenshot(page, '02b-vertical-wipe.png');
  const vAccum = await readAccum(page, 960, 540);
  console.log(`  V-wipe accum: [${fmtAccum(vAccum)}]`);
  console.log(`  Difference: H-weight=${hAccum[3].toFixed(4)} V-weight=${vAccum[3].toFixed(4)}`);
});

// ─── Test 3: Wipe Pressure ──────────────────────────────────────────

test('03: wipe pressure — light vs medium vs heavy', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  console.log('Painting wide band...');
  await paintBand(page, 0.5, 1, { thinners: 0.2, load: 0.9 });
  await screenshot(page, '03a-paint.png');

  // Read baseline
  const baseline = await readAccum(page, 400, 540);

  // Light wipe (0.2) on left third
  console.log('Light wipe (0.2) on left...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.25, y: 0.38 + (i / 49) * 0.24, pressure: 0.2,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.7 }
    );
  });

  // Medium wipe (0.5) on center
  console.log('Medium wipe (0.5) on center...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.5, y: 0.38 + (i / 49) * 0.24, pressure: 0.5,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.7 }
    );
  });

  // Heavy wipe (0.8) on right
  console.log('Heavy wipe (0.8) on right...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.75, y: 0.38 + (i / 49) * 0.24, pressure: 0.8,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.7 }
    );
  });
  await screenshot(page, '03b-pressure-comparison.png');

  const light = await readAccum(page, 480, 540);
  const medium = await readAccum(page, 960, 540);
  const heavy = await readAccum(page, 1440, 540);
  console.log(`  Baseline weight: ${baseline[3].toFixed(4)}`);
  console.log(`  Light  (0.2): ${light[3].toFixed(4)} (${((1 - light[3]/baseline[3]) * 100).toFixed(1)}% removed)`);
  console.log(`  Medium (0.5): ${medium[3].toFixed(4)} (${((1 - medium[3]/baseline[3]) * 100).toFixed(1)}% removed)`);
  console.log(`  Heavy  (0.8): ${heavy[3].toFixed(4)} (${((1 - heavy[3]/baseline[3]) * 100).toFixed(1)}% removed)`);
});

// ─── Test 4: Wipe on Different Paint Thickness ──────────────────────

test('04: wipe on thick vs thin paint', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  // Thick paint on left half
  console.log('Painting thick band (left, thinners=0.1)...');
  await paintBand(page, 0.5, 1, { thinners: 0.1, load: 0.9, xStart: 0.05, xEnd: 0.48 });

  // Thin paint on right half
  console.log('Painting thin band (right, thinners=0.7)...');
  await paintBand(page, 0.5, 1, { thinners: 0.7, load: 0.4, xStart: 0.52, xEnd: 0.95 });
  await screenshot(page, '04a-thick-vs-thin.png');

  const thickBefore = await readAccum(page, 480, 540);
  const thinBefore = await readAccum(page, 1440, 540);
  console.log(`  Thick before: weight=${thickBefore[3].toFixed(4)}`);
  console.log(`  Thin before:  weight=${thinBefore[3].toFixed(4)}`);

  // Single vertical wipe through both
  console.log('Wiping vertical pass through both...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    // Wipe through thick (left)
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.25, y: 0.38 + (i / 49) * 0.24, pressure: 0.6,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.3, load: 0.7 }
    );
    // Wipe through thin (right)
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.75, y: 0.38 + (i / 49) * 0.24, pressure: 0.6,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.3, load: 0.7 }
    );
  });
  await screenshot(page, '04b-wipe-both.png');

  const thickAfter = await readAccum(page, 480, 540);
  const thinAfter = await readAccum(page, 1440, 540);
  console.log(`  Thick after:  weight=${thickAfter[3].toFixed(4)} (${((1 - thickAfter[3]/thickBefore[3]) * 100).toFixed(1)}% removed)`);
  console.log(`  Thin after:   weight=${thinAfter[3].toFixed(4)} (${((1 - thinAfter[3]/thinBefore[3]) * 100).toFixed(1)}% removed)`);
  console.log('  Thin paint should lose more % than thick paint');
});

// ─── Test 5: Multiple Wipe Passes ───────────────────────────────────

test('05: multiple wipe passes — convergence to residue floor', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  console.log('Painting band...');
  await paintBand(page, 0.5, 1, { thinners: 0.2, load: 0.9 });

  const weights: number[] = [];
  const initial = await readAccum(page, 960, 540);
  weights.push(initial[3]);
  console.log(`  Pass 0 (initial): weight=${initial[3].toFixed(4)}`);

  for (let pass = 1; pass <= 5; pass++) {
    await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      await ghz.replayStroke(
        Array.from({ length: 50 }, (_, i) => ({
          x: 0.5, y: 0.38 + (i / 49) * 0.24, pressure: 0.6,
        })),
        { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.7 }
      );
    });
    await screenshot(page, `05-pass${pass}.png`);
    const acc = await readAccum(page, 960, 540);
    weights.push(acc[3]);
    const pctRemoved = ((1 - acc[3] / weights[pass - 1]) * 100).toFixed(1);
    console.log(`  Pass ${pass}: weight=${acc[3].toFixed(4)} (${pctRemoved}% removed this pass)`);
  }

  console.log(`\n  Convergence: ${weights.map(w => w.toFixed(3)).join(' → ')}`);
  console.log(`  Total removed: ${((1 - weights[5] / weights[0]) * 100).toFixed(1)}%`);
  console.log('  Should converge toward residue floor (never reach zero)');
});

// ─── Test 6: Wipe Smear ─────────────────────────────────────────────

test('06: wipe smear — paint displacement into bare surface', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  // Paint a concentrated patch in center
  console.log('Painting concentrated patch in center...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    for (let pass = 0; pass < 4; pass++) {
      await ghz.replayStroke(
        Array.from({ length: 30 }, (_, i) => ({
          x: 0.4 + (i / 29) * 0.1,
          y: 0.48 + pass * 0.015,
          pressure: 0.7,
        })),
        { brushSlot: 3, hueIndex: 1, brushSize: 0.05, thinners: 0.15, load: 0.9 }
      );
    }
  });
  await screenshot(page, '06a-patch.png');

  // Read bare surface to the right
  const bareBefore = await readAccum(page, 1200, 540);
  console.log(`  Bare surface before smear: weight=${bareBefore[3].toFixed(4)}`);

  // Wipe from center-right into bare surface
  console.log('Wiping from patch rightward into bare surface...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 60 }, (_, i) => ({
        x: 0.45 + (i / 59) * 0.3,
        y: 0.5,
        pressure: 0.5,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.05, thinners: 0.2, load: 0.6 }
    );
  });
  await screenshot(page, '06b-smear.png');

  const bareAfter = await readAccum(page, 1200, 540);
  console.log(`  Bare surface after smear:  weight=${bareAfter[3].toFixed(4)}`);
  console.log(`  Paint displaced: ${bareAfter[3] > 0.01 ? 'YES — smear working' : 'NO — no displacement'}`);
});

// ─── Test 7: Wipe Across Two Colors ─────────────────────────────────

test('07: wipe across two colors — K-M mixing in smear', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  // Blue patch on left
  console.log('Painting blue patch (left)...');
  await paintBand(page, 0.5, 3, { thinners: 0.2, load: 0.9, xStart: 0.1, xEnd: 0.35 });

  // Yellow patch on right with gap
  console.log('Painting gold patch (right)...');
  await paintBand(page, 0.5, 0, { thinners: 0.2, load: 0.9, xStart: 0.55, xEnd: 0.8 });
  await screenshot(page, '07a-two-colors.png');

  // Read gap before wipe
  const gapBefore = await readAccum(page, 864, 540); // ~0.45 normalized
  console.log(`  Gap before: weight=${gapBefore[3].toFixed(4)}`);

  // Wipe left to right across everything
  console.log('Wiping left to right through blue → gap → gold...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 80 }, (_, i) => ({
        x: 0.15 + (i / 79) * 0.6,
        y: 0.5,
        pressure: 0.5,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.05, thinners: 0.2, load: 0.6 }
    );
  });
  await screenshot(page, '07b-color-smear.png');

  const gapAfter = await readAccum(page, 864, 540);
  console.log(`  Gap after:  weight=${gapAfter[3].toFixed(4)}`);
  console.log(`  Color carried into gap: ${gapAfter[3] > 0.01 ? 'YES' : 'NO'}`);
});

// ─── Test 8: Scrape vs Wipe ─────────────────────────────────────────

test('08: scrape vs wipe — tool comparison', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  // Two identical bands
  console.log('Painting two bands...');
  await paintBand(page, 0.35, 1, { thinners: 0.2, load: 0.9 }); // top band
  await paintBand(page, 0.65, 1, { thinners: 0.2, load: 0.9 }); // bottom band
  await screenshot(page, '08a-two-bands.png');

  const topBefore = await readAccum(page, 960, 378);
  const botBefore = await readAccum(page, 960, 702);

  // Scrape through top band
  console.log('Scraping top band...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.3 + (i / 49) * 0.4, y: 0.35, pressure: 0.6,
      })),
      { tool: 'scrape', brushSlot: 2, brushSize: 0.05 }
    );
  });

  // Wipe through bottom band
  console.log('Wiping bottom band...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.3 + (i / 49) * 0.4, y: 0.65, pressure: 0.6,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.05, thinners: 0.2, load: 0.7 }
    );
  });
  await screenshot(page, '08b-scrape-vs-wipe.png');

  const topAfter = await readAccum(page, 960, 378);
  const botAfter = await readAccum(page, 960, 702);
  console.log(`  Scrape: weight ${topBefore[3].toFixed(4)} → ${topAfter[3].toFixed(4)} (${((1 - topAfter[3]/topBefore[3]) * 100).toFixed(1)}% removed)`);
  console.log(`  Wipe:   weight ${botBefore[3].toFixed(4)} → ${botAfter[3].toFixed(4)} (${((1 - botAfter[3]/botBefore[3]) * 100).toFixed(1)}% removed)`);
  console.log('  Scrape should remove more cleanly; wipe should be softer with residue');
});
