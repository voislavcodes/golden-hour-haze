/* eslint-disable @typescript-eslint/no-explicit-any */

let ort: any = null;
const sessionCache = new Map<string, any>();

async function loadOrt(): Promise<any> {
  if (ort) return ort;
  ort = await import('onnxruntime-web' as string);
  return ort;
}

export async function getSession(modelPath: string): Promise<any> {
  const cached = sessionCache.get(modelPath);
  if (cached) return cached;

  const runtime = await loadOrt();

  let session: any;
  try {
    session = await runtime.InferenceSession.create(modelPath, {
      executionProviders: ['webgpu'],
    });
  } catch {
    console.warn(`WebGPU backend unavailable for ONNX, falling back to WASM: ${modelPath}`);
    session = await runtime.InferenceSession.create(modelPath, {
      executionProviders: ['wasm'],
    });
  }

  sessionCache.set(modelPath, session);
  return session;
}
