// Material definitions — per-material constants for surface generation + compositing
import type { MaterialType } from '../state/scene-state.js';

export interface MaterialDef {
  colorLight: [number, number, number];  // sRGB float
  colorDark: [number, number, number];
  absorption: number;
  drySpeed: number;
  mode: number;  // u32 for shader: 0=board, 1=canvas, 2=paper, 3=gesso
  friction: number;  // how much surface slows tips (0-1)
  tooth: number;     // how much texture catches paint (0-1)
  residueFloor: number;  // minimum paint floor after rag wipe (0-1)
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
    friction: 0.3,
    tooth: 0.4,
    residueFloor: 0.18,
  },
  canvas: {
    colorLight: hexToLinear('#F0EBE0'),
    colorDark: hexToLinear('#B8A888'),
    absorption: 0.10,
    drySpeed: 0.9,
    mode: 1,
    friction: 0.5,
    tooth: 0.8,
    residueFloor: 0.25,
  },
  paper: {
    colorLight: hexToLinear('#F5F0E8'),
    colorDark: hexToLinear('#C8B8A0'),
    absorption: 0.25,
    drySpeed: 1.4,
    mode: 2,
    friction: 0.7,
    tooth: 0.6,
    residueFloor: 0.20,
  },
  gesso: {
    colorLight: hexToLinear('#F5F3F0'),
    colorDark: hexToLinear('#D0C4B0'),
    absorption: 0.05,
    drySpeed: 0.7,
    mode: 3,
    friction: 0.2,
    tooth: 0.2,
    residueFloor: 0.12,
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
