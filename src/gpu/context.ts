export interface GPUContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  dpr: number;
}

let gpuCtx: GPUContext | null = null;
let resizeCallbacks: Array<(width: number, height: number) => void> = [];

export function onResize(cb: (width: number, height: number) => void) {
  resizeCallbacks.push(cb);
  return () => {
    resizeCallbacks = resizeCallbacks.filter((c) => c !== cb);
  };
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  if (!navigator.gpu) throw new Error('WebGPU not supported');

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) throw new Error('No GPU adapter found');

  const device = await adapter.requestDevice({
    requiredFeatures: [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  device.lost.then((info) => {
    console.error('GPU device lost:', info.message);
    if (info.reason !== 'destroyed') {
      // Attempt re-initialization
      initGPU(canvas).catch(() => {
        showFallback('GPU device lost and could not be recovered.');
      });
    }
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Failed to get WebGPU context');

  const format = navigator.gpu.getPreferredCanvasFormat();
  const dpr = Math.min(window.devicePixelRatio, 2);

  const width = Math.floor(canvas.clientWidth * dpr);
  const height = Math.floor(canvas.clientHeight * dpr);
  canvas.width = width;
  canvas.height = height;

  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  gpuCtx = { device, context, format, canvas, width, height, dpr };

  const ro = new ResizeObserver(() => {
    if (!gpuCtx) return;
    const newDpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.floor(canvas.clientWidth * newDpr);
    const h = Math.floor(canvas.clientHeight * newDpr);
    if (w === gpuCtx.width && h === gpuCtx.height && newDpr === gpuCtx.dpr) return;

    gpuCtx.width = w;
    gpuCtx.height = h;
    gpuCtx.dpr = newDpr;
    canvas.width = w;
    canvas.height = h;

    context.configure({ device, format, alphaMode: 'premultiplied' });

    for (const cb of resizeCallbacks) cb(w, h);
  });
  ro.observe(canvas);

  return gpuCtx;
}

export function getGPU(): GPUContext {
  if (!gpuCtx) throw new Error('GPU not initialized');
  return gpuCtx;
}

function showFallback(message?: string) {
  const el = document.getElementById('fallback');
  if (el) {
    el.style.display = 'flex';
    if (message) {
      const p = el.querySelector('p');
      if (p) p.textContent = message;
    }
  }
}

export { showFallback };
