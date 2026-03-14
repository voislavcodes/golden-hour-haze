// Feature Aggregation — tissue outputs → organ input vector
// Builds ~30-dim SceneFeatures from all tissue analysis results.

import type { Region, RegionClass } from './region-analysis.js';
import type { DepthClass, ColorAnalysis, AccentResult, EdgeResult, SceneFeatures } from './types.js';

export function aggregateFeatures(
  regions: Region[],
  depths: Map<number, DepthClass>,
  colors: Map<number, ColorAnalysis>,
  accents: Map<number, AccentResult>,
  edges: EdgeResult[],
  horizonRow: number,
  totalRows: number,
): SceneFeatures {
  // Region class counts
  const classCounts: Record<RegionClass, number> = {
    sky: 0, ground: 0, horizon: 0, mass: 0,
    vertical: 0, accent: 0, reflection: 0, fill: 0,
  };
  for (const r of regions) classCounts[r.classification]++;

  // Spatial distribution of verticals
  const verticalYs = regions.filter(r => r.classification === 'vertical').map(r => r.centroid.y);
  const avgYVerticals = verticalYs.length > 0 ? verticalYs.reduce((s, v) => s + v, 0) / verticalYs.length : 0.5;
  const spreadYVerticals = verticalYs.length > 1
    ? Math.sqrt(verticalYs.reduce((s, v) => s + (v - avgYVerticals) ** 2, 0) / verticalYs.length)
    : 0;

  // Spatial distribution of masses
  const massYs = regions.filter(r => r.classification === 'mass').map(r => r.centroid.y);
  const avgYMasses = massYs.length > 0 ? massYs.reduce((s, v) => s + v, 0) / massYs.length : 0.5;
  const spreadYMasses = massYs.length > 1
    ? Math.sqrt(massYs.reduce((s, v) => s + (v - avgYMasses) ** 2, 0) / massYs.length)
    : 0;

  // Depth distribution
  let countNear = 0, countMid = 0, countFar = 0;
  for (const d of depths.values()) {
    if (d === 'near') countNear++;
    else if (d === 'mid') countMid++;
    else countFar++;
  }

  // Edge ratios
  let sharpCount = 0, softCount = 0;
  for (const e of edges) {
    if (e.edgeType === 'sharp') sharpCount++;
    else if (e.edgeType === 'soft') softCount++;
  }
  const edgeTotal = Math.max(1, sharpCount + softCount);
  const ratioSharp = sharpCount / edgeTotal;
  const ratioSoft = softCount / edgeTotal;

  // Accent info
  let bestAccent: AccentResult | null = null;
  for (const a of accents.values()) {
    if (a.isAccent && (!bestAccent || a.intensity > bestAccent.intensity)) {
      bestAccent = a;
    }
  }
  const accentRegion = bestAccent ? regions.find(r => r.id === bestAccent!.regionId) : null;

  // Tonal area ratios
  let totalDarkArea = 0, totalLightArea = 0;
  for (const r of regions) {
    if (r.meldrumIndex >= 3) totalDarkArea += r.areaFraction;
    if (r.meldrumIndex <= 1) totalLightArea += r.areaFraction;
  }
  const darkToLightRatio = totalLightArea > 0 ? totalDarkArea / totalLightArea : totalDarkArea > 0 ? 10 : 1;

  // Sky/ground area fractions
  let skyArea = 0, groundArea = 0;
  for (const r of regions) {
    if (r.classification === 'sky') skyArea += r.areaFraction;
    if (r.classification === 'ground') groundArea += r.areaFraction;
  }

  // Color stats
  let totalChroma = 0, minChroma = Infinity, maxChroma = 0;
  let sinSum = 0, cosSum = 0, chromaCount = 0;
  for (const c of colors.values()) {
    totalChroma += c.avgChroma;
    if (c.avgChroma < minChroma) minChroma = c.avgChroma;
    if (c.avgChroma > maxChroma) maxChroma = c.avgChroma;
    if (c.chromatic) {
      const rad = c.avgHue * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
      chromaCount++;
    }
  }
  const colorCount = Math.max(1, colors.size);
  const avgChroma = totalChroma / colorCount;
  const chromaRange = maxChroma - (minChroma === Infinity ? 0 : minChroma);
  let dominantHueAngle = chromaCount > 0
    ? Math.atan2(sinSum / chromaCount, cosSum / chromaCount) * 180 / Math.PI
    : 0;
  if (dominantHueAngle < 0) dominantHueAngle += 360;

  return {
    countSky: classCounts.sky,
    countGround: classCounts.ground,
    countHorizon: classCounts.horizon,
    countMass: classCounts.mass,
    countVertical: classCounts.vertical,
    countAccent: classCounts.accent,
    countReflection: classCounts.reflection,
    countFill: classCounts.fill,
    avgYVerticals,
    spreadYVerticals,
    avgYMasses,
    spreadYMasses,
    countNear,
    countMid,
    countFar,
    ratioSharp,
    ratioSoft,
    hasAccent: bestAccent ? 1 : 0,
    accentX: accentRegion ? accentRegion.centroid.x : 0.5,
    accentY: accentRegion ? accentRegion.centroid.y : 0.5,
    accentChroma: bestAccent ? bestAccent.intensity : 0,
    totalDarkArea,
    totalLightArea,
    darkToLightRatio,
    horizonY: horizonRow / totalRows,
    verticalCount: classCounts.vertical,
    massCount: classCounts.mass,
    skyAreaFraction: skyArea,
    groundAreaFraction: groundArea,
    avgChroma,
    chromaRange,
    dominantHueAngle,
  };
}
