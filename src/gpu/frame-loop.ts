export type FrameCallback = (dt: number, elapsed: number) => void;

let running = false;
let frameId = 0;
let lastTime = 0;
let elapsed = 0;
let callback: FrameCallback | null = null;

function tick(now: number) {
  if (!running) return;
  const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 1 / 60;
  lastTime = now;
  elapsed += dt;
  callback?.(dt, elapsed);
  frameId = requestAnimationFrame(tick);
}

export function startLoop(cb: FrameCallback) {
  callback = cb;
  running = true;
  lastTime = 0;
  elapsed = 0;
  frameId = requestAnimationFrame(tick);
}

export function stopLoop() {
  running = false;
  cancelAnimationFrame(frameId);
}
