// Conductor Gardening — generate painting variations with perturbed conductor settings.
// For each reference, paint 5 variations, screenshot, then evaluate as gardener.
// Run: CHROME=1 npx playwright test test/clarice/conductor-garden.spec.ts --project=clarice

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/garden');
const PREFS_PATH = path.resolve(__dirname, '../../training-data/conductor-preferences.jsonl');

// Focus on 5 diverse references for manageable gardening
const REF_IMAGES = [
  'beckett-reference-3.png',    // beach + buildings + umbrella (seascape)
  'beckett-reference-30.jpg',   // atmospheric street scene
  'beckett-reference-50.jpg',   // misty/foggy
  'beckett-reference-13.png',   // complex scene
  'beckett-reference-7.webp',   // harbor/water
];

// 5 conductor variations: default + 4 perturbations
const VARIATIONS: { name: string; overrides: Record<string, number> }[] = [
  { name: 'default', overrides: {} },
  { name: 'sparse', overrides: { restraint: 0.90, focalDensity: 1.2, darkSoftening: 0.15, interRegionBleed: 0.25 } },
  { name: 'expressive', overrides: { restraint: 0.55, focalDensity: 2.2, darkSoftening: 0.55, interRegionBleed: 0.65 } },
  { name: 'atmospheric', overrides: { restraint: 0.80, veilStrength: 0.85, darkSoftening: 0.20, bareCanvasThreshold: 0.05 } },
  { name: 'bold', overrides: { restraint: 0.60, focalDensity: 2.0, darkSoftening: 0.50, bareCanvasThreshold: 0.00, interRegionBleed: 0.30 } },
];

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
});

test('generate conductor variations for gardening', async ({ page }) => {
  test.setTimeout(900_000);

  const stream = fs.createWriteStream(PREFS_PATH);

  for (const refName of REF_IMAGES) {
    const refPath = path.resolve(__dirname, 'reference', refName);
    if (!fs.existsSync(refPath)) { console.log(`skip ${refName} (not found)`); continue; }
    const base64 = fs.readFileSync(refPath).toString('base64');
    const mimeType = refName.endsWith('.webp') ? 'image/webp'
      : refName.endsWith('.jpg') || refName.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';

    console.log(`\n=== ${refName} ===`);

    for (const variant of VARIATIONS) {
      // Fresh page for each variation
      await page.goto('/?test');
      await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 60_000 });

      const result = await page.evaluate(async (args: any) => {
        const ghz = (window as any).__ghz;
        ghz.applyMood(0);
        await ghz.waitFrames(5);

        const binary = atob(args.b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: args.mime });
        await ghz.createMoodFromImage('Garden', blob, 0);
        const moods = ghz.getAllMoods();
        ghz.selectMood(moods.length - 1);
        await ghz.waitFrames(10);
        await ghz.setPhase('paint');
        await ghz.waitFrames(10);

        const imageData = await ghz.downsampleImage(blob, 80, 60);
        const palette = ghz.stores.scene.get().palette;
        const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
        const complement = ghz.getActiveComplement();

        // Pass conductor overrides to the debug pipeline
        const debug = await ghz.clariceHierarchyDebug(
          imageData, paletteColors, complement, 80, 60,
          undefined, // no full-res
          Object.keys(args.overrides).length > 0 ? args.overrides : undefined,
        );
        const plan = debug.plan;

        // Execute painting
        for (const layer of plan.layers) {
          if (layer.strokes.length === 0) continue;
          ghz.setTimeMultiplier(10);
          await ghz.waitFrames(20);
          ghz.setTimeMultiplier(1);
          ghz.wipeOnRag();
          ghz.wipeBrush();
          await ghz.waitFrames(2);
          for (const stroke of layer.strokes) {
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
        }
        await ghz.waitFrames(15);

        return {
          strokeCount: plan.metadata.strokeCount,
          composition: debug.organs?.composition?.class || 'unknown',
          conductor: debug.organism?.conductor,
        };
      }, { b64: base64, mime: mimeType, overrides: variant.overrides });

      const filename = `${refName.replace(/\.[^.]+$/, '')}_${variant.name}.png`;
      await page.screenshot({ path: path.join(OUTPUT_DIR, filename) });
      console.log(`  ${variant.name}: ${result.strokeCount} strokes, comp=${result.composition} → ${filename}`);
    }

    // Write preference record (to be filled by gardener evaluation)
    stream.write(JSON.stringify({
      file: refName,
      variations: VARIATIONS.map(v => v.name),
      preferred: null, // filled after visual evaluation
    }) + '\n');
  }

  stream.end();
  console.log(`\nDone! Variations in ${OUTPUT_DIR}`);
  console.log(`Fill in 'preferred' field in ${PREFS_PATH}`);
});
