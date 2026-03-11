// Headless painting test — drives the GHZ app via Playwright
// Run: npm run test:draw
// Screenshots saved to test/output/

import { test } from '@playwright/test';
import { DEMO_STROKES, type StrokeDefinition } from './strokes.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

test('paint demo scene', async ({ page }) => {
  // Longer timeout for GPU init + painting
  test.setTimeout(120_000);

  // Navigate with test bridge enabled
  await page.goto('/?test');

  // Check WebGPU availability
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) {
    console.error(
      '\n  WebGPU not available in this browser instance.\n' +
      '  Try: CHROME=1 npm run test:draw  (uses system Chrome)\n' +
      '  Or run headed: HEADED=1 npm run test:draw\n'
    );
    test.skip();
    return;
  }

  // Wait for the app + test bridge to initialize
  console.log('Waiting for GHZ test bridge...');
  await page.waitForFunction(
    () => (window as any).__ghz?.ready === true,
    { timeout: 30_000 }
  );
  console.log('Bridge ready. Setting up scene...');

  // Set up mood and advance to paint phase
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0); // Golden Hour
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  });

  // Screenshot blank canvas
  const canvas = page.locator('#ghz');
  await canvas.screenshot({ path: path.join(OUTPUT_DIR, '00-blank.png') });
  console.log('Saved 00-blank.png');

  // Replay each stroke and screenshot after
  for (let i = 0; i < DEMO_STROKES.length; i++) {
    const stroke = DEMO_STROKES[i];
    console.log(`Painting stroke ${i + 1}/${DEMO_STROKES.length}: ${stroke.name}`);

    await page.evaluate(async ({ points, options }) => {
      await (window as any).__ghz.replayStroke(points, options);
    }, { points: stroke.points, options: stroke.options });

    // Let rendering settle
    await page.evaluate(() => (window as any).__ghz.waitFrames(5));

    const filename = `${String(i + 1).padStart(2, '0')}-${stroke.name}.png`;
    await canvas.screenshot({ path: path.join(OUTPUT_DIR, filename) });
    console.log(`Saved ${filename}`);
  }

  // Final screenshot with extra settle time
  await page.evaluate(() => (window as any).__ghz.waitFrames(15));
  await canvas.screenshot({ path: path.join(OUTPUT_DIR, 'final.png') });
  console.log(`\nDone! Screenshots in ${OUTPUT_DIR}`);
});

// Custom strokes test — for iterative refinement
test('paint custom strokes from JSON', async ({ page }) => {
  test.setTimeout(120_000);

  // Check for custom strokes file
  const customPath = path.resolve(__dirname, '../custom-strokes.json');
  if (!fs.existsSync(customPath)) {
    test.skip();
    return;
  }

  const customStrokes: StrokeDefinition[] = JSON.parse(
    fs.readFileSync(customPath, 'utf-8')
  );

  await page.goto('/?test');
  await page.waitForFunction(
    () => (window as any).__ghz?.ready === true,
    { timeout: 30_000 }
  );

  // Setup — read mood from custom file or default to Golden Hour
  const moodIndex = (customStrokes as any).moodIndex ?? 0;
  await page.evaluate(async (mood: number) => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(mood);
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
  }, moodIndex);

  const canvas = page.locator('#ghz');

  for (let i = 0; i < customStrokes.length; i++) {
    const stroke = customStrokes[i];
    await page.evaluate(async ({ points, options }) => {
      await (window as any).__ghz.replayStroke(points, options);
    }, { points: stroke.points, options: stroke.options });

    await page.evaluate(() => (window as any).__ghz.waitFrames(5));

    const filename = `custom-${String(i + 1).padStart(2, '0')}-${stroke.name || 'stroke'}.png`;
    await canvas.screenshot({ path: path.join(OUTPUT_DIR, filename) });
  }

  await page.evaluate(() => (window as any).__ghz.waitFrames(15));
  await canvas.screenshot({ path: path.join(OUTPUT_DIR, 'custom-final.png') });
});
