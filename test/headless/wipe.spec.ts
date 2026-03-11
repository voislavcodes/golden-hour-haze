// Wipe/rag physics test — verifies directional smear, pressure sensitivity,
// cloth contact, residue floor, rag contamination, dry paint resistance
// Run: npm run test:draw

import { test } from '@playwright/test';
import { bezierStroke, lineStroke, arcStroke, pressureSwell, pressureSteady } from './strokes.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/wipe');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function screenshot(page: any, name: string) {
  await page.evaluate(() => (window as any).__ghz.waitFrames(8));
  await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
  console.log(`  -> ${name}`);
}

test('rag physics — smear, lift, pressure, cloth', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/?test');
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });

  // Setup: Golden Hour mood, board surface (residueFloor 0.03), advance to paint
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0);
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  });

  await screenshot(page, '00-blank-board.png');

  // --- Phase 1: Lay down paint to wipe ---
  // Thick horizontal band of warm gold (high load, low thinners = thick wet paint)
  console.log('Phase 1: Laying down paint...');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    // Thick warm gold band across upper third
    await ghz.replayStroke(
      // Two overlapping passes for thick coverage
      Array.from({ length: 80 }, (_, i) => ({
        x: 0.05 + (i / 79) * 0.9,
        y: 0.3 + Math.sin(i / 79 * Math.PI) * 0.02,
        pressure: 0.6,
      })),
      { brushSlot: 3, hueIndex: 0, brushSize: 0.08, thinners: 0.15, load: 0.9 }
    );
  });
  await screenshot(page, '01-gold-band.png');

  // Second pass to thicken
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 60 }, (_, i) => ({
        x: 0.1 + (i / 59) * 0.8,
        y: 0.32,
        pressure: 0.7,
      })),
      { brushSlot: 3, hueIndex: 0, brushSize: 0.07, thinners: 0.1, load: 0.85 }
    );
  });
  await screenshot(page, '02-gold-thick.png');

  // Burnt orange band in middle
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 80 }, (_, i) => ({
        x: 0.05 + (i / 79) * 0.9,
        y: 0.5,
        pressure: 0.55,
      })),
      { brushSlot: 3, hueIndex: 1, brushSize: 0.07, thinners: 0.2, load: 0.8 }
    );
  });
  await screenshot(page, '03-orange-band.png');

  // Blue band in lower third
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 80 }, (_, i) => ({
        x: 0.05 + (i / 79) * 0.9,
        y: 0.7,
        pressure: 0.5,
      })),
      { brushSlot: 3, hueIndex: 3, brushSize: 0.06, thinners: 0.25, load: 0.75 }
    );
  });
  await screenshot(page, '04-three-bands.png');

  // --- Phase 2: Wipe tests ---
  console.log('Phase 2: Wipe tests...');

  // Test A: Light pressure horizontal wipe across gold band (should SMEAR/BLEND)
  console.log('  Test A: Light pressure wipe (blend mode)');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.15 + (i / 49) * 0.3,
        y: 0.3,
        pressure: 0.2,  // LIGHT pressure
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.05, thinners: 0.15, load: 0.7 }
    );
  });
  await screenshot(page, '05-wipe-light-horizontal.png');

  // Test B: Heavy pressure horizontal wipe across gold band (should REMOVE more)
  console.log('  Test B: Heavy pressure wipe (removal mode)');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.55 + (i / 49) * 0.3,
        y: 0.3,
        pressure: 0.8,  // HEAVY pressure
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.05, thinners: 0.15, load: 0.7 }
    );
  });
  await screenshot(page, '06-wipe-heavy-horizontal.png');

  // Test C: Diagonal wipe across orange band (test directional smear)
  console.log('  Test C: Diagonal wipe (directional smear)');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 60 }, (_, i) => ({
        x: 0.2 + (i / 59) * 0.4,
        y: 0.45 + (i / 59) * 0.1,
        pressure: 0.4,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.06, thinners: 0.2, load: 0.6 }
    );
  });
  await screenshot(page, '07-wipe-diagonal-smear.png');

  // Test D: Vertical wipe crossing all three bands (smear should carry color between bands)
  console.log('  Test D: Vertical cross-band wipe');
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 80 }, (_, i) => ({
        x: 0.5,
        y: 0.2 + (i / 79) * 0.6,
        pressure: 0.45,
      })),
      { tool: 'wipe', brushSlot: 3, brushSize: 0.04, thinners: 0.2, load: 0.5 }
    );
  });
  await screenshot(page, '08-wipe-vertical-crossband.png');

  // Test E: Circular wipe on blue band (test curved smear direction tracking)
  console.log('  Test E: Circular wipe');
  const circlePoints = arcStroke(0.5, 0.7, 0.1, 0, Math.PI * 1.5, 60, pressureSteady);
  await page.evaluate(async (pts) => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(pts, { tool: 'wipe', brushSlot: 2, brushSize: 0.04, thinners: 0.2, load: 0.5 });
  }, circlePoints);
  await screenshot(page, '09-wipe-circular.png');

  // Test F: Multiple wipes in same spot (rag contamination should build up)
  console.log('  Test F: Repeated wipes (rag contamination)');
  for (let pass = 0; pass < 3; pass++) {
    await page.evaluate(async (p) => {
      const ghz = (window as any).__ghz;
      await ghz.replayStroke(
        Array.from({ length: 40 }, (_, i) => ({
          x: 0.75 + (i / 39) * 0.15,
          y: 0.5,
          pressure: 0.5,
        })),
        { tool: 'wipe', brushSlot: 2, brushSize: 0.05, thinners: 0.2, load: 0.5 }
      );
    }, pass);
  }
  await screenshot(page, '10-wipe-repeated-contamination.png');

  // Test G: Wipe with very high thinners (should lift more easily)
  console.log('  Test G: High-thinners wipe');
  // First lay fresh thinned paint
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.05 + (i / 49) * 0.4,
        y: 0.88,
        pressure: 0.5,
      })),
      { brushSlot: 2, hueIndex: 2, brushSize: 0.05, thinners: 0.7, load: 0.6 }
    );
  });
  await screenshot(page, '11-thinned-mauve.png');

  // Wipe the thinned paint — should lift easily
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.replayStroke(
      Array.from({ length: 50 }, (_, i) => ({
        x: 0.1 + (i / 49) * 0.3,
        y: 0.88,
        pressure: 0.4,
      })),
      { tool: 'wipe', brushSlot: 2, brushSize: 0.05, thinners: 0.7, load: 0.5 }
    );
  });
  await screenshot(page, '12-wipe-thinned-easy-lift.png');

  // Final composite
  await screenshot(page, 'final.png');
  console.log(`\nWipe test complete! Screenshots in ${OUTPUT_DIR}`);
});
