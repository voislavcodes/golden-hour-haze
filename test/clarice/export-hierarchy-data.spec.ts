// Training Data Export — extracts hierarchy decisions from reference images
// Uses clariceHierarchyDebug() (heuristic-only) to generate ground-truth labels.
// Output: training-data/hierarchy-export.jsonl (JSON Lines, float arrays as base64)
// Run: CHROME=1 npx playwright test test/clarice/export-hierarchy-data.spec.ts --project=clarice

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF_DIR = path.resolve(__dirname, 'reference');
const OUTPUT_DIR = path.resolve(__dirname, '../../training-data');

// Encode Float32Array to base64
function f32ToBase64(arr: number[]): string {
  const f32 = new Float32Array(arr);
  const bytes = new Uint8Array(f32.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

test('export hierarchy training data from all references', async ({ page }) => {
  // Setup
  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) { test.skip(); return; }
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0);
    await ghz.waitFrames(5);
  });

  // Find all reference images
  const refFiles = fs.readdirSync(REF_DIR).filter(f =>
    /\.(png|jpg|jpeg|webp)$/i.test(f),
  ).sort();
  console.log(`Found ${refFiles.length} reference images`);
  expect(refFiles.length).toBeGreaterThan(0);

  const outputPath = path.join(OUTPUT_DIR, 'hierarchy-export.jsonl');
  const stream = fs.createWriteStream(outputPath);

  let totalRegions = 0;
  let totalScenes = 0;

  for (const refFile of refFiles) {
    const refPath = path.resolve(REF_DIR, refFile);
    const refBytes = fs.readFileSync(refPath);
    const refBase64 = refBytes.toString('base64');
    const mimeType = refFile.endsWith('.webp') ? 'image/webp'
      : refFile.endsWith('.jpg') || refFile.endsWith('.jpeg') ? 'image/jpeg'
      : 'image/png';

    try {
      const result = await page.evaluate(async (args: any) => {
        const ghz = (window as any).__ghz;
        const binary = atob(args.b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: args.mime });
        const imageData = await ghz.downsampleImage(blob, 40, 30);

        // Also get full-res for patch extraction
        const fullBitmap = await createImageBitmap(blob);
        const fullCanvas = new OffscreenCanvas(fullBitmap.width, fullBitmap.height);
        const fullCtx = fullCanvas.getContext('2d')!;
        fullCtx.drawImage(fullBitmap, 0, 0);
        fullBitmap.close();
        const fullResImageData = fullCtx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);

        const palette = ghz.stores.scene.get().palette;
        const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
        const complement = ghz.getActiveComplement();

        // Run heuristic-only debug pipeline
        const debug = await ghz.clariceHierarchyDebug(imageData, paletteColors, complement, 40, 30);

        // Extract regions + map for patch extraction
        const map = ghz.analyzeTonalStructure(imageData, 40, 30);
        ghz.assignHuesToCells(map, paletteColors);
        const luts = ghz.buildMeldrumLUTs(paletteColors, complement);
        ghz.quantizeCells(map, luts);
        const regions = ghz.extractRegions(map);
        const horizonRow = ghz.detectHorizon(map);
        ghz.classifyAllHeuristic(regions, horizonRow, 30);

        // Serialize scene features
        const sceneFeatures = ghz.serializeSceneFeatures(debug.organism.sceneFeatures);

        // Conductor input/output
        const conductorInput = ghz.serializeConductorInput(
          debug.organs.composition.class,
          debug.organs.focalPoint,
          debug.organs.fogDensity,
          debug.organs.budget,
          debug.organism.sceneFeatures,
        );

        // Per-region data
        const regionRecords: any[] = [];
        for (const region of regions) {
          // RGB patch
          const patch = ghz.extractPatch(fullResImageData, region, 40, 30);

          // Feature scalars
          const features = ghz.computeRegionFeatures(region, 40, 30);

          regionRecords.push({
            regionId: region.id,
            classification: region.classification,
            depth: debug.tissues.depths[region.id],
            strokeType: debug.tissues.strokeTypes[region.id],
            recipe: debug.tissues.recipes[region.id],
            tone: debug.tissues.tones[region.id],
            patch: Array.from(patch),
            features: {
              x: features.x,
              y: features.y,
              aspectRatio: features.aspectRatio,
              areaFraction: features.areaFraction,
              meldrumIndex: features.meldrumIndex,
              maxChroma: features.maxChroma,
            },
            refinedParams: {
              thinners: debug.plan.layers.length > 0 ? 0 : 0, // placeholder
            },
            boundingBox: region.boundingBox,
            centroid: region.centroid,
          });
        }

        return {
          sceneFeatures: Array.from(sceneFeatures),
          composition: debug.organs.composition,
          conductorInput: Array.from(conductorInput),
          conductor: debug.organism.conductor,
          focalPoint: debug.organs.focalPoint,
          fogDensity: debug.organs.fogDensity,
          budget: debug.organs.budget,
          regionCount: regions.length,
          regions: regionRecords,
        };
      }, { b64: refBase64, mime: mimeType });

      // Write scene-level record
      const sceneRecord = {
        type: 'scene',
        file: refFile,
        sceneFeatures: f32ToBase64(result.sceneFeatures),
        composition: result.composition,
        conductorInput: f32ToBase64(result.conductorInput),
        conductor: result.conductor,
        focalPoint: result.focalPoint,
        fogDensity: result.fogDensity,
        budget: result.budget,
        regionCount: result.regionCount,
      };
      stream.write(JSON.stringify(sceneRecord) + '\n');
      totalScenes++;

      // Write per-region records
      for (const region of result.regions) {
        const regionRecord = {
          type: 'region',
          file: refFile,
          regionId: region.regionId,
          classification: region.classification,
          depth: region.depth,
          strokeType: region.strokeType,
          recipe: region.recipe,
          tone: region.tone,
          patch: f32ToBase64(region.patch),
          features: region.features,
          boundingBox: region.boundingBox,
          centroid: region.centroid,
        };
        stream.write(JSON.stringify(regionRecord) + '\n');
        totalRegions++;
      }

      console.log(`  ${refFile}: ${result.regionCount} regions, composition=${result.composition.class}`);
    } catch (e) {
      console.warn(`  ${refFile}: FAILED — ${e}`);
    }
  }

  stream.end();
  console.log(`\nExported ${totalScenes} scenes, ${totalRegions} regions to ${outputPath}`);
  expect(totalScenes).toBeGreaterThan(0);
  expect(totalRegions).toBeGreaterThan(0);
});
