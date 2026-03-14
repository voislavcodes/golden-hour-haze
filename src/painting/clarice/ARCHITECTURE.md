# Clarice — Hierarchical Organism Architecture

## The Split

Three monolithic approaches were attempted and failed. A 15M-param autoregressive transformer collapsed to mean prediction — too many parameters, too few examples, sequence modeling impossible from 85 images. A 168K-param dense CNN placed correct tonal values but painted every patch with identical crosshatch marks — no spatial grouping, no composition, no shape awareness. A 2M-param frozen-encoder variant performed worse than training from scratch — features from the wrong task don't transfer.

Each failure narrowed the solution space. Each proved something specific about what works and what doesn't with small datasets on a creative task. The hierarchy that follows is not theoretical — it's the architecture that remains after eliminating everything that was empirically shown to fail.

Split the job into specialists. Each specialist answers one question about the reference image. Their answers compose upward into a painting plan. The physics executes.

The reference image flows through three tiers: tissues perceive it, organs understand it, the organism decides how to paint it.

## Tier 1: Tissues — Perceive the Image

Each tissue reads the reference image (or the grid analysis of it) and answers one question. Most are heuristics. A few are small ML models. They run independently — no tissue reads another tissue's output.

### T1: Region Segmenter
**Job:** Divide the image into coherent regions of similar tone and color.
**Implementation:** Heuristic. The existing pipeline — downsample to grid, OKLCH conversion, BFS flood fill on quantized Meldrum bands, merge small regions into neighbors.
**Output:** List of regions with bounds, centroid, area, cell membership.
**Why heuristic:** Connected component analysis on a quantized grid is a solved problem. No ML needed.
**Why critical:** The dense CNN model proved that per-patch prediction without spatial grouping produces uniform marks everywhere. T1 provides what the dense model lacked — patches grouped into meaningful regions that can be classified, shaped, and painted as coherent forms.

### T2: Region Classifier
**Job:** "What is each region?" Sky, ground, mass, vertical, accent, horizon, reflection, fill.
**Implementation:** ML. 7K params. Already built, trained, deployed in ONNX. The one tissue where heuristics weren't flexible enough — a figure with an umbrella isn't a simple tall rectangle.
**Input:** 16×16 patch per region + scalar features (position, aspect ratio, area, meldrum index, chroma).
**Output:** 8-class label + confidence per region.

### T3: Depth Mapper
**Job:** "How far away is each region?" Near, mid, far.
**Implementation:** Heuristic. Position relative to horizon + tonal value.
```
if region.centroidY < horizon * 0.7 → far
elif region.centroidY < horizon * 1.3 → mid
else → near
// Override: meldrumIndex >= DARK → near (dark = committed = foreground)
// Override: meldrumIndex <= LIGHT and above horizon → far
```
**Output:** Depth label per region.
**Why heuristic:** In tonalist landscapes, depth is almost entirely determined by vertical position and tonal value. The heuristic handles 95% of cases.

### T4: Color Analyzer
**Job:** "What are the dominant hues in each region, and how chromatic are they?"
**Implementation:** Heuristic. Per-region average OKLCH values from the grid cells. Already computed during grid analysis.
```
for each region:
    avg_L = mean of cell.labL values
    avg_chroma = mean of cell.chroma values  
    avg_hue = circular mean of cell.hue values
    nearest_palette_hue = argmin distance to 5 mood hues
    chromatic = avg_chroma > 0.04
```
**Output:** Per region: average luminance, chroma, hue angle, nearest palette hue index, chromatic flag.
**Why heuristic:** Color statistics are deterministic math. No classification needed. The dense CNN model validated that per-patch tonal reading is the one thing that works well without spatial awareness — the heuristic captures the same capability with zero parameters.

### T5: Tonal Mapper
**Job:** "What Meldrum band does each region belong to?"
**Implementation:** Heuristic. Already exists — `snapToMeldrum()`. Compare region's average luminance against the per-hue Meldrum LUT to find the closest band.
```
for each region:
    lut = meldrumLUTs[region.nearestHueIndex]
    distances = [abs(region.avgL - lut.luminances[i]) for i in 0..4]
    meldrumIndex = argmin(distances)
```
**Output:** Meldrum band (WHITE/LIGHT/MID/DARK/BLACK) per region.
**Why heuristic:** Direct lookup against pre-computed LUT values. Perfect accuracy, zero ambiguity.

### T6: Edge Detector
**Job:** "What kind of boundary exists between adjacent regions?"
**Implementation:** Heuristic. Compare depth and classification of neighboring regions.
```
for each region pair sharing a boundary:
    if same meldrumIndex → none
    if abs(depth_a - depth_b) > 1 → sharp (big depth gap)
    if both above horizon and both LIGHT → soft (atmospheric fade)
    if either is 'vertical' → sharp on that boundary
    else → soft (default atmospheric)
```
**Output:** Edge type (sharp, soft, none) per region boundary.
**Why heuristic:** Edge character in tonalist painting follows depth and region type mechanically. A pole against fog is always sharp. Two fog regions meeting is always soft.

### T7: Accent Detector
**Job:** "Which regions are the vivid accents?"
**Implementation:** Heuristic. Chroma threshold + area constraint.
```
for each region:
    isAccent = region.maxChroma > 0.06 AND region.area < 5% of canvas
```
**Output:** Boolean flag per region + accent intensity (chroma value).
**Why heuristic:** Accents are high-chroma small regions. That's a two-number threshold. No ML needed.

### T8: Stroke Type Inferrer
**Job:** "What kind of mark should paint each region?" Horizontal wash, vertical stroke, clustered dabs, single dab, arc.
**Implementation:** ML. ~5K params. This is the second tissue where heuristics struggle. A mass that's wider than tall could be a hedge (horizontal dabs) or a reflection (vertical soft) — the difference depends on visual texture and position context that aspect ratio alone can't capture.
**Input:** 16×16 patch per region + classification label + depth + position.
**Output:** 5-class stroke type.
**Training data:** From existing procedural pipeline outputs — each stroke command has a known type. Extract region → stroke type mappings.

### T9: Shape Recipe Classifier
**Job:** "How would Beckett construct this specific form?" Not stroke TYPE (T8) but the construction RECIPE — the specific sequence of marks, pressure curves, overlap patterns, and width variations that produce a Beckett-like form.

Beckett had a specific gestural vocabulary. Her figures aren't rectangles. Her poles aren't straight lines. Her tree masses aren't circles. Each type of form is built from a specific recipe of strokes:

- **Figure with umbrella:** dome (overlapping arcs, heavier at top), body column (2-3 vertical passes, narrowing at waist, widening at hem), legs (thin tapered verticals), feet (tiny dabs)
- **Standing figure:** body column (single broad vertical), legs (two thin tapers), no umbrella
- **Pole simple:** one wobbling vertical, pressure heavier at top, tapering at bottom
- **Pole with crossbar:** main vertical + short horizontal at top or crossbar position
- **Tree mass rounded:** 8-15 overlapping short horizontal dabs, Gaussian distribution from center, irregular outline
- **Tree mass spread:** wider, flatter, fewer dabs, more horizontal extent
- **Hedge band:** horizontal band of overlapping marks, darker base, lighter top dissolving into atmosphere
- **Vehicle body:** rectangular mass (3-4 horizontal passes), warm accent window (dab with OIL+CAD), dark undercarriage
- **Building block:** rectangular, hard vertical edges, softer horizontal transitions
- **Atmospheric wash:** broad horizontal sweeps, full-width, thin paint

**Implementation:** ML. ~8K params. Takes a region's silhouette + classification and outputs a recipe class.
**Input:** 16×16 silhouette patch (binary mask of region shape) + classification from T2 + aspect ratio + area + depth from T3.
**Output:** 10-class recipe label.

Each recipe class maps to a **deterministic stroke construction function** in the organism. The function takes the region bounds + brush parameters from SO1 and produces a specific sequence of strokes:

```typescript
// Example: figure-with-umbrella recipe
function paintFigureWithUmbrella(region: Region, params: BrushParams): StrokeCommand[] {
    const strokes: StrokeCommand[] = [];
    const cx = region.centroid.x;
    const top = region.bounds.y0;
    const bottom = region.bounds.y1;
    const height = bottom - top;
    const width = region.bounds.width;
    
    // Umbrella dome: 2-3 overlapping arcs
    for (let i = 0; i < 3; i++) {
        strokes.push(arc(cx, top + height * 0.15, width * 0.8, {
            ...params, pressure: params.pressure * (0.9 - i * 0.08),
        }));
    }
    // Body column: 2 vertical passes
    strokes.push(vertical(cx - width * 0.05, top + height * 0.3, bottom - height * 0.15, {
        ...params, brushSize: params.brushSize * 0.7,
    }));
    strokes.push(vertical(cx + width * 0.05, top + height * 0.3, bottom - height * 0.15, {
        ...params, brushSize: params.brushSize * 0.6,
    }));
    // Legs: thin tapered
    strokes.push(taperVertical(cx - width * 0.1, bottom - height * 0.2, bottom, {
        ...params, brushSize: params.brushSize * 0.3, pressureEnd: 0.2,
    }));
    strokes.push(taperVertical(cx + width * 0.1, bottom - height * 0.2, bottom, {
        ...params, brushSize: params.brushSize * 0.3, pressureEnd: 0.2,
    }));
    
    return strokes;
}

// Example: tree-mass-rounded recipe
function paintTreeMassRounded(region: Region, params: BrushParams): StrokeCommand[] {
    const strokes: StrokeCommand[] = [];
    const count = 8 + Math.floor(region.area * 20);
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = gaussianRandom() * 0.7;
        const x = region.centroid.x + Math.cos(angle) * region.bounds.width * 0.4 * dist;
        const y = region.centroid.y + Math.sin(angle) * region.bounds.height * 0.4 * dist;
        const len = 0.01 + Math.random() * 0.025;
        strokes.push(horizontalDab(x, y, len, {
            ...params, pressure: params.pressure * (0.7 + Math.random() * 0.3),
        }));
    }
    return strokes;
}
```

**Training data:** The hand-authored clarice-beckett.spec.ts IS a labeled dataset of shape recipes. The umbrella is `umbrellaArc()`. The body is `taperV()`. The poles are `V()`. Each region in the reference image maps to the stroke construction that painted it. Extract (silhouette, classification) → recipe class. Additional data from studying reference paintings — label 50-100 regions with their recipe class by looking at how Beckett built each type of form.

**Why ML:** A figure with an umbrella and a figure without one have similar aspect ratios and classifications (both 'vertical'). The difference is in the silhouette — the umbrella creates a wider top. The model learns silhouette features that the classification alone can't distinguish. A heuristic would need manual silhouette rules for each recipe; the model learns them from examples.

**Why this is the tissue that makes it look like Beckett:** T2 says "this is a figure." T8 says "paint it with vertical strokes." T9 says "paint it the way Beckett painted figures — umbrella dome, body column, tapered legs." The difference between T8 and T9 is the difference between "a painting of a figure" and "a Beckett painting of a figure."

**Why this tissue exists:** The dense CNN model painted every patch with identical crosshatch marks — same construction everywhere, regardless of content. T9 is the direct fix. Instead of one stroke pattern for everything, 10 Beckett-specific construction recipes, each triggered by the region's silhouette and classification. Different forms get different marks.

### Tissue Summary

| Tissue | Job | Implementation | Params | Output |
|--------|-----|----------------|--------|--------|
| T1 Region Segmenter | Divide into regions | Heuristic | 0 | Region list |
| T2 Region Classifier | What is each region? | ML (ONNX) | 7K | 8-class label |
| T3 Depth Mapper | How far? | Heuristic | 0 | 3-class depth |
| T4 Color Analyzer | What color? | Heuristic | 0 | OKLCH stats |
| T5 Tonal Mapper | What Meldrum band? | Heuristic | 0 | 5-class band |
| T6 Edge Detector | What kind of boundary? | Heuristic | 0 | 3-class edge |
| T7 Accent Detector | Is this vivid? | Heuristic | 0 | Boolean + intensity |
| T8 Stroke Type | What mark to make? | ML (ONNX) | 5K | 5-class type |
| T9 Shape Recipe | How would Beckett build it? | ML (ONNX) | 8K | 10-class recipe |
| **Total** | | **6 heuristic, 3 ML** | **20K** | |

20K total learned parameters across all tissues. Everything else is algorithms. The tissues produce a rich feature set per region: classification, depth, color stats, tonal band, edge character, accent flag, stroke type, and now the specific Beckett construction recipe.

## Tier 2: Organs — Understand the Scene

Organs read the tissue outputs — not the raw image — and synthesize higher-order understanding. Each organ answers a question that no single tissue can.

### O1: Composition Reader
**Job:** "What is this scene about?" Lonely-figure, street-scene, seascape, twilight-glow, intimate-scene, abstract-masses.
**Implementation:** ML. ~10K params. Dense network on scalar features aggregated from all tissue outputs.
**Input:** A scene feature vector (~40 dimensions):
```
features = [
    // Region class counts
    count_sky, count_ground, count_horizon, count_mass,
    count_vertical, count_accent, count_reflection, count_fill,
    
    // Spatial distribution
    avg_y_verticals, spread_y_verticals,
    avg_y_masses, spread_y_masses,
    
    // Depth distribution
    count_near, count_mid, count_far,
    
    // Edge summary
    ratio_sharp, ratio_soft,
    
    // Accent
    has_accent, accent_x, accent_y, accent_chroma,
    
    // Tonal distribution
    total_dark_area, total_light_area,
    dark_to_light_ratio,
    
    // Geometry
    horizon_y,
    vertical_count,
    mass_count,
    sky_area_fraction,
    ground_area_fraction,
    
    // Color
    avg_chroma,
    chroma_range,
    dominant_hue_angle,
]
```
**Architecture:** Dense(40→32, GELU) → Dense(32→16, GELU) → Dense(16→6, Softmax)
**Output:** 6-class composition label + confidence.
**Training data:** Human labels 50+ reference images with one composition class each. One click per image. Takes 10 minutes total.
**Why ML:** The relationships between tissue counts determine composition. "One vertical + zero accents + large sky = lonely figure." "Multiple verticals + one accent + horizon = street scene." A decision tree could handle the obvious cases but the boundary cases (is this a sparse street scene or a lonely figure with a pole?) benefit from learned weights.

### O2: Focal Point Locator
**Job:** "Where should the eye go first?"
**Implementation:** Hybrid. Heuristic primary, ML refinement if needed.
**Heuristic logic:**
```
if accents exist:
    focal = position of highest-chroma accent
    focal_type = 'point'
elif verticals exist:
    focal = centroid of largest/darkest vertical
    focal_type = 'figure'
elif horizon is warm (avg chroma of horizon band > threshold):
    focal = center of horizon band
    focal_type = 'band'
else:
    focal = canvas center biased toward densest mass cluster
    focal_type = 'distributed'
```
**Output:** Focal point (x, y) + focal type (point, figure, band, distributed).
**Why heuristic:** The accent IS the focal point in tonalist painting. The figure IS the focal point when there's no accent. The heuristic captures this directly.

### O3: Atmosphere Density Reader
**Job:** "How atmospheric is this scene? How much fog?"
**Implementation:** Heuristic.
```
fog_density = (
    sky_area_fraction * 0.3 +
    (1.0 - avg_chroma / max_possible_chroma) * 0.3 +
    (count_far / total_regions) * 0.2 +
    ratio_soft_edges * 0.2
)
// 0.0 = crystal clear, 1.0 = pure fog
```
**Output:** Fog density scalar (0-1).
**Why heuristic:** Atmosphere density is a weighted combination of tissue outputs — how much sky, how muted the colors, how many far regions, how soft the edges. Deterministic math.

### O4: Layer Budget Allocator
**Job:** "How many strokes per layer?"
**Implementation:** Heuristic. Informed by composition type from O1.
```
base_budgets = {
    'lonely-figure': { atmos: 0.40, bg: 0.20, mid: 0.10, dark: 0.10, accent: 0.05, veil: 0.15 },
    'street-scene':  { atmos: 0.25, bg: 0.15, mid: 0.20, dark: 0.20, accent: 0.08, veil: 0.12 },
    'seascape':      { atmos: 0.45, bg: 0.25, mid: 0.10, dark: 0.05, accent: 0.03, veil: 0.12 },
    'twilight-glow': { atmos: 0.35, bg: 0.15, mid: 0.15, dark: 0.15, accent: 0.10, veil: 0.10 },
    'intimate':      { atmos: 0.20, bg: 0.15, mid: 0.25, dark: 0.25, accent: 0.05, veil: 0.10 },
    'abstract':      { atmos: 0.30, bg: 0.20, mid: 0.25, dark: 0.15, accent: 0.05, veil: 0.05 },
}
total_strokes = 300 + region_count * 3  // more complex scenes get more strokes
```
**Output:** Per-layer stroke count.
**Why heuristic:** The budget is a strategy table indexed by composition class. Six entries. Hand-authored from painting experience. No ML needed — if the composition classification is correct, the budget follows mechanically.

### Organ Summary

| Organ | Job | Implementation | Params | Input |
|-------|-----|----------------|--------|-------|
| O1 Composition | What scene type? | ML (ONNX) | 10K | 40-dim feature vector |
| O2 Focal Point | Where does the eye go? | Heuristic | 0 | Accent/vertical positions |
| O3 Atmosphere | How much fog? | Heuristic | 0 | Tissue ratios |
| O4 Layer Budget | Strokes per layer? | Heuristic | 0 | Composition class |
| **Total** | | **3 heuristic, 1 ML** | **10K** | |

10K learned parameters. One ML model. Three heuristics. The organs convert tissue-level perception into scene-level understanding.

## Tier 3: Organism — Decide How to Paint

The organism reads all organ and tissue outputs and produces the final painting plan — a sequence of stroke commands that the cells execute.

### SO1: Painting Planner
**Job:** Take the full understanding of the scene (composition, focal point, atmosphere, budget, per-region properties) and produce a concrete `PaintingPlan` with `StrokeCommand[]` per layer.
**Implementation:** Algorithmic with ML color/parameter refinement.

The planner is mostly deterministic because the hard decisions have already been made by the tissues and organs. The planner's job is assembly, not perception. It follows rules — not sequences. The autoregressive model's failure proved that predicting "what stroke comes next" from small data is impossible. The hierarchy eliminates sequence modeling entirely: layer ordering is deterministic, stroke order within a layer doesn't matter (the cells handle overlap physics), and the conductor configures the rules rather than generating a sequence.

### Assembly Rules

**Layer 1: Mother Wash**
```
Select motherHueIndex (from T5: most common hue in LIGHT/WHITE regions)
For passes 1-3:
    Generate full-width horizontal strokes
    thinners = 0.04 - 0.06 (thin wash)
    load = 0.5 - 0.7
    pressure = 0.3 - 0.5
    brushSlot = 4 (largest)
    meldrumIndex = LIGHT
    Slight y-offset per pass for coverage
```

**Layer 2: Background (sky + ground)**
```
For each region classified as 'sky' or 'ground':
    depth = T3 output
    thinners = depth_thinners_map[depth]  // far = more thinners
    load = depth_load_map[depth]          // far = less load
    brushSlot = depth_brush_map[depth]    // far = bigger brush
    hueIndex = T4.nearestHueIndex
    meldrumIndex = T5.meldrumIndex
    
    Generate horizontal washes across region bounds
    Edge softness from T6 determines stroke extension beyond bounds
```

**Layer 3: Midtones (masses)**
```
For each region classified as 'mass' or 'horizon':
    recipe = T9 output (tree-mass-rounded, hedge-band, etc.)
    brushParams = SO1 output (context-sensitive thinners, load, pressure, brushSize)
    
    // T9 recipe replaces generic stroke generation
    strokes = SHAPE_RECIPES[recipe](region, brushParams)
    
    hueIndex = T4.nearestHueIndex
    meldrumIndex = T5.meldrumIndex
```

**Layer 4: Dark Forms (verticals, dark masses)**
```
For each region classified as 'vertical':
    recipe = T9 output (figure-with-umbrella, figure-standing, pole-simple, pole-with-crossbar)
    brushParams = SO1 output
    
    // T9 recipe determines the construction sequence
    // A figure-with-umbrella gets arcs + body column + tapered legs
    // A pole-simple gets one wobbling vertical with pressure taper
    strokes = SHAPE_RECIPES[recipe](region, brushParams)

For each region with meldrumIndex >= DARK and not vertical:
    recipe = T9 output (building-block, vehicle-body, etc.)
    brushParams = SO1 output
    strokes = SHAPE_RECIPES[recipe](region, brushParams)
```

**Layer 5: Accents**
```
For each region flagged by T7:
    useOil = true
    useAnchor = true
    recipe = T9 output (may be vehicle-body for the tram → specific accent recipe)
    brushParams = SO1 output, override: load=1.0, thinners=0.0
    
    // If the accent is part of a larger form (vehicle window),
    // T9 knows to paint just the accent dab, not the whole vehicle
    strokes = SHAPE_RECIPES[recipe](region, brushParams)
    
    hueIndex from T4 (most chromatic available)
    meldrumIndex = MID (peak chroma zone)
```

**Layer 6: Atmospheric Veil**
```
fog_density from O3
if fog_density > 0.3:
    Generate thin washes over non-dark regions
    Skip regions with meldrumIndex >= DARK (don't veil the anchors)
    thinners = 0.06-0.08
    load = 0.2-0.3
    motherHueIndex at WHITE
    Fewer passes for low fog, more for heavy fog
```

### Parameter Refinement Model

The assembly rules handle layer ordering and stroke type. But the brush parameters — thinners, load, pressure, brush size — need context sensitivity. A lone figure in vast fog needs different pressure than one of eight poles on a busy street. Same classification, same depth, completely different painting moment. Lookup tables can't capture this. A small model can.

**Implementation:** ML. ~15K params. Dense network, per-region prediction.

**Input per region** (~12 dimensions):
```
region_class (one-hot 8)          // from T2
depth (one-hot 3)                 // from T3
meldrum_band (one-hot 5)          // from T5
chroma                            // from T4
area_fraction                     // from T1
edge_sharpness                    // from T6
composition_class (one-hot 6)     // from O1
fog_density                       // from O3
distance_to_focal_point           // from O2
is_accent                         // from T7
stroke_type (one-hot 5)           // from T8
region_count_in_same_band         // how many other regions share this meldrum band
```

**Architecture:** Dense(~40→32, GELU) → Dense(32→16, GELU) → Dense(16→4, Sigmoid)

**Output per region:** `[thinners, load, pressure, brushSize]` — all normalized 0-1.

This model learns "for a DARK VERTICAL at NEAR depth in a LONELY-FIGURE composition with high fog density and distance 0.3 from the focal point, the best parameters are thinners=0.01, load=0.95, pressure=0.72, brushSize=0.02." Context-sensitive. Composition-aware. Every region gets personalized brush parameters.

**Training data:** Every region in every procedural pipeline output already has both its context features AND the brush parameters that painted it. 85 images × 80 regions = 6,800 examples. The pipeline's parameter choices were decent — they produced paintings that read as tonalist. The model learns to reproduce those choices given the context, then improves through the recursive loop.

**Fallback:** If the model doesn't load, use depth→parameter lookup tables. The painting will be less nuanced but structurally correct.

### SO2: Painting Conductor

SO1 decides HOW to paint each region. SO2 decides HOW TO PAINT THE PAINTING.

The assembly rules follow a fixed playbook: atmosphere first, darks last, accent at the end. But Beckett didn't always follow the playbook. Sometimes she went back to the atmosphere after placing a dark — added more fog OVER the committed mark to soften it back into the haze. Sometimes she placed the accent early and built the atmosphere around it. Sometimes she left half the canvas bare because the surface WAS the right value.

SO2 is the conductor. It reads the full scene understanding and makes the compositional decisions that determine the character of the painting — not what goes where (the tissues handle that) but how the painting is BUILT.

**Implementation:** ML. ~25K params. Dense network on scene-level features.

**Input** (~30 dimensions):
```
composition_class (one-hot 6)         // from O1
focal_type (one-hot 4)                // from O2
focal_position (2)                    // from O2
fog_density                           // from O3
layer_budgets (6)                     // from O4
region_count_per_class (8)            // aggregated from T2
depth_distribution (3)                // count near/mid/far
total_dark_area                       // fraction of canvas in DARK/BLACK
accent_count                          // number of accent regions
accent_max_chroma                     // strongest accent intensity
avg_chroma                            // overall scene chroma
vertical_to_mass_ratio                // compositional balance
```

**Architecture:** Dense(30→48, GELU) → Dense(48→32, GELU) → Dense(32→16, GELU) → Dense(16→outputs)

**Output** — painting-level decisions:
```typescript
interface ConductorDecisions {
    // Rhythm
    layer_order: number[];           // which layers to paint in what order
                                     // default [1,2,3,4,5,6] but may be [1,2,3,4,6,5]
                                     // (veil before accents) or [1,5,2,3,4,6] (accent early)
    
    // Focus  
    focal_density_multiplier: number; // stroke concentration near focal (1.0-3.0)
                                      // lonely-figure: 2.5 (heavy concentration)
                                      // seascape: 1.2 (distributed)
    
    // Restraint
    restraint_factor: number;         // global stroke reduction (0.4-1.0)
                                      // lonely-figure: 0.5 (half the budget — less is more)
                                      // street-scene: 0.9 (busy, needs the strokes)
    bare_canvas_threshold: number;    // regions lighter than this get zero strokes
                                      // let the surface speak — Beckett left board showing
    
    // Atmosphere
    veil_strength: number;            // how heavy the final atmosphere pass (0.0-1.0)
                                      // foggy scene: 0.8 (heavy reunifying veil)
                                      // clear scene: 0.2 (light dust)
    dark_softening: number;           // atmosphere painted OVER darks (0.0-1.0)
                                      // 0.0 = crisp darks, 1.0 = darks fogged back
                                      // Beckett often softened her darks after placing them
    
    // Timing
    accent_timing: number;            // when accent fires in the sequence (0.0-1.0)
                                      // 0.0 = early (build atmosphere around it)
                                      // 1.0 = last (the climax)
                                      // Beckett usually: 0.85 (near the end, not quite last)
    
    // Boundaries
    inter_region_bleed: number;       // strokes extend beyond region bounds (0.0-1.0)
                                      // 0.0 = tight to regions (graphic)
                                      // 1.0 = loose, strokes overlap into neighbors (painterly)
                                      // Beckett: 0.6-0.8 (soft boundaries, things dissolve)
}
```

**What changes with the conductor:**

Without SO2, the assembly rules produce structurally correct but characterless paintings — the same failure mode as the dense CNN model, which painted everything with equal density and no restraint. The layer order is always the same. The density is uniform. The darks are always crisp. The accent is always last. Every painting feels the same — competent but mechanical. The dense model's crosshatch-everywhere output proved that uniform treatment of all regions produces something that reads as "generated," not "painted."

With SO2, each painting has its own strategy:

- A **lonely figure in heavy fog**: restraint_factor=0.45, focal_density=2.8, dark_softening=0.6, bare_canvas_threshold=0.3, inter_region_bleed=0.8. Half the strokes. Heavy concentration on the figure. Darks softened by atmosphere. A third of the canvas left bare. Everything dissolves at the edges. Beckett.

- A **busy street scene**: restraint_factor=0.85, focal_density=1.5, dark_softening=0.2, bare_canvas_threshold=0.05, inter_region_bleed=0.5. Most of the budget used. Moderate focal concentration. Darks stay crisp. Almost everything painted. Tighter boundaries. More structure, less fog.

- A **seascape**: restraint_factor=0.55, focal_density=1.1, veil_strength=0.9, bare_canvas_threshold=0.4, accent_timing=0.3. Low density, distributed evenly. Heavy veil. Lots of bare canvas. The accent fires early — the warm horizon — and the atmosphere builds around it.

Three completely different painting strategies from the same assembly rules, because the conductor configured them differently.

**Training data:** Run the hierarchy with varied conductor settings on the same reference. Export PNGs. The gardener ranks them: "this painting with restraint=0.5 and focal_density=2.5 is better than the one with restraint=0.9." The winning settings + the scene features = one training example.

Start with hand-authored defaults per composition class (like O4). Perturb each setting ±30% and generate 3-5 variations per reference. The gardener picks the best. Over 50 references, that's 50 preference-labeled examples. Enough for a 25K param dense network.

The recursive loop improves SO2 the fastest because the gardener's preference IS the training signal. "I like this painting better" directly maps to the conductor settings that produced it.

**Fallback:** If the model doesn't load, use hand-authored conductor defaults per composition class. The paintings will be decent — same strategy for every lonely-figure scene, same strategy for every street scene. The model adds per-scene nuance.

### Organism Summary

| Component | Implementation | Params |
|-----------|----------------|--------|
| Layer assembly logic | Algorithmic (rules configured by SO2) | 0 |
| Per-region stroke generators | Algorithmic (T9 recipes) | 0 |
| SO1 Parameter refinement | ML (ONNX) | 15K |
| SO2 Painting conductor | ML (ONNX) | 25K |
| **Total** | **Algorithmic + 2 ML models** | **40K** |

The organism has 40K learned parameters doing two jobs. SO1 handles micro decisions (per-region brush parameters). SO2 handles macro decisions (painting-level strategy). The assembly rules connect them — SO2 configures the rules, SO1 fills in the parameters, the rules generate the strokes, the cells execute.

## Full Hierarchy

```
REFERENCE IMAGE (224×224)
    │
    ├── Grid Analysis (cells — downsample, OKLCH, quantize)
    │
    ▼
TISSUES (perceive — 9 units, 20K learned params)
    │
    ├── T1 Region Segmenter ──────── Heuristic: BFS flood fill
    ├── T2 Region Classifier ─────── ML 7K: 8-class per patch
    ├── T3 Depth Mapper ──────────── Heuristic: position + tone
    ├── T4 Color Analyzer ────────── Heuristic: OKLCH stats
    ├── T5 Tonal Mapper ──────────── Heuristic: LUT lookup
    ├── T6 Edge Detector ─────────── Heuristic: neighbor comparison
    ├── T7 Accent Detector ───────── Heuristic: chroma threshold
    ├── T8 Stroke Type Inferrer ──── ML 5K: 5-class per region
    └── T9 Shape Recipe Classifier ── ML 8K: 10-class Beckett recipe
    │
    ▼
ORGANS (understand — 4 units, 10K learned params)
    │
    ├── O1 Composition Reader ────── ML 10K: 6-class scene type
    ├── O2 Focal Point Locator ───── Heuristic: accent/vertical position
    ├── O3 Atmosphere Density ─────── Heuristic: weighted tissue ratios
    └── O4 Layer Budget ──────────── Heuristic: strategy table
    │
    ▼
ORGANISM (paint — 2 ML models + rules, 40K learned params)
    │
    └── SO2 Painting Conductor ───── ML 25K: painting-level strategy
        │                             (restraint, focal density, rhythm,
        │                              bare canvas, veil, bleed)
        └── SO1 Parameter Refinement ── ML 15K: per-region brush params
            │
            └── Assembly Rules ────── Algorithmic: layer ordering
                │                      + T9 recipe execution
                │                      + configured by SO2 decisions
        │
        ▼ StrokeCommand[]
    │
    ▼
CELLS (execute — 0 AI, millions of computations)
    │
    └── replayStroke() → K-M mixing → surface → compositor → paint
    │
    ▼
THE GARDENER
    │
    └── Sees the painting. Pauses. Picks up the brush.
        Overrides any level. Every override improves that level.
```

## The Numbers

| Level | Units | ML Units | Heuristic Units | Learned Params |
|-------|-------|----------|-----------------|----------------|
| Tissues | 9 | 3 | 6 | 20K |
| Organs | 4 | 1 | 3 | 10K |
| Organism | 2 ML + rules | 2 | 1 (assembly) | 40K |
| **Total** | **15** | **6** | **9** | **70K** |

70K total learned parameters. Six ONNX models. Nine heuristic algorithms. One rule-based assembly layer configured by the conductor.

Compare to the monolithic Clarice: 15M params, one model, one point of failure, not enough data to train it.

The hierarchy uses the SAME 85 reference images but extracts vastly more signal:
- T2 region classifier: 85 images × 80 regions = 6,800 patch examples
- T8 stroke type: 85 images × 80 regions = 6,800 examples
- T9 shape recipe: 500-800 labeled silhouettes
- O1 composition: 85 scene labels (human-provided)
- SO1 parameter refinement: 85 images × 80 regions = 6,800 context→parameter examples
- SO2 painting conductor: 50-85 preference rankings (human-curated)

Each model has abundant data for its specific narrow task.

## Data Requirements

| Model | Training Examples | Source | Labeler |
|-------|-------------------|--------|---------|
| T2 Region Classifier | ~6,800 patches | Heuristic bootstrap | Claude Code: views screenshot + heuristic output, corrects misclassifications |
| T8 Stroke Type | ~6,800 patches | Procedural pipeline outputs | Claude Code: infers type from stroke→region alignment in pipeline data |
| T9 Shape Recipe | ~500-800 regions | Reference paintings | Claude Code: views each region crop against Beckett references, classifies construction pattern |
| O1 Composition | 50-85 scene labels | Reference images | Claude Code: views each reference image, picks one of 6 composition classes |
| SO1 Parameter Refinement | ~6,800 region contexts | Procedural pipeline outputs | Automatic extraction — zero labeling needed |
| SO2 Painting Conductor | 50-85 preference rankings | Painting variations | Claude Code: views 3-5 PNGs per reference, ranks against original Beckett |
| **Total human effort** | | | **0 minutes** |

Zero human labeling. Claude Code does it all in the CLI.

Claude Code has vision. It can view a reference image and say "this is a lonely-figure composition." It can view a region crop and say "this silhouette is a figure-with-umbrella, not a pole." It can view 5 painting variations side by side with the Beckett reference and say "variation 3 is closest — the restraint is right, the focal point is in the right place, the darks are softened correctly."

The labeling pipeline runs overnight alongside training:

```bash
# Automated labeling + training loop
# Claude Code executes each step, no human in the loop

# Step 1: Label compositions
# For each reference image, Claude Code views it and outputs a class
for img in training-images/*.png; do
    # Claude Code: "View this image. Classify as one of:
    # lonely-figure, street-scene, seascape, twilight-glow, intimate-scene, abstract-masses"
    claude_label_composition "$img" >> labels/compositions.json
done

# Step 2: Label shape recipes
# For each region, Claude Code views the crop + the reference + Beckett examples
for region in regions/*.json; do
    # Claude Code: "View this region silhouette alongside the reference.
    # Classify the Beckett construction recipe"
    claude_label_recipe "$region" >> labels/recipes.json
done

# Step 3: Correct region classifications
# Claude Code views heuristic output, flags errors
for img in training-images/*.png; do
    # Claude Code: "The heuristic classified these regions as [labels].
    # View the image. Which classifications are wrong?"
    claude_correct_regions "$img" >> labels/region_corrections.json
done

# Step 4: Rank conductor variations
# After generating 3-5 painting variations per reference
for ref in training-images/*.png; do
    # Claude Code: "View these 5 painting variations alongside the Beckett reference.
    # Rank from best to worst match. Which captures Beckett's approach?"
    claude_rank_paintings "$ref" variations/ >> labels/conductor_rankings.json
done

# Step 5: Train all models with Claude Code's labels
python3 tools/train-hierarchy.py --labels labels/
```

### Quality of Claude Code's Labels

Claude Code's labels won't be perfect. But they don't need to be.

**T2 corrections:** Claude Code looks at a region classified as 'mass' and the reference image. If the region is clearly a pole, it corrects. Obvious corrections are 95%+ accurate. Ambiguous cases (is this a mass or a spread tree?) might be wrong — but those are exactly the cases the heuristic was already wrong about, so even a 70% accurate correction is better than the heuristic's 50% on edge cases.

**T9 recipes:** Claude Code has seen Beckett's paintings. It knows what an umbrella figure looks like vs a standing figure vs a pole. The 10 recipe classes are visually distinct. Accuracy: likely 85%+.

**O1 composition:** Six classes, one per image, visually obvious. "Is this a lonely figure or a busy street?" Claude Code handles this at near-human accuracy. Likely 95%+.

**SO2 rankings:** This is the most subjective task. "Which of these 5 paintings is most like Beckett?" Claude Code will sometimes disagree with the gardener's taste. But the rankings provide a consistent baseline that the gardener can override in V2. And Claude Code's aesthetic judgment on "does this capture atmospheric restraint" is surprisingly good.

### The Gardener's Role Shifts

The gardener no longer labels. The gardener REVIEWS.

After the overnight loop, the gardener wakes up to:
- Trained models with Claude Code's labels
- Eval screenshots showing what the hierarchy produces
- A summary of what Claude Code labeled and why

The gardener reviews the output paintings. If they're good — ship it. If something's off — the gardener makes targeted corrections. "Claude Code ranked variation 2 highest but variation 4 is better because the accent timing is more restrained." That one correction overrides Claude Code's label and improves SO2.

The gardener's taste is still the ultimate authority. But instead of doing 160 minutes of labeling to get V1, the gardener does 0 minutes of labeling and 15 minutes of review. The gardener's time is spent on JUDGMENT, not labor.

### The Recursive Loop — Fully Automated

```
Night 1: Claude Code labels all training data → train all 6 models → export ONNX
Night 2: Run hierarchy on all references → export paintings → Claude Code evaluates + relabels → retrain
Night 3: Same loop → models improve → Claude Code's labels get better because the hierarchy's output is better
Morning: Gardener reviews. Overrides 5-10 labels. These corrections go into Night 4's training.
```

Three nights of automated training. One 15-minute review session per morning. By day 4, the hierarchy has been trained on Claude Code's labels, corrected by the gardener's taste, and retrained. V0.3 with effectively zero human labor.

## Model Sizes on Disk

| Model | Params | ONNX Size | Inference |
|-------|--------|-----------|-----------|
| T2 Region Classifier | 7K | ~28KB | <2ms batched |
| T8 Stroke Type | 5K | ~20KB | <2ms batched |
| T9 Shape Recipe | 8K | ~32KB | <2ms batched |
| O1 Composition | 10K | ~40KB | <1ms |
| SO1 Parameter Refinement | 15K | ~60KB | <2ms batched |
| SO2 Painting Conductor | 25K | ~100KB | <1ms |
| **Total** | **70K** | **~280KB** | **<10ms** |

280KB total on disk. Under 10ms total inference. The entire Clarice hierarchy — six learned models, nine heuristics, the full perceptual and decision stack from "here's a photo" to "here's how Beckett would paint it" — is smaller than a single low-res JPEG.

## Lessons from Failed Approaches

Three architectures were attempted before the hierarchy. Each failed. Each taught something specific that shaped the hierarchy's design.

### Attempt 1: Autoregressive Transformer (15M params)

**Architecture:** ViT-Tiny encoder → autoregressive stroke decoder. Image in, sequence of 600 stroke tokens out. Each token predicted from all previous tokens + the image.

**Result:** Loss dropped from 9.65 to 0.71 — strong convergence on paper. Position/physics converged to 0.012. Binary flags near-perfect at 0.007. But in practice: mode collapse. The decoder found one "safe" token and repeated it. Brush slot 4 for 599/600 strokes. One hue. One meldrum band. 6% spatial coverage — all strokes in the same area. With temperature sampling added, it produced colorful but compositionally random paintings.

**Root cause:** 15M parameters learning sequence modeling from 455 examples. The autoregressive decoder needs to learn "what comes next given everything before" — that's the hardest possible learning task. With teacher forcing at 100%, the model never saw its own outputs during training, so inference diverged immediately from the training distribution.

**Lesson for the hierarchy:**
- **No sequence modeling.** The hierarchy avoids autoregressive generation entirely. Layer ordering is deterministic rules (SO2 configures them). Stroke ORDER within a layer doesn't matter — the cells handle overlap physics. The hardest part of the monolithic model (sequence prediction) is eliminated by design.
- **Teacher forcing is dangerous with small data.** The model learned to predict the NEXT ground truth token perfectly but couldn't generate coherently. The hierarchy's ML models are all classification or regression — they predict labels or parameters, not sequences. No autoregressive loop, no drift.
- **Separate what's learnable from what's deterministic.** The monolithic model tried to learn layer ordering (deterministic), stroke type selection (classifiable), brush parameters (regressive), AND sequential dependencies (impossible with small data) in one model. The hierarchy separates each into its own unit with the right implementation.

### Attempt 2: Dense Patch CNN (168K params)

**Architecture:** 4-layer CNN encoder (224→14×14) → per-patch MLP head predicting stroke properties. Each of the 196 patches independently predicts what stroke should go there.

**Result:** Correct tonal placement — dark strokes where the reference was dark, warm where warm, cool where cool. The 168K model with 8× augmentation (3,400 effective samples) learned VALUE correctly. But every patch painted with the same crosshatch pattern. Vertical + horizontal marks overlapping in identical rhythm across the entire canvas. No composition. No shape variety. No atmosphere vs committed marks.

**Root cause:** Independent per-patch prediction. Each patch sees only its own 16×16 pixel area. It doesn't know neighboring patches exist. It can't form regions, can't detect silhouettes, can't distinguish a patch that's part of a figure from a patch that's part of sky. It learned the safest universal stroke construction (crosshatch) and applied it everywhere.

**Lessons for the hierarchy:**
- **T1 region segmentation is critical.** The dense model proved that per-patch is not enough. Patches must be GROUPED into regions before classification. A "figure" is 8 patches together — no single patch contains that information. T1 (BFS flood fill) provides what the dense model lacked: spatial grouping.
- **T9 shape recipes exist because of this failure.** The crosshatch pattern is what happens when every spatial unit gets the same stroke construction. T9 ensures different regions get different construction recipes — the figure gets arcs and tapered verticals, the tree mass gets clustered dabs, the pole gets a single wobbling vertical. Per-region recipes replace per-patch uniformity.
- **SO2 conductor's restraint_factor is a direct response.** The dense model painted EVERY patch — full coverage, no bare canvas, no restraint. Beckett left half her surfaces bare. SO2's bare_canvas_threshold and restraint_factor explicitly control what NOT to paint. The dense model taught us that knowing what to OMIT is as important as knowing what to paint.
- **The dense model's tonal reading is reusable.** T4 (Color Analyzer) and T5 (Tonal Mapper) do essentially what the dense model's per-patch prediction did correctly — read the tonal value and hue of each region. The dense model validated that per-patch color reading works. The hierarchy keeps that capability as a heuristic (even simpler than the CNN) and adds composition awareness on top.

### Attempt 3: Dense Patch CNN with frozen ViT encoder (2M params)

**Architecture:** ViT encoder from the autoregressive model (frozen) → per-patch MLP head.

**Result:** Worse than the unfrozen CNN (val_loss 312 vs 161). The autoregressive encoder learned features optimized for "what token comes next" — not for "what stroke properties does this patch need."

**Lesson for the hierarchy:**
- **Features must match the task.** The hierarchy's ML models are all trained from scratch on their specific task. T2 learns region classification features. T9 learns silhouette features. O1 learns composition features. No transfer from mismatched tasks. Small models on matched tasks beat large models on mismatched tasks.

### Summary of Architectural Constraints

| Constraint | Source | Hierarchy Solution |
|-----------|--------|-------------------|
| Can't learn sequences from 85 examples | Autoregressive failure | No sequence modeling — deterministic layer ordering |
| Per-patch prediction lacks spatial grouping | Dense model failure | T1 groups patches into regions before any classification |
| One stroke construction for everything | Dense model failure | T9 provides 10 Beckett-specific shape recipes |
| Paints everything, no restraint | Dense model failure | SO2 conductor controls restraint, bare canvas, focal density |
| Tonal value placement IS learnable per-patch | Dense model success | T4/T5 heuristics capture the same capability |
| Frozen features from wrong task hurt | ViT transfer failure | All models trained from scratch on matched tasks |
| 455 examples for 15M params = impossible | Autoregressive failure | 6,800 examples per 5-15K params per model |
| 85 images can teach a LOT if decomposed | All three attempts | Each image yields ~80 regions, each region yields multiple training signals |

## Why This Works When the Monoliths Didn't

The monolithic model tried to learn a function:
```
f(224×224 pixels) → 600 stroke tokens with 14 fields each
```
That's a mapping from 150,528 input dimensions to 8,400 output dimensions. With 85 training examples. Impossible.

The dense model tried:
```
f(224×224 pixels) → 196 patches × 27 properties each
```
Better — per-patch is simpler than sequential. But no spatial grouping, no composition, no shape awareness. Correct values, wrong marks.

The hierarchy decomposes it:
```
T1(pixels) → 80 regions                          // deterministic — spatial grouping the dense model lacked
T2(16×16 patch) → 1 of 8 classes                  // 6,800 examples for 7K params
T3(region position + tone) → 1 of 3 depths        // deterministic
T4(region cells) → color stats                     // deterministic — validated by dense model's tonal success
T5(region luminance) → 1 of 5 bands                // deterministic — validated by dense model's tonal success
T6(region pair) → 1 of 3 edge types               // deterministic
T7(region chroma) → accent flag                    // deterministic
T8(16×16 patch + context) → 1 of 5 stroke types   // 6,800 examples for 5K params
T9(16×16 silhouette + class) → 1 of 10 recipes    // 500-800 examples for 8K params — fixes dense model's uniform marks
O1(40 scalars) → 1 of 6 compositions              // 85 examples for 10K params
O2(accent positions) → focal point                 // deterministic
O3(tissue ratios) → fog density                    // deterministic
O4(composition class) → stroke budgets             // lookup table
SO1(12 features per region) → 4 brush params        // 6,800 examples for 15K params
SO2(30 scene features) → 8 conductor decisions       // 50-85 examples for 25K params — adds restraint the dense model lacked
Assembly(all of the above) → StrokeCommand[]         // deterministic rules — no sequence prediction needed
```

Each learned step is a tiny classification or regression with abundant data. Each deterministic step is trustworthy math. The spatial grouping (T1) that the dense model lacked is a heuristic. The shape vocabulary (T9) that prevents crosshatch uniformity is an 8K model. The restraint (SO2) that the dense model couldn't learn is a 25K model trained on preference rankings. The tonal placement that the dense model DID learn correctly is captured by T4/T5 heuristics without needing any ML at all.

No single step is asked to do something that was proven impossible by the failed approaches.

## Execution Flow

```typescript
async function clariceHierarchy(imageData: ImageData, mood: Mood): Promise<PaintingPlan> {
    // Cells: grid analysis
    const grid = analyzeGrid(imageData, 60, 45);
    const horizonRow = detectHorizon(grid);
    
    // Tissues
    const regions = extractRegions(grid);                    // T1: heuristic
    const classes = await classifyRegions(regions);          // T2: ML
    const depths = mapDepths(regions, horizonRow);           // T3: heuristic
    const colors = analyzeColors(regions, grid);             // T4: heuristic
    const tones = mapTones(regions, meldrumLUTs);            // T5: heuristic
    const edges = detectEdges(regions);                      // T6: heuristic
    const accents = detectAccents(regions, colors);          // T7: heuristic
    const strokeTypes = await inferStrokeTypes(regions);     // T8: ML
    const recipes = await classifyShapeRecipes(regions, classes, depths); // T9: ML
    
    // Organs
    const features = aggregateFeatures(regions, classes, depths, colors, tones, edges, accents);
    const composition = await classifyComposition(features); // O1: ML
    const focalPoint = locateFocalPoint(accents, classes);   // O2: heuristic
    const fogDensity = readAtmosphere(features);             // O3: heuristic
    const budget = allocateBudget(composition, regions);     // O4: heuristic
    
    // Organism
    const conductor = await conductPainting(                 // SO2: ML
        composition, focalPoint, fogDensity, budget,
        features,
    );
    
    const params = await refineParameters(                   // SO1: ML
        regions, classes, depths, colors, tones, edges,
        accents, strokeTypes, composition, focalPoint, fogDensity,
    );
    
    const plan = assemblePaintingPlan({                       // Rules configured by SO2
        regions, classes, depths, colors, tones, edges,
        accents, strokeTypes, recipes, composition, focalPoint,
        fogDensity, budget, params, conductor, mood, horizonRow,
    });
    
    return plan;  // → cells execute via replayStroke()
}
```

Total inference time: <10ms for the ML models + <10ms for the heuristics. Under 20ms for the entire hierarchy. The conductor makes its decisions, the parameters are refined, the assembly rules build the plan, and the cells start painting — all before the user finishes lifting their finger off the GROW button.

## Upgrade Path

V1 ships with 70K learned params, 6 ONNX models, and 9 heuristic algorithms. Every ML model has a heuristic fallback. The product works without any ML — it just works better with it.

V2 improvements come from the recursive loop — all automated with Claude Code labeling, gardener reviews in the morning:
- T2 improves from Claude Code viewing GARDEN outputs and correcting region classifications
- T8 improves from Claude Code evaluating which stroke types produced the best marks
- T9 improves from Claude Code studying more Beckett paintings — new recipe classes can be added as new forms are identified
- O1 improves from Claude Code labeling more reference images
- SO1 parameter refinement improves from curated painting outputs — Claude Code evaluates, gardener confirms
- SO2 painting conductor improves the fastest — Claude Code ranks variations against Beckett references, gardener overrides when taste diverges. The conductor learns from both.

The hierarchy improves at every level from use. No architectural changes needed. Just better weights.

## Implementation Order

### Sprint 1: Wire the Hierarchy (1-2 days)
- T1, T3-T7 heuristics already exist or are trivial to implement
- T2 already exists as ONNX model
- Wire them together in the execution flow
- Use lookup tables as fallback for SO1 parameter refinement
- Run on all references, export screenshots
- This produces structurally similar output to the current procedural pipeline — but organized as a hierarchy

### Sprint 2: Train T8 + T9 + O1 + SO1 + SO2 (2-3 days, mostly automated overnight)
- Extract T8 training data from procedural pipeline outputs (region → stroke type)
- Claude Code labels T8 corrections by viewing pipeline stroke→region alignments
- Train T8 (5K params), export ONNX, integrate
- Implement the 10 deterministic recipe functions (figure-with-umbrella, pole-simple, tree-mass-rounded, etc.)
- Claude Code labels T9 by viewing region crops against Beckett references — classifies construction pattern for each
- Train T9 (8K params), export ONNX, integrate
- Claude Code labels O1 by viewing each reference image — picks composition class
- Train O1 (10K params), export ONNX, integrate
- Extract SO1 training data from procedural pipeline outputs (automatic, zero labeling)
- Train SO1 (15K params), export ONNX, integrate
- Generate 3-5 conductor variations per reference (perturb restraint, focal density, veil, etc.)
- Run each variation through the cells, export PNGs
- Claude Code ranks variations against Beckett reference — picks best per scene
- Train SO2 (25K params) on winning conductor settings, export ONNX, integrate
- Run on all references — gardener reviews output paintings in the morning (15 min)
- Gardener overrides any labels that feel wrong — corrections feed into next training round

### Sprint 3: Tune the Organism (1-2 days)
- Run the full hierarchy on 20+ diverse references
- Export paintings, evaluate per-layer
- Tune the assembly rules: layer ordering, stroke density curves, accent behavior
- Tune SO1 via the recursive correction loop — run hierarchy, compare to procedural, correct, fine-tune
- Use the Playwright loop for automated evaluation
- Hand-tune until the paintings read as tonalist

### Sprint 4: GARDEN Mode Integration (1 day)
- Wire the hierarchy into the GARDEN flow: load reference → run hierarchy → execute plan with replayStroke()
- Add pause/resume — human can take over at any point
- Add speed control: real-time, fast, instant
- Per-layer commentary for LEARN mode

### Implementation Agent Instructions

Claude Code: Sprint 1 first. Wire the existing heuristics and T2 classifier into the execution flow. T8 and T9 use heuristic fallbacks in Sprint 1. O1 defaults to 'street-scene'. SO1 uses lookup tables. SO2 uses hand-authored conductor defaults per composition class. The point of Sprint 1 is to prove the hierarchy produces valid painting plans.

Sprint 2 is where you do double duty — you are both the TRAINER and the LABELER. For each ML model:
1. View the reference images and pipeline outputs using your vision capabilities
2. Generate the labels (composition classes, recipe classifications, conductor rankings)
3. Save labels as JSON
4. Train the model on your own labels
5. Export ONNX
6. Integrate and test

For T9, implement the 10 deterministic recipe functions FIRST — these are the output vocabulary the model selects from. Then label regions by viewing their silhouettes against Beckett reference paintings.

For SO2, generate 3-5 conductor variations per reference by perturbing the settings, run them through the cells, screenshot each, then VIEW all variations alongside the Beckett reference and rank them. Your rankings train the conductor.

Sprint 3 tunes through the Playwright loop — run the full hierarchy, screenshot, evaluate, relabel where needed, retrain. The gardener reviews each morning and overrides any labels that don't match their taste. Their corrections go into the next night's training.

Sprint 4 ships. After shipping, every GARDEN mode intervention from real users improves every level of the hierarchy.
