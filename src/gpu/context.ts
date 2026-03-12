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

/**
 * Fit the canvas CSS display size to the viewport container.
 * Never upscales — only downscales if the artboard is larger than the container.
 */
function fitCanvasToViewport() {
  if (!gpuCtx) return;
  const { canvas, width, height } = gpuCtx;
  const container = canvas.parentElement;
  if (!container) return;

  const containerW = container.clientWidth;
  const containerH = container.clientHeight;
  const scale = Math.min(1, containerW / width, containerH / height);

  canvas.style.width = `${Math.floor(width * scale)}px`;
  canvas.style.height = `${Math.floor(height * scale)}px`;
}

export async function initGPU(canvas: HTMLCanvasElement, artboardW: number, artboardH: number): Promise<GPUContext> {
  if (!navigator.gpu) throw new Error('WebGPU not supported');

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapter) throw new Error('No GPU adapter found');

  // Request float32-filterable so r32float textures work with filtering samplers
  // (needed by density compute pass for depth texture sampling)
  const features: GPUFeatureName[] = [];
  if (adapter.features.has('float32-filterable')) {
    features.push('float32-filterable');
  }

  const device = await adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  device.lost.then((info) => {
    console.error('GPU device lost:', info.message);
    if (info.reason !== 'destroyed') {
      initGPU(canvas, artboardW, artboardH).catch(() => {
        showFallback('GPU device lost and could not be recovered.');
      });
    }
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Failed to get WebGPU context');

  const format = navigator.gpu.getPreferredCanvasFormat();

  // Fixed artboard size — DPR is always 1
  canvas.width = artboardW;
  canvas.height = artboardH;

  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  gpuCtx = { device, context, format, canvas, width: artboardW, height: artboardH, dpr: 1 };

  fitCanvasToViewport();

  // ResizeObserver only adjusts CSS display size — no texture reallocation
  const ro = new ResizeObserver(() => {
    fitCanvasToViewport();
  });
  const container = canvas.parentElement;
  if (container) {
    ro.observe(container);
  }

  return gpuCtx;
}

/**
 * Resize the artboard — reconfigures GPU backing store and fires onResize callbacks
 * for texture reallocation. Only called when user explicitly changes artboard size.
 */
export function resizeArtboard(w: number, h: number) {
  if (!gpuCtx) return;
  const { canvas, context, device, format } = gpuCtx;

  canvas.width = w;
  canvas.height = h;
  gpuCtx.width = w;
  gpuCtx.height = h;

  context.configure({ device, format, alphaMode: 'premultiplied' });
  fitCanvasToViewport();

  for (const cb of resizeCallbacks) cb(w, h);
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
