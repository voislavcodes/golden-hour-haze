// Dirty flag system for conditional GPU dispatch
// Module-level state (synchronous, not in reactive store)

export type DirtyFlag = 'depth' | 'density' | 'scatter' | 'grain' | 'forms' | 'light' | 'composite';

const dirty: Record<DirtyFlag, boolean> = {
  depth: true,
  density: true,
  scatter: true,
  grain: true,
  forms: true,
  light: true,
  composite: true,
};

// Cascade rules: marking a pass dirty cascades to downstream consumers
const cascades: Record<DirtyFlag, DirtyFlag[]> = {
  depth: ['density', 'grain', 'forms', 'light', 'composite'],
  density: ['scatter', 'light', 'composite'],
  scatter: ['composite'],
  grain: ['composite'],
  forms: ['light', 'composite'],
  light: ['composite'],
  composite: [],
};

export function markDirty(flag: DirtyFlag) {
  if (dirty[flag]) return; // already dirty, skip cascade
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
  return dirty.depth || dirty.density || dirty.scatter || dirty.grain ||
    dirty.forms || dirty.light || dirty.composite;
}

export function markAllDirty() {
  dirty.depth = true;
  dirty.density = true;
  dirty.scatter = true;
  dirty.grain = true;
  dirty.forms = true;
  dirty.light = true;
  dirty.composite = true;
}
