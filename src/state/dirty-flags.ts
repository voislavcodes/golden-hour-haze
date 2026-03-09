// V2 Dirty flag system — no forms, replaced with surface

export type DirtyFlag = 'density' | 'scatter' | 'grain' | 'surface' | 'light' | 'composite';

const dirty: Record<DirtyFlag, boolean> = {
  density: true,
  scatter: true,
  grain: true,
  surface: true,
  light: true,
  composite: true,
};

// Cascade: marking a flag dirty cascades to downstream consumers
const cascades: Record<DirtyFlag, DirtyFlag[]> = {
  density: ['scatter', 'light', 'composite'],
  scatter: ['composite'],
  grain: ['composite'],
  surface: ['light', 'composite'],
  light: ['composite'],
  composite: [],
};

export function markDirty(flag: DirtyFlag) {
  if (dirty[flag]) return;
  dirty[flag] = true;
  for (const dep of cascades[flag]) {
    dirty[dep] = true;
  }
}

export function isDirty(flag: DirtyFlag): boolean {
  return dirty[flag];
}

export function clearDirty(flag: DirtyFlag) {
  dirty[flag] = false;
}

export function isAnyDirty(): boolean {
  return dirty.density || dirty.scatter || dirty.grain ||
    dirty.surface || dirty.light || dirty.composite;
}

export function markAllDirty() {
  dirty.density = true;
  dirty.scatter = true;
  dirty.grain = true;
  dirty.surface = true;
  dirty.light = true;
  dirty.composite = true;
}
