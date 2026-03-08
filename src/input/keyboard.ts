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
  a: 'anchor',
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

    // Brush size / dissolve strength shortcuts (context-aware)
    if (e.key === '[') {
      if (uiStore.get().activeTool === 'dissolve') {
        uiStore.update((s) => ({ dissolveStrength: Math.max(0.1, s.dissolveStrength * 0.8) }));
      } else {
        uiStore.update((s) => ({ brushSize: Math.max(0.01, s.brushSize * 0.8) }));
      }
      return;
    }
    if (e.key === ']') {
      if (uiStore.get().activeTool === 'dissolve') {
        uiStore.update((s) => ({ dissolveStrength: Math.min(1.0, s.dissolveStrength * 1.25) }));
      } else {
        uiStore.update((s) => ({ brushSize: Math.min(0.25, s.brushSize * 1.25) }));
      }
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
