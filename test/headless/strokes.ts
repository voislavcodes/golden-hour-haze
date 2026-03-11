// Stroke definitions for headless painting tests
// Each stroke is a named sequence of points with brush configuration

export interface StrokePoint {
  x: number;       // 0-1 normalized
  y: number;       // 0-1 normalized
  pressure: number; // 0-1
  tiltX?: number;
  tiltY?: number;
}

export interface StrokeDefinition {
  name: string;
  points: StrokePoint[];
  options: {
    tool?: 'form' | 'scrape' | 'wipe';
    brushSlot?: number;  // 0=Detail, 1=Small, 2=Medium, 3=Large, 4=Wash
    hueIndex?: number;   // 0-4 (palette column)
    brushSize?: number;  // radius in normalized-Y space
    thinners?: number;   // 0-1
    load?: number;       // 0-1
  };
}

// --- Stroke generators ---

/** Cubic bezier curve with pressure envelope */
export function bezierStroke(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  steps: number,
  pressureFn: (t: number) => number = (t) => 0.3 + 0.4 * Math.sin(t * Math.PI),
): StrokePoint[] {
  const points: StrokePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt*mt*mt*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t*t*t*p3[0];
    const y = mt*mt*mt*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t*t*t*p3[1];
    points.push({ x, y, pressure: pressureFn(t) });
  }
  return points;
}

/** Straight line with pressure envelope */
export function lineStroke(
  from: [number, number],
  to: [number, number],
  steps: number,
  pressureFn: (t: number) => number = (t) => 0.3 + 0.4 * Math.sin(t * Math.PI),
): StrokePoint[] {
  const points: StrokePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: from[0] + (to[0] - from[0]) * t,
      y: from[1] + (to[1] - from[1]) * t,
      pressure: pressureFn(t),
    });
  }
  return points;
}

/** Arc stroke (portion of a circle) */
export function arcStroke(
  cx: number, cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  steps: number,
  pressureFn: (t: number) => number = (t) => 0.3 + 0.4 * Math.sin(t * Math.PI),
): StrokePoint[] {
  const points: StrokePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = startAngle + (endAngle - startAngle) * t;
    points.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      pressure: pressureFn(t),
    });
  }
  return points;
}

// --- Pressure envelopes ---

/** Gentle swell: light → medium → light */
export const pressureSwell = (t: number) => 0.2 + 0.4 * Math.sin(t * Math.PI);

/** Attack stroke: strong start → taper */
export const pressureAttack = (t: number) => 0.7 * Math.max(0, 1 - t * 1.3);

/** Steady medium pressure */
export const pressureSteady = (_t: number) => 0.5;

/** Ramp up: light → heavy */
export const pressureRamp = (t: number) => 0.15 + 0.6 * t;

// --- Demo scene: Golden Hour landscape ---

export const DEMO_STROKES: StrokeDefinition[] = [
  // 1. Big warm wash across the sky area
  {
    name: 'sky-wash',
    points: bezierStroke(
      [0.05, 0.15], [0.3, 0.08], [0.7, 0.12], [0.95, 0.18],
      60,
      (t) => 0.2 + 0.3 * Math.sin(t * Math.PI),
    ),
    options: {
      brushSlot: 4,  // Wash
      hueIndex: 0,   // warm gold
      brushSize: 0.12,
      thinners: 0.6,
      load: 0.8,
    },
  },

  // 2. Second sky wash — cooler top
  {
    name: 'sky-cool',
    points: bezierStroke(
      [0.02, 0.05], [0.25, 0.03], [0.75, 0.06], [0.98, 0.08],
      50,
      (t) => 0.15 + 0.25 * Math.sin(t * Math.PI),
    ),
    options: {
      brushSlot: 4,
      hueIndex: 3,   // twilight blue
      brushSize: 0.1,
      thinners: 0.7,
      load: 0.6,
    },
  },

  // 3. Horizon line — warm cream
  {
    name: 'horizon',
    points: lineStroke(
      [0.02, 0.5], [0.98, 0.48],
      40,
      pressureSwell,
    ),
    options: {
      brushSlot: 2,  // Medium
      hueIndex: 4,   // warm cream
      brushSize: 0.02,
      thinners: 0.3,
      load: 0.6,
    },
  },

  // 4. Distant hills — muted mauve
  {
    name: 'distant-hills',
    points: bezierStroke(
      [0.0, 0.48], [0.2, 0.42], [0.5, 0.44], [0.75, 0.46],
      45,
      (t) => 0.3 + 0.3 * Math.sin(t * Math.PI),
    ),
    options: {
      brushSlot: 3,  // Large
      hueIndex: 2,   // muted mauve
      brushSize: 0.06,
      thinners: 0.4,
      load: 0.5,
    },
  },

  // 5. Foreground mass — dark warm
  {
    name: 'foreground-mass',
    points: bezierStroke(
      [0.1, 0.9], [0.3, 0.65], [0.6, 0.7], [0.85, 0.85],
      50,
      (t) => 0.5 + 0.3 * Math.sin(t * Math.PI),
    ),
    options: {
      brushSlot: 3,
      hueIndex: 1,   // burnt orange
      brushSize: 0.08,
      thinners: 0.15,
      load: 0.7,
    },
  },

  // 6. Shadow in distance — blue
  {
    name: 'distance-shadow',
    points: bezierStroke(
      [0.5, 0.45], [0.55, 0.42], [0.7, 0.44], [0.8, 0.48],
      35,
      (t) => 0.2 + 0.3 * Math.sin(t * Math.PI),
    ),
    options: {
      brushSlot: 2,
      hueIndex: 3,
      brushSize: 0.04,
      thinners: 0.4,
      load: 0.4,
    },
  },

  // 7. Accent marks — mauve
  {
    name: 'accent-marks',
    points: bezierStroke(
      [0.2, 0.4], [0.25, 0.35], [0.35, 0.38], [0.4, 0.42],
      30,
      (t) => 0.3 + 0.4 * Math.sin(t * Math.PI),
    ),
    options: {
      brushSlot: 1,  // Small
      hueIndex: 2,
      brushSize: 0.03,
      thinners: 0.25,
      load: 0.5,
    },
  },

  // 8. Detail strokes
  {
    name: 'detail',
    points: bezierStroke(
      [0.3, 0.6], [0.32, 0.55], [0.28, 0.58], [0.35, 0.62],
      20,
      (t) => 0.4 + 0.3 * Math.sin(t * Math.PI * 2),
    ),
    options: {
      brushSlot: 0,  // Detail
      hueIndex: 0,
      brushSize: 0.015,
      thinners: 0.2,
      load: 0.6,
    },
  },

  // 9. Scrape back some sky for texture
  {
    name: 'sky-scrape',
    points: lineStroke(
      [0.3, 0.2], [0.6, 0.18],
      25,
      pressureSteady,
    ),
    options: {
      tool: 'scrape',
      brushSlot: 2,
      brushSize: 0.04,
    },
  },
];
