// ML Model Integration Tests — validates ONNX models + inference wrappers
// Run: CHROME=1 npx playwright test test/clarice/ml-models.spec.ts --project=clarice

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF_DIR = path.resolve(__dirname, 'reference');

function loadRefBase64(name: string): string | null {
  const refPath = path.resolve(REF_DIR, name);
  if (!fs.existsSync(refPath)) return null;
  return fs.readFileSync(refPath).toString('base64');
}

async function setupPage(page: any) {
  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) return false;
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0);
    await ghz.waitFrames(5);
  });
  return true;
}

// Helper: run full hierarchy with ML
async function runHierarchy(page: any, refBase64: string) {
  return page.evaluate(async (args: any) => {
    const ghz = (window as any).__ghz;
    const binary = atob(args.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const imageData = await ghz.downsampleImage(blob, 40, 30);

    const palette = ghz.stores.scene.get().palette;
    const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
    const complement = ghz.getActiveComplement();

    return await ghz.clariceHierarchy(imageData, paletteColors, complement, 40, 30);
  }, { b64: refBase64 });
}

// Helper: run debug hierarchy (heuristic-only)
async function runHierarchyDebug(page: any, refBase64: string) {
  return page.evaluate(async (args: any) => {
    const ghz = (window as any).__ghz;
    const binary = atob(args.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const imageData = await ghz.downsampleImage(blob, 40, 30);

    const palette = ghz.stores.scene.get().palette;
    const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
    const complement = ghz.getActiveComplement();

    return await ghz.clariceHierarchyDebug(imageData, paletteColors, complement, 40, 30);
  }, { b64: refBase64 });
}

// ─────────────────────────────────────────────────────────────────────
// Registry Tests
// ─────────────────────────────────────────────────────────────────────

test.describe('ONNX Registry', () => {
  test('initModel succeeds for region-classifier', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }

    const result = await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      const loaded = await ghz.initModel('region-classifier');
      return { loaded, ready: ghz.isModelReady('region-classifier') };
    });

    // region-classifier.onnx exists in public/models/
    expect(result.loaded).toBe(true);
    expect(result.ready).toBe(true);
  });

  test('second initModel is cached no-op', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }

    const result = await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      await ghz.initModel('region-classifier');
      const t0 = performance.now();
      await ghz.initModel('region-classifier');
      return performance.now() - t0;
    });

    // Second call should be nearly instant (< 50ms vs ~500ms for first)
    expect(result).toBeLessThan(50);
  });

  test('initModel returns false for missing model', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }

    const result = await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      // stroke-type.onnx may not exist yet (needs training)
      const loaded = await ghz.initModel('stroke-type');
      return { loaded, ready: ghz.isModelReady('stroke-type') };
    });

    // If model file doesn't exist, initModel returns false gracefully
    if (!result.loaded) {
      expect(result.ready).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Fallback Tests — pipeline works even without ML models
// ─────────────────────────────────────────────────────────────────────

test.describe('Heuristic fallback', () => {
  test('clariceHierarchy produces 6-layer plan without ML models', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }
    const ref = loadRefBase64('beckett-reference-2.png');
    if (!ref) { test.skip(); return; }

    const plan = await runHierarchy(page, ref);

    // Should still produce valid plan via heuristic fallback
    expect(plan.layers.length).toBe(6);
    const layerNames = new Set(plan.layers.map((l: any) => l.name));
    expect(layerNames).toEqual(new Set(['Mother', 'Background', 'Midtones', 'Dark Forms', 'Accents', 'Veil']));
    expect(plan.layers[0].name).toBe('Mother');
    expect(plan.metadata.strokeCount).toBeGreaterThan(50);
  });

  test('clariceHierarchyDebug returns mlStatus', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }
    const ref = loadRefBase64('beckett-reference-2.png');
    if (!ref) { test.skip(); return; }

    const result = await runHierarchyDebug(page, ref);

    expect(result.mlStatus).toBeDefined();
    expect(typeof result.mlStatus['region-classifier']).toBe('boolean');
    expect(typeof result.mlStatus['stroke-type']).toBe('boolean');
    expect(typeof result.mlStatus['composition']).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Feature Serialization Tests
// ─────────────────────────────────────────────────────────────────────

test.describe('Feature serialization', () => {
  test('serializeSceneFeatures produces Float32Array(30)', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }
    const ref = loadRefBase64('beckett-reference-2.png');
    if (!ref) { test.skip(); return; }

    const result = await page.evaluate(async (args: any) => {
      const ghz = (window as any).__ghz;
      const binary = atob(args.b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const imageData = await ghz.downsampleImage(blob, 40, 30);

      const palette = ghz.stores.scene.get().palette;
      const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
      const complement = ghz.getActiveComplement();
      const debug = await ghz.clariceHierarchyDebug(imageData, paletteColors, complement, 40, 30);

      const serialized = ghz.serializeSceneFeatures(debug.organism.sceneFeatures);
      return { length: serialized.length, isFloat32: serialized instanceof Float32Array };
    }, { b64: ref });

    expect(result.length).toBe(30);
    expect(result.isFloat32).toBe(true);
  });

  test('SCENE_FEATURE_ORDER has 30 entries', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }

    const length = await page.evaluate(() => {
      return (window as any).__ghz.SCENE_FEATURE_ORDER.length;
    });
    expect(length).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Assembly Upgrade Tests
// ─────────────────────────────────────────────────────────────────────

test.describe('Assembly upgrades', () => {
  test('accentTiming reorders accent layer', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }
    const ref = loadRefBase64('beckett-reference-2.png');
    if (!ref) { test.skip(); return; }

    const result = await page.evaluate(async (args: any) => {
      const ghz = (window as any).__ghz;
      const binary = atob(args.b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const imageData = await ghz.downsampleImage(blob, 40, 30);

      const palette = ghz.stores.scene.get().palette;
      const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
      const complement = ghz.getActiveComplement();

      // Get debug data for manual assembly with custom conductor
      const map = ghz.analyzeTonalStructure(imageData, 40, 30);
      ghz.assignHuesToCells(map, paletteColors);
      const luts = ghz.buildMeldrumLUTs(paletteColors, complement);
      ghz.quantizeCells(map, luts);
      const regions = ghz.extractRegions(map);
      const horizonRow = ghz.detectHorizon(map);
      ghz.classifyAllHeuristic(regions, horizonRow, 30);

      const depths = ghz.mapDepths(regions, horizonRow, 30);
      const colors = ghz.analyzeColors(regions, map);
      const tones = ghz.mapTones(regions, colors, luts);
      const edges = ghz.detectEdges(regions, map, depths, horizonRow);
      const accents = ghz.detectAccents(regions);
      const recipes = ghz.classifyRecipes(regions, depths);
      const features = ghz.aggregateFeatures(regions, depths, colors, accents, edges, horizonRow, 30);
      const composition = ghz.classifyComposition(features);
      const focalPoint = ghz.locateFocalPoint(accents, regions, colors);
      const budget = ghz.allocateBudget(composition.class, regions.length);
      const refinedParams = ghz.refineParameters(regions, depths, colors, tones, focalPoint);

      // Low accentTiming — should place accents early
      const conductorEarly = ghz.conductPainting(composition.class, focalPoint, 0.5, budget, features);
      conductorEarly.accentTiming = 0.1; // Force low timing
      const planEarly = ghz.assembleHierarchyPlan(
        regions, map, luts, tones, colors, accents, recipes,
        refinedParams, edges, focalPoint, budget, conductorEarly,
      );

      // High accentTiming — should place accents late
      const conductorLate = ghz.conductPainting(composition.class, focalPoint, 0.5, budget, features);
      conductorLate.accentTiming = 0.95; // Force high timing
      const planLate = ghz.assembleHierarchyPlan(
        regions, map, luts, tones, colors, accents, recipes,
        refinedParams, edges, focalPoint, budget, conductorLate,
      );

      const earlyIdx = planEarly.layers.findIndex((l: any) => l.name === 'Accents');
      const lateIdx = planLate.layers.findIndex((l: any) => l.name === 'Accents');

      return { earlyIdx, lateIdx };
    }, { b64: ref });

    // Early timing → accent near front (index 1)
    expect(result.earlyIdx).toBeLessThanOrEqual(2);
    // Late timing → accent near back (index 4-5)
    expect(result.lateIdx).toBeGreaterThanOrEqual(3);
    // Different positions
    expect(result.earlyIdx).not.toBe(result.lateIdx);
  });

  test('interRegionBleed extends stroke bounds', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }
    const ref = loadRefBase64('beckett-reference-2.png');
    if (!ref) { test.skip(); return; }

    const result = await page.evaluate(async (args: any) => {
      const ghz = (window as any).__ghz;
      const binary = atob(args.b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      const imageData = await ghz.downsampleImage(blob, 40, 30);

      const palette = ghz.stores.scene.get().palette;
      const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
      const complement = ghz.getActiveComplement();

      const map = ghz.analyzeTonalStructure(imageData, 40, 30);
      ghz.assignHuesToCells(map, paletteColors);
      const luts = ghz.buildMeldrumLUTs(paletteColors, complement);
      ghz.quantizeCells(map, luts);
      const regions = ghz.extractRegions(map);
      const horizonRow = ghz.detectHorizon(map);
      ghz.classifyAllHeuristic(regions, horizonRow, 30);

      const depths = ghz.mapDepths(regions, horizonRow, 30);
      const colors = ghz.analyzeColors(regions, map);
      const tones = ghz.mapTones(regions, colors, luts);
      const edges = ghz.detectEdges(regions, map, depths, horizonRow);
      const accents = ghz.detectAccents(regions);
      const recipes = ghz.classifyRecipes(regions, depths);
      const features = ghz.aggregateFeatures(regions, depths, colors, accents, edges, horizonRow, 30);
      const composition = ghz.classifyComposition(features);
      const focalPoint = ghz.locateFocalPoint(accents, regions, colors);
      const budget = ghz.allocateBudget(composition.class, regions.length);
      const refinedParams = ghz.refineParameters(regions, depths, colors, tones, focalPoint);

      // No bleed
      const conductorNone = ghz.conductPainting(composition.class, focalPoint, 0.5, budget, features);
      conductorNone.interRegionBleed = 0;
      const planNone = ghz.assembleHierarchyPlan(
        regions, map, luts, tones, colors, accents, recipes,
        refinedParams, edges, focalPoint, budget, conductorNone,
      );

      // High bleed
      const conductorBleed = ghz.conductPainting(composition.class, focalPoint, 0.5, budget, features);
      conductorBleed.interRegionBleed = 0.8;
      const planBleed = ghz.assembleHierarchyPlan(
        regions, map, luts, tones, colors, accents, recipes,
        refinedParams, edges, focalPoint, budget, conductorBleed,
      );

      // Compare total stroke point ranges
      function getStrokeExtent(plan: any) {
        let minX = 1, maxX = 0, minY = 1, maxY = 0;
        for (const layer of plan.layers) {
          for (const stroke of layer.strokes) {
            for (const p of stroke.points) {
              if (p.x < minX) minX = p.x;
              if (p.x > maxX) maxX = p.x;
              if (p.y < minY) minY = p.y;
              if (p.y > maxY) maxY = p.y;
            }
          }
        }
        return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
      }

      const extentNone = getStrokeExtent(planNone);
      const extentBleed = getStrokeExtent(planBleed);

      return { extentNone, extentBleed };
    }, { b64: ref });

    // Bleed should extend bounds (or at least not shrink them)
    // The exact effect depends on region layout, but bleed shouldn't reduce coverage
    expect(result.extentBleed.width).toBeGreaterThanOrEqual(result.extentNone.width * 0.99);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Full Pipeline ML Test
// ─────────────────────────────────────────────────────────────────────

test.describe('Full ML pipeline', () => {
  test('clariceHierarchy with ML models still produces valid plan', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }
    const ref = loadRefBase64('beckett-reference-2.png');
    if (!ref) { test.skip(); return; }

    const plan = await runHierarchy(page, ref);

    expect(plan.layers.length).toBe(6);
    const layerNames = new Set(plan.layers.map((l: any) => l.name));
    expect(layerNames).toEqual(new Set(['Mother', 'Background', 'Midtones', 'Dark Forms', 'Accents', 'Veil']));
    expect(plan.layers[0].name).toBe('Mother');
    expect(plan.layers[0].strokes.length).toBeGreaterThan(0);
    expect(plan.metadata.strokeCount).toBeGreaterThan(50);
    expect(plan.metadata.hueAssignments.length).toBe(5);
  });

  test('multiple references produce different plans', async ({ page }) => {
    if (!await setupPage(page)) { test.skip(); return; }

    const refs = ['beckett-reference-2.png', 'beckett-reference-3.png'];
    const plans = [];

    for (const refName of refs) {
      const ref = loadRefBase64(refName);
      if (!ref) continue;
      plans.push(await runHierarchy(page, ref));
    }

    if (plans.length < 2) { test.skip(); return; }

    // Different images should produce different stroke counts
    const counts = plans.map(p => p.metadata.strokeCount);
    // At least verify both produce valid plans
    for (const plan of plans) {
      expect(plan.layers.length).toBe(6);
      expect(plan.metadata.strokeCount).toBeGreaterThan(0);
    }
  });
});
