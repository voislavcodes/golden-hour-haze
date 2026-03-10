import { uiStore, type Tool } from '../state/ui-state.js';
import { wipeOnRag } from '../painting/palette.js';

const toolKeys: Record<string, Tool> = {
  v: 'select',
  f: 'form',
  d: 'scrape',
  w: 'wipe',
};

export function initKeyboardInput() {
  document.addEventListener('keydown', (e) => {
    // Tool shortcuts
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const tool = toolKeys[e.key.toLowerCase()];
      if (tool) {
        uiStore.set({ activeTool: tool });
        return;
      }
    }

    // Brush size shortcuts — always controls circle size for all tools
    if (e.key === '[') {
      uiStore.update((s) => ({ brushSize: Math.max(0.01, s.brushSize * 0.8) }));
      return;
    }
    if (e.key === ']') {
      uiStore.update((s) => ({ brushSize: Math.min(0.25, s.brushSize * 1.25) }));
      return;
    }

    // Rag wipe
    if (e.key.toLowerCase() === 'x' && !e.ctrlKey && !e.metaKey) {
      wipeOnRag();
      return;
    }

    // Grayscale preview
    if (e.key.toLowerCase() === 'g') {
      uiStore.update((s) => ({ grayscalePreview: !s.grayscalePreview }));
      return;
    }

    // Toggle UI
    if (e.key === 'Tab') {
      e.preventDefault();
      uiStore.update((s) => ({ showUI: !s.showUI }));
    }

  });
}
