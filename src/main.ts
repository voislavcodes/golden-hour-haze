import { initGPU, showFallback } from './gpu/context.js';
import { initApp } from './app.js';

async function main() {
  // Check for WebGPU support
  if (!navigator.gpu) {
    showFallback();
    return;
  }

  const canvas = document.getElementById('ghz') as HTMLCanvasElement;
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }

  try {
    await initGPU(canvas);
    initApp();
    console.log('Golden Hour Haze initialized');
  } catch (err) {
    console.error('Failed to initialize:', err);
    showFallback((err as Error).message);
  }
}

main();
