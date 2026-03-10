// Material definitions — per-material constants for surface generation + compositing
import type { MaterialType } from '../state/scene-state.js';

export interface MaterialDef {
  colorLight: [number, number, number];  // sRGB float
  colorDark: [number, number, number];
  absorption: number;
  drySpeed: number;
  mode: number;  // u32 for shader: 0=board, 1=canvas, 2=paper, 3=gesso
}

function hexToLinear(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = ((v >> 16) & 0xff) / 255;
  const g = ((v >> 8) & 0xff) / 255;
  const b = (v & 0xff) / 255;
  return [r, g, b];
}

export const MATERIALS: Record<MaterialType, MaterialDef> = {
  board: {
    colorLight: hexToLinear('#C8B898'),
    colorDark: hexToLinear('#8B7355'),
    absorption: 0.15,
    drySpeed: 1.0,
    mode: 0,
  },
  canvas: {
    colorLight: hexToLinear('#F0EBE0'),
    colorDark: hexToLinear('#D8CDB8'),
    absorption: 0.10,
    drySpeed: 0.9,
    mode: 1,
  },
  paper: {
    colorLight: hexToLinear('#F5F0E8'),
    colorDark: hexToLinear('#E0D5C0'),
    absorption: 0.25,
    drySpeed: 1.4,
    mode: 2,
  },
  gesso: {
    colorLight: hexToLinear('#F5F3F0'),
    colorDark: hexToLinear('#E8DFD0'),
    absorption: 0.05,
    drySpeed: 0.7,
    mode: 3,
  },
};

export function getMaterial(type: MaterialType): MaterialDef {
  return MATERIALS[type];
}

export function getSurfaceBaseColor(material: MaterialType, tone: number): [number, number, number] {
  const m = MATERIALS[material];
  const t = Math.max(0, Math.min(1, tone));
  return [
    m.colorLight[0] + (m.colorDark[0] - m.colorLight[0]) * t,
    m.colorLight[1] + (m.colorDark[1] - m.colorLight[1]) * t,
    m.colorLight[2] + (m.colorDark[2] - m.colorLight[2]) * t,
  ];
}
