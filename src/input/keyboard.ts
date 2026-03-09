import { uiStore, type Tool } from '../state/ui-state.js';
import { sceneStore } from '../state/scene-state.js';

const toolKeys: Record<string, Tool> = {
  v: 'select',
  f: 'form',
  l: 'light',
  d: 'dissolve',
  r: 'drift',
  p: 'palette',
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

    // Brush size shortcuts — always controls circle size for all tools
    if (e.key === '[') {
      uiStore.update((s) => ({ brushSize: Math.max(0.01, s.brushSize * 0.8) }));
      return;
    }
    if (e.key === ']') {
      uiStore.update((s) => ({ brushSize: Math.min(0.25, s.brushSize * 1.25) }));
      return;
    }

    // Horizon cycle: current → 0.5 (center) → -1.0 (off) → 0.5
    if (e.key.toLowerCase() === 'h') {
      const cur = sceneStore.get().horizonY;
      if (cur < 0) {
        sceneStore.set({ horizonY: 0.5 });
      } else if (Math.abs(cur - 0.5) < 0.01) {
        sceneStore.set({ horizonY: -1.0 });
      } else {
        sceneStore.set({ horizonY: 0.5 });
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

    // Undo/Redo handled in app.ts (requires GPU encoder)
  });
}
