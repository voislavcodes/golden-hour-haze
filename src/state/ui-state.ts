import { createStore } from './store.js';

export type Tool = 'select' | 'form' | 'light' | 'dissolve' | 'drift' | 'palette' | 'depth' | 'anchor';

export interface UIState {
  activeTool: Tool;
  mouseX: number;
  mouseY: number;
  mouseDown: boolean;
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: string;
  showUI: boolean;
  brushSize: number;
  grayscalePreview: boolean;
}

export const uiStore = createStore<UIState>({
  activeTool: 'form',
  mouseX: 0,
  mouseY: 0,
  mouseDown: false,
  pressure: 0,
  tiltX: 0,
  tiltY: 0,
  pointerType: 'mouse',
  showUI: true,
  brushSize: 0.06,
  grayscalePreview: false,
});
