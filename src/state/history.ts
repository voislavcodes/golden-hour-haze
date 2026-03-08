import { sceneStore, type SceneState } from './scene-state.js';
import {
  snapshotDissolution,
  restoreDissolution,
  isDissolutionModified,
  resetDissolutionModified,
} from '../layers/dissolution-buffer.js';

const MAX_ENTRIES = 50;

interface Diff {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

type Snapshot = Diff[];

const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];

// Parallel dissolution snapshot stacks
const dissUndoStack: (Float32Array | null)[] = [];
const dissRedoStack: (Float32Array | null)[] = [];

/** Deep-compare two values and collect changed paths. */
function computeDiffs(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  prefix: string,
  out: Diff[],
): void {
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (oldVal === newVal) continue;

    if (oldVal instanceof Float32Array || newVal instanceof Float32Array) {
      const a = oldVal as Float32Array | undefined;
      const b = newVal as Float32Array | undefined;
      if (a && b && a.length === b.length && a.every((v, i) => v === b[i])) continue;
      out.push({ path, oldValue: a ? new Float32Array(a) : undefined, newValue: b ? new Float32Array(b) : undefined });
    } else if (Array.isArray(oldVal) || Array.isArray(newVal)) {
      // For arrays, store full copies as a single diff entry
      out.push({
        path,
        oldValue: oldVal ? structuredClone(oldVal) : undefined,
        newValue: newVal ? structuredClone(newVal) : undefined,
      });
    } else if (
      oldVal !== null && newVal !== null &&
      typeof oldVal === 'object' && typeof newVal === 'object'
    ) {
      computeDiffs(
        oldVal as Record<string, unknown>,
        newVal as Record<string, unknown>,
        path,
        out,
      );
    } else {
      out.push({ path, oldValue: oldVal, newValue: newVal });
    }
  }
}

function cloneState(state: SceneState): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value instanceof Float32Array) {
      result[key] = new Float32Array(value);
    } else if (Array.isArray(value)) {
      result[key] = structuredClone(value);
    } else if (value !== null && typeof value === 'object') {
      result[key] = cloneState(value as unknown as SceneState);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value instanceof Float32Array
    ? new Float32Array(value)
    : Array.isArray(value)
      ? structuredClone(value)
      : value;
}

let lastSnapshot: Record<string, unknown> = cloneState(sceneStore.get());

/**
 * Capture the current state as a history entry.
 * Call this before a user action mutates the scene.
 */
export function pushHistory(): void {
  const current = cloneState(sceneStore.get());
  const diffs: Diff[] = [];
  computeDiffs(lastSnapshot, current, '', diffs);

  const dissChanged = isDissolutionModified();

  if (diffs.length === 0 && !dissChanged) return;

  undoStack.push(diffs);
  dissUndoStack.push(dissChanged ? snapshotDissolution() : null);
  if (undoStack.length > MAX_ENTRIES) {
    undoStack.shift();
    dissUndoStack.shift();
  }
  // Any new action clears the redo stack
  redoStack.length = 0;
  dissRedoStack.length = 0;

  if (dissChanged) resetDissolutionModified();
  lastSnapshot = current;
}

/** Undo the last action. */
export function undo(): void {
  const snapshot = undoStack.pop();
  if (!snapshot) return;

  const dissSnap = dissUndoStack.pop() ?? null;

  const state = cloneState(sceneStore.get()) as Record<string, unknown>;
  const reverseDiffs: Diff[] = [];

  for (const diff of snapshot) {
    reverseDiffs.push({ path: diff.path, oldValue: diff.newValue, newValue: diff.oldValue });
    setNestedValue(state, diff.path, diff.oldValue);
  }

  redoStack.push(reverseDiffs);

  // Save current dissolution state before restoring
  if (dissSnap) {
    dissRedoStack.push(snapshotDissolution());
    restoreDissolution(dissSnap);
  } else {
    dissRedoStack.push(null);
  }

  sceneStore.set(state as unknown as Partial<SceneState>);
  lastSnapshot = cloneState(sceneStore.get());
}

/** Redo the last undone action. */
export function redo(): void {
  const snapshot = redoStack.pop();
  if (!snapshot) return;

  const dissSnap = dissRedoStack.pop() ?? null;

  const state = cloneState(sceneStore.get()) as Record<string, unknown>;
  const reverseDiffs: Diff[] = [];

  for (const diff of snapshot) {
    reverseDiffs.push({ path: diff.path, oldValue: diff.newValue, newValue: diff.oldValue });
    setNestedValue(state, diff.path, diff.oldValue);
  }

  undoStack.push(reverseDiffs);

  if (dissSnap) {
    dissUndoStack.push(snapshotDissolution());
    restoreDissolution(dissSnap);
  } else {
    dissUndoStack.push(null);
  }

  sceneStore.set(state as unknown as Partial<SceneState>);
  lastSnapshot = cloneState(sceneStore.get());
}
