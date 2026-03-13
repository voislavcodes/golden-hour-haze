// Tonal Recreation — procedural painting from reference image
// Analyzes beckett-reference.png, builds a painting plan via Meldrum 5-tone quantization,
// and executes strokes layer by layer following tonalist principles.
// Run: CHROME=1 npx playwright test test/headless/tonal-recreation.spec.ts --headed

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/tonal-recreation');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function snap(page: any, name: string) {
  await page.evaluate(() => (window as any).__ghz.waitFrames(8));
  await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
  console.log(`  -> ${name}`);
}

test('Tonal recreation — procedural Beckett from reference', async ({ page }) => {
  test.setTimeout(600_000);

  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) { test.skip(); return; }
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });

  // --- Load reference image ---
  const refPath = path.resolve(__dirname, 'beckett-reference.png');
  if (!fs.existsSync(refPath)) {
    console.log('No beckett-reference.png found, skipping');
    test.skip();
    return;
  }

  const imageBytes = fs.readFileSync(refPath);
  const base64 = imageBytes.toString('base64');

  // --- Apply Golden Hour mood, extract colors from reference ---
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0); // Golden Hour
    await ghz.waitFrames(5);
  });

  const extraction = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    return await ghz.createMoodFromImage('Tonal Recreation', blob, 0);
  }, base64);
  console.log(`Extracted OKLCH: [${extraction.colors.map((c: any) => `(L=${c.l.toFixed(2)} C=${c.c.toFixed(3)} H=${Math.round(c.h)})`).join(', ')}]`);

  // Select the extracted mood and enter paint phase
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const moods = ghz.getAllMoods();
    ghz.selectMood(moods.length - 1);
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  });

  await snap(page, '00-blank.png');

  // --- Analyze reference image ---
  const analysis = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    return await ghz.analyzeImage(blob, 40, 30);
  }, base64);

  // --- Sanity checks ---
  const { plan, map, luts, spanCount } = analysis;
  console.log(`\n--- Tonal Analysis ---`);
  console.log(`  Grid: ${map.cols}×${map.rows}`);
  console.log(`  Mother tone (OKLab L): ${map.motherTone.toFixed(3)}`);
  console.log(`  Mother hue index: ${map.motherHueIndex}`);
  console.log(`  Span count: ${spanCount}`);
  console.log(`  Total strokes: ${plan.metadata.strokeCount}`);

  // LUT monotonicity check: luminance should decrease WHITE→BLACK
  console.log(`\n--- Meldrum LUTs (L at each tonal step) ---`);
  for (const lut of luts) {
    const vals = lut.luminances.map((v: number) => v.toFixed(3));
    const monotonic = lut.luminances[0] >= lut.luminances[4];
    console.log(`  Hue ${lut.hueIndex}: [${vals.join(', ')}] ${monotonic ? 'OK' : 'NOT MONOTONIC'}`);
    expect(monotonic, `LUT hue ${lut.hueIndex} should be monotonically decreasing`).toBe(true);
  }

  // Stroke budget
  console.log(`\n--- Layer stroke counts ---`);
  for (const layer of plan.layers) {
    console.log(`  ${layer.name}: ${layer.strokes.length} strokes`);
  }
  expect(plan.metadata.strokeCount).toBeLessThan(600);

  // --- Execute painting plan layer by layer ---
  for (let li = 0; li < plan.layers.length; li++) {
    const layer = plan.layers[li];
    console.log(`\nPainting layer ${li + 1}/${plan.layers.length}: ${layer.name} (${layer.strokes.length} strokes)...`);

    await page.evaluate(async (layerData: any) => {
      const ghz = (window as any).__ghz;

      // Wipe rag between layers for clean brush
      ghz.wipeOnRag();
      ghz.wipeBrush();
      await ghz.waitFrames(2);

      for (const stroke of layerData.strokes) {
        ghz.setTonalIndex(stroke.hueIndex, stroke.meldrumIndex);

        if (stroke.useOil) ghz.toggleOil();
        if (stroke.useAnchor) ghz.toggleAnchor();

        await ghz.replayStroke(stroke.points, {
          brushSlot: stroke.brushSlot,
          brushSize: stroke.brushSize,
          hueIndex: stroke.hueIndex,
          thinners: stroke.thinners,
          load: stroke.load,
        });
      }
    }, layer);

    const padded = String(li + 1).padStart(2, '0');
    await snap(page, `${padded}-${layer.name.toLowerCase().replace(/\s+/g, '-')}.png`);
  }

  // Final frame with extra settling
  await page.evaluate(() => (window as any).__ghz.waitFrames(20));
  await snap(page, '07-final.png');

  // --- Pixel spot checks ---
  const pixels = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const w = ghz.getSurfaceDimensions().width;
    const h = ghz.getSurfaceDimensions().height;
    return {
      sky: await ghz.readCanvasPixel(Math.round(w * 0.5), Math.round(h * 0.10)),
      figure: await ghz.readCanvasPixel(Math.round(w * 0.28), Math.round(h * 0.40)),
      tram: await ghz.readCanvasPixel(Math.round(w * 0.85), Math.round(h * 0.41)),
    };
  });

  console.log(`\n--- Canvas pixel spot checks (BGRA on macOS) ---`);
  for (const [name, vals] of Object.entries(pixels)) {
    const v = vals as number[];
    console.log(`  ${name}: raw=(${v[0]}, ${v[1]}, ${v[2]}) → RGB(${v[2]}, ${v[1]}, ${v[0]})`);
  }

  // Sky should be warm cream-grey (light values)
  const sky = pixels.sky as number[];
  expect(sky[0]).toBeGreaterThan(100); // B channel
  expect(sky[1]).toBeGreaterThan(100); // G channel
  expect(sky[2]).toBeGreaterThan(100); // R channel

  // Figure area should be darker than sky
  const figure = pixels.figure as number[];
  const skyLum = sky[0] + sky[1] + sky[2];
  const figLum = figure[0] + figure[1] + figure[2];
  console.log(`  Sky luminance sum: ${skyLum}, Figure luminance sum: ${figLum}`);

  console.log(`\nDone! Screenshots: ${OUTPUT_DIR}`);
});
