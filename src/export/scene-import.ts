import { sceneStore, type SceneState } from '../state/scene-state.js';

/**
 * Recursively walk parsed JSON and reconstruct Float32Array instances
 * from the serialized `{ __type: 'Float32Array', data: [...] }` markers.
 */
function deserializeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }

  const obj = value as Record<string, unknown>;

  // Detect serialized Float32Array
  if (obj.__type === 'Float32Array' && Array.isArray(obj.data)) {
    return new Float32Array(obj.data as number[]);
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = deserializeValue(v);
  }
  return result;
}

/**
 * Open a file picker, read a `.ghz` file, deserialize and apply to scene state.
 */
export function importScene(): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ghz,application/json';
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        input.remove();
        resolve();
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = reader.result as string;
          const envelope = JSON.parse(text);

          if (envelope.format !== 'golden-hour-haze') {
            throw new Error(`Unknown file format: ${envelope.format}`);
          }

          const scene = deserializeValue(envelope.scene) as SceneState;
          sceneStore.set(scene);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          input.remove();
        }
      };

      reader.onerror = () => {
        reject(new Error('Failed to read file'));
        input.remove();
      };

      reader.readAsText(file);
    });

    // Handle cancel — user closes dialog without picking a file
    input.addEventListener('cancel', () => {
      input.remove();
      resolve();
    });

    document.body.appendChild(input);
    input.click();
  });
}
