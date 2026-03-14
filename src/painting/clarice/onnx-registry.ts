// ONNX Model Registry — shared singleton for all Clarice ML models
// Lazy-imports onnxruntime-web/wasm once, maintains session map.

export type ModelName =
  | 'region-classifier' | 'stroke-type' | 'shape-recipe'
  | 'composition' | 'param-refinement' | 'painting-conductor';

interface ModelMeta {
  path: string;
  inputNames: string[];
  inputShapes: number[][]; // for warm-up
}

const MODEL_META: Record<ModelName, ModelMeta> = {
  'region-classifier': {
    path: '/models/region-classifier.onnx',
    inputNames: ['patch', 'features'],
    inputShapes: [[1, 3, 16, 16], [1, 6]],
  },
  'stroke-type': {
    path: '/models/stroke-type.onnx',
    inputNames: ['patch', 'features'],
    inputShapes: [[1, 3, 16, 16], [1, 6]],
  },
  'shape-recipe': {
    path: '/models/shape-recipe.onnx',
    inputNames: ['silhouette', 'scalars'],
    inputShapes: [[1, 1, 16, 16], [1, 13]],
  },
  'composition': {
    path: '/models/composition.onnx',
    inputNames: ['features'],
    inputShapes: [[1, 30]],
  },
  'param-refinement': {
    path: '/models/param-refinement.onnx',
    inputNames: ['context'],
    inputShapes: [[1, 32]],
  },
  'painting-conductor': {
    path: '/models/painting-conductor.onnx',
    inputNames: ['input'],
    inputShapes: [[1, 30]],
  },
};

let ortModule: any = null;
const sessions = new Map<ModelName, any>();
const initFailed = new Set<ModelName>();

async function ensureOrt(): Promise<any> {
  if (ortModule) return ortModule;
  // @ts-ignore — subpath import
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = '/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ortModule = ort;
  return ort;
}

/** Load a single ONNX model. Returns true if successful. */
export async function initModel(name: ModelName): Promise<boolean> {
  if (sessions.has(name)) return true;
  if (initFailed.has(name)) return false;

  try {
    const ort = await ensureOrt();
    const meta = MODEL_META[name];

    const resp = await fetch(meta.path);
    if (!resp.ok) throw new Error(`Model fetch failed: ${resp.status}`);
    const buffer = await resp.arrayBuffer();

    const session = await ort.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
    });

    // Warm up with dummy data
    const feeds: Record<string, any> = {};
    for (let i = 0; i < meta.inputNames.length; i++) {
      const shape = meta.inputShapes[i];
      const size = shape.reduce((a, b) => a * b, 1);
      feeds[meta.inputNames[i]] = new ort.Tensor('float32', new Float32Array(size), shape);
    }
    await session.run(feeds);

    sessions.set(name, session);
    console.log(`[ONNX Registry] ${name} loaded and warmed up`);
    return true;
  } catch (e) {
    console.warn(`[ONNX Registry] Failed to load ${name}:`, e);
    initFailed.delete(name); // allow retry (matches T2 behavior)
    return false;
  }
}

/** Check if a model is ready for inference */
export function isModelReady(name: ModelName): boolean {
  return sessions.has(name);
}

/** Get the InferenceSession for a loaded model */
export function getSession(name: ModelName): any | null {
  return sessions.get(name) ?? null;
}

/** Get the ORT module (must call ensureOrt or initModel first) */
export function getOrt(): any {
  return ortModule;
}

/** Get model metadata (input names, shapes) */
export function getModelMeta(name: ModelName): ModelMeta {
  return MODEL_META[name];
}

/** Init all models sequentially (avoids WASM memory contention) */
export async function initAllModels(): Promise<void> {
  const names: ModelName[] = [
    'region-classifier', 'stroke-type', 'shape-recipe',
    'composition', 'param-refinement', 'painting-conductor',
  ];
  for (const name of names) {
    await initModel(name).catch(() => false);
  }
}
