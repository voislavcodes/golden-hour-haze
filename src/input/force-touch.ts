let currentForce = 0;
let supported = false;
let _initialized = false;

/**
 * Attach Force Touch listeners on window.
 * Must preventDefault on webkitmouseforcewillbegin to opt in to force events.
 */
export function initForceTouch(): void {
  if (_initialized) return;
  _initialized = true;

  // Opt in to Force Touch — without this, Safari intercepts for Quick Look
  window.addEventListener('webkitmouseforcewillbegin', (e: Event) => {
    e.preventDefault();
  }, true);

  // Track force changes continuously during contact
  window.addEventListener('webkitmouseforcechanged', (e: Event) => {
    currentForce = (e as any).webkitForce ?? 0;
    supported = true;
  }, true);
}

export function getForceTouchPressure(): number | null {
  if (!supported || currentForce <= 0) return null;
  // webkitForce 0-3 → pressure 0.3-1.0 (continuous, no discontinuity with 0.5 fallback)
  // Normal click (~1.0) maps to ~0.53, close to the 0.5 fallback.
  // Hard press (3) = full pressure. Light touch (<1) = below default.
  const t = Math.min(1.0, currentForce / 3.0);
  return 0.3 + 0.7 * t;
}

export function resetForceTouch(): void {
  currentForce = 0;
}
