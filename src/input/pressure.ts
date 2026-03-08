// Pressure normalization + form variation mapping
// Fast confident stroke → sharp geometric form
// Slow wavering → weathered organic
// Heavy trailing off → form leans

export interface StrokeMetrics {
  velocity: number;
  pressure: number;
  variance: number;  // how much the stroke wavers
  duration: number;
}

export interface FormModifiers {
  softness: number;
  rotation: number;
  size: number;
}

let prevX = 0;
let prevY = 0;
let prevTime = 0;
let velocityHistory: number[] = [];
let pressureHistory: number[] = [];
const HISTORY_LEN = 10;

export function resetStrokeTracking() {
  prevX = 0;
  prevY = 0;
  prevTime = 0;
  velocityHistory = [];
  pressureHistory = [];
}

export function updateStrokeMetrics(
  x: number,
  y: number,
  pressure: number,
  time: number
): StrokeMetrics {
  const dt = prevTime ? time - prevTime : 16;
  const dx = x - prevX;
  const dy = y - prevY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const velocity = dt > 0 ? dist / dt : 0;

  prevX = x;
  prevY = y;
  prevTime = time;

  velocityHistory.push(velocity);
  pressureHistory.push(pressure);
  if (velocityHistory.length > HISTORY_LEN) velocityHistory.shift();
  if (pressureHistory.length > HISTORY_LEN) pressureHistory.shift();

  // Compute variance from mean velocity
  const avgVel =
    velocityHistory.reduce((a, b) => a + b, 0) / velocityHistory.length;
  const variance =
    velocityHistory.reduce((sum, v) => sum + (v - avgVel) ** 2, 0) /
    velocityHistory.length;

  return {
    velocity: avgVel,
    pressure,
    variance,
    duration: velocityHistory.length * 16,
  };
}

export function metricsToModifiers(metrics: StrokeMetrics): FormModifiers {
  const { velocity, pressure, variance } = metrics;

  // Fast + confident → sharp (low softness)
  // Slow + wavering → organic (high softness)
  const speed = Math.min(velocity * 200, 1);
  const waver = Math.min(variance * 1000, 1);

  const softness = 0.01 + (1 - speed) * 0.15 + waver * 0.1;

  // Heavy trailing off → form leans in stroke direction
  const pressureDelta =
    pressureHistory.length > 1
      ? pressureHistory[pressureHistory.length - 1] -
        pressureHistory[pressureHistory.length - 2]
      : 0;
  const rotation = pressureDelta * -0.5; // lean into pressure release

  // Size modulated by pressure (min 0.04 so forms are visible on trackpads)
  const effectivePressure = pressure > 0 ? pressure : 0.5;
  const size = 0.04 + effectivePressure * 0.08;

  return { softness, rotation, size };
}
