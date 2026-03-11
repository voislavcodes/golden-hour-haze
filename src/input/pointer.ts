import { uiStore, pointerQueue } from '../state/ui-state.js';

let canvas: HTMLCanvasElement;

export function initPointerInput(c: HTMLCanvasElement) {
  canvas = c;

  // If canvas-overlay component exists, it handles pointer events instead
  // Only attach canvas listeners as fallback
  if (!document.querySelector('ghz-canvas-overlay')) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

function normalizeCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
}

function onPointerDown(e: PointerEvent) {
  canvas.setPointerCapture(e.pointerId);
  const { x, y } = normalizeCoords(e);
  uiStore.set({
    mouseX: x,
    mouseY: y,
    mouseDown: true,
    pressure: e.pressure,
    tiltX: e.tiltX,
    tiltY: e.tiltY,
    pointerType: e.pointerType,
  });
}

function onPointerMove(e: PointerEvent) {
  // Queue all coalesced positions for the brush engine
  const events = e.getCoalescedEvents?.() ?? [e];
  for (const ce of events) {
    const rect = canvas.getBoundingClientRect();
    pointerQueue.push({
      x: (ce.clientX - rect.left) / rect.width,
      y: (ce.clientY - rect.top) / rect.height,
      pressure: ce.pressure > 0 ? ce.pressure : 0.5,
      tiltX: ce.tiltX || 0,
      tiltY: ce.tiltY || 0,
    });
  }

  const last = events[events.length - 1] || e;
  const { x, y } = normalizeCoords(last);

  uiStore.set({
    mouseX: x,
    mouseY: y,
    pressure: last.pressure,
    tiltX: last.tiltX,
    tiltY: last.tiltY,
    pointerType: last.pointerType,
  });
}

function onPointerUp(e: PointerEvent) {
  const { x, y } = normalizeCoords(e);
  uiStore.set({
    mouseX: x,
    mouseY: y,
    mouseDown: false,
    pressure: 0,
  });
}
