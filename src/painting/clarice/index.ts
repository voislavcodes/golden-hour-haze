// Clarice — hierarchical organism architecture for procedural painting
// Barrel export — the hierarchy entry point

// Shared types
export type {
  DepthClass, StrokeType, RecipeClass, CompositionClass, FocalType, EdgeType,
  ColorAnalysis, AccentResult, EdgeResult, FocalPoint, LayerBudget,
  RefinedParams, ConductorDecisions, SceneFeatures, TissueContext,
} from './types.js';

// Tier 1: Tissues
export { extractRegions, detectHorizon, computeRegionFeatures } from './region-analysis.js';
export type { Region, RegionClass, RegionFeatures } from './region-analysis.js';
export { classifyAllHeuristic, classifyRegionHeuristic } from './region-classify-heuristic.js';
export { initClassifier, isClassifierReady, classifyRegionsBatch } from './region-classify-ml.js';
export { extractPatch } from './region-patches.js';
export { mapDepths } from './tissue-depth.js';
export { analyzeColors } from './tissue-color.js';
export { mapTones } from './tissue-tonal.js';
export { detectEdges } from './tissue-edges.js';
export { detectAccents } from './tissue-accent.js';
export { inferStrokeTypes } from './tissue-stroke-type.js';
export { classifyRecipes, extractSilhouettePatch } from './tissue-recipe.js';

// Tier 1 heuristics (from tonal-recreation)
export { analyzeTonalStructure, buildMeldrumLUTs, quantizeCells,
         assignHuesToCells, downsampleImage } from './tonal-recreation.js';
export type { TonalMap, MeldrumLUT, StrokeCommand, PaintingPlan } from './tonal-recreation.js';

// Feature aggregation
export { aggregateFeatures } from './features.js';

// Tier 2: Organs
export { classifyComposition } from './organ-composition.js';
export { locateFocalPoint } from './organ-focal.js';
export { readAtmosphere } from './organ-atmosphere.js';
export { allocateBudget } from './organ-budget.js';

// Tier 3: Organism
export { refineParameters } from './organism-params.js';
export { conductPainting } from './organism-conductor.js';

// Recipes
export { executeRecipe } from './recipes.js';

// Assembly
export { assemblePlan as assembleHierarchyPlan } from './assembly.js';

// Full pipelines
export { generateSpans, assemblePlan, createPaintingPlan,
         createPaintingPlanLegacy, clariceHierarchy,
         clariceHierarchyDebug } from './tonal-recreation.js';

// Legacy stroke generation
export { generateRegionStrokes, assembleRegionPlan } from './region-strokes.js';

// ONNX Model Registry
export { initModel, isModelReady, initAllModels } from './onnx-registry.js';
export type { ModelName } from './onnx-registry.js';

// ML Inference Wrappers
export { inferStrokeTypesML, classifyRecipesML, classifyCompositionML,
         refineParametersML, conductPaintingML } from './ml-inference.js';

// Feature Serialization
export { serializeSceneFeatures, serializeRegionContext,
         serializeConductorInput, SCENE_FEATURE_ORDER } from './feature-serialize.js';
