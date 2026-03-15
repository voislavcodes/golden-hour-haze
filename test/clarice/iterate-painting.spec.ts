// Fast iteration test — single reference, paint, screenshot, compare.
// Run: CHROME=1 npx playwright test test/clarice/iterate-painting.spec.ts --project=clarice
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/iterate');
const REF_NAME = 'beckett-reference-3.png';

test.beforeAll(() => { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); });

test('iterate — paint one reference and compare', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) { test.skip(); return; }
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });

  const refPath = path.resolve(__dirname, 'reference', REF_NAME);
  if (!fs.existsSync(refPath)) { test.skip(); return; }
  const base64 = fs.readFileSync(refPath).toString('base64');

  // Extract mood from reference
  const extraction = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0);
    await ghz.waitFrames(5);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    return await ghz.createMoodFromImage('Iterate', blob, 0);
  }, base64);

  console.log(`Palette: [${extraction.colors.map((c: any) =>
    `(L=${c.l.toFixed(2)} C=${c.c.toFixed(3)} H=${Math.round(c.h)})`).join(', ')}]`);

  // Select mood and enter paint phase
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const moods = ghz.getAllMoods();
    ghz.selectMood(moods.length - 1);
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  });

  // Run V3 hierarchy pipeline (ML-enabled)
  const plan = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const imageData = await ghz.downsampleImage(blob, 80, 60);
    const palette = ghz.stores.scene.get().palette;
    const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
    const complement = ghz.getActiveComplement();
    return await ghz.clariceHierarchy(imageData, paletteColors, complement, 80, 60);
  }, base64);

  console.log(`Layers: ${plan.layers.map((l: any) => `${l.name}(${l.strokes.length})`).join(', ')}`);
  console.log(`Total: ${plan.metadata.strokeCount} strokes`);

  // Debug: check meldrumIndex distribution in dark forms layer
  const darkLayer = plan.layers.find((l: any) => l.name === 'Dark Forms');
  if (darkLayer) {
    const melCounts: Record<number, number> = {};
    for (const s of darkLayer.strokes) { melCounts[s.meldrumIndex] = (melCounts[s.meldrumIndex] || 0) + 1; }
    console.log(`Dark Forms meldrum: ${JSON.stringify(melCounts)}`);
  }

  // Diagnostics: region classification + recipes
  const diag = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const imageData = await ghz.downsampleImage(blob, 80, 60);
    const palette = ghz.stores.scene.get().palette;
    const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
    const complement = ghz.getActiveComplement();
    const map = ghz.analyzeTonalStructure(imageData, 80, 60);
    ghz.assignHuesToCells(map, paletteColors);
    const luts = ghz.buildMeldrumLUTs(paletteColors, complement);
    ghz.quantizeCells(map, luts);
    const regions = ghz.extractRegions(map);
    const horizonRow = ghz.detectHorizon(map);
    ghz.classifyAllHeuristic(regions, horizonRow, 60);
    const depths = ghz.mapDepths(regions, horizonRow, 60);
    const recipes = ghz.classifyRecipes(regions, depths);

    const classCounts: Record<string, number> = {};
    const recipeCounts: Record<string, number> = {};
    for (const r of regions) {
      classCounts[r.classification] = (classCounts[r.classification] || 0) + 1;
      const rec = recipes.get(r.id) || 'atmospheric-wash';
      recipeCounts[rec] = (recipeCounts[rec] || 0) + 1;
    }
    // Mass/vertical/accent details
    const shapeDetails = regions
      .filter((r: any) => r.classification === 'mass' || r.classification === 'vertical' || r.classification === 'accent')
      .map((r: any) => {
        const rec = recipes.get(r.id) || 'atmospheric-wash';
        const bw = r.boundingBox.x1 - r.boundingBox.x0 + 1;
        const bh = r.boundingBox.y1 - r.boundingBox.y0 + 1;
        return `${r.classification}[hue=${r.hueIndex} mel=${r.meldrumIndex} ${bw}x${bh} cx=${r.centroid.x.toFixed(2)},cy=${r.centroid.y.toFixed(2)} c=${r.maxChroma.toFixed(3)} →${rec}]`;
      });

    return { regionCount: regions.length, horizonRow, classCounts, recipeCounts, shapeDetails };
  }, base64);

  console.log(`Regions: ${diag.regionCount}, horizon at row ${diag.horizonRow}`);
  console.log(`Classes: ${JSON.stringify(diag.classCounts)}`);
  console.log(`Recipes: ${JSON.stringify(diag.recipeCounts)}`);
  console.log(`Shapes: ${diag.shapeDetails.join('\n  ')}`);

  // Execute painting layer by layer (skip empty layers)
  for (let li = 0; li < plan.layers.length; li++) {
    const layer = plan.layers[li];
    if (layer.strokes.length === 0) continue;
    const isVeil = layer.name === 'Veil';

    await page.evaluate(async (args: { layerData: any; isVeil: boolean }) => {
      const ghz = (window as any).__ghz;
      const dryFrames = args.isVeil ? 60 : 30;
      ghz.setTimeMultiplier(10);
      await ghz.waitFrames(dryFrames);
      ghz.setTimeMultiplier(1);
      ghz.wipeOnRag();
      ghz.wipeBrush();
      await ghz.waitFrames(2);

      for (const stroke of args.layerData.strokes) {
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
    }, { layerData: layer, isVeil });

    // Screenshot after each layer
    await page.evaluate(() => (window as any).__ghz.waitFrames(8));
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${String(li).padStart(2,'0')}-${layer.name.toLowerCase().replace(/\s+/g,'-')}.png`) });
  }

  // Final
  await page.evaluate(() => (window as any).__ghz.waitFrames(20));
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'final.png') });

  // Basic sanity: painting should have some strokes
  expect(plan.metadata.strokeCount).toBeGreaterThan(100);
  console.log(`Done! Screenshots in ${OUTPUT_DIR}`);
});
