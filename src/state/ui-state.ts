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
  dissolveStrength: number;  // 0.1-1.0, default 0.5
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
  dissolveStrength: 0.5,
});
