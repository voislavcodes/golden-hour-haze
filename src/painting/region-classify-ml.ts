// ML Region Classifier — ONNX model loading + inference
// Falls back to heuristic classifier if model fails to load or confidence is low.
// Uses lazy import of onnxruntime-web to avoid blocking module init.

import type { RegionClass, RegionFeatures } from './region-analysis.js';

const CLASS_LABELS: RegionClass[] = ['sky', 'ground', 'horizon', 'mass', 'vertical', 'accent', 'reflection', 'fill'];
const CONFIDENCE_THRESHOLD = 0.6;

let session: any = null;
let ortModule: any = null;
let initFailed = false;

/** Load ONNX Runtime and the region classifier model. Returns true if successful. */
export async function initClassifier(): Promise<boolean> {
  if (session) return true;
  if (initFailed) return false;

  try {
    // Use wasm-only bundle to avoid WebGL/WebGPU deps
    // @ts-ignore — subpath import
    const ort = await import('onnxruntime-web/wasm');
    ortModule = ort;

    // Set WASM paths — files served from public/
    ort.env.wasm.wasmPaths = '/';
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;

    // Fetch model as ArrayBuffer
    const resp = await fetch('/models/region-classifier.onnx');
    if (!resp.ok) throw new Error(`Model fetch failed: ${resp.status}`);
    const modelBuffer = await resp.arrayBuffer();

    session = await ortModule.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
    });

    // Warm up with dummy data
    const dummyPatch = new ortModule.Tensor('float32', new Float32Array(3 * 16 * 16), [1, 3, 16, 16]);
    const dummyFeatures = new ortModule.Tensor('float32', new Float32Array(6), [1, 6]);
    await session.run({ patch: dummyPatch, features: dummyFeatures });

    console.log('[Region ML] Classifier loaded and warmed up');
    return true;
  } catch (e) {
    console.warn('[Region ML] Failed to load classifier, using heuristic fallback:', e);
    initFailed = false; // allow retry
    session = null;
    return false;
  }
}

/** Check if the ML classifier is available */
export function isClassifierReady(): boolean {
  return session !== null;
}

/**
 * Batch classify regions using the ONNX model.
 * patches: array of Float32Array, each 3×16×16 = 768 floats (CHW)
 * features: array of RegionFeatures (6 scalars each)
 */
export async function classifyRegionsBatch(
  patches: Float32Array[],
  features: RegionFeatures[],
): Promise<{ classification: RegionClass; confidence: number }[]> {
  if (!session || !ortModule) {
    throw new Error('Classifier not initialized — call initClassifier() first');
  }

  const N = patches.length;
  if (N === 0) return [];

  // Batch patches into [N, 3, 16, 16]
  const patchData = new Float32Array(N * 3 * 16 * 16);
  for (let i = 0; i < N; i++) {
    patchData.set(patches[i], i * 768);
  }
  const patchTensor = new ortModule.Tensor('float32', patchData, [N, 3, 16, 16]);

  // Batch features into [N, 6]
  const featData = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) {
    const f = features[i];
    featData[i * 6 + 0] = f.x;
    featData[i * 6 + 1] = f.y;
    featData[i * 6 + 2] = f.aspectRatio;
    featData[i * 6 + 3] = f.areaFraction;
    featData[i * 6 + 4] = f.meldrumIndex;
    featData[i * 6 + 5] = f.maxChroma;
  }
  const featuresTensor = new ortModule.Tensor('float32', featData, [N, 6]);

  // Run inference
  const results = await session.run({ patch: patchTensor, features: featuresTensor });
  const outputKey = session.outputNames[0];
  const logits = results[outputKey].data as Float32Array;

  // Softmax + argmax per sample
  const output: { classification: RegionClass; confidence: number }[] = [];
  for (let i = 0; i < N; i++) {
    const start = i * 8;
    let maxLogit = -Infinity;
    for (let j = 0; j < 8; j++) {
      if (logits[start + j] > maxLogit) maxLogit = logits[start + j];
    }
    let sumExp = 0;
    const probs = new Float32Array(8);
    for (let j = 0; j < 8; j++) {
      probs[j] = Math.exp(logits[start + j] - maxLogit);
      sumExp += probs[j];
    }
    let bestIdx = 0, bestProb = 0;
    for (let j = 0; j < 8; j++) {
      probs[j] /= sumExp;
      if (probs[j] > bestProb) { bestProb = probs[j]; bestIdx = j; }
    }

    output.push({
      classification: CLASS_LABELS[bestIdx],
      confidence: bestProb,
    });
  }

  return output;
}

/** Return the confidence threshold — regions below this use heuristic fallback */
export function getConfidenceThreshold(): number {
  return CONFIDENCE_THRESHOLD;
}
