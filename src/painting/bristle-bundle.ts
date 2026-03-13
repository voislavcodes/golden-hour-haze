// Bristle bundle — 1024-tip physical brush simulation (CPU-side)
// Drives per-vertex splay, depletion, age effects for the polyline SDF renderer.
// The GPU renders capsule SDFs; this module computes the physical brush state
// that modulates per-vertex radius and reservoir.

type Vec2 = [number, number];

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
  ringIndex: number;
  inContact: boolean;
}

export interface BristleBundle {
  tips: BristleTip[];
  tipCount: number;
  splay: number;
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

// --- Ring layout ---
const RING_COUNT = 13;
const TIP_COUNT = 1024;
const MAX_RING = RING_COUNT - 1;

function buildRingCounts(): number[] {
  const counts = [1];
  let total = 1;
  const rawCounts: number[] = [];
  let rawTotal = 0;
  for (let r = 1; r < RING_COUNT; r++) {
    const c = Math.round(6 * r);
    rawCounts.push(c);
    rawTotal += c;
  }
  for (let r = 0; r < rawCounts.length; r++) {
    const scaled = Math.round(rawCounts[r] * (TIP_COUNT - 1) / rawTotal);
    counts.push(scaled);
    total += scaled;
  }
  counts[counts.length - 1] += TIP_COUNT - total;
  return counts;
}

const RING_COUNTS = buildRingCounts();

export function createBundle(seed: number, age: number): BristleBundle {
  const stiffness = 1.0 - age * 0.5;
  const recoveryRate = 1.0 - age * 0.4;
  const tips: BristleTip[] = [];

  for (let ring = 0; ring < RING_COUNT; ring++) {
    const count = RING_COUNTS[ring];
    const ringRadius = ring / MAX_RING;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + ring * 0.618;
      const drift = age * 0.08 * (Math.sin(seed * 127.1 + i * 311.7) * 0.5 + 0.5);
      const r = ringRadius * (1.0 + drift);
      const ox = Math.cos(angle) * r;
      const oy = Math.sin(angle) * r;

      tips.push({
        restOffset: [ox, oy],
        currentOffset: [ox, oy],
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
        ringIndex: ring,
        inContact: false,
      });
    }
  }

  initPickupGrid();

  return {
    tips,
    tipCount: tips.length,
    splay: 0,
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
  };
}

/** Advance bristle physics for one frame. Updates bundle state in-place.
 *  The engine reads bundle.splay and getAverageLoad() for per-vertex params. */
export function updateBundle(
  bundle: BristleBundle,
  pos: Vec2,
  pressure: number,
  tiltX: number,
  tiltY: number,
  dt: number,
  brushRadius: number,
): void {
  const { tips, stiffness, age } = bundle;

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

  // Splay from pressure — quadratic response (Euler-Bernoulli beam bending)
  // Light pressure barely changes footprint; heavy pressure dramatically expands
  const pressureSq = pressure * pressure;
  const targetSplay = pressureSq * 0.85 + 0.15;
  bundle.splay += (targetSplay - bundle.splay) * 0.4;
  bundle.contactPressure = pressure;

  // Dominant bend direction — trails movement
  const bendSmooth = 0.25;
  bundle.dominantBendDir[0] = bundle.dominantBendDir[0] * (1 - bendSmooth) + (-moveDir[0]) * bendSmooth;
  bundle.dominantBendDir[1] = bundle.dominantBendDir[1] * (1 - bendSmooth) + (-moveDir[1]) * bendSmooth;

  const tiltNormX = (tiltX || 0) / 90;
  const tiltNormY = (tiltY || 0) / 90;
  const tiltInfluence = 0.3;
  const frictionFactor = 1.0 - bundle.friction * 0.5;

  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i];
    const ringNorm = tip.ringIndex / MAX_RING;

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

    // Contact detection
    const contactThreshold = ringNorm * (1.0 - pressure * 0.9);
    tip.inContact = pressure > contactThreshold;

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

    // Per-tip depletion — edges deplete first (cubic gradient)
    // Gentle rate: sigmoidal curve in brush-engine handles macro-depletion,
    // tips add micro-texture (edge drying) without creating visible gaps
    if (tip.load > 0) {
      const edgeFactor = ringNorm * ringNorm * ringNorm; // cubic: 0 center → 1 edge
      const depletionRate = (0.05 + edgeFactor * 0.25) * tipPressure;
      tip.load = Math.max(0, tip.load - depletionRate * dt);
    }

    // Deposit into pickup grid
    if (tip.load > 0.01) {
      depositGrid(wx, wy, tip.colorKr, tip.colorKg, tip.colorKb, tip.load);
    }
  }

  bundle.lastPos = [pos[0], pos[1]];
}

export function dipBundle(bundle: BristleBundle, kr: number, kg: number, kb: number, oil: number, anchor: number, load: number) {
  for (const tip of bundle.tips) {
    // Steeper capillary loading gradient — inner bristles hold more paint
    const ringNorm = tip.ringIndex / MAX_RING;
    const ringFalloff = 1.0 - ringNorm * ringNorm * 0.6;
    tip.load = load * ringFalloff;
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

// --- 1D bristle density profile for GPU dry brush ---
// Projects all 1024 tips onto the cross-stroke (perpendicular) axis,
// producing a density profile the shader samples instead of hash-noise lanes.
// Natural ring layout + splay + age drift → irregular clumping.
export const BRISTLE_PROFILE_SIZE = 64;

export function buildBristleProfile(bundle: BristleBundle, dirX: number, dirY: number): Float32Array {
  const profile = new Float32Array(BRISTLE_PROFILE_SIZE);
  const { tips } = bundle;

  // Perpendicular to stroke direction
  const perpX = -dirY;
  const perpY = dirX;

  // Find max extent of tips along perp axis for normalization
  let maxExtent = 0;
  for (let i = 0; i < tips.length; i++) {
    const proj = Math.abs(tips[i].currentOffset[0] * perpX + tips[i].currentOffset[1] * perpY);
    if (proj > maxExtent) maxExtent = proj;
  }
  if (maxExtent < 0.001) {
    // No clear direction — fill profile uniformly
    profile.fill(1.0);
    return profile;
  }

  for (let i = 0; i < tips.length; i++) {
    const tip = tips[i];
    const perpProj = tip.currentOffset[0] * perpX + tip.currentOffset[1] * perpY;

    // Map from [-maxExtent, maxExtent] to [0, PROFILE_SIZE-1]
    const normalized = (perpProj / maxExtent + 1) * 0.5;
    const bin = Math.floor(normalized * (BRISTLE_PROFILE_SIZE - 1));
    if (bin < 0 || bin >= BRISTLE_PROFILE_SIZE) continue;

    // In-contact tips: full contribution weighted by load
    // Out-of-contact: faint residue from tips that barely graze the surface
    const weight = tip.inContact
      ? Math.max(tip.load, 0.08)
      : tip.load * 0.12;

    // Spread across neighboring bins — tip has physical width
    profile[bin] += weight * 0.5;
    if (bin > 0) profile[bin - 1] += weight * 0.25;
    if (bin < BRISTLE_PROFILE_SIZE - 1) profile[bin + 1] += weight * 0.25;
  }

  // Normalize peak to 1.0
  let maxVal = 0;
  for (let i = 0; i < BRISTLE_PROFILE_SIZE; i++) {
    if (profile[i] > maxVal) maxVal = profile[i];
  }
  if (maxVal > 0) {
    for (let i = 0; i < BRISTLE_PROFILE_SIZE; i++) {
      profile[i] /= maxVal;
    }
  }

  return profile;
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
