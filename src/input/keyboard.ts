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

    // Direct brush slot selection: 1-5
    if (e.key >= '1' && e.key <= '5' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      uiStore.set({ activeBrushSlot: parseInt(e.key) - 1 });
      return;
    }

    // Brush slot stepping
    if (e.key === '[') {
      uiStore.update((s) => ({ activeBrushSlot: Math.max(0, s.activeBrushSlot - 1) }));
      return;
    }
    if (e.key === ']') {
      uiStore.update((s) => ({ activeBrushSlot: Math.min(4, s.activeBrushSlot + 1) }));
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
