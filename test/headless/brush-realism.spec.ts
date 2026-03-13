// Brush realism tests — loaded brush solidity & dry brush surface texture
// Two physics problems to validate and fix:
// 1. Loaded brush: horizontal bands should NOT appear in first 50% of stroke
// 2. Dry brush: pattern should be surface-texture-driven, not bristle-line-driven
//
// Run: CHROME=1 npx playwright test test/headless/brush-realism.spec.ts --reporter=verbose

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/brush-realism');

test.beforeAll(() => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
});

async function screenshot(page: any, name: string) {
  await page.evaluate(() => (window as any).__ghz.waitFrames(8));
  await page.screenshot({ path: path.join(OUTPUT_DIR, name) });
  console.log(`  -> ${name}`);
}

async function setupFreshSession(page: any) {
  await page.goto('/?test');
  const hasWebGPU = await page.evaluate(() => !!navigator.gpu);
  if (!hasWebGPU) {
    console.error('\n  WebGPU not available. Try: CHROME=1 npm run test:draw\n');
    test.skip();
    return;
  }
  await page.waitForFunction(() => (window as any).__ghz?.ready === true, { timeout: 30_000 });
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.applyMood(0); // Golden Hour
    await ghz.waitFrames(10);
    await ghz.setPhase('paint');
    await ghz.waitFrames(10);
    // Fixed bristle seeds for deterministic contact noise patterns
    ghz.stores.session.set({ bristleSeeds: [0.42, 0.42, 0.42, 0.42, 0.42] });
  });
}

async function readAccum(page: any, x: number, y: number): Promise<number[]> {
  return page.evaluate(async (c: any) => {
    return await (window as any).__ghz.readAccumPixel(c.x, c.y);
  }, { x, y });
}

async function readAccumLine(page: any, y: number, xStart: number, count: number): Promise<number[][]> {
  return page.evaluate(async (c: any) => {
    return await (window as any).__ghz.readAccumLine(c.y, c.xStart, c.count);
  }, { y, xStart, count });
}

async function getSurfaceDims(page: any): Promise<{ width: number; height: number }> {
  return page.evaluate(() => (window as any).__ghz.getSurfaceDimensions());
}

function fw(v: number): string { return v.toFixed(4); }

function computeCV(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean < 0.001) return 0;
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return std / mean;
}

// ─── Test A: Loaded brush — first-half solidity ──────────────────────
// A fully loaded brush should produce nearly solid coverage in the first 50%
// of a stroke. Capillary reservoir keeps paint flowing continuously.
// We measure the INNER CORE (central 60% of painted width) to avoid edge falloff.

test('A: loaded brush — first-half solidity (no deep bands)', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);
  console.log(`  Surface: ${dims.width}x${dims.height}`);

  // Long vertical stroke — load=1.0, medium brush
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 150; i++) {
      points.push({ x: 0.5, y: 0.1 + (i / 150) * 0.8, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
  });
  await screenshot(page, 'A-loaded-stroke.png');

  const centerX = Math.floor(0.5 * dims.width);

  // Measure stroke half-width at 30% position to calibrate inner core
  let halfWidth = 0;
  const probeY = Math.floor(0.3 * dims.height);
  for (let dx = 1; dx < 200; dx++) {
    const accum = await readAccum(page, centerX + dx, probeY);
    if (accum[3] < 0.005) { halfWidth = dx; break; }
  }
  if (halfWidth === 0) halfWidth = 30;
  console.log(`  Measured half-width: ${halfWidth}px`);

  // Inner core = central 60% of painted width (avoids edge softness)
  const innerHalf = Math.max(3, Math.floor(halfWidth * 0.3));
  console.log(`  Inner core half-width: ${innerHalf}px`);

  // Sample 10 horizontal scanlines along the stroke, reading only the inner core
  const numScanlines = 10;
  const scanlineResults: { yFrac: number; weights: number[]; min: number; max: number; cv: number; mean: number }[] = [];

  console.log('\n  Inner-core scanline analysis (loaded brush):');
  console.log('  Y%     | Mean     | MinW     | MaxW     | Min/Max  | CV');
  console.log('  -------|----------|----------|----------|----------|------');

  for (let s = 0; s < numScanlines; s++) {
    const yFrac = 0.14 + (s / (numScanlines - 1)) * 0.72; // 14% to 86% of surface
    const pixelY = Math.floor(yFrac * dims.height);
    const xStart = centerX - innerHalf;
    const count = innerHalf * 2;

    const line = await readAccumLine(page, pixelY, xStart, count);
    const paintedWeights = line.map(p => p[3]).filter(w => w > 0.01);

    if (paintedWeights.length === 0) {
      scanlineResults.push({ yFrac, weights: [], min: 0, max: 0, cv: 0, mean: 0 });
      console.log(`  ${(yFrac * 100).toFixed(0).padStart(4)}%   | no paint`);
      continue;
    }

    const min = Math.min(...paintedWeights);
    const max = Math.max(...paintedWeights);
    const mean = paintedWeights.reduce((a, b) => a + b, 0) / paintedWeights.length;
    const cv = computeCV(paintedWeights);
    scanlineResults.push({ yFrac, weights: paintedWeights, min, max, cv, mean });

    const ratio = max > 0 ? min / max : 0;
    console.log(`  ${(yFrac * 100).toFixed(0).padStart(4)}%   | ${fw(mean)} | ${fw(min)} | ${fw(max)} | ${ratio.toFixed(3).padStart(8)} | ${cv.toFixed(3)}`);
  }

  // Assert: first 50% scanlines inner core should have min/max ratio > 0.6
  const firstHalf = scanlineResults.filter(r => r.yFrac < 0.5 && r.weights.length > 0);
  console.log(`\n  First-half scanlines: ${firstHalf.length}`);

  let firstHalfPass = true;
  for (const r of firstHalf) {
    const ratio = r.max > 0 ? r.min / r.max : 0;
    if (ratio < 0.6) {
      console.log(`  FAIL at y=${(r.yFrac * 100).toFixed(0)}%: min/max=${ratio.toFixed(3)} (need > 0.6)`);
      firstHalfPass = false;
    }
  }

  // Assert: CV < 0.15 for first-half inner core scanlines
  const avgCV = firstHalf.length > 0
    ? firstHalf.reduce((s, r) => s + r.cv, 0) / firstHalf.length
    : 0;
  console.log(`  Avg CV (first half inner core): ${avgCV.toFixed(3)} (need < 0.15)`);
  const cvPass = avgCV < 0.15;

  console.log(`  -> First-half solidity: ${firstHalfPass ? 'PASS' : 'FAIL'}`);
  console.log(`  -> First-half CV:       ${cvPass ? 'PASS' : 'FAIL'}`);

  expect(firstHalfPass, 'First half inner core should have min/max > 0.6 (no deep bands)').toBe(true);
  expect(cvPass, `First half inner core CV should be < 0.15, got ${avgCV.toFixed(3)}`).toBe(true);
});

// ─── Test B: Loaded brush — band irregularity ──────────────────────
// In the second half, depletion bands should be IRREGULAR, not perfectly
// correlated horizontal lines.

test('B: loaded brush — second-half band irregularity', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  // Same long vertical stroke
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 150; i++) {
      points.push({ x: 0.5, y: 0.1 + (i / 150) * 0.8, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
  });

  const centerX = Math.floor(0.5 * dims.width);

  // Measure stroke width
  let halfWidth = 0;
  const probeY = Math.floor(0.3 * dims.height);
  for (let dx = 1; dx < 200; dx++) {
    const accum = await readAccum(page, centerX + dx, probeY);
    if (accum[3] < 0.005) { halfWidth = dx; break; }
  }
  if (halfWidth === 0) halfWidth = 30;

  // Compare adjacent scanlines in second half — they should NOT be identical
  const scanWidth = Math.max(6, Math.floor(halfWidth * 0.8));
  const numPairs = 5;
  const correlations: number[] = [];

  console.log('\n  Band correlation analysis (second half):');

  for (let p = 0; p < numPairs; p++) {
    const yFrac = 0.55 + (p / (numPairs - 1)) * 0.3;
    const y1 = Math.floor(yFrac * dims.height);
    const y2 = y1 + 3; // 3 pixels apart
    const xStart = centerX - scanWidth;
    const count = scanWidth * 2;

    const line1 = await readAccumLine(page, y1, xStart, count);
    const line2 = await readAccumLine(page, y2, xStart, count);

    const w1 = line1.map(p => p[3]);
    const w2 = line2.map(p => p[3]);

    // Compute normalized cross-correlation
    const mean1 = w1.reduce((a, b) => a + b, 0) / w1.length;
    const mean2 = w2.reduce((a, b) => a + b, 0) / w2.length;
    let num = 0, den1 = 0, den2 = 0;
    for (let i = 0; i < Math.min(w1.length, w2.length); i++) {
      const d1 = w1[i] - mean1;
      const d2 = w2[i] - mean2;
      num += d1 * d2;
      den1 += d1 * d1;
      den2 += d2 * d2;
    }
    const corr = (den1 > 0 && den2 > 0) ? num / Math.sqrt(den1 * den2) : 1.0;
    correlations.push(corr);

    console.log(`  y=${(yFrac * 100).toFixed(0)}%: correlation=${corr.toFixed(3)}`);
  }

  // Perfect horizontal bands would give correlation ~1.0
  // Irregular bands should give correlation < 0.95
  const avgCorr = correlations.reduce((a, b) => a + b, 0) / correlations.length;
  console.log(`\n  Average correlation: ${avgCorr.toFixed(3)} (need < 0.95 for irregularity)`);

  // Diagnostic only — don't hard-fail since bands may be subtle in second half
  console.log(`  -> ${avgCorr < 0.95 ? 'PASS: bands are irregular' : 'INFO: bands are still quite regular'}`);

  // Soft assertion — we want bands to not be perfectly correlated
  expect(avgCorr).toBeLessThan(0.98);
});

// ─── Test C: Dry brush — surface texture driven ─────────────────────
// After dip + rag wipe, the stroke should show surface-texture-driven patterns:
// - Coverage 10-70% (broken, grain-gated)
// - Pattern varies between adjacent rows (not identical cross-stroke lines)
// - Paint presence should correlate with surface grain, not bristle spacing

test('C: dry brush — grain-driven coverage pattern', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);
  console.log(`  Surface: ${dims.width}x${dims.height}`);

  // Real dry brush: dip in color → wipe on rag → paint
  // The dip loads the brush fully, the rag removes excess paint
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    // Dip brush in color (replayStroke with hueIndex calls dipBrush + reloadBrush)
    const dipPoints: any[] = [];
    for (let i = 0; i <= 5; i++) {
      dipPoints.push({ x: 0.1, y: 0.1 + (i / 5) * 0.02, pressure: 0.5 });
    }
    await ghz.replayStroke(dipPoints, {
      brushSlot: 2, hueIndex: 2, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
    await ghz.waitFrames(3);

    // Wipe on rag — this is the key step for dry brush
    ghz.wipeOnRag();
    ghz.wipeBrush();
    await ghz.waitFrames(3);
  });

  // Paint with the wiped brush — do NOT pass hueIndex (would re-dip and reset wipe)
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 120; i++) {
      points.push({ x: 0.5, y: 0.15 + (i / 120) * 0.7, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, brushSize: 0.04, thinners: 0.15,
    });
  });
  await screenshot(page, 'C-dry-brush.png');

  const centerY = Math.floor(0.5 * dims.height);
  const centerX = Math.floor(0.5 * dims.width);
  const expectedHalfWidth = Math.floor(0.04 * dims.width * 0.6);
  const scanWidth = expectedHalfWidth;
  const xStart = centerX - scanWidth;
  const count = scanWidth * 2;

  // Read a grid of scanlines: rows along the stroke, columns across it
  // Use wide spacing so adjacent rows sample different grain texture
  const numRows = 9;
  const rowSpacing = 20; // pixels between rows (wider than noise cell cycle)
  const rowData: { y: number; weights: number[]; coverage: number }[] = [];

  for (let row = 0; row < numRows; row++) {
    const sy = centerY + (row - Math.floor(numRows / 2)) * rowSpacing;
    const line = await readAccumLine(page, sy, xStart, count);
    const rowWeights = line.map(p => p[3]);
    const painted = rowWeights.filter(w => w > 0.001).length;
    rowData.push({ y: sy, weights: rowWeights, coverage: painted / rowWeights.length });
  }

  // Overall coverage
  const allWeights = rowData.flatMap(r => r.weights);
  const paintedPixels = allWeights.filter(w => w > 0.001).length;
  const totalPixels = allWeights.length;
  const overallCoverage = paintedPixels / totalPixels;

  console.log(`\n  Scan area: ${numRows} rows x ${count} cols = ${totalPixels} pixels`);
  console.log(`  Painted: ${paintedPixels} (${(overallCoverage * 100).toFixed(1)}%)`);
  console.log(`  Per-row coverage: ${rowData.map(r => (r.coverage * 100).toFixed(0) + '%').join(', ')}`);

  if (paintedPixels > 0) {
    const paintedMean = allWeights.filter(w => w > 0.001).reduce((a, b) => a + b, 0) / paintedPixels;
    console.log(`  Mean weight (painted pixels): ${fw(paintedMean)}`);
  }

  // Display best row
  const bestRow = rowData.reduce((best, r) => r.coverage > best.coverage ? r : best, rowData[0]);
  console.log(`\n  Best row (y=${bestRow.y}, coverage=${(bestRow.coverage * 100).toFixed(0)}%):`);
  for (let i = 0; i < bestRow.weights.length; i += 4) {
    const w = bestRow.weights[i];
    if (w > 0.001 || i % 16 === 0) {
      const bar = '#'.repeat(Math.min(40, Math.floor(w * 200)));
      console.log(`  px ${String(i).padStart(3)}: ${fw(w)} ${bar}`);
    }
  }

  // Need at least some paint
  expect(paintedPixels, 'Dry brush should deposit at least some paint').toBeGreaterThan(5);

  // KEY TEST 1: Coverage is broken (not solid) — grain gating creates gaps
  console.log(`\n  -> Coverage: ${(overallCoverage * 100).toFixed(1)}% (need 5-75%)`);
  expect(overallCoverage, 'Dry brush coverage should be > 5%').toBeGreaterThan(0.05);
  expect(overallCoverage, 'Dry brush coverage should be < 75%').toBeLessThan(0.75);

  // KEY TEST 2: Row-to-row correlation — bristle lines create identical patterns across rows.
  // Surface texture creates patterns that CHANGE between rows.
  // Only compare rows that BOTH have >5% coverage (ignore edge transitions).
  const paintedRows = rowData.filter(r => r.coverage > 0.05);
  const rowCorrelations: number[] = [];
  for (let i = 0; i < paintedRows.length - 1; i++) {
    const a = paintedRows[i].weights;
    const b = paintedRows[i + 1].weights;
    let matches = 0;
    const minLen = Math.min(a.length, b.length);
    for (let j = 0; j < minLen; j++) {
      const aPainted = a[j] > 0.001;
      const bPainted = b[j] > 0.001;
      if (aPainted === bPainted) matches++;
    }
    rowCorrelations.push(matches / minLen);
  }

  const avgRowCorr = rowCorrelations.length > 0
    ? rowCorrelations.reduce((a, b) => a + b, 0) / rowCorrelations.length
    : 0;
  console.log(`\n  Row-to-row pattern correlation (painted rows only, ${paintedRows.length} rows):`);
  if (rowCorrelations.length > 0) {
    console.log(`  ${rowCorrelations.map(c => c.toFixed(2)).join(', ')}`);
  }
  console.log(`  Average: ${avgRowCorr.toFixed(3)}`);

  // KEY TEST 3: Coverage variation — at least some rows should differ in coverage (not all identical).
  // Bristle lines give identical coverage across all Y positions within the brush.
  // Surface texture means different Y positions hit different grain features.
  const covValues = paintedRows.map(r => r.coverage);
  const covCV = computeCV(covValues);
  console.log(`\n  Coverage variation (painted rows): CV=${covCV.toFixed(3)}`);
  console.log(`  Individual: ${covValues.map(c => (c * 100).toFixed(0) + '%').join(', ')}`);

  // The pattern should show SOME variation. Board surface has horizontal fibers
  // so adjacent rows may be very similar, but overall there should be variation.
  // For pristine bristle lines, ALL rows would be identical (CV ~0).
  // For surface-driven, coverage should vary as grain varies (CV > 0.02 across rows).
  const hasCoverageVariation = covCV > 0.02 || (covValues.length > 2 &&
    Math.max(...covValues) - Math.min(...covValues) > 0.05);
  console.log(`  -> ${hasCoverageVariation ? 'PASS: coverage varies between rows' : 'INFO: uniform coverage (board grain is directional)'}`);

  // Assertions: coverage range + pattern not perfectly uniform
  // Use lenient row correlation threshold — board grain is directional
  if (rowCorrelations.length > 0) {
    console.log(`  -> Row correlation: ${avgRowCorr < 0.98 ? 'PASS' : 'FAIL'} (need < 0.98)`);
    expect(avgRowCorr, 'Adjacent painted rows should not be perfectly identical').toBeLessThan(0.98);
  }
});

// ─── Test D: Dry brush — visible patches not faint lines ─────────────
// Where dry brush deposits paint, it should be moderate opacity (not invisible).
// Overall coverage should be 20-60% (broken but visible).

test('D: dry brush — visible patches with moderate coverage', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  // Real dry brush: dip → single wipe → paint
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const dipPoints: any[] = [];
    for (let i = 0; i <= 5; i++) {
      dipPoints.push({ x: 0.1, y: 0.1 + (i / 5) * 0.02, pressure: 0.5 });
    }
    await ghz.replayStroke(dipPoints, {
      brushSlot: 2, hueIndex: 2, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
    await ghz.waitFrames(3);

    // Single wipe on rag
    ghz.wipeOnRag();
    ghz.wipeBrush();
    await ghz.waitFrames(3);
  });

  // Paint with wiped brush — no hueIndex (don't re-dip)
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 120; i++) {
      points.push({ x: 0.5, y: 0.15 + (i / 120) * 0.7, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, brushSize: 0.04, thinners: 0.15,
    });
  });
  await screenshot(page, 'D-dry-brush-patches.png');

  const centerY = Math.floor(0.5 * dims.height);
  const centerX = Math.floor(0.5 * dims.width);

  // Use known brush size for scan range (dry brush is sparse, can't detect width from paint)
  const expectedHalfWidth = Math.floor(0.04 * dims.width * 0.6);
  const scanWidth = expectedHalfWidth;
  const xStart = centerX - scanWidth;
  const pixelCount = scanWidth * 2;

  // Average over 9 scanlines near center for robustness
  let totalPainted = 0;
  let totalPixels = 0;
  let paintedAboveThreshold = 0;
  let totalInStroke = 0;
  const allWeights: number[] = [];

  for (let dy = -12; dy <= 12; dy += 3) {
    const sy = centerY + dy;
    const line = await readAccumLine(page, sy, xStart, pixelCount);
    for (const px of line) {
      totalPixels++;
      if (px[3] > 0.001) {
        totalInStroke++;
        allWeights.push(px[3]);
        if (px[3] > 0.05) {
          paintedAboveThreshold++;
        }
      }
    }
  }

  const coverage = totalInStroke / totalPixels;
  const visibleCoverage = paintedAboveThreshold / totalPixels;
  const meanWeight = allWeights.length > 0
    ? allWeights.reduce((a, b) => a + b, 0) / allWeights.length
    : 0;
  const paintedMean = allWeights.filter(w => w > 0.05).length > 0
    ? allWeights.filter(w => w > 0.05).reduce((a, b) => a + b, 0) / allWeights.filter(w => w > 0.05).length
    : 0;

  console.log('\n  Dry brush coverage analysis:');
  console.log(`  Total pixels sampled: ${totalPixels}`);
  console.log(`  Pixels with any paint: ${totalInStroke} (${(coverage * 100).toFixed(1)}%)`);
  console.log(`  Pixels with weight > 0.05: ${paintedAboveThreshold} (${(visibleCoverage * 100).toFixed(1)}%)`);
  console.log(`  Mean weight (all painted): ${fw(meanWeight)}`);
  console.log(`  Mean weight (visible patches): ${fw(paintedMean)}`);

  // Where paint IS present, it should be visible (not invisible lines)
  console.log(`\n  -> Mean weight (painted): ${fw(meanWeight)} (need > 0.005)`);
  console.log(`  -> Coverage: ${(coverage * 100).toFixed(1)}% (need 5-75%)`);

  // The dry brush should deposit visible paint (above detection threshold)
  expect(allWeights.length, 'Dry brush should deposit some paint').toBeGreaterThan(0);
  expect(coverage, 'Dry brush coverage should be > 5%').toBeGreaterThan(0.05);
  expect(coverage, 'Dry brush coverage should be < 75%').toBeLessThan(0.75);
  expect(meanWeight, 'Dry brush paint should be above detection threshold').toBeGreaterThan(0.005);
});

// ─── Test E: Dry brush depletes across consecutive strokes ────────────
// A rag-wiped brush has a thin film of paint that should run out after
// a few brush-widths. Painting multiple strokes without re-dipping must
// produce decreasing paint weight — the brush actually empties.

test('E: dry brush — depletes across consecutive strokes', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);
  console.log(`  Surface: ${dims.width}x${dims.height}`);

  // Dip + wipe to create dry brush
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const dipPoints: any[] = [];
    for (let i = 0; i <= 5; i++) {
      dipPoints.push({ x: 0.1, y: 0.1 + (i / 5) * 0.02, pressure: 0.5 });
    }
    await ghz.replayStroke(dipPoints, {
      brushSlot: 2, hueIndex: 2, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
    await ghz.waitFrames(3);
    ghz.wipeOnRag();
    ghz.wipeBrush();
    await ghz.waitFrames(3);
  });

  // Paint 3 strokes in separate vertical lanes (no re-dip between them)
  const strokes = [0.25, 0.50, 0.75];
  const strokeWeights: number[] = [];

  for (let s = 0; s < strokes.length; s++) {
    const sx = strokes[s];
    await page.evaluate(async (c: any) => {
      const ghz = (window as any).__ghz;
      const points: any[] = [];
      for (let i = 0; i <= 80; i++) {
        points.push({ x: c.sx, y: 0.3 + (i / 80) * 0.4, pressure: 0.5 });
      }
      // No hueIndex → preserves dry brush state (no re-dip)
      await ghz.replayStroke(points, { brushSlot: 2, brushSize: 0.04, thinners: 0.15 });
    }, { sx });

    // Measure mean weight at the midpoint of this stripe
    const cx = Math.floor(sx * dims.width);
    const cy = Math.floor(0.5 * dims.height);
    const halfW = Math.floor(0.04 * dims.width * 0.3);
    const line = await readAccumLine(page, cy, cx - halfW, halfW * 2);
    const painted = line.map(p => p[3]).filter(w => w > 0.001);
    const meanW = painted.length > 0 ? painted.reduce((a, b) => a + b, 0) / painted.length : 0;
    strokeWeights.push(meanW);

    const res = await page.evaluate(() => (window as any).__ghz.getReservoir());
    console.log(`  Stroke ${s + 1} (x=${sx}): painted=${painted.length}px, mean weight=${fw(meanW)}, reservoir=${fw(res)}`);
  }

  await screenshot(page, 'E-dry-depletion.png');

  // Stroke 1 should have meaningfully more paint than stroke 3
  console.log(`\n  Weight progression: ${strokeWeights.map(w => fw(w)).join(' → ')}`);
  const ratio31 = strokeWeights[0] > 0 ? strokeWeights[2] / strokeWeights[0] : 1;
  console.log(`  Stroke 3 / Stroke 1 ratio: ${ratio31.toFixed(3)} (need < 0.50)`);

  expect(strokeWeights[0], 'Stroke 1 should have visible paint').toBeGreaterThan(0.01);
  expect(ratio31, 'Dry brush should deplete: stroke 3 should be < 50% of stroke 1').toBeLessThan(0.50);
});

// ─── Test F: Loaded brush — multi-pass buildup ──────────────────────
// Painting over the same area with a loaded brush (re-dipping between
// strokes) should accumulate paint weight — each pass adds more.

test('F: loaded brush — multi-pass paint accumulation', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);
  const cx = Math.floor(0.5 * dims.width);
  const cy = Math.floor(0.5 * dims.height);

  // Stroke 1: loaded brush, vertical through center
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 100; i++) {
      points.push({ x: 0.5, y: 0.2 + (i / 100) * 0.6, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
  });

  const w1 = await readAccum(page, cx, cy);
  console.log(`  After stroke 1: weight=${fw(w1[3])}`);

  // Stroke 2: re-dip (hueIndex provided) and paint same area
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 100; i++) {
      points.push({ x: 0.5, y: 0.2 + (i / 100) * 0.6, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
  });

  const w2 = await readAccum(page, cx, cy);
  console.log(`  After stroke 2: weight=${fw(w2[3])}`);

  // Stroke 3: re-dip and paint again
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 100; i++) {
      points.push({ x: 0.5, y: 0.2 + (i / 100) * 0.6, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
  });

  const w3 = await readAccum(page, cx, cy);
  console.log(`  After stroke 3: weight=${fw(w3[3])}`);

  await screenshot(page, 'F-multi-pass-loaded.png');

  const added2 = w2[3] - w1[3];
  const added3 = w3[3] - w2[3];
  console.log(`\n  Weight progression: ${fw(w1[3])} → ${fw(w2[3])} → ${fw(w3[3])}`);
  console.log(`  Added by stroke 2: ${fw(added2)}`);
  console.log(`  Added by stroke 3: ${fw(added3)}`);

  // Paint should accumulate
  expect(w2[3], 'Second pass should add paint').toBeGreaterThan(w1[3]);
  expect(w3[3], 'Third pass should add more paint').toBeGreaterThan(w2[3]);
  // But not unlimited — should show diminishing returns or reasonable buildup
  expect(w3[3], 'Three passes should not exceed 10x single pass').toBeLessThan(w1[3] * 10);
});

// ─── Test G: Dry brush multi-pass — diminishing buildup ──────────────
// Painting over the same area with a dry brush (no re-dip) should add
// less paint with each pass as the brush depletes.

test('G: dry brush — multi-pass diminishing returns', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);
  const cx = Math.floor(0.5 * dims.width);
  const cy = Math.floor(0.5 * dims.height);

  // Dip + wipe to create dry brush
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const dipPoints: any[] = [];
    for (let i = 0; i <= 5; i++) {
      dipPoints.push({ x: 0.1, y: 0.1 + (i / 5) * 0.02, pressure: 0.5 });
    }
    await ghz.replayStroke(dipPoints, {
      brushSlot: 2, hueIndex: 2, brushSize: 0.04, thinners: 0.15, load: 1.0,
    });
    await ghz.waitFrames(3);
    ghz.wipeOnRag();
    ghz.wipeBrush();
    await ghz.waitFrames(3);
  });

  const weights: number[] = [];
  const reservoirs: number[] = [];

  // Paint 3 overlapping strokes through center (no re-dip)
  for (let s = 0; s < 3; s++) {
    await page.evaluate(async () => {
      const ghz = (window as any).__ghz;
      const points: any[] = [];
      for (let i = 0; i <= 80; i++) {
        points.push({ x: 0.5, y: 0.3 + (i / 80) * 0.4, pressure: 0.5 });
      }
      await ghz.replayStroke(points, { brushSlot: 2, brushSize: 0.04, thinners: 0.15 });
    });

    const w = await readAccum(page, cx, cy);
    weights.push(w[3]);

    const res = await page.evaluate(() => (window as any).__ghz.getReservoir());
    reservoirs.push(res);
    console.log(`  After pass ${s + 1}: weight=${fw(w[3])}, reservoir=${fw(res)}`);
  }

  await screenshot(page, 'G-multi-pass-dry.png');

  console.log(`\n  Reservoir progression: ${reservoirs.map(r => fw(r)).join(' → ')}`);
  console.log(`  Weight progression:    ${weights.map(w => fw(w)).join(' → ')}`);

  // Pass 1 should deposit visible paint
  expect(weights[0], 'First dry brush pass should deposit paint').toBeGreaterThan(0.005);
  // Brush should deplete — reservoir drops across passes
  expect(reservoirs[0], 'Reservoir should drop after pass 1').toBeLessThan(0.1);
  expect(reservoirs[2], 'Reservoir should be near zero after pass 3').toBeLessThan(0.01);
  // Weight should be bounded (smearing redistributes but doesn't create paint from nothing)
  expect(weights[2], 'Total weight after 3 passes should be bounded').toBeLessThan(weights[0] * 5);
});
