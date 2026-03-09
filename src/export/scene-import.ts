import { sceneStore, type SceneState } from '../state/scene-state.js';
import type { LightDef } from '../layers/layer-types.js';

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

/** Migrate old LightDef format ({radius, scatter, scaleX, scaleY}) to new ({coreRadius, bloomRadius, aspectRatio, paletteSlot}) */
function migrateLights(lights: any[]): LightDef[] {
  return lights.map((l: any) => {
    if ('coreRadius' in l) return l as LightDef;
    return {
      x: l.x ?? 0.5,
      y: l.y ?? 0.5,
      coreRadius: l.radius ? l.radius * 0.25 : 0.02,
      bloomRadius: l.radius ?? 0.08,
      intensity: l.intensity ? Math.min(l.intensity, 1.0) : 0.6,
      aspectRatio: l.scaleY && l.scaleX ? l.scaleY / l.scaleX : 1.0,
      rotation: l.rotation ?? 0,
      paletteSlot: -1,
      colorR: l.colorR ?? 1.0,
      colorG: l.colorG ?? 0.85,
      colorB: l.colorB ?? 0.6,
      depth: l.depth ?? 0.5,
    };
  });
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

          // Migrate old LightDef format
          if (scene.lights) {
            scene.lights = migrateLights(scene.lights);
          }
          // Drop sunAzimuth from old scenes
          delete (scene as any).sunAzimuth;

          // Migrate tonal columns
          if (scene.forms) {
            scene.forms = scene.forms.map(f => ({ ...f, paintedValue: f.paintedValue ?? 0.5 }));
          }
          if (scene.palette && !scene.palette.tonalValues) {
            scene.palette.tonalValues = scene.palette.colors.map(() => 0.5);
          }

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
