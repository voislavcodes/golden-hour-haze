import { uiStore, type Tool } from '../state/ui-state.js';

const toolKeys: Record<string, Tool> = {
  v: 'select',
  f: 'form',
  l: 'light',
  d: 'dissolve',
  w: 'drift',
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

    // Toggle UI
    if (e.key === 'Tab') {
      e.preventDefault();
      uiStore.update((s) => ({ showUI: !s.showUI }));
    }

    // Undo/Redo (placeholders for history system)
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      // Will be connected to history in Phase 8
    }
  });
}
