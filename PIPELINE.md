# Procedural Painter Pipeline — Architecture Diagram

## High-Level Flow

```
                              Reference Image (PNG)
                                      |
                                      v
                    +-----------------------------------+
                    |     1. TONAL ANALYSIS (CPU)       |
                    |   analyzeTonalStructure()         |
                    |   Downsample to 40x30 grid        |
                    |   Each cell → OKLab (L, a, b)     |
                    |   → chroma, hue, motherTone       |
                    +-----------------------------------+
                                      |
                                      v
                    +-----------------------------------+
                    |     2. HUE ASSIGNMENT (CPU)       |
                    |   assignHuesToCells()              |
                    |   Match each cell's hue to        |
                    |   nearest of 5 palette colors     |
                    |   → assignedHueIndex (0-4)        |
                    |   → motherHueIndex (most common)  |
                    +-----------------------------------+
                                      |
                                      v
                    +-----------------------------------+
                    |     3. MELDRUM LUTS (CPU)          |
                    |   buildMeldrumLUTs()               |
                    |   For each palette hue, sample     |
                    |   5 tonal values [WHITE..BLACK]    |
                    |   through K-M pigment physics      |
                    |   → 5×5 luminance lookup table     |
                    +-----------------------------------+
                                      |
                                      v
                    +-----------------------------------+
                    |     4. QUANTIZATION (CPU)          |
                    |   quantizeCells()                  |
                    |   Snap each cell's lightness to    |
                    |   nearest Meldrum step (0-4)       |
                    |   using its hue's LUT              |
                    |   → meldrumIndex per cell          |
                    +-----------------------------------+
                                      |
                        +-------------+-------------+
                        |  V2 LEGACY (span-based)   |  V3 (region-based)
                        v                           v
              +------------------+      +-------------------------+
              | 5a. generateSpans|      | 5b. extractRegions()    |
              |  Row-by-row      |      |  BFS flood fill on      |
              |  merge same-     |      |  meldrumIndex, 4-conn.  |
              |  meldrum cells   |      |  Merge tiny (<3 cells)  |
              +------------------+      |  into largest neighbor  |
                        |               +-------------------------+
                        |                           |
                        v                           v
              +------------------+      +-------------------------+
              | 6a. assemblePlan |      | 6b. CLASSIFY REGIONS    |
              |  Span→stroke     |      |  detectHorizon()        |
              |  conversion      |      |  → ML or Heuristic      |
              +------------------+      +-------------------------+
                        |                           |
                        v                           v
                +-------+-------+       +-------------------------+
                | PaintingPlan  |       | 7b. assembleRegionPlan  |
                +-------+-------+       |  Per-class stroke gen   |
                        |               +-------------------------+
                        |                           |
                        +----------+----------------+
                                   |
                                   v
                    +-----------------------------------+
                    |     8. REPLAY (GPU)                |
                    |   replayStroke() per stroke        |
                    |   → dipBrush (load pigment)       |
                    |   → pointerQueue (simulate input) |
                    |   → brush engine (polyline SDF)   |
                    |   → compositor (K-M → screen)     |
                    +-----------------------------------+
                                   |
                                   v
                          Painted Canvas (WebGPU)
```

---

## V3 Region Pipeline — Detailed

### Step 5b: Region Extraction

```
  TonalMap (40×30 grid, each cell has meldrumIndex 0-4)

  ┌─────────────────────────────────────┐
  │ 2 2 2 2 1 1 1 2 2 2 2 2 1 1 2 2 2  │  ← meldrumIndex values
  │ 2 2 2 1 1 1 1 1 2 2 2 1 1 1 1 2 2  │
  │ 2 2 3 3 3 2 2 2 2 3 3 3 2 2 2 2 2  │
  │ 3 3 3 3 3 3 2 2 3 3 3 3 3 2 2 2 2  │  ← horizon zone
  │ 3 3 3 3 2 2 2 2 3 3 3 2 2 2 2 2 2  │
  │ 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2  │
  └─────────────────────────────────────┘

  BFS flood fill (4-connectivity, same meldrumIndex)
        → Connected components = Region[]

  Each Region has:
    .id             — unique int
    .cells[]        — list of {gridX, gridY}
    .meldrumIndex   — the tonal value (0=WHITE .. 4=BLACK)
    .hueIndex       — majority palette slot
    .maxChroma      — highest chroma in region
    .boundingBox    — {x0, y0, x1, y1} in grid coords
    .areaFraction   — cells.length / (cols × rows)
    .aspectRatio    — bboxHeight / bboxWidth
    .centroid       — normalized {x, y} in 0-1
    .edgeCells      — cells bordering different meldrum
    .edgeDensity    — edgeCells / total cells
```

### Step 6b: Classification

```
  Two classifiers, ML preferred:

  ┌─────────────────────────────────────────────────┐
  │ ML CLASSIFIER (ONNX, ~29KB, ~7K params)         │
  │                                                 │
  │  Branch A: 16×16 RGB patch                      │
  │    Full-res bbox → bilinear downsample          │
  │    → Conv2d(3→16, 3×3) + ReLU                   │
  │    → Conv2d(16→32, 3×3) + ReLU                  │
  │    → AdaptiveAvgPool → 32-dim                   │
  │                                                 │
  │  Branch B: 6 scalar features                    │
  │    [x, y, aspectRatio, areaFraction,            │
  │     meldrumIndex/4, maxChroma]                  │
  │    → Linear(6→16) + ReLU → 16-dim              │
  │                                                 │
  │  Concat → Linear(48→32) + ReLU                  │
  │         → Linear(32→8) → softmax                │
  │                                                 │
  │  If confidence < 0.6 → fallback to heuristic    │
  └─────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────┐
  │ HEURISTIC CLASSIFIER (fallback)                 │
  │                                                 │
  │  Priority chain:                                │
  │  1. vertical: aspect ≥ 2.0 AND meldrum ≥ DARK  │
  │  2. accent:   chroma > 0.08 AND area < 3%      │
  │  3. sky:      centroid above horizon, area > 1% │
  │  4. horizon:  bbox straddles horizon, wide      │
  │  5. mass:     dark, compact, area < 15%         │
  │  6. reflection: below 55%, tallish, mid-dark    │
  │  7. ground:   centroid below horizon, area > 1% │
  │  8. fill:     position-based fallback           │
  └─────────────────────────────────────────────────┘

  8 classes:
    sky | ground | horizon | mass | vertical | accent | reflection | fill
```

### Step 7b: Stroke Generation

```
  Region + classification → per-class stroke generator → StrokeCommand[]

  ┌────────────┬──────────────────┬───────┬───────────────────────────────────┐
  │ Class      │ Generator        │ Brush │ Behavior                          │
  ├────────────┼──────────────────┼───────┼───────────────────────────────────┤
  │ sky        │ horizontalWash   │   4   │ Dense H sweeps, 2 passes          │
  │ ground     │ horizontalWash   │   3   │ Dense H sweeps, 2 passes          │
  │ horizon    │ horizontalBand   │   3   │ Narrow H strokes at horizon Y     │
  │ mass       │ clusteredDabs    │   2   │ Random short overlapping marks    │
  │ vertical   │ verticalStrokes  │   1   │ Top-to-bottom, pressure taper     │
  │ accent     │ dabCluster       │   1   │ 2-5 short dabs, oil+anchor        │
  │ reflection │ verticalSoft     │   2   │ Vertical with sinusoidal wobble   │
  │ fill       │ horizontalWash   │   2   │ Default fill, 1 pass              │
  └────────────┴──────────────────┴───────┴───────────────────────────────────┘

  Brush sizes (normalized 0-1):
    Slot 0: 0.012 (tiny)
    Slot 1: 0.025 (small)
    Slot 2: 0.050 (medium)
    Slot 3: 0.100 (large)
    Slot 4: 0.200 (wash)

  Layer painting order:
    Mother wash → Sky → Ground → Horizon → Mass → Fill → Vertical → Accent → Reflection

  Depth-aware adjustments:
    Above horizon: +thinners, -load, +brush size (atmospheric)
    Below horizon: -thinners, +load, +pressure (committed)

  Total budget cap: 1500 strokes (excess evenly sampled down)
```

### assembleRegionPlan() Output

```
  PaintingPlan {
    layers: [
      { name: "Mother",     strokes: StrokeCommand[] },  // full-canvas wash
      { name: "Sky",        strokes: StrokeCommand[] },  // sky regions
      { name: "Ground",     strokes: StrokeCommand[] },  // ground regions
      { name: "Mass",       strokes: StrokeCommand[] },  // dark masses
      ...
    ],
    metadata: {
      gridSize: [40, 30],
      strokeCount: number,
      motherHueIndex: number,        // dominant palette slot
      hueAssignments: [              // median hue per slot
        { hueIndex: 0, hue: 45.2 },
        { hueIndex: 1, hue: 120.8 },
        ...
      ]
    }
  }
```

---

## Step 8: Stroke Replay (GPU)

```
  For each StrokeCommand:

  ┌─────────────────────────────────────┐
  │ 1. CONFIGURE                        │
  │    Set active brush slot            │
  │    Set palette hue index            │
  │    dipBrush() — load K-M pigment    │
  │    Set thinners, load, brushSize    │
  │    Set oil/anchor toggles           │
  └───────────────┬─────────────────────┘
                  │
                  v
  ┌─────────────────────────────────────┐
  │ 2. SIMULATE POINTER INPUT           │
  │    mouseDown at points[0]           │
  │    Feed points via pointerQueue     │
  │    5 points per frame               │
  │    Each point: {x, y, pressure}     │
  │    mouseUp at end                   │
  └───────────────┬─────────────────────┘
                  │
                  v
  ┌─────────────────────────────────────┐
  │ 3. GPU BRUSH ENGINE (per frame)     │
  │                                     │
  │  CPU: bristle-bundle.ts             │
  │    1024-tip bundle physics          │
  │    Splay, bend, depletion, pickup   │
  │    → 64-bin bristle density profile │
  │    → per-vertex splay + reservoir   │
  │                                     │
  │  GPU: brush shader (pipeline        │
  │    key: 'brush-v8')                 │
  │    Polyline SDF renderer            │
  │    Capsule segments from points     │
  │    Contact gate from bristle profile│
  │    → writes to accum texture        │
  │      (rgba16float: Kr, Kg, Kb, wt)  │
  │    → writes to state texture        │
  │      (rgba32float: time, thin,      │
  │       oil, reserved)                │
  └───────────────┬─────────────────────┘
                  │
                  v
  ┌─────────────────────────────────────┐
  │ 4. COMPOSITOR (per frame)           │
  │    pipeline key: 'composite-v4'     │
  │                                     │
  │    Reads:                           │
  │      accum (K_r, K_g, K_b, weight) │
  │      paint_state (time, thin, oil)  │
  │      surface_height (grain)         │
  │      surface_color                  │
  │      scatter LUT, grain LUT         │
  │                                     │
  │    K-M pigment physics:             │
  │      K/S absorption/scatter         │
  │      → Kubelka-Munk reflectance     │
  │      → sRGB output                  │
  │                                     │
  │    + surface grain interaction      │
  │    + wet/dry blend (drying model)   │
  │    + oil sheen                      │
  │    → final canvas pixels            │
  └─────────────────────────────────────┘
```

---

## StrokeCommand Data Structure

```
  StrokeCommand {
    points: { x, y, pressure }[]   // normalized 0-1 canvas coords
    brushSlot: 0-4                  // indexes BRUSH_SLOT_SIZES
    brushSize: number               // actual size (0.012 .. 0.200)
    hueIndex: 0-4                   // palette color slot
    meldrumIndex: 0-4               // tonal value (WHITE..BLACK)
    thinners: 0-0.12               // medium dilution
    load: 0.3-0.92                 // pigment load amount
    useOil: boolean                 // oil medium toggle
    useAnchor: boolean              // anchor pigment toggle
  }
```

---

## File Map

```
  src/painting/
  ├── tonal-recreation.ts    — Steps 1-4 + orchestrator (createPaintingPlan)
  │                            Also: legacy V2 span pipeline
  │
  ├── region-analysis.ts     — Step 5b: BFS flood fill, horizon detection
  ├── region-classify-heuristic.ts — Step 6b: rule-based classifier
  ├── region-classify-ml.ts  — Step 6b: ONNX model loader + batch inference
  ├── region-patches.ts      — 16×16 patch extraction for ML input
  ├── region-strokes.ts      — Step 7b: per-class generators + assembleRegionPlan
  │
  ├── palette.ts             — 15-pile palette, BRUSH_SLOT_SIZES, K-M sampling
  ├── bristle-bundle.ts      — 1024-tip CPU bristle physics
  ├── brush-engine.ts        — GPU polyline SDF brush dispatch
  └── surface.ts             — Accumulation/state texture management

  src/test-bridge.ts         — Exposes pipeline to Playwright via window.__ghz
  test/headless/region-classify.spec.ts — E2E test: analyze → plan → replay → screenshot

  tools/
  ├── export-training-data.ts — Reference images → labeled patches (Node/sharp)
  └── train-classifier.py     — PyTorch dual-branch CNN → ONNX export

  public/models/
  └── region-classifier.onnx  — 29KB trained model
```

---

## Entry Points

### Browser (test bridge)
```
page.evaluate → ghz.analyzeImage(blob, 80, 60)
  → createPaintingPlan(imageData, palette, complement, 80, 60, fullRes)
    → analyzeTonalStructure → assignHuesToCells → buildMeldrumLUTs → quantizeCells
    → extractRegions → detectHorizon
    → initClassifier → classifyRegionsBatch (or classifyAllHeuristic)
    → assembleRegionPlan
    → return PaintingPlan

for layer in plan.layers:
  for stroke in layer.strokes:
    ghz.replayStroke(stroke.points, { brushSlot, hueIndex, brushSize, thinners, load })
```

### Training pipeline (Node)
```
npx tsx tools/export-training-data.ts
  → sharp(image) → analyzeTonalStructure → extractRegions
  → classifyAllHeuristic (bootstrap labels)
  → extract 16×16 patches
  → 3 resolutions × flip = 6× augmentation
  → patches.bin + labels.json

python tools/train-classifier.py
  → load patches.bin + labels.json
  → train dual-branch CNN (7K params)
  → export region-classifier.onnx → public/models/
```
