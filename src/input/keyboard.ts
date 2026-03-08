import { uiStore, type Tool } from '../state/ui-state.js';
import { undo, redo } from '../state/history.js';
import { sceneStore } from '../state/scene-state.js';

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

    // Atmosphere preset recall (1-4)
    const digit = parseInt(e.key, 10);
    if (digit >= 1 && digit <= 4) {
      const presets = sceneStore.get().orbPresets;
      const preset = presets[digit - 1];
      if (preset) {
        sceneStore.update(() => ({ atmosphere: { ...preset } }));
      }
      return;
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
