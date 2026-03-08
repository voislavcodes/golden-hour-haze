import { uiStore, type Tool } from '../state/ui-state.js';
import { undo, redo } from '../state/history.js';

const toolKeys: Record<string, Tool> = {
  v: 'select',
  f: 'form',
  l: 'light',
  d: 'dissolve',
  r: 'drift',
  p: 'palette',
  z: 'depth',
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

    // Brush size shortcuts
    if (e.key === '[') {
      uiStore.update((s) => ({ brushSize: Math.max(0.01, s.brushSize * 0.8) }));
      return;
    }
    if (e.key === ']') {
      uiStore.update((s) => ({ brushSize: Math.min(0.25, s.brushSize * 1.25) }));
      return;
    }

    // Toggle UI
    if (e.key === 'Tab') {
      e.preventDefault();
      uiStore.update((s) => ({ showUI: !s.showUI }));
    }

    // Undo/Redo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    }
  });
}
