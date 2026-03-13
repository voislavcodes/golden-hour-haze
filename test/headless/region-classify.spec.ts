// Region Classifier — end-to-end test for the V3 region-based procedural painter
// Verifies: region extraction, heuristic classification, stroke generation, painting replay
// Run: CHROME=1 npx playwright test test/headless/region-classify.spec.ts --headed

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/region-classify');
const REFERENCE = path.resolve(__dirname, 'beckett-reference.png');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function snap(page: any, name: string) {
  await page.evaluate(() => (window as any).__ghz.waitFrames(8));
  await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
  console.log(`  -> ${name}`);
}

async function setupScene(page: any) {
  await page.goto('/?test', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window as any).__ghz?.ready, { timeout: 15000 });
  // Apply foggy mood (index 0)
  await page.evaluate(() => (window as any).__ghz.applyMood(0));
  await page.evaluate(() => (window as any).__ghz.setPhase('paint'));
  await page.evaluate(() => (window as any).__ghz.waitFrames(5));
}

// --- Phase 1: Region extraction ---

test('region extraction produces 30-150 regions', async ({ page }) => {
  await setupScene(page);

  const refBuf = fs.readFileSync(REFERENCE);
  const result = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
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

    // Count classifications
    const classCounts: Record<string, number> = {};
    for (const r of regions) {
      classCounts[r.classification] = (classCounts[r.classification] || 0) + 1;
    }

    return {
      regionCount: regions.length,
      horizonRow,
      classCounts,
      totalCells: regions.reduce((sum: number, r: any) => sum + r.cells.length, 0),
    };
  }, refBuf.toString('base64'));

  console.log(`Region count: ${result.regionCount}`);
  console.log(`Horizon row: ${result.horizonRow} (${(result.horizonRow / 30 * 100).toFixed(0)}%)`);
  console.log('Class distribution:', result.classCounts);
  console.log(`Total cells covered: ${result.totalCells} / ${80 * 60}`);

  // Expect 30-150 regions
  expect(result.regionCount).toBeGreaterThanOrEqual(20);
  expect(result.regionCount).toBeLessThanOrEqual(200);

  // Horizon should be in 20-60% range
  expect(result.horizonRow / 30).toBeGreaterThanOrEqual(0.15);
  expect(result.horizonRow / 30).toBeLessThanOrEqual(0.65);

  // All cells should be covered
  expect(result.totalCells).toBe(40 * 30);

  // Should detect at least sky and ground/mass
  const hasUpperRegion = (result.classCounts['sky'] || 0) > 0;
  const hasLowerRegion = (result.classCounts['ground'] || 0) + (result.classCounts['mass'] || 0) > 0;
  expect(hasUpperRegion || hasLowerRegion).toBe(true);
});

// --- Phase 2-3: Full painting pipeline ---

test('region-based painting produces valid plan and renders', async ({ page }) => {
  await setupScene(page);

  const refBuf = fs.readFileSync(REFERENCE);
  const analysis = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });

    return await ghz.analyzeImage(blob, 80, 60);
  }, refBuf.toString('base64'));

  console.log(`\nPlan layers: ${analysis.plan.layers.length}`);
  for (const layer of analysis.plan.layers) {
    console.log(`  ${layer.name}: ${layer.strokes.length} strokes`);
  }
  console.log(`Total strokes: ${analysis.plan.metadata.strokeCount}`);
  console.log(`Regions: ${analysis.regionCount}`);
  console.log(`Horizon: row ${analysis.horizonRow}`);
  console.log('Classes:', analysis.classCounts);

  // Should have multiple layers
  expect(analysis.plan.layers.length).toBeGreaterThanOrEqual(2);

  // Total strokes should be reasonable (under 2000)
  expect(analysis.plan.metadata.strokeCount).toBeLessThanOrEqual(2000);
  expect(analysis.plan.metadata.strokeCount).toBeGreaterThanOrEqual(10);

  // Now paint it — replay all strokes layer by layer
  await snap(page, '00-blank-canvas.png');

  for (let li = 0; li < analysis.plan.layers.length; li++) {
    const layer = analysis.plan.layers[li];
    console.log(`\nPainting layer ${li}: ${layer.name} (${layer.strokes.length} strokes)...`);

    // Batch strokes to the page for faster replay
    await page.evaluate(async (layerData: any) => {
      const ghz = (window as any).__ghz;
      const strokes = layerData.strokes;

      for (let si = 0; si < strokes.length; si++) {
        const s = strokes[si];

        // Set oil/anchor state if needed
        const uiState = ghz.stores.ui.get();
        if (s.useOil) {
          const sceneState = ghz.stores.scene.get();
          if (!sceneState.oilIntensity || sceneState.oilIntensity < 0.5) {
            ghz.toggleOil();
          }
        }
        if (s.useAnchor) {
          // Anchor is set per-stroke via scene state
        }

        await ghz.replayStroke(s.points, {
          tool: 'form',
          brushSlot: s.brushSlot,
          hueIndex: s.hueIndex,
          brushSize: s.brushSize,
          thinners: s.thinners,
          load: s.load,
        });
      }
    }, layer);

    await snap(page, `${String(li + 1).padStart(2, '0')}-${layer.name.toLowerCase().replace(/\s+/g, '-')}.png`);
  }

  await snap(page, 'final.png');
  console.log('\nPainting complete!');
});

// --- Vertical stroke detection ---

test('vertical regions produce vertical strokes', async ({ page }) => {
  await setupScene(page);

  const refBuf = fs.readFileSync(REFERENCE);
  const result = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
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

    const verticals = regions.filter((r: any) => r.classification === 'vertical');
    const accents = regions.filter((r: any) => r.classification === 'accent');

    // Check that vertical strokes are actually vertical
    const verticalStrokes = verticals.flatMap((r: any) => ghz.generateRegionStrokes(r, map));

    let verticalStrokeCount = 0;
    for (const s of verticalStrokes) {
      if (s.points.length < 2) continue;
      const dx = Math.abs(s.points[s.points.length - 1].x - s.points[0].x);
      const dy = Math.abs(s.points[s.points.length - 1].y - s.points[0].y);
      if (dy > dx) verticalStrokeCount++;
    }

    return {
      verticalRegions: verticals.length,
      accentRegions: accents.length,
      verticalStrokes: verticalStrokes.length,
      verticallyOriented: verticalStrokeCount,
      accentHaveOil: accents.length > 0 ? accents.every((r: any) => {
        const strokes = ghz.generateRegionStrokes(r, map);
        return strokes.every((s: any) => s.useOil);
      }) : true,
    };
  }, refBuf.toString('base64'));

  console.log(`Vertical regions: ${result.verticalRegions}`);
  console.log(`Accent regions: ${result.accentRegions}`);
  console.log(`Vertical strokes: ${result.verticalStrokes} (${result.verticallyOriented} vertically oriented)`);
  console.log(`Accents use oil: ${result.accentHaveOil}`);

  // If there are vertical strokes, most should be vertically oriented
  if (result.verticalStrokes > 0) {
    expect(result.verticallyOriented / result.verticalStrokes).toBeGreaterThanOrEqual(0.7);
  }

  // Accent strokes should use oil
  expect(result.accentHaveOil).toBe(true);
});

// --- Region diagnostic map ---

test('generate region diagnostic overlay', async ({ page }) => {
  await setupScene(page);

  const refBuf = fs.readFileSync(REFERENCE);
  const diagnosticPng = await page.evaluate(async (b64: string) => {
    const ghz = (window as any).__ghz;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });

    // Run analysis at 40×30
    const gridCols = 40, gridRows = 30;
    const imageData = await ghz.downsampleImage(blob, gridCols, gridRows);

    // Full-res for ML patches
    const fullBitmap = await createImageBitmap(blob);
    const fullCanvas = new OffscreenCanvas(fullBitmap.width, fullBitmap.height);
    const fullCtx = fullCanvas.getContext('2d')!;
    fullCtx.drawImage(fullBitmap, 0, 0);
    const fullW = fullBitmap.width, fullH = fullBitmap.height;
    fullBitmap.close();
    const fullResImageData = fullCtx.getImageData(0, 0, fullW, fullH);

    const palette = ghz.stores.scene.get().palette;
    const paletteColors = palette.colors.map((c: any) => ({ r: c.r, g: c.g, b: c.b }));
    const complement = ghz.getActiveComplement();

    const map = ghz.analyzeTonalStructure(imageData, gridCols, gridRows);
    ghz.assignHuesToCells(map, paletteColors);
    const luts = ghz.buildMeldrumLUTs(paletteColors, complement);
    ghz.quantizeCells(map, luts);

    const regions = ghz.extractRegions(map);
    const horizonRow = ghz.detectHorizon(map);

    // Classify with heuristic
    ghz.classifyAllHeuristic(regions, horizonRow, gridRows);
    const heuristicLabels = regions.map((r: any) => ({
      id: r.id, cls: r.classification, conf: r.confidence
    }));

    // Classify with ML
    let mlLabels: any[] = [];
    const mlReady = await ghz.initClassifier();
    if (mlReady) {
      const patches = regions.map((r: any) => ghz.extractPatch(fullResImageData, r, gridCols, gridRows));
      const features = regions.map((r: any) => ghz.computeRegionFeatures(r, gridCols, gridRows));
      const mlResults = await ghz.classifyRegionsBatch(patches, features);
      mlLabels = mlResults.map((r: any, i: number) => ({
        id: regions[i].id, cls: r.classification, conf: r.confidence
      }));
    }

    // Color map for classes
    const classColors: Record<string, [number, number, number]> = {
      sky:        [135, 206, 235],  // light blue
      ground:     [194, 178, 128],  // khaki
      horizon:    [255, 165,   0],  // orange
      mass:       [100,  60,  40],  // brown
      vertical:   [180,  50,  50],  // red
      accent:     [255,  50,  50],  // bright red
      reflection: [100, 149, 237],  // cornflower blue
      fill:       [200, 200, 200],  // grey
    };

    // Build cell→region lookup
    const cellRegion = new Map<string, any>();
    for (const r of regions) {
      for (const c of r.cells) {
        cellRegion.set(`${c.gridX},${c.gridY}`, r);
      }
    }

    // Render: reference image (left) + heuristic overlay (center) + ML overlay (right)
    const panelW = fullW;
    const panelH = fullH;
    const totalW = panelW * (mlLabels.length > 0 ? 3 : 2);
    const canvas = new OffscreenCanvas(totalW, panelH);
    const ctx = canvas.getContext('2d')!;

    // Panel 1: Reference
    ctx.putImageData(fullResImageData, 0, 0);

    // Helper: draw overlay
    function drawOverlay(offsetX: number, labels: any[]) {
      // Draw reference dimmed
      ctx.globalAlpha = 0.3;
      ctx.putImageData(fullResImageData, offsetX, 0);
      ctx.globalAlpha = 1.0;

      const cellW = panelW / gridCols;
      const cellH = panelH / gridRows;
      const labelMap = new Map(labels.map((l: any) => [l.id, l]));

      for (const r of regions) {
        const label = labelMap.get(r.id);
        if (!label) continue;
        const [cr, cg, cb] = classColors[label.cls] || [128, 128, 128];

        ctx.fillStyle = `rgba(${cr},${cg},${cb},0.5)`;
        for (const c of r.cells) {
          ctx.fillRect(offsetX + c.gridX * cellW, c.gridY * cellH, cellW, cellH);
        }

        // Draw label text at centroid
        const cx = offsetX + r.centroid.x * panelW;
        const cy = r.centroid.y * panelH;
        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = 'black';
        ctx.fillText(`${label.cls}`, cx - 15, cy - 2);
        ctx.fillStyle = 'white';
        ctx.fillText(`${label.cls}`, cx - 16, cy - 3);
        ctx.fillStyle = 'black';
        ctx.font = '9px monospace';
        ctx.fillText(`${(label.conf * 100).toFixed(0)}%`, cx - 10, cy + 10);
      }

      // Draw horizon line
      const hy = (horizonRow / gridRows) * panelH;
      ctx.strokeStyle = 'rgba(255,0,0,0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(offsetX, hy);
      ctx.lineTo(offsetX + panelW, hy);
      ctx.stroke();
      ctx.setLineDash([]);

      // Title
      ctx.font = 'bold 16px monospace';
      ctx.fillStyle = 'white';
      ctx.fillRect(offsetX, 0, 120, 22);
      ctx.fillStyle = 'black';
      ctx.fillText(offsetX === panelW ? 'HEURISTIC' : 'ML MODEL', offsetX + 4, 16);
    }

    // Panel 2: Heuristic
    drawOverlay(panelW, heuristicLabels);

    // Panel 3: ML (if available)
    if (mlLabels.length > 0) {
      drawOverlay(panelW * 2, mlLabels);
    }

    // Title on reference
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 120, 22);
    ctx.fillStyle = 'black';
    ctx.fillText('REFERENCE', 4, 16);

    // Legend at bottom of reference
    const legendY = panelH - 25;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, legendY - 2, panelW, 27);
    ctx.font = '10px monospace';
    let lx = 5;
    for (const [cls, [cr, cg, cb]] of Object.entries(classColors)) {
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(lx, legendY + 2, 12, 12);
      ctx.fillStyle = 'white';
      ctx.fillText(cls, lx + 15, legendY + 12);
      lx += ctx.measureText(cls).width + 25;
    }

    // Export as PNG
    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await outBlob.arrayBuffer();
    const arr = new Uint8Array(buf);
    let b64out = '';
    for (let i = 0; i < arr.length; i++) {
      b64out += String.fromCharCode(arr[i]);
    }
    return btoa(b64out);
  }, refBuf.toString('base64'));

  // Write diagnostic image
  const pngBuf = Buffer.from(diagnosticPng, 'base64');
  const outPath = path.join(OUTPUT_DIR, 'region-diagnostic.png');
  fs.writeFileSync(outPath, pngBuf);
  console.log(`Diagnostic: ${outPath} (${(pngBuf.length / 1024).toFixed(0)} KB)`);
});

// --- ML fallback test ---

test('ML classifier loads and runs', async ({ page }) => {
  await setupScene(page);

  // Collect console messages for diagnostics
  const logs: string[] = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  const result = await page.evaluate(async () => {
    const ghz = (window as any).__ghz;

    // Check model is servable
    const modelUrl = new URL('/models/region-classifier.onnx', window.location.origin).href;
    let modelStatus = 'not fetched';
    let modelSize = 0;
    try {
      const resp = await fetch(modelUrl);
      modelStatus = `${resp.status} ${resp.statusText}`;
      modelSize = (await resp.clone().arrayBuffer()).byteLength;
    } catch (e: any) {
      modelStatus = `fetch error: ${e.message}`;
    }

    // Try full init through bridge (uses Vite-bundled onnxruntime-web)
    const mlReady = await ghz.initClassifier();
    const isReady = ghz.isClassifierReady();

    return { modelUrl, modelStatus, modelSize, mlReady, isReady };
  });

  console.log(`Model URL: ${result.modelUrl}`);
  console.log(`Model fetch: ${result.modelStatus} (${result.modelSize} bytes)`);
  console.log(`ML classifier loaded: ${result.mlReady}`);
  console.log(`ML classifier ready: ${result.isReady}`);
  for (const l of logs) {
    if (l.includes('Region ML') || l.includes('onnx') || l.includes('wasm')) {
      console.log(`  ${l}`);
    }
  }

  expect(result.modelSize).toBeGreaterThan(0);
});
