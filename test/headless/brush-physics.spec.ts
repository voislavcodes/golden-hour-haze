// Brush physics headless test suite — diagnostic and tuning
// Tests depletion curves, pressure response, edge behavior, grain interaction, color mixing
// Run: npx playwright test test/headless/brush-physics.spec.ts
//
// Reference: WetBrush (Chen et al. 2015), Chu & Baxter 2010, Euler-Bernoulli beam theory
// Real brush physics: sigmoidal depletion, quadratic pressure-splay, cubic edge falloff

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '../output/brush-physics');

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

async function getBundleState(page: any): Promise<any> {
  return page.evaluate(() => (window as any).__ghz.getBundleState());
}

function fw(v: number): string { return v.toFixed(4); }

// ─── Test 1: Depletion Curve Shape ──────────────────────────────────
// Real paint: sigmoidal — plateau (capillary reservoir feeds), rapid drop, residual tail
// Current system: exponential exp(-drainRate * dist) — no plateau

test('01: depletion curve — should show initial plateau then decay', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);
  console.log(`Surface: ${dims.width}×${dims.height}`);

  // Long horizontal stroke — moderate load so sigmoid transition is visible
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 120; i++) {
      points.push({ x: 0.05 + (i / 120) * 0.9, y: 0.3, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.2, load: 0.6,
    });
  });
  await screenshot(page, '01-depletion.png');

  // Sample paint weight at 20 positions along stroke, averaging across width
  // Averaging eliminates per-pixel bristle clump noise
  const N = 20;
  const centerY = Math.floor(0.3 * dims.height);
  const weights: number[] = [];
  const crossSamples = 7; // sample ±3 pixels around center
  const crossStep = 3;

  console.log('\n  Depletion profile (width-averaged):');
  console.log('  Position% | AvgWeight | Δ from prev');
  console.log('  ----------|-----------|------------');

  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = Math.floor((0.08 + t * 0.84) * dims.width); // avoid stroke start/end taper
    let sum = 0, count = 0;
    for (let dy = -Math.floor(crossSamples / 2); dy <= Math.floor(crossSamples / 2); dy++) {
      const sy = centerY + dy * crossStep;
      const accum = await readAccum(page, x, sy);
      if (accum[3] > 0.005) { sum += accum[3]; count++; }
    }
    const w = count > 0 ? sum / count : 0;
    weights.push(w);
    const delta = i > 0 ? w - weights[i - 1] : 0;
    console.log(`  ${(t * 100).toFixed(0).padStart(5)}%    | ${fw(w).padStart(9)} | ${delta >= 0 ? '+' : ''}${fw(delta)}`);
  }

  // Analysis
  const startW = weights[0];
  const q1 = weights[Math.floor(N * 0.25)];
  const midW = weights[Math.floor(N * 0.5)];
  const q3 = weights[Math.floor(N * 0.75)];
  const endW = weights[N - 1];

  console.log('\n  Summary:');
  console.log(`  Start:  ${fw(startW)}`);
  console.log(`  25%:    ${fw(q1)}  (${startW > 0 ? (q1 / startW * 100).toFixed(1) : '0'}% of start)`);
  console.log(`  50%:    ${fw(midW)}  (${startW > 0 ? (midW / startW * 100).toFixed(1) : '0'}% of start)`);
  console.log(`  75%:    ${fw(q3)}  (${startW > 0 ? (q3 / startW * 100).toFixed(1) : '0'}% of start)`);
  console.log(`  End:    ${fw(endW)}  (${startW > 0 ? (endW / startW * 100).toFixed(1) : '0'}% of start)`);

  // Plateau check: first 20% should vary by < 20% of start weight
  const plateauSlice = weights.slice(0, Math.floor(N * 0.2));
  const pVar = Math.max(...plateauSlice) - Math.min(...plateauSlice);
  console.log(`\n  Plateau (0-20%): variation=${fw(pVar)} (${startW > 0 ? (pVar / startW * 100).toFixed(1) : '0'}% of start)`);
  console.log(`  → ${startW > 0 && pVar / startW < 0.2 ? 'PASS: good plateau' : 'NEEDS WORK: too much early decay (pure exponential?)'}`);

  // Sigmoidal shape: plateau early, decay late (late > early is correct!)
  const earlyDecay = startW - midW;
  const lateDecay = midW - endW;
  console.log(`  Early decay (0-50%): ${fw(earlyDecay)}`);
  console.log(`  Late decay (50-100%): ${fw(lateDecay)}`);
  const sigmoid = lateDecay > earlyDecay * 1.5 && earlyDecay < startW * 0.15;
  console.log(`  → ${sigmoid ? 'PASS: sigmoidal — plateau then drop' : lateDecay > earlyDecay ? 'OK: late decay > early (sigmoidal trend)' : 'NEEDS WORK: exponential decay (no plateau)'}`);
});

// ─── Test 2: Pressure-Footprint Scaling ─────────────────────────────
// Real bristles: splay follows Euler-Bernoulli beam — quadratic/cubic with pressure
// Light pressure barely changes footprint; heavy pressure dramatically expands it

test('02: pressure scaling — should be non-linear', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);
  const pressures = [0.15, 0.3, 0.5, 0.7, 0.9];
  const results: { pressure: number; width: number; peakWeight: number }[] = [];

  for (let pi = 0; pi < pressures.length; pi++) {
    const p = pressures[pi];
    const yPos = 0.15 + pi * 0.15;

    await page.evaluate(async (opts: any) => {
      const ghz = (window as any).__ghz;
      const points: any[] = [];
      for (let i = 0; i <= 30; i++) {
        points.push({ x: 0.3 + (i / 30) * 0.4, y: opts.y, pressure: opts.p });
      }
      await ghz.replayStroke(points, {
        brushSlot: 2, hueIndex: 0, brushSize: 0.05, thinners: 0.2, load: 0.8,
      });
    }, { y: yPos, p });

    // Scan perpendicular at midpoint to find painted width
    const centerX = Math.floor(0.5 * dims.width);
    const centerY = Math.floor(yPos * dims.height);
    const scanRadius = Math.floor(0.12 * dims.height);

    let minY = centerY, maxY = centerY, peakW = 0;
    for (let dy = -scanRadius; dy <= scanRadius; dy += 2) {
      const sy = centerY + dy;
      if (sy < 0 || sy >= dims.height) continue;
      const accum = await readAccum(page, centerX, sy);
      if (accum[3] > 0.005) {
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      }
      if (accum[3] > peakW) peakW = accum[3];
    }

    const width = maxY - minY;
    results.push({ pressure: p, width, peakWeight: peakW });
  }
  await screenshot(page, '02-pressure-scaling.png');

  console.log('\n  Pressure-Footprint Results:');
  console.log('  Pressure | Width (px) | Peak Weight | Width Ratio');
  console.log('  ---------|------------|-------------|------------');

  const baseWidth = results[0].width || 1;
  for (const r of results) {
    console.log(`  ${r.pressure.toFixed(2).padStart(7)}  | ${String(r.width).padStart(10)} | ${fw(r.peakWeight).padStart(11)} | ${(r.width / baseWidth).toFixed(2)}×`);
  }

  // Non-linearity check: compare width growth rates
  // Linear: width ∝ pressure → ratio at 2x pressure ≈ 2x
  // Quadratic: width ∝ pressure² → ratio at 2x pressure ≈ 4x
  const w03 = results[1].width || 1; // p=0.3
  const w07 = results[3].width || 1; // p=0.7
  const ratio = w07 / w03;
  console.log(`\n  Width ratio p=0.7 / p=0.3: ${ratio.toFixed(2)}`);
  console.log(`  Expected linear: ~2.33, quadratic: ~5.44`);
  console.log(`  → ${ratio > 3.0 ? 'PASS: non-linear' : ratio > 2.0 ? 'Mildly non-linear — consider quadratic' : 'Too linear — needs quadratic splay'}`);
});

// ─── Test 3: Cross-Section Profile ──────────────────────────────────
// Real brush: relatively flat paint deposit in center, steep falloff at edges
// The "flat top" comes from multiple bristle tips depositing uniformly

test('03: cross-section — flat top, steep edges', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 60; i++) {
      points.push({ x: 0.2 + (i / 60) * 0.6, y: 0.5, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 1, brushSize: 0.05, thinners: 0.15, load: 0.8,
    });
  });
  await screenshot(page, '03-cross-section.png');

  // Scan perpendicular at 50% along stroke
  const sampleX = Math.floor(0.5 * dims.width);
  const centerY = Math.floor(0.5 * dims.height);
  const scanRange = Math.floor(0.12 * dims.height);

  console.log('\n  Cross-section at 50% stroke:');
  console.log('  Offset | Weight');
  console.log('  -------|--------');

  const profile: { offset: number; weight: number }[] = [];
  for (let dy = -scanRange; dy <= scanRange; dy += 3) {
    const sy = centerY + dy;
    if (sy < 0 || sy >= dims.height) continue;
    const accum = await readAccum(page, sampleX, sy);
    profile.push({ offset: dy, weight: accum[3] });
    if (accum[3] > 0.001) {
      console.log(`  ${String(dy).padStart(6)} | ${fw(accum[3])}`);
    }
  }

  const peakWeight = Math.max(...profile.map(p => p.weight));
  const paintedPixels = profile.filter(p => p.weight > 0.01);

  if (paintedPixels.length > 2) {
    const edgeLeft = paintedPixels[0];
    const edgeRight = paintedPixels[paintedPixels.length - 1];
    const center = profile.find(p => p.weight === peakWeight)!;

    console.log(`\n  Peak: ${fw(peakWeight)} at offset ${center.offset}`);
    console.log(`  Left edge:  ${fw(edgeLeft.weight)} at offset ${edgeLeft.offset}`);
    console.log(`  Right edge: ${fw(edgeRight.weight)} at offset ${edgeRight.offset}`);
    console.log(`  Painted width: ${edgeRight.offset - edgeLeft.offset} px`);

    // Flat top check — middle 50% should be relatively uniform
    const q1 = Math.floor(paintedPixels.length * 0.25);
    const q3 = Math.floor(paintedPixels.length * 0.75);
    const centerHalf = paintedPixels.slice(q1, q3);
    const halfMin = Math.min(...centerHalf.map(p => p.weight));
    const halfMax = Math.max(...centerHalf.map(p => p.weight));
    const halfVar = peakWeight > 0 ? (halfMax - halfMin) / peakWeight : 0;
    console.log(`  Center 50% variation: ${(halfVar * 100).toFixed(1)}% of peak`);
    console.log(`  → ${halfVar < 0.3 ? 'PASS: flat top' : 'NEEDS WORK: too much center variation'}`);

    // Edge steepness — how quickly does weight drop from center to edge?
    const edge10 = paintedPixels[Math.floor(paintedPixels.length * 0.1)];
    const edge90 = paintedPixels[Math.floor(paintedPixels.length * 0.9)];
    console.log(`  10% weight: ${fw(edge10.weight)} (${(edge10.weight / peakWeight * 100).toFixed(0)}% of peak)`);
    console.log(`  90% weight: ${fw(edge90.weight)} (${(edge90.weight / peakWeight * 100).toFixed(0)}% of peak)`);
  }
});

// ─── Test 4: Edge vs Center Depletion ───────────────────────────────
// Real brush: edges deplete first (fewer bristles, less capillary reservoir)
// The edge/center ratio should decrease along stroke length

test('04: edge depletion — edges should empty before center', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  // Long stroke with low load — forces visible depletion
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 120; i++) {
      points.push({ x: 0.05 + (i / 120) * 0.9, y: 0.5, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.2, load: 0.4,
    });
  });
  await screenshot(page, '04-edge-depletion.png');

  const centerY = Math.floor(0.5 * dims.height);

  // Measure actual stroke width at 20% position
  const probeX = Math.floor(0.2 * dims.width);
  let halfWidth = 0;
  for (let dy = 1; dy < 200; dy++) {
    const accum = await readAccum(page, probeX, centerY + dy);
    if (accum[3] < 0.005) { halfWidth = dy; break; }
  }
  if (halfWidth === 0) halfWidth = 20;
  console.log(`\n  Measured half-width: ${halfWidth}px`);

  // At each position: average inner-half weight vs outer-half weight
  // This averages out bristle noise
  const positions = [0.15, 0.3, 0.5, 0.7, 0.85];

  console.log('\n  Inner vs Outer ring weight along stroke:');
  console.log('  Position | Inner    | Outer    | Outer/Inner');
  console.log('  ---------|----------|----------|------------');

  const ratios: number[] = [];
  for (const pos of positions) {
    const x = Math.floor(pos * dims.width);
    let innerSum = 0, innerCount = 0;
    let outerSum = 0, outerCount = 0;

    for (let dy = -halfWidth; dy <= halfWidth; dy += 2) {
      const accum = await readAccum(page, x, centerY + dy);
      if (accum[3] < 0.002) continue;
      const norm = Math.abs(dy) / halfWidth;
      if (norm < 0.5) {
        innerSum += accum[3]; innerCount++;
      } else {
        outerSum += accum[3]; outerCount++;
      }
    }

    const innerAvg = innerCount > 0 ? innerSum / innerCount : 0;
    const outerAvg = outerCount > 0 ? outerSum / outerCount : 0;
    const ratio = innerAvg > 0.01 ? outerAvg / innerAvg : 0;
    ratios.push(ratio);
    console.log(`  ${(pos * 100).toFixed(0).padStart(5)}%    | ${fw(innerAvg)} | ${fw(outerAvg)} | ${ratio.toFixed(3)}`);
  }

  // Outer/Inner ratio should decrease along stroke (edges deplete faster)
  const validRatios = ratios.filter(r => r > 0);
  if (validRatios.length >= 2) {
    const first = validRatios[0];
    const last = validRatios[validRatios.length - 1];
    const drop = first - last;
    console.log(`\n  Outer/Inner trend: ${first.toFixed(3)} → ${last.toFixed(3)}`);
    console.log(`  Ratio drop: ${drop.toFixed(3)}`);
    console.log(`  → ${drop > 0.1 ? 'PASS: edges deplete faster' : 'NEEDS WORK: edge depletion too subtle'}`);
    console.log(`  → ${first > 0.5 ? 'Good: edges start with paint' : 'Edge too thin initially'}`);
  }
});

// ─── Test 5: Thinners Effect ────────────────────────────────────────
// Thin paint (high thinners): spreads further, more transparent, softer edges
// Thick paint (low thinners): shorter hold, more opaque, sharper edges

test('05: thinners effect — thin paint spreads further', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  // Thick paint stroke (low thinners)
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 100; i++) {
      points.push({ x: 0.05 + (i / 100) * 0.9, y: 0.3, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.1, load: 0.8,
    });
  });

  // Thin paint stroke (high thinners)
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 100; i++) {
      points.push({ x: 0.05 + (i / 100) * 0.9, y: 0.6, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.04, thinners: 0.7, load: 0.8,
    });
  });
  await screenshot(page, '05-thinners.png');

  const N = 15;
  const thickY = Math.floor(0.3 * dims.height);
  const thinY = Math.floor(0.6 * dims.height);

  console.log('\n  Depletion: thick (thin=0.1) vs thin (thin=0.7):');
  console.log('  Position | Thick    | Thin     | Ratio');
  console.log('  ---------|----------|----------|------');

  let thickLastPainted = 0;
  let thinLastPainted = 0;

  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = Math.floor((0.05 + t * 0.9) * dims.width);
    const thick = await readAccum(page, x, thickY);
    const thin = await readAccum(page, x, thinY);
    const ratio = thick[3] > 0.01 ? thin[3] / thick[3] : 0;
    console.log(`  ${(t * 100).toFixed(0).padStart(5)}%    | ${fw(thick[3])} | ${fw(thin[3])} | ${ratio.toFixed(2)}`);
    if (thick[3] > 0.02) thickLastPainted = t;
    if (thin[3] > 0.02) thinLastPainted = t;
  }

  // Thin paint: wider spread radius (thinners * 0.4 factor in engine)
  // But much lower pigment density — deposits less per pixel
  // Key check: thin paint should show wider footprint but lower weight
  const thickWeights: number[] = [], thinWeights: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = Math.floor((0.05 + t * 0.9) * dims.width);
    const thick = await readAccum(page, x, thickY);
    const thin = await readAccum(page, x, thinY);
    thickWeights.push(thick[3]);
    thinWeights.push(thin[3]);
  }

  const thickAvg = thickWeights.reduce((a, b) => a + b, 0) / N;
  const thinAvg = thinWeights.reduce((a, b) => a + b, 0) / N;
  console.log(`\n  Avg weight — thick: ${fw(thickAvg)}, thin: ${fw(thinAvg)}`);
  console.log(`  Density ratio (thin/thick): ${thickAvg > 0 ? (thinAvg / thickAvg).toFixed(3) : 'N/A'}`);
  console.log(`  → ${thinAvg < thickAvg * 0.3 ? 'PASS: thin paint deposits less' : 'NEEDS WORK: density difference too small'}`);

  // Check depletion rate: thin paint should deplete slower (lower viscosity)
  const thickDrop = thickWeights[0] > 0 ? thickWeights[N - 1] / thickWeights[0] : 0;
  const thinDrop = thinWeights[0] > 0 ? thinWeights[N - 1] / thinWeights[0] : 0;
  console.log(`  End/Start ratio — thick: ${thickDrop.toFixed(3)}, thin: ${thinDrop.toFixed(3)}`);
  console.log(`  → ${thinDrop > thickDrop ? 'PASS: thin paint holds better' : 'Thin paint depletes faster — check viscosity curve'}`);
});

// ─── Test 6: Wet-on-Wet Color Mixing ────────────────────────────────
// K-M theory: wet paint mixes subtractively with existing wet paint
// Overlap zone should show blended K values, not pure replacement

test('06: wet-on-wet mixing — colors should blend', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  // Paint gold stroke
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 60; i++) {
      points.push({ x: 0.2 + (i / 60) * 0.6, y: 0.45, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 3, hueIndex: 0, brushSize: 0.06, thinners: 0.15, load: 0.9,
    });
  });

  // Read gold-only pixel
  const sampleX = Math.floor(0.5 * dims.width);
  const goldY = Math.floor(0.45 * dims.height);
  const goldAccum = await readAccum(page, sampleX, goldY);
  console.log(`  Gold only: K=[${goldAccum.slice(0, 3).map(fw).join(', ')}], w=${fw(goldAccum[3])}`);

  // Immediately paint blue stroke overlapping
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 60; i++) {
      points.push({ x: 0.2 + (i / 60) * 0.6, y: 0.48, pressure: 0.6 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 3, hueIndex: 3, brushSize: 0.06, thinners: 0.15, load: 0.9,
    });
  });
  await screenshot(page, '06-wet-on-wet.png');

  // Read pure blue pixel (below overlap)
  const blueY = Math.floor(0.52 * dims.height);
  const blueAccum = await readAccum(page, sampleX, blueY);
  console.log(`  Blue only: K=[${blueAccum.slice(0, 3).map(fw).join(', ')}], w=${fw(blueAccum[3])}`);

  // Read overlap zone
  const overlapY = Math.floor(0.465 * dims.height);
  const overlapAccum = await readAccum(page, sampleX, overlapY);
  console.log(`  Overlap:   K=[${overlapAccum.slice(0, 3).map(fw).join(', ')}], w=${fw(overlapAccum[3])}`);

  // Check K-M mixing — overlap should differ from both pure colors
  const goldK = goldAccum.slice(0, 3);
  const blueK = blueAccum.slice(0, 3);
  const mixK = overlapAccum.slice(0, 3);

  let diffFromGold = 0, diffFromBlue = 0;
  for (let i = 0; i < 3; i++) {
    diffFromGold += Math.abs(mixK[i] - goldK[i]);
    diffFromBlue += Math.abs(mixK[i] - blueK[i]);
  }

  console.log(`\n  K distance from gold: ${diffFromGold.toFixed(4)}`);
  console.log(`  K distance from blue: ${diffFromBlue.toFixed(4)}`);
  console.log(`  → ${diffFromGold > 0.05 && diffFromBlue > 0.05 ? 'PASS: genuine mixing' : 'NEEDS WORK: one color dominates too much'}`);

  // Weight should be higher in overlap (more paint)
  console.log(`  Overlap weight: ${fw(overlapAccum[3])} vs gold: ${fw(goldAccum[3])}, blue: ${fw(blueAccum[3])}`);
  console.log(`  → ${overlapAccum[3] > Math.max(goldAccum[3], blueAccum[3]) * 0.8 ? 'PASS: overlap builds up' : 'Low overlap weight?'}`);
});

// ─── Test 7: Grain Gating at Low Reservoir ──────────────────────────
// Real dry brush: paint catches only on surface peaks (grain gates deposition)
// Should see non-uniform paint weight matching surface texture

test('07: grain gating — depleted brush shows surface texture', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  // Very long stroke that depletes — low load forces depletion
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    const points: any[] = [];
    for (let i = 0; i <= 200; i++) {
      points.push({ x: 0.02 + (i / 200) * 0.96, y: 0.5, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 1, hueIndex: 0, brushSize: 0.03, thinners: 0.25, load: 0.35,
    });
  });
  await screenshot(page, '07-grain-gating.png');

  const y = Math.floor(0.5 * dims.height);

  // Sample wet zone (early stroke) — should be uniform
  const wetStart = Math.floor(0.05 * dims.width);
  const wetCount = Math.min(60, Math.floor(0.15 * dims.width));
  const wetLine = await readAccumLine(page, y, wetStart, wetCount);
  const wetWeights = wetLine.map(p => p[3]).filter(w => w > 0.001);
  const wetMean = wetWeights.length > 0 ? wetWeights.reduce((a, b) => a + b, 0) / wetWeights.length : 0;
  const wetStd = wetWeights.length > 1
    ? Math.sqrt(wetWeights.reduce((sum, w) => sum + (w - wetMean) ** 2, 0) / wetWeights.length)
    : 0;
  const wetCV = wetMean > 0 ? wetStd / wetMean : 0;

  // Sample dry zone (late stroke) — should show grain variation
  const dryStart = Math.floor(0.8 * dims.width);
  const dryCount = Math.min(60, Math.floor(0.15 * dims.width));
  const dryLine = await readAccumLine(page, y, dryStart, dryCount);
  const dryWeights = dryLine.map(p => p[3]).filter(w => w > 0.0001);
  const dryMean = dryWeights.length > 0 ? dryWeights.reduce((a, b) => a + b, 0) / dryWeights.length : 0;
  const dryStd = dryWeights.length > 1
    ? Math.sqrt(dryWeights.reduce((sum, w) => sum + (w - dryMean) ** 2, 0) / dryWeights.length)
    : 0;
  const dryCV = dryMean > 0 ? dryStd / dryMean : 0;

  console.log('\n  Grain gating analysis:');
  console.log(`  Wet zone:  mean=${fw(wetMean)}, CV=${wetCV.toFixed(3)}, samples=${wetWeights.length}`);
  console.log(`  Dry zone:  mean=${fw(dryMean)}, CV=${dryCV.toFixed(3)}, samples=${dryWeights.length}`);
  console.log(`  CV ratio (dry/wet): ${wetCV > 0 ? (dryCV / wetCV).toFixed(2) : 'N/A'}×`);
  console.log(`  → ${dryCV > wetCV * 1.5 ? 'PASS: grain variation visible in dry zone' : 'NEEDS WORK: dry zone too uniform — grain gating weak'}`);

  // Check for zero-weight gaps (bare surface showing through)
  const zeroPixels = dryLine.filter(p => p[3] < 0.001).length;
  console.log(`  Bare pixels in dry zone: ${zeroPixels}/${dryCount}`);
  console.log(`  → ${zeroPixels > dryCount * 0.1 ? 'Good: dry brush skips valleys' : 'Dry brush coverage too uniform'}`);
});

// ─── Test 8: Brush Age Effects ──────────────────────────────────────
// Old brushes: lower stiffness, more splay, slower recovery, rougher edges
// Visually: wider stroke, more bristle texture, more uneven depletion

test('08: brush age — worn brush should show different character', async ({ page }) => {
  test.setTimeout(120_000);
  await setupFreshSession(page);

  const dims = await getSurfaceDims(page);

  // New brush (age = 0)
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.setBrushAge(2, 0);
    const points: any[] = [];
    for (let i = 0; i <= 80; i++) {
      points.push({ x: 0.1 + (i / 80) * 0.8, y: 0.3, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.05, thinners: 0.2, load: 0.7,
    });
  });

  const newBundle = await getBundleState(page);
  console.log(`  New brush — age: ${newBundle?.age}, stiffness: ${newBundle?.stiffness?.toFixed(2)}, recovery: ${newBundle?.recoveryRate?.toFixed(2)}`);

  // Old brush (age = 0.8)
  await page.evaluate(async () => {
    const ghz = (window as any).__ghz;
    ghz.setBrushAge(2, 0.8);
    const points: any[] = [];
    for (let i = 0; i <= 80; i++) {
      points.push({ x: 0.1 + (i / 80) * 0.8, y: 0.6, pressure: 0.5 });
    }
    await ghz.replayStroke(points, {
      brushSlot: 2, hueIndex: 0, brushSize: 0.05, thinners: 0.2, load: 0.7,
    });
  });
  await screenshot(page, '08-brush-age.png');

  const oldBundle = await getBundleState(page);
  console.log(`  Old brush — age: ${oldBundle?.age}, stiffness: ${oldBundle?.stiffness?.toFixed(2)}, recovery: ${oldBundle?.recoveryRate?.toFixed(2)}`);

  // Compare cross-sections at midpoint
  const sampleX = Math.floor(0.5 * dims.width);
  const newY = Math.floor(0.3 * dims.height);
  const oldY = Math.floor(0.6 * dims.height);
  const scanRange = Math.floor(0.1 * dims.height);

  let newWidth = 0, oldWidth = 0;
  let newPeak = 0, oldPeak = 0;
  const newProfile: number[] = [];
  const oldProfile: number[] = [];

  for (let dy = -scanRange; dy <= scanRange; dy += 2) {
    const nAcc = await readAccum(page, sampleX, newY + dy);
    const oAcc = await readAccum(page, sampleX, oldY + dy);
    if (nAcc[3] > 0.005) newWidth++;
    if (oAcc[3] > 0.005) oldWidth++;
    newPeak = Math.max(newPeak, nAcc[3]);
    oldPeak = Math.max(oldPeak, oAcc[3]);
    if (nAcc[3] > 0.001) newProfile.push(nAcc[3]);
    if (oAcc[3] > 0.001) oldProfile.push(oAcc[3]);
  }

  // Calculate roughness (coefficient of variation in the painted zone)
  const newMean = newProfile.length > 0 ? newProfile.reduce((a, b) => a + b, 0) / newProfile.length : 0;
  const oldMean = oldProfile.length > 0 ? oldProfile.reduce((a, b) => a + b, 0) / oldProfile.length : 0;
  const newCV = newMean > 0
    ? Math.sqrt(newProfile.reduce((s, w) => s + (w - newMean) ** 2, 0) / newProfile.length) / newMean
    : 0;
  const oldCV = oldMean > 0
    ? Math.sqrt(oldProfile.reduce((s, w) => s + (w - oldMean) ** 2, 0) / oldProfile.length) / oldMean
    : 0;

  console.log(`\n  New brush: width=${newWidth * 2}px, peak=${fw(newPeak)}, roughness CV=${newCV.toFixed(3)}`);
  console.log(`  Old brush: width=${oldWidth * 2}px, peak=${fw(oldPeak)}, roughness CV=${oldCV.toFixed(3)}`);
  console.log(`  Width ratio (old/new): ${newWidth > 0 ? (oldWidth / newWidth).toFixed(2) : 'N/A'}`);
  console.log(`  Roughness ratio (old/new): ${newCV > 0 ? (oldCV / newCV).toFixed(2) : 'N/A'}`);
  console.log(`  → Width: ${oldWidth > newWidth * 1.05 ? 'PASS: old brush wider' : 'NEEDS WORK: old brush not wider enough'}`);
  console.log(`  → Roughness: ${oldCV > newCV * 1.1 ? 'PASS: old brush rougher' : 'NEEDS WORK: old brush not rough enough'}`);
});
