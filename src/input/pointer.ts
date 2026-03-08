import { uiStore } from '../state/ui-state.js';

let canvas: HTMLCanvasElement;

export function initPointerInput(c: HTMLCanvasElement) {
  canvas = c;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
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
  // Use coalesced events if available for smoother strokes
  const events = ('getCoalescedEvents' in e) ? e.getCoalescedEvents() : [e];
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
