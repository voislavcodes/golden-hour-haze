// Gesture recognition: pinch, rotate, pan

export interface GestureState {
  pinchScale: number;
  rotation: number;
  panX: number;
  panY: number;
  active: boolean;
}

type GestureCallback = (state: GestureState) => void;

let gestureState: GestureState = {
  pinchScale: 1,
  rotation: 0,
  panX: 0,
  panY: 0,
  active: false,
};

let callback: GestureCallback | null = null;
const activePointers = new Map<number, { x: number; y: number }>();
let initialDistance = 0;
let initialAngle = 0;
let initialCenter = { x: 0, y: 0 };

export function initGestureInput(canvas: HTMLCanvasElement, cb: GestureCallback) {
  callback = cb;

  canvas.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) startGesture();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2 && gestureState.active) updateGesture();
  });

  const endPointer = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) {
      gestureState.active = false;
    }
  };

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
}

function getPoints(): [{ x: number; y: number }, { x: number; y: number }] | null {
  const pts = Array.from(activePointers.values());
  if (pts.length < 2) return null;
  return [pts[0], pts[1]];
}

function startGesture() {
  const pts = getPoints();
  if (!pts) return;

  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  initialDistance = Math.sqrt(dx * dx + dy * dy);
  initialAngle = Math.atan2(dy, dx);
  initialCenter = {
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2,
  };

  gestureState.active = true;
  gestureState.pinchScale = 1;
  gestureState.rotation = 0;
  gestureState.panX = 0;
  gestureState.panY = 0;
}

function updateGesture() {
  const pts = getPoints();
  if (!pts) return;

  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const center = {
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2,
  };

  gestureState.pinchScale = initialDistance > 0 ? dist / initialDistance : 1;
  gestureState.rotation = angle - initialAngle;
  gestureState.panX = center.x - initialCenter.x;
  gestureState.panY = center.y - initialCenter.y;

  callback?.(gestureState);
}

export function getGestureState(): GestureState {
  return gestureState;
}
