import { createStore } from './store.js';

export interface ArtboardPreset {
  name: string;
  width: number;
  height: number;
}

export const ARTBOARD_PRESETS: ArtboardPreset[] = [
  { name: 'Landscape',       width: 1920, height: 1080 },
  { name: 'Portrait',        width: 1080, height: 1920 },
  { name: 'Square',          width: 1440, height: 1440 },
  { name: 'Large Landscape', width: 2560, height: 1440 },
];

export interface ArtboardState {
  presetIndex: number;
  width: number;
  height: number;
}

export const artboardStore = createStore<ArtboardState>({
  presetIndex: 0,
  width: ARTBOARD_PRESETS[0].width,
  height: ARTBOARD_PRESETS[0].height,
});
