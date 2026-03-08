import { sceneStore } from '../state/scene-state.js';

interface SerializedFloat32Array {
  __type: 'Float32Array';
  data: number[];
}

/**
 * Recursively walk an object and convert Float32Array instances
 * to a serializable representation.
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Float32Array) {
    return { __type: 'Float32Array', data: Array.from(value) } satisfies SerializedFloat32Array;
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = serializeValue(v);
    }
    return result;
  }
  return value;
}

/**
 * Export the current scene state as a `.ghz` JSON file download.
 */
export function exportScene(): void {
  const state = sceneStore.get();
  const serialized = serializeValue(state);

  const envelope = {
    format: 'golden-hour-haze',
    version: 1,
    createdAt: new Date().toISOString(),
    scene: serialized,
  };

  const json = JSON.stringify(envelope, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scene_${Date.now()}.ghz`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}
