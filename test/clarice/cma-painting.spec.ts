// CMA-ES painting worker — headless painting from parameter vector.
// Reads params.json (vector + reference image name), paints, screenshots candidate.png.
// Run: CHROME=1 npx playwright test test/clarice/cma-painting.spec.ts --project=clarice
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CMA_DIR = process.env.CMA_WORK_DIR || path.resolve(__dirname, '../output/cma');
const PARAMS_PATH = path.join(CMA_DIR, 'params.json');
const CANDIDATE_PATH = path.join(CMA_DIR, 'candidate.png');

test.beforeAll(() => { fs.mkdirSync(CMA_DIR, { recursive: true }); });

test('cma — paint from parameter vector', async ({ page }) => {
  test.setTimeout(300_000);

  // Read params.json — written by the Python CMA-ES optimizer
  if (!fs.existsSync(PARAMS_PATH)) {
    console.log('No params.json found — skipping');
    test.skip();
    return;
  }
  const paramsData = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf-8'));
  const paramVector: number[] = paramsData.vector;
  const refName: string = paramsData.reference;
  expect(paramVector).toHaveLength(47);

  // Load reference image
  const refPath = path.resolve(__dirname, 'reference', refName);
  if (!fs.existsSync(refPath)) {
    console.log(`Reference ${refName} not found — skipping`);
    test.skip();
    return;
  }
  const base64 = fs.readFileSync(refPath).toString('base64');
  const mimeType = refName.endsWith('.jpg') || refName.endsWith('.jpeg')
    ? 'image/jpeg' : 'image/png';

  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) { test.skip(); return; }
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });

  // Extract mood from reference
  await page.evaluate(async (args: { b64: string; mime: string }) => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0);
    await ghz.waitFrames(5);
    const binary = atob(args.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: args.mime });
    await ghz.createMoodFromImage('CMA', blob, 0);
  }, { b64: base64, mime: mimeType });

  // Select extracted mood and enter paint phase
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const moods = ghz.getAllMoods();
    ghz.selectMood(moods.length - 1);
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  });

  // Run vector-parameterized hierarchy pipeline
  const plan = await page.evaluate(async (args: { b64: string; mime: string; vec: number[] }) => {
    const ghz = (window as any).__ghz;
    const binary = atob(args.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: args.mime });
    const imageData = await ghz.downsampleImage(blob, 80, 60);
    const palette = ghz.stores.scene.get().palette;
    const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
    const complement = ghz.getActiveComplement();
    return await ghz.clariceHierarchyWithParams(
      imageData, paletteColors, complement, args.vec, 80, 60,
    );
  }, { b64: base64, mime: mimeType, vec: paramVector });

  console.log(`Layers: ${plan.layers.map((l: any) => `${l.name}(${l.strokes.length})`).join(', ')}`);
  console.log(`Total: ${plan.metadata.strokeCount} strokes`);

  // Execute painting layer by layer
  for (let li = 0; li < plan.layers.length; li++) {
    const layer = plan.layers[li];
    if (layer.strokes.length === 0) continue;
    const isVeil = layer.name === 'Veil';

    await page.evaluate(async (args: { layerData: any; isVeil: boolean }) => {
      const ghz = (window as any).__ghz;
      const dryFrames = args.isVeil ? 20 : 10;
      ghz.setTimeMultiplier(50);
      await ghz.waitFrames(dryFrames);
      ghz.setTimeMultiplier(1);
      ghz.wipeOnRag();
      ghz.wipeBrush();
      await ghz.waitFrames(1);

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
  }

  // Capture canvas pixels directly (no UI chrome)
  await page.evaluate(() => (window as any).__ghz.waitFrames(8));
  const pngBase64 = await page.evaluate(async () => {
    return await (window as any).__ghz.captureCanvasPNG();
  });
  fs.writeFileSync(CANDIDATE_PATH, Buffer.from(pngBase64, 'base64'));

  // Write metadata for the optimizer
  const metaPath = path.join(CMA_DIR, 'result.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    strokeCount: plan.metadata.strokeCount,
    layerCounts: plan.layers.map((l: any) => ({ name: l.name, count: l.strokes.length })),
    timestamp: Date.now(),
  }));

  expect(plan.metadata.strokeCount).toBeGreaterThan(50);
  console.log(`Candidate saved to ${CANDIDATE_PATH}`);
});
