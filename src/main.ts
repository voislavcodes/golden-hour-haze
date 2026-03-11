import { initGPU, showFallback } from './gpu/context.js';
import { initApp } from './app.js';
import { artboardStore } from './state/artboard-state.js';

async function main() {
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
    const { width, height } = artboardStore.get();
    await initGPU(canvas, width, height);
    initApp();
    console.log('Golden Hour Haze V2 initialized');

    // Load test bridge when ?test is in the URL (for headless Playwright testing)
    if (new URLSearchParams(location.search).has('test')) {
      import('./test-bridge.js');
    }
  } catch (err) {
    console.error('Failed to initialize:', err);
    showFallback((err as Error).message);
  }
}

main();
