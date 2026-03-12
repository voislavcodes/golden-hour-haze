// Tonal complement mixing test — verifies dark tones converge toward neutral grey
// Run: npm run test:draw

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

test('tonal columns converge to neutral dark', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/?test');

  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) {
    console.error('\n  WebGPU not available.\n');
    test.skip();
    return;
  }

  await page.waitForFunction(
    () => (window as any).__ghz?.ready === true,
    null, { timeout: 30_000 },
  );

  // --- CPU-side K-channel convergence test ---
  // At tonal value 0.95 with complement, K channels should be nearly equal (neutral)
  const convergence = await page.evaluate(() => {
    const ghz = (window as any).__ghz;
    const comp = ghz.DEFAULT_COMPLEMENT;
    const palette = ghz.stores.scene.get().palette;
    const results: { hue: number; ratio: number; kr: number; kg: number; kb: number }[] = [];

    for (let i = 0; i < palette.colors.length; i++) {
      const baseColor = palette.colors[i];
      const color = ghz.sampleTonalColumn(baseColor, 0.95, comp);

      // Convert to K-S space to check channel equality
      const rr = Math.max(color.r * color.r, 0.001);
      const rg = Math.max(color.g * color.g, 0.001);
      const rb = Math.max(color.b * color.b, 0.001);
      const kr = (1 - rr) * (1 - rr) / (2 * rr);
      const kg = (1 - rg) * (1 - rg) / (2 * rg);
      const kb = (1 - rb) * (1 - rb) / (2 * rb);

      const maxK = Math.max(kr, kg, kb);
      const minK = Math.min(kr, kg, kb);
      const ratio = minK > 0 ? maxK / minK : 999;

      results.push({ hue: i, ratio, kr, kg, kb });
    }
    return results;
  });

  console.log('K-channel convergence at tonal 0.95:');
  for (const r of convergence) {
    console.log(`  Hue ${r.hue}: ratio=${r.ratio.toFixed(2)} (Kr=${r.kr.toFixed(2)}, Kg=${r.kg.toFixed(2)}, Kb=${r.kb.toFixed(2)})`);
    // Near-neutral means max(K)/min(K) < 1.5
    expect(r.ratio).toBeLessThan(1.5);
  }

  // --- Verify no complement effect before onset ---
  const noEffect = await page.evaluate(() => {
    const ghz = (window as any).__ghz;
    const comp = ghz.DEFAULT_COMPLEMENT;
    const palette = ghz.stores.scene.get().palette;
    const baseColor = palette.colors[0];

    // At value 0.3 (well before onset of 0.55), complement should have no effect
    const withComp = ghz.sampleTonalColumn(baseColor, 0.3, comp);
    const withoutComp = ghz.sampleTonalColumn(baseColor, 0.3);

    return {
      diffR: Math.abs(withComp.r - withoutComp.r),
      diffG: Math.abs(withComp.g - withoutComp.g),
      diffB: Math.abs(withComp.b - withoutComp.b),
    };
  });

  expect(noEffect.diffR).toBeLessThan(0.001);
  expect(noEffect.diffG).toBeLessThan(0.001);
  expect(noEffect.diffB).toBeLessThan(0.001);

  // --- Paint gradient strips for visual verification ---
  const bridge = () => page.evaluate(() => (window as any).__ghz);

  // Set up mood and enter paint mode
  await page.evaluate(() => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0); // Golden Hour
  });
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    await ghz.setPhase('paint');
  });

  // Paint 5 vertical gradient strips (one per hue) from tonal 0.0 to 1.0
  for (let hue = 0; hue < 5; hue++) {
    const xCenter = 0.1 + hue * 0.18; // Space columns across canvas

    for (let step = 0; step < 20; step++) {
      const tonalValue = step / 19;
      const y = 0.05 + tonalValue * 0.9;

      // Set tonal value for this hue
      await page.evaluate(({ hueIdx, tv }) => {
        const ghz = (window as any).__ghz;
        const palette = ghz.stores.scene.get().palette;
        const newValues = [...palette.tonalValues];
        newValues[hueIdx] = tv;
        ghz.stores.scene.update((s: any) => ({
          palette: { ...s.palette, tonalValues: newValues },
        }));
      }, { hueIdx: hue, tv: tonalValue });

      // Paint a short horizontal stroke
      await page.evaluate(async ({ x, yPos, hueIdx }) => {
        const ghz = (window as any).__ghz;
        await ghz.replayStroke(
          [
            { x: x - 0.04, y: yPos, pressure: 0.6 },
            { x: x + 0.04, y: yPos, pressure: 0.6 },
          ],
          { hueIndex: hueIdx, brushSlot: 3, brushSize: 0.04, thinners: 0.3, load: 0.8 },
        );
      }, { x: xCenter, yPos: y, hueIdx: hue });
    }
  }

  // Screenshot
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.markAllDirty();
    await ghz.waitFrames(3);
  });

  const screenshot = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'tonal-complement-gradients.png'), screenshot);
  console.log('Saved tonal-complement-gradients.png');
});
