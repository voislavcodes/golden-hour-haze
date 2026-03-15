// Bristle bundle — 1024-tip physical brush simulation (CPU-side)
// Drives per-vertex splay, depletion, age effects for the polyline SDF renderer.
// The GPU renders capsule SDFs; this module computes the physical brush state
// that modulates per-vertex radius and reservoir.
//
// Physics: Poisson disk layout, pink noise load capacity, spring-damper splay,
// Ornstein-Uhlenbeck bristle paths, stochastic edge contact, exponential depletion.

type Vec2 = [number, number];

// --- Per-bristle path rendering constants ---
export const SELECTED_TIP_COUNT = 48;

export interface BristlePath {
  tipIndex: number;
  prevPos: Vec2 | null;   // committed position (null before first commit)
  prevRadius: number;
  prevLoad: number;
  currPos: Vec2 | null;   // current frame position (set by updateBundle)
  currRadius: number;
  currLoad: number;
  colorKr: number;
  colorKg: number;
  colorKb: number;
  ringNorm: number;
  dirty: boolean;         // true if currPos was updated this waypoint
}

export interface BristleTip {
  restOffset: Vec2;
  currentOffset: Vec2;
  velocity: Vec2;
  bend: number;
  bendDir: Vec2;
  load: number;
  oil: number;
  anchor: number;
  colorKr: number;
  colorKg: number;
  colorKb: number;
  contamination: number;
  ringNorm: number;      // distance from center [0, 1] — continuous radial position
  loadCapacity: number;  // pink noise [0.7, 1.0] — persistent per-bristle
  noiseX: number;        // Ornstein-Uhlenbeck deviation X
  noiseY: number;        // Ornstein-Uhlenbeck deviation Y
  inContact: boolean;
}

export interface BristleBundle {
  tips: BristleTip[];
  tipCount: number;
  splay: number;
  splayVelocity: number;    // spring-damper dynamics
  contactPressure: number;
  dominantBendDir: Vec2;
  age: number;
  stiffness: number;
  recoveryRate: number;
  seed: number;
  lastPos: Vec2 | null;
  lastVelocity: Vec2;
  springBackActive: boolean;
  springBackFrames: number;
  friction: number;
  tooth: number;
  frameCount: number;       // for stochastic seeding
  selectedTips: number[];   // 48 indices into tips[] for per-bristle path rendering
  paths: BristlePath[];     // 48 per-bristle polyline paths
}

// --- Pickup grid (64x64 low-res color tracking) ---
const GRID_RES = 64;
interface GridCell {
  kr: number;
  kg: number;
  kb: number;
  wetness: number;
  weight: number;
}

let pickupGrid: GridCell[] = [];

function initPickupGrid() {
  pickupGrid = Array.from({ length: GRID_RES * GRID_RES }, () => ({
    kr: 0, kg: 0, kb: 0, wetness: 0, weight: 0,
  }));
}

function sampleGrid(x: number, y: number): GridCell {
  const gx = Math.floor(Math.max(0, Math.min(GRID_RES - 1, x * GRID_RES)));
  const gy = Math.floor(Math.max(0, Math.min(GRID_RES - 1, y * GRID_RES)));
  return pickupGrid[gy * GRID_RES + gx];
}

function depositGrid(x: number, y: number, kr: number, kg: number, kb: number, load: number) {
  const gx = Math.floor(Math.max(0, Math.min(GRID_RES - 1, x * GRID_RES)));
  const gy = Math.floor(Math.max(0, Math.min(GRID_RES - 1, y * GRID_RES)));
  const cell = pickupGrid[gy * GRID_RES + gx];
  const t = load * 0.1;
  cell.kr = cell.kr * (1 - t) + kr * t;
  cell.kg = cell.kg * (1 - t) + kg * t;
  cell.kb = cell.kb * (1 - t) + kb * t;
  cell.wetness = Math.min(1.0, cell.wetness + load * 0.2);
  cell.weight = Math.min(1.0, cell.weight + load * 0.05);
}

// --- Seeded PRNG (splitmix32) ---
function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    z = z ^ (z >>> 16);
    return (z >>> 0) / 0x100000000;
  };
}

// --- Hash functions for stochastic contact and Brownian bridge ---
function hashFloat(a: number, b: number, c: number): number {
  let h = ((a * 127 + b * 311 + c * 74) | 0) & 0x7fffffff;
  h = ((h << 13) ^ h) | 0;
  h = (Math.imul(h, Math.imul(h, h) * 15731 + 789221) + 1376312589) & 0x7fffffff;
  return h / 0x7fffffff;
}

function hashNormal(seed: number, index: number, frame: number): number {
  const u1 = Math.max(1e-10, hashFloat(seed, index, frame));
  const u2 = hashFloat(seed + 5557, index + 3571, frame + 7919);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- Poisson disk in unit disk (Bridson's algorithm) ---
const TIP_COUNT = 1024;
const POISSON_MIN_DIST = 0.048;
const POISSON_CANDIDATES = 30;

function poissonDiskInUnitDisk(count: number, minDist: number, seed: number): Vec2[] {
  const rng = splitmix32(seed);
  const cellSize = minDist / Math.SQRT2;
  const gridSize = Math.ceil(2.0 / cellSize);
  // Flat grid array: -1 = empty, else point index
  const grid = new Int32Array(gridSize * gridSize).fill(-1);
  const points: Vec2[] = [];
  const active: number[] = [];

  const toGridIdx = (x: number, y: number): number => {
    const gx = Math.floor((x + 1) / cellSize);
    const gy = Math.floor((y + 1) / cellSize);
    if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) return -1;
    return gy * gridSize + gx;
  };

  // Seed with center point
  points.push([0, 0]);
  active.push(0);
  const centerIdx = toGridIdx(0, 0);
  if (centerIdx >= 0) grid[centerIdx] = 0;

  while (active.length > 0 && points.length < count * 2) {
    const activeIdx = Math.floor(rng() * active.length);
    const [px, py] = points[active[activeIdx]];
    let foundAny = false;

    for (let k = 0; k < POISSON_CANDIDATES; k++) {
      const angle = rng() * Math.PI * 2;
      const r = minDist + rng() * minDist;
      const cx = px + Math.cos(angle) * r;
      const cy = py + Math.sin(angle) * r;

      // Reject outside unit disk
      if (cx * cx + cy * cy > 1.0) continue;

      const gx = Math.floor((cx + 1) / cellSize);
      const gy = Math.floor((cy + 1) / cellSize);
      if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) continue;

      // Check neighbors in 5×5 grid
      let tooClose = false;
      for (let dy = -2; dy <= 2 && !tooClose; dy++) {
        for (let dx = -2; dx <= 2 && !tooClose; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
          const ni = grid[ny * gridSize + nx];
          if (ni === -1) continue;
          const [npx, npy] = points[ni];
          const ddx = cx - npx;
          const ddy = cy - npy;
          if (ddx * ddx + ddy * ddy < minDist * minDist) {
            tooClose = true;
          }
        }
      }

      if (!tooClose) {
        const newIdx = points.length;
        points.push([cx, cy]);
        active.push(newIdx);
        grid[gy * gridSize + gx] = newIdx;
        foundAny = true;
      }
    }

    if (!foundAny) {
      active[activeIdx] = active[active.length - 1];
      active.pop();
    }
  }

  // Trim to count (take first `count` — center point first, then by discovery order)
  if (points.length >= count) {
    return points.slice(0, count);
  }

  // Pad by jittering existing points
  while (points.length < count) {
    const src = points[Math.floor(rng() * points.length)];
    const jx = src[0] + (rng() - 0.5) * minDist * 0.3;
    const jy = src[1] + (rng() - 0.5) * minDist * 0.3;
    if (jx * jx + jy * jy <= 1.0) {
      points.push([jx, jy]);
    }
  }

  return points.slice(0, count);
}

// --- Pink noise (Voss-McCartney) ---
function generatePinkNoise(count: number, seed: number): Float32Array {
  const rng = splitmix32(seed + 7919);
  const OCTAVES = 6;
  const rows = new Float32Array(OCTAVES);
  for (let i = 0; i < OCTAVES; i++) rows[i] = rng();

  const result = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Update rows based on trailing zeros of (i+1)
    let v = i + 1;
    let tz = 0;
    while ((v & 1) === 0 && tz < OCTAVES - 1) { tz++; v >>= 1; }
    rows[tz] = rng();

    let sum = 0;
    for (let j = 0; j < OCTAVES; j++) sum += rows[j];
    result[i] = sum / OCTAVES;
  }

  // Normalize to [0.7, 1.0]
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < count; i++) {
    if (result[i] < minVal) minVal = result[i];
    if (result[i] > maxVal) maxVal = result[i];
  }
  const range = maxVal - minVal || 1;
  for (let i = 0; i < count; i++) {
    result[i] = 0.7 + 0.3 * (result[i] - minVal) / range;
  }

  return result;
}

// --- Stratified tip selection: 48 tips from 1024 ---
// 4 concentric bands by ringNorm, proportional to ring area
function selectTips(tips: BristleTip[], seed: number): number[] {
  const rng = splitmix32(seed + 31337);
  const bands: { range: [number, number]; count: number }[] = [
    { range: [0, 0.25], count: 4 },
    { range: [0.25, 0.5], count: 12 },
    { range: [0.5, 0.75], count: 16 },
    { range: [0.75, 1.0], count: 16 },
  ];

  const selected: number[] = [];
  for (const band of bands) {
    // Collect candidate indices in this band
    const candidates: number[] = [];
    for (let i = 0; i < tips.length; i++) {
      if (tips[i].ringNorm >= band.range[0] && tips[i].ringNorm < band.range[1]) {
        candidates.push(i);
      }
    }
    // Include tips at ringNorm exactly 1.0 in the last band
    if (band.range[1] === 1.0) {
      for (let i = 0; i < tips.length; i++) {
        if (tips[i].ringNorm === 1.0 && !candidates.includes(i)) {
          candidates.push(i);
        }
      }
    }

    // Sort by angle for even angular distribution, then pick evenly spaced
    candidates.sort((a, b) => {
      const aa = Math.atan2(tips[a].restOffset[1], tips[a].restOffset[0]);
      const ab = Math.atan2(tips[b].restOffset[1], tips[b].restOffset[0]);
      return aa - ab;
    });

    const n = Math.min(band.count, candidates.length);
    if (candidates.length <= n) {
      selected.push(...candidates);
    } else {
      // Evenly spaced with jitter
      const step = candidates.length / n;
      const offset = rng() * step;
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(offset + i * step) % candidates.length;
        selected.push(candidates[idx]);
      }
    }
  }

  return selected;
}

function createEmptyPath(tipIndex: number, tip: BristleTip): BristlePath {
  return {
    tipIndex,
    prevPos: null,
    prevRadius: 0,
    prevLoad: 0,
    currPos: null,
    currRadius: 0,
    currLoad: 0,
    colorKr: tip.colorKr,
    colorKg: tip.colorKg,
    colorKb: tip.colorKb,
    ringNorm: tip.ringNorm,
    dirty: false,
  };
}

// --- Bundle creation ---

export function createBundle(seed: number, age: number): BristleBundle {
  const stiffness = 1.0 - age * 0.5;
  const recoveryRate = 1.0 - age * 0.4;

  // Generate Poisson disk positions in unit disk
  const positions = poissonDiskInUnitDisk(TIP_COUNT, POISSON_MIN_DIST, seed);

  // Generate pink noise load capacities
  const loadCapacities = generatePinkNoise(TIP_COUNT, seed);

  const tips: BristleTip[] = [];

  for (let i = 0; i < TIP_COUNT; i++) {
    const [ox, oy] = positions[i];
    const ringNorm = Math.sqrt(ox * ox + oy * oy);

    // Age-driven radial drift — worn brushes splay outward
    const drift = age * 0.08 * (hashFloat(seed, i, 0) * 0.5 + 0.5);
    const scale = ringNorm > 0.001 ? (1.0 + drift) : 1.0;
    const rx = ox * scale;
    const ry = oy * scale;

    tips.push({
      restOffset: [rx, ry],
      currentOffset: [rx, ry],
      velocity: [0, 0],
      bend: 0,
      bendDir: [0, 0],
      load: 0,
      oil: 0,
      anchor: 0,
      colorKr: 0,
      colorKg: 0,
      colorKb: 0,
      contamination: 0,
      ringNorm,
      loadCapacity: loadCapacities[i],
      noiseX: 0,
      noiseY: 0,
      inContact: false,
    });
  }

  initPickupGrid();

  const selectedTips = selectTips(tips, seed);
  const paths = selectedTips.map(idx => createEmptyPath(idx, tips[idx]));

  return {
    tips,
    tipCount: tips.length,
    splay: 0,
    splayVelocity: 0,
    contactPressure: 0,
    dominantBendDir: [0, 0],
    age,
    stiffness,
    recoveryRate,
    seed,
    lastPos: null,
    lastVelocity: [0, 0],
    springBackActive: false,
    springBackFrames: 0,
    friction: 0.3,
    tooth: 0.4,
    frameCount: 0,
    selectedTips,
    paths,
  };
}

/** Advance bristle physics for one frame. Updates bundle state in-place.
 *  The engine reads bundle.splay and getAverageLoad() for per-vertex params. */
/** Snap all tip offsets to match the current splay.
 *  Call on stroke start to prevent first-frame capture at stale splay. */
export function snapTipOffsets(bundle: BristleBundle): void {
  const splayScale = bundle.splay * (1.0 + bundle.age * 0.3);
  for (const tip of bundle.tips) {
    tip.currentOffset[0] = tip.restOffset[0] * splayScale;
    tip.currentOffset[1] = tip.restOffset[1] * splayScale;
    tip.velocity[0] = 0;
    tip.velocity[1] = 0;
  }
}

export function updateBundle(
  bundle: BristleBundle,
  pos: Vec2,
  pressure: number,
  tiltX: number,
  tiltY: number,
  dt: number,
  brushRadius: number,
  aspectCorrection: number = 1.0, // surfaceHeight / surfaceWidth — makes brush circular on screen
  reservoirScale: number = 1.0,   // CPU reservoir (0-1) — modulates per-vertex load for depletion
): void {
  const { tips, stiffness, age } = bundle;
  bundle.frameCount++;

  // Velocity from position delta
  let velX = 0, velY = 0;
  if (bundle.lastPos) {
    velX = (pos[0] - bundle.lastPos[0]) / Math.max(dt, 0.001);
    velY = (pos[1] - bundle.lastPos[1]) / Math.max(dt, 0.001);
  }

  const smoothing = 0.3;
  bundle.lastVelocity[0] = bundle.lastVelocity[0] * smoothing + velX * (1 - smoothing);
  bundle.lastVelocity[1] = bundle.lastVelocity[1] * smoothing + velY * (1 - smoothing);
  const speed = Math.sqrt(bundle.lastVelocity[0] ** 2 + bundle.lastVelocity[1] ** 2);

  let moveDir: Vec2 = [0, 0];
  if (speed > 0.001) {
    moveDir = [bundle.lastVelocity[0] / speed, bundle.lastVelocity[1] / speed];
  }

  // Splay from pressure — momentum-accelerated approach with overshoot.
  // Velocity carries momentum: fast convergence (~5 calls) with ~10% overshoot
  // on press-down, lag on lift-off. Frame-rate independent (per-call, like old lerp).
  const pressureSq = pressure * pressure;
  const targetSplay = pressureSq * 0.85 + 0.15; // [0.15, 1.0]
  const error = targetSplay - bundle.splay;
  bundle.splayVelocity = bundle.splayVelocity * 0.5 + error * 0.25;
  bundle.splay = Math.max(0, Math.min(1.0, bundle.splay + bundle.splayVelocity));
  bundle.contactPressure = pressure;

  // Dominant bend direction — trails movement
  const bendSmooth = 0.25;
  bundle.dominantBendDir[0] = bundle.dominantBendDir[0] * (1 - bendSmooth) + (-moveDir[0]) * bendSmooth;
  bundle.dominantBendDir[1] = bundle.dominantBendDir[1] * (1 - bendSmooth) + (-moveDir[1]) * bendSmooth;

  // Brush center distance this frame (for distance-based depletion)
  let brushDist = 0;
  if (bundle.lastPos) {
    const ddx = pos[0] - bundle.lastPos[0];
    const ddy = pos[1] - bundle.lastPos[1];
    brushDist = Math.sqrt(ddx * ddx + ddy * ddy);
  }

  const tiltNormX = (tiltX || 0) / 90;
  const tiltNormY = (tiltY || 0) / 90;
  const tiltInfluence = 0.3;
  const frictionFactor = 1.0 - bundle.friction * 0.5;

  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i];
    const ringNorm = tip.ringNorm;

    // Splay: radial outward
    const splayScale = bundle.splay * (1.0 + age * 0.3);
    const targetX = tip.restOffset[0] * splayScale;
    const targetY = tip.restOffset[1] * splayScale;

    // Trailing bend
    const bendAmount = Math.min(speed * 15.0, 1.0) * (0.3 + ringNorm * 0.7) * frictionFactor;
    tip.bend = tip.bend * 0.7 + bendAmount * 0.3;
    tip.bendDir[0] = bundle.dominantBendDir[0];
    tip.bendDir[1] = bundle.dominantBendDir[1];

    const bendOffset = tip.bend * brushRadius * 0.6;
    const bendX = tip.bendDir[0] * bendOffset;
    const bendY = tip.bendDir[1] * bendOffset;

    const tiltOffX = tiltNormX * tiltInfluence * brushRadius * ringNorm;
    const tiltOffY = tiltNormY * tiltInfluence * brushRadius * ringNorm;

    // Spring physics — age-dependent damping (viscoelastic relaxation)
    const springForce = stiffness * 8.0;
    const dampening = 0.85 - age * 0.12; // worn brushes: slower recovery
    const goalX = targetX + bendX + tiltOffX;
    const goalY = targetY + bendY + tiltOffY;
    tip.velocity[0] = tip.velocity[0] * dampening + (goalX - tip.currentOffset[0]) * springForce * dt;
    tip.velocity[1] = tip.velocity[1] * dampening + (goalY - tip.currentOffset[1]) * springForce * dt;
    tip.currentOffset[0] += tip.velocity[0] * dt;
    tip.currentOffset[1] += tip.velocity[1] * dt;

    // Ornstein-Uhlenbeck micro-deviation — bristles weave slightly
    // Variance scales with age: NEW = tight, WORN = loose, OLD = wild
    const sigma = (0.003 + age * 0.01) * brushRadius;
    const theta = 5.0;
    const rand1 = hashNormal(bundle.seed, i, bundle.frameCount);
    const rand2 = hashNormal(bundle.seed, i + 4999, bundle.frameCount);
    tip.noiseX += (-theta * tip.noiseX + sigma * rand1) * dt;
    tip.noiseY += (-theta * tip.noiseY + sigma * rand2) * dt;
    tip.currentOffset[0] += tip.noiseX;
    tip.currentOffset[1] += tip.noiseY;

    // Contact detection — stochastic skip for outer bristles (ragged edges)
    const contactThreshold = ringNorm * (1.0 - pressure * 0.9);
    let edgeContact = true;
    if (ringNorm > 0.8) {
      // Gradual fadeout: 70% contact at boundary, dropping to ~0% at rim
      const skipThreshold = 0.3 + (ringNorm - 0.8) * 3.5;
      edgeContact = hashFloat(bundle.seed + i, bundle.frameCount, i * 17) < (1.0 - skipThreshold);
    }
    tip.inContact = pressure > contactThreshold && edgeContact;

    if (!tip.inContact) continue;

    const wx = pos[0] + tip.currentOffset[0] * brushRadius;
    const wy = pos[1] + tip.currentOffset[1] * brushRadius;
    const tipPressure = pressure * (1.0 - ringNorm * 0.3);

    // Pickup from grid
    const cell = sampleGrid(wx, wy);
    if (cell.wetness > 0.1 && cell.weight > 0.01) {
      const contaminationRate = 0.05 * cell.wetness;
      tip.colorKr = tip.colorKr * (1 - contaminationRate) + cell.kr * contaminationRate;
      tip.colorKg = tip.colorKg * (1 - contaminationRate) + cell.kg * contaminationRate;
      tip.colorKb = tip.colorKb * (1 - contaminationRate) + cell.kb * contaminationRate;
      tip.contamination = Math.min(1.0, tip.contamination + contaminationRate * 0.5);
    }

    // Per-tip depletion — TWO-PHASE: loaded brush holds paint, then exponential dry tail
    // Phase 1 (load > 0.35): slow depletion — solid coverage for several brush-widths
    // Phase 2 (load < 0.35): faster exponential decay — dry brush tail with grain interaction
    if (tip.load > 0) {
      const edgeFactor = ringNorm * ringNorm * ringNorm; // cubic: 0 center → 1 edge
      const phase = tip.load > 0.35 ? 0.012 : 0.08; // slow loaded → faster dry tail
      const baseRate = (phase + edgeFactor * 0.06) * tipPressure / tip.loadCapacity;
      const distanceTerm = brushDist > 0 ? baseRate * (brushDist / brushRadius) : 0;
      // Contact cost: stationary pressure squeezes paint out. Scales inversely with speed
      // so it only matters for dabs, not continuous strokes (which use distance term).
      const speedNorm = Math.min(1, brushDist / (brushRadius * 0.05));
      const contactTerm = baseRate * 1.0 * (1.0 - speedNorm);
      const transferred = tip.load * (distanceTerm + contactTerm);
      tip.load = Math.max(0, tip.load - transferred);
    }

    // Deposit into pickup grid
    if (tip.load > 0.01) {
      depositGrid(wx, wy, tip.colorKr, tip.colorKg, tip.colorKb, tip.load);
    }
  }

  // --- Per-bristle path tracking: set currPos for selected tips ---
  // Skip recording when pressure is near zero — prevents convergent blob on release
  if (bundle.contactPressure < 0.05) {
    bundle.lastPos = [pos[0], pos[1]];
    return;
  }
  for (let si = 0; si < bundle.selectedTips.length; si++) {
    const tipIdx = bundle.selectedTips[si];
    const tip = tips[tipIdx];
    const path = bundle.paths[si];

    const wx: number = pos[0] + tip.currentOffset[0] * brushRadius * aspectCorrection;
    const wy: number = pos[1] + tip.currentOffset[1] * brushRadius;
    const splayScale = bundle.splay * (1.0 + bundle.age * 0.3);
    const rBristle = (brushRadius / Math.sqrt(SELECTED_TIP_COUNT))
      * (0.35 - 0.08 * tip.ringNorm) * splayScale;

    // Deduplicate: skip if tip hasn't moved at least 10% of its radius
    const dedupThresh = rBristle * rBristle * 0.01;
    const cmpPos = path.prevPos ?? path.currPos;
    if (cmpPos) {
      const ddx = wx - cmpPos[0];
      const ddy = wy - cmpPos[1];
      if (ddx * ddx + ddy * ddy < dedupThresh) continue;
    }

    path.currPos = [wx, wy];
    path.currRadius = Math.max(rBristle, 0.0005);
    path.currLoad = tip.load * reservoirScale;
    path.dirty = true;

    // Update per-bristle color from tip
    path.colorKr = tip.colorKr;
    path.colorKg = tip.colorKg;
    path.colorKb = tip.colorKb;
  }

  bundle.lastPos = [pos[0], pos[1]];
}

export function dipBundle(bundle: BristleBundle, kr: number, kg: number, kb: number, oil: number, anchor: number, load: number) {
  for (const tip of bundle.tips) {
    // Capillary loading gradient × per-bristle load capacity (pink noise)
    const ringFalloff = 1.0 - tip.ringNorm * tip.ringNorm * 0.6;
    tip.load = load * ringFalloff * tip.loadCapacity;
    tip.oil = oil;
    tip.anchor = anchor;

    if (tip.contamination > 0.01) {
      const contam = tip.contamination * 0.3;
      tip.colorKr = kr * (1 - contam) + tip.colorKr * contam;
      tip.colorKg = kg * (1 - contam) + tip.colorKg * contam;
      tip.colorKb = kb * (1 - contam) + tip.colorKb * contam;
    } else {
      tip.colorKr = kr;
      tip.colorKg = kg;
      tip.colorKb = kb;
    }
  }
}

export function wipeBundle(bundle: BristleBundle) {
  for (const tip of bundle.tips) {
    tip.load *= 0.2;
    tip.contamination *= 0.2;
    tip.oil = 0;
    tip.anchor = 0;
  }
}

export function resetPaths(bundle: BristleBundle): void {
  for (let i = 0; i < bundle.paths.length; i++) {
    const tip = bundle.tips[bundle.selectedTips[i]];
    bundle.paths[i] = createEmptyPath(bundle.selectedTips[i], tip);
  }
}

/** Copy curr→prev for dirty paths, clear dirty flag. Call after each dispatch. */
export function commitPaths(bundle: BristleBundle): void {
  for (const path of bundle.paths) {
    if (path.currPos) {
      path.prevPos = path.currPos;
      path.prevRadius = path.currRadius;
      path.prevLoad = path.currLoad;
      path.currPos = null;
      path.dirty = false;
    }
  }
}

/** True if any path has both prevPos and currPos set + dirty — ready for dispatch */
export function hasDirtyPaths(bundle: BristleBundle): boolean {
  for (const path of bundle.paths) {
    if (path.dirty && path.prevPos && path.currPos) return true;
  }
  return false;
}

export function getAverageLoad(bundle: BristleBundle): number {
  let sum = 0;
  let count = 0;
  for (const tip of bundle.tips) {
    sum += tip.load;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

export function setSurfaceProperties(bundle: BristleBundle, friction: number, tooth: number) {
  bundle.friction = friction;
  bundle.tooth = tooth;
}

// --- Module-level bundle instance ---
let activeBundle: BristleBundle | null = null;

export function getActiveBundle(): BristleBundle | null {
  return activeBundle;
}

export function setActiveBundle(bundle: BristleBundle) {
  activeBundle = bundle;
}

export function resetActiveBundle() {
  activeBundle = null;
}

export function ensureBundle(seed: number, age: number): BristleBundle {
  if (!activeBundle) {
    activeBundle = createBundle(seed, age);
  }
  return activeBundle;
}
