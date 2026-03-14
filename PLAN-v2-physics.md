# GHH V2 — Implementation Plan
### Three Physical Systems + Session Flow + Thinners

Three design docs, one build plan. Eight phases, dependency-ordered.

**Source docs:**
- `ghh-three-physical-systems.md` — Brush bristles, surface absorption, paint drying
- `ghh-session-flow.md` — Prepare/Test/Paint phases, mood system, 15-pile palette, rag
- `ghh-thinners.md` — Paint consistency as master physics variable (replaces VELVET)

**The key insight:** Thinners is the connective tissue. It's not a control that affects one thing — it's a physical property that changes how every system behaves. Thick paint and thin paint are fundamentally different materials. Thinners modulates: deposit amount, edge softness, grain interaction, drying speed, surface absorption, scrape resistance, wipe effectiveness, color pickup, and enables "oiling in" at maximum. Every phase that touches the brush/scrape/wipe shaders must account for thinners.

---

## Current State

The codebase is a WebGPU painting app with:
- K-M pigment physics (brush.wgsl, kubelka-munk.wgsl)
- Brush/scrape/wipe engines with ping-pong accumulation (rgba16float)
- Atmosphere system (density compute, scatter render, noise/grain LUTs)
- Light wells with bloom (light-scatter.wgsl, bloom.wgsl)
- 8 tools (SEL, FRM, LGT, DSLV→SCRP, DRFT, PAL, DPTH, ANCR)
- Undo system (30 GPU texture snapshots)
- Controls: TIME dial, ATMOSPHERE orb, VELVET, LOAD, ECHO, palette (5 swatches × tonal column), surface pad, drift field, anchor, horizon, light wells
- Compositor: 11-step pipeline (sky, K-M, lights, bloom, conformance, desaturation, color bleed, sun grade, grain, tonemap, sRGB)

---

## Phase 0: Strip & Simplify

**Goal:** Remove everything the design docs eliminate. Clear the deck before building.

### 0.0 index.html Cleanup
- Remove all deleted custom element tags: `<ghz-light-wells>`, `<ghz-drift-field>`, `<ghz-anchor-control>`, `<ghz-atmosphere-orb>`, `<ghz-horizon>`, `<ghz-time-dial>`, `<ghz-echo-slider>`, `<ghz-velvet-slider>`
- New elements (`<ghz-mood-selector>`, `<ghz-thinners-slider>`, etc.) added in their respective phases

### 0.1 Remove Undo System
- Delete `src/painting/undo.ts`
- Remove undo/redo from `src/input/keyboard.ts` (Cmd+Z, Cmd+Shift+Z handlers)
- Remove undo snapshot allocation and calls in `src/app.ts`
- Remove any undo-related state from stores
- **Result:** ~500MB GPU memory freed (30 snapshots), simpler app.ts

### 0.2 Remove Light Wells & Bloom (ATOMIC with 0.4)
**This step and 0.4 must be done together.** The compositor bind group layout references light/bloom textures. Deleting `light-layer.ts` without simultaneously restructuring the compositor bind group will crash the app.

- Delete `src/light/light-layer.ts`
- Delete `src/shaders/light/light-scatter.wgsl`
- Delete `src/shaders/light/bloom.wgsl`
- Remove `getBloomTexture` import in `src/compositor/compositor.ts` (line 9) and fallback bloom texture creation (lines 112-119)
- Remove LightDef from `src/state/scene-state.ts`
- Remove light texture creation from `src/gpu/texture-pool.ts`
- Remove light/bloom bind group entries (bindings 4, 5) and dispatch from `src/compositor/compositor.ts` — renumber remaining bindings
- Remove light-related steps from `src/shaders/composite/composite.wgsl` (step 3: light wells, bloom overlay)
- Delete `src/controls/light-wells.ts`
- Update `src/state/dirty-flags.ts`: remove `'light'` flag and its cascade entries (`density → [scatter, light, composite]` becomes `density → [scatter, composite]`)
- **Result:** No procedural lights. Light is paint.

### 0.3 Remove Eliminated Tools & Controls
- Delete `src/controls/atmosphere-orb.ts` (ATMOSPHERE)
- Delete `src/controls/time-dial.ts` (TIME)
- Delete `src/controls/velvet-slider.ts` (VELVET)
- Delete `src/controls/echo-slider.ts` (ECHO)
- Delete `src/controls/drift-field.ts` (DRFT)
- Delete `src/controls/anchor-control.ts` (ANCR)
- Delete `src/controls/horizon-control.ts` (HORIZON)
- Delete `src/shaders/ui/orb.wgsl`, `src/shaders/ui/dial.wgsl`
- Remove tool types from `src/state/ui-state.ts`: keep only `'form' | 'scrape' | 'wipe'`
- Remove corresponding state fields from `src/state/scene-state.ts`:
  - `atmosphere.warmth`, `atmosphere.scatter` (if mood-derived)
  - `sun.angle`, `sun.elevation` (no TIME dial)
  - `anchor` point (no ANCR)
  - `lights[]` array (no LGT)
  - `horizonY` (no HORIZON — you want a horizon, you paint it)
  - `brush.velvet` (replaced by thinners in Phase 3)
  - `brush.echo` (replaced by physics in Phase 7)
- Remove horizon line rendering from `src/controls/canvas-overlay.ts`
- Remove `horizon_y` from scatter.wgsl params — already has fallback path (`horizon_y < 0` → simple vertical blend)
- Remove horizon haze band from density.wgsl — already guarded by `horizon_y >= 0.0`
- In Phase 1, scatter shader gets rewritten to use mood-derived sky colors anyway, so horizon logic is fully replaced
- Update `src/controls/canvas-overlay.ts`: remove TOOL_CURSORS entries for `'light'`, `'drift'`, `'palette'`, `'anchor'`, and clean up BRUSH_TOOLS set
- Update `src/app.ts`: remove tool type pattern matches for deleted tools in `setupPaintingInteraction`
- Remove gesture handler atmosphere references in `src/app.ts` (lines 137-147 modify `atmosphere.grain`/`atmosphere.grainAngle`) — gestures removed, atmosphere is mood-driven
- Strip toolbar to 3 tools in `src/controls/toolbar.ts`

### 0.4 Simplify Compositor (ATOMIC with 0.2)
- Remove from `composite.wgsl`:
  - Step 3: Light wells + bloom overlay (removed in 0.2)
  - Step 5: Anchor-based desaturation (no ANCR)
  - Step 7: Sun-grade color timing (no TIME dial — mood sets this)
- Keep: Sky gradient, K-M paint, conformance, color bleed, grain, tonemap, sRGB
- Remove drift/advection from density.wgsl (paintings don't animate)
- The compositor becomes a ~7-step pipeline

### 0.5 Simplify Atmosphere
- Remove drift/turbulence/advection from `src/shaders/atmosphere/density.wgsl`
- Density becomes static — computed once from mood params, not animated per frame
- Remove drift-related state from scene-state
- Keep: density value, fog color, scatter — but driven by mood, not interactive controls
- The atmosphere becomes a fixed backdrop set at session start

### 0.6 Wire Keyboard Shortcuts
- F = FRM (paint), D = SCRP (scrape), W = WIPE (wipe)
- Remove old keyboard bindings for deleted tools
- Update `src/input/keyboard.ts`

**Files touched:** ~20 files deleted/modified
**Risk:** Medium — lots of deletions, but each is independent. Run after each sub-step to catch breaks.
**Verification:** App launches, painting works (FRM/SCRP/WIPE), no console errors from missing modules.

---

## Phase 1: Mood System & Atmosphere Derivation

**Goal:** Replace interactive atmosphere controls with mood-driven presets.

### 1.1 Mood Data Model
- New file: `src/mood/moods.ts`
- Define `Mood` interface:
  ```ts
  interface Mood {
    name: string
    description: string
    density: number
    piles: [KColor, KColor, KColor][] // 5 hues × 3 values (light/med/dark)
    defaultSurface: string
  }
  ```
- Define 7 preset moods from the session flow doc: Golden Hour, Blue Hour, Foggy Morning, Midday Haze, Dusk, Overcast, Night
- Each mood has 15 pile colors (5 hues × 3 values) specified as hex, converted to K-M absorption values
- Store as const array

### 1.2 Atmosphere Derivation from Palette
- New function: `deriveAtmosphere(mood: Mood): AtmosphereParams`
- Sky zenith = lightest value of coolest hue
- Sky horizon = lightest value of warmest hue
- Mid sky = K-M mix of zenith and horizon
- Fog color = average of all light values
- Density from mood definition
- Update `AtmosphereParams` interface (remove warmth, scatter — now derived)
- This replaces the TIME dial + ATMOSPHERE orb entirely

### 1.3 Surface Presets with Physical Properties
- Extend surface presets in state with absorption + drySpeed:
  ```ts
  interface SurfacePreset {
    name: string
    grainSize: number
    directionality: number
    mode: 'standard' | 'woodblock'
    absorption: number   // NEW: 0.05 (smooth) to 0.25 (paper)
    drySpeed: number     // NEW: 0.7 (smooth) to 1.4 (paper)
  }
  ```
- 5 presets: Board (0.15/1.0), Canvas (0.10/0.9), Paper (0.25/1.4), Smooth (0.05/0.7), Woodblock (0.20/1.2)

### 1.4 Update Scatter Shader
- `scatter.wgsl` now reads atmosphere params derived from mood
- Sun elevation/angle become fixed per mood (derived from the mood's character)
- Remove dynamic sun positioning — the light IS the mood

### 1.5 Session State Model (v4)
- Update `GHZProject` interface (in `src/export/scene-io.ts`) to version 4
  - Note: the plan design docs call this `GHZSession` but the codebase uses `GHZProject` — use the existing name
- Add: `mood`, `surface.absorption`, `surface.drySpeed`, `brushes.slots[].age`, `brushes.slots[].bristleSeed`, `canvas.stateData`, `sessionStartTime`, `sessionElapsed`
- Remove: `controls.horizonY` — horizon is painted, not procedural
- **Save file migration:** `loadProject()` currently does `sceneStore.set(header.scene)` which spreads old fields into live state. Add a migration function that strips stale v2 fields (`velvet`, `echo`, `lights`, `anchor`, `sunAngle`, `sunElevation`, `horizonY`) before applying to store, and maps old fields to new equivalents where applicable
- Update `src/export/scene-io.ts` for new format

**Files touched:** ~8 files new/modified
**Verification:** App renders sky from mood-derived atmosphere. Surface presets have absorption/drySpeed values (unused yet).

---

## Phase 2: Session Flow (Prepare / Test / Paint)

**Goal:** Three-phase UX flow. Mood selection → test canvas → permanent painting.

### 2.1 Phase State Machine
- New file: `src/session/session-state.ts`
- Phase enum: `'prepare-mood' | 'prepare-surface' | 'test' | 'paint'`
- Transitions: mood → surface → test → paint (forward only from paint)
- Back navigation: test → surface → mood (allowed during test)

### 2.2 Mood Selection UI
- New component: `src/controls/mood-selector.ts`
- Full-screen card layout
- Each card shows: sky gradient preview, 15 pile colors, name, description
- Tap card = preview (background becomes that mood's atmosphere)
- Confirm = advance to surface selection
- Mobile-first: swipeable cards

### 2.3 Surface Selection UI
- Reuse/adapt `src/controls/surface-pad.ts`
- Show 5 preset buttons (board, canvas, paper, smooth, woodblock)
- Background shows grain texture preview
- Default surface per mood (from mood data)
- Confirm = advance to test canvas

### 2.4 Preparation Confirmation Screen
- Show: "{MOOD} on {SURFACE}" with sky gradient and 15 piles
- Button: "TEST CANVAS" → advance to Phase 2

### 2.5 Test Canvas Mode
- Same rendering pipeline, flagged as test mode
- All tools available: FRM, SCRP, WIPE
- All controls available: THINNERS, LOAD, brush sizes, brush ages
- Back buttons: return to mood selection, return to surface selection
- "START PAINTING" button at bottom center

### 2.6 Start Painting Transition
- Confirmation dialog: "Ready to paint? The test canvas will be cleared. Every mark from here is permanent."
- On confirm:
  - Destroy test canvas (clear accumulation texture)
  - Clear paint state texture
  - Set phase = 'paint'
  - Record `sessionStartTime = Date.now()`
  - Randomize bristle seeds per brush slot
  - Lock mood and surface (no changes allowed)

### 2.7 New Painting Flow
- "NEW PAINTING" button (menu or keyboard shortcut)
- Confirmation: "Start a new painting? The current canvas will be destroyed."
- On confirm: reset everything, return to Phase 1

### 2.8 Session Timer
- `src/session/session-timer.ts`
- Track elapsed time excluding tab-hidden periods
- `document.visibilitychange` listener to pause/resume
- `getSessionTime(): number` returns seconds elapsed
- Pass to shaders as `session_time` uniform

**Files touched:** ~6 new files, ~5 modified
**Verification:** Full flow works: select mood → select surface → test canvas → start painting → clean canvas. New painting returns to mood selection. Session timer ticks.

---

## Phase 3: 15-Pile Palette, Rag & Controls Rework

**Goal:** Replace 5-swatch tonal columns with 15 discrete piles, add rag, rework controls.

### 3.1 15-Pile Palette Panel
- Rewrite `src/controls/palette-panel.ts`
- 5×3 grid of tappable pile swatches (~24×24px each)
- Tap pile = dip brush (set active color, reload reservoir at LOAD value)
- Active pile has bright border
- Show contaminated color as small dot inside active pile
- Piles come from current mood (locked in paint phase)

### 3.2 Rag UI Element
- Add rag to palette panel (textured rectangle below the 5×3 grid)
- Tap rag = wipe brush (reduce residue to 15%, reservoir to 15%)
- Visual stain accumulation: each wipe adds a faint mark to the rag texture
  - `RagStain { color, position, opacity, size }`
  - Canvas 2D overlay or small dedicated texture
- Keyboard: X = wipe on rag

### 3.3 Brush Contamination — 5 Slots
- Each brush size slot carries: `residue_K`, `residue_amount`, `age`, `bristleSeed`
- Switching brush sizes = picking up a different physical brush with its own state
- Dipping: new color mixes with residue → `active_K = mix(pile_K, residue_K, residue_amount)`
- Rag wipe: `residue_amount *= 0.15`
- Store contamination per slot in session state

### 3.4 THINNERS Slider (replaces VELVET)
- Rename velvet → thinners throughout state, shaders, UI
- Semantics: 0 = thick paint (hard edge, opaque, sits on top) → 1 = thin paint (soft edge, translucent, flows)
- Update `src/controls/velvet-slider.ts` → rename to `src/controls/thinners-slider.ts`
- **Range labels:**
  - 0.00 = Pure pigment (tube paint, hard edges, opaque, buries grain)
  - 0.25 = Studio consistency (default — slightly translucent, slight softness)
  - 0.50 = Working thin (noticeably translucent, soft edges, grain visible)
  - 0.75 = Wash (near-glaze, dissolving edges, surface dominates)
  - 1.00 = Pure medium (no pigment — wets surface for "oiling in")

### 3.5 Palette Engine Rewrite
- Update `src/painting/palette.ts`: `getActiveKS()` currently reads from `sceneStore.get().palette` (5 colors with tonal columns). Rewrite to read from the 15-pile mood system and factor in per-slot brush contamination (residue mixing from 3.3)
- The palette engine becomes: `active_K = mix(pile_K, slot.residue_K, slot.residue_amount)`

### 3.6 Clarify baseOpacity / falloff
- Current brush shader chain: `effective_alpha = alpha * params.base_opacity * pow(params.falloff, layers) * params.reservoir`
- Thinners adds `pigment_density` which modulates deposit amount
- **Decision:** `baseOpacity` is subsumed by `pigment_density` from thinners — remove `baseOpacity` from scene state and brush params. `falloff` (per-stroke diminishing returns) remains — it controls how subsequent dabs in a single stroke fade, which is independent of paint consistency
- The new chain: `effective_alpha = alpha * pigment_density * pow(params.falloff, layers) * params.reservoir`
- This avoids a 5-way multiplication producing unexpectedly faint marks

### 3.7 THINNERS in Brush Shader — Core Behaviors
All of these go into `brush.wgsl` during this phase:

**3.5a Pigment density (transparency):**
```wgsl
let pigment_density = 1.0 - params.thinners * 0.85;
// thinners 0.0 → density 1.0 (full pigment)
// thinners 0.5 → density 0.575 (half)
// thinners 1.0 → density 0.15 (almost no pigment)
let deposit_K = input_K * effective_alpha * pigment_density;
```

**3.5b Edge softness & spread:**
```wgsl
let spread = 1.0 + params.thinners * 0.4;
let effective_radius = params.radius * spread;
let edge_softness = params.radius * params.thinners * 0.5;
let alpha = 1.0 - smoothstep(effective_radius - edge_softness, effective_radius, dist);
```

**3.5c Grain-aware deposition:**
Thin paint catches on grain peaks, misses valleys — texture baked into paint layer itself:
```wgsl
let grain = textureSample(grain_lut, grain_sampler, grain_uv).r;
let grain_interaction = mix(1.0, grain, params.thinners * 0.5);
// thick: deposits everywhere equally. thin: peaks only.
let final_deposit = deposit_K * grain_interaction;
```

**3.5d Pure medium mode (thinners > 0.9) — DEFERRED to Phase 6:**
The full "oiling in" technique requires the paint state texture (Phase 6). In Phase 3, thinners > 0.9 simply deposits near-zero pigment via the pigment_density formula (density = 0.15 at thinners 1.0). The special behavior of wetting the surface without depositing pigment is added in Phase 6 when the paint state texture exists.

For Phase 3, this is adequate — the mark is barely visible at thinners 1.0 anyway. Phase 6 adds the physics that makes the next stroke blend more over the wetted area.

### 3.8 Velvet → Thinners Rename in Scrape/Wipe Engines
- `src/painting/scrape-engine.ts` (line 155): `softness = scene.velvet * radius` → use `scene.thinners`
- `src/painting/wipe-engine.ts` (line 137): `softness = scene.velvet * radius` → use `scene.thinners`
- Both engines read velvet for softness calculations — this rename must happen in Phase 3 when velvet is removed from scene state, not deferred to Phase 6

### 3.9 LOAD × THINNERS Interaction
- Effective pigment per dab = LOAD × pigment_density × reservoir
- Same LOAD, different THINNERS → completely different deposits:
  - LOAD 0.5, THINNERS 0.0: 50% × 100% = 0.50 effective
  - LOAD 0.5, THINNERS 0.5: 50% × 57.5% = 0.29 effective
  - LOAD 0.5, THINNERS 1.0: 50% × 15% = 0.075 effective
- THINNERS is the master consistency control. LOAD is how much of that consistency you pick up.

### 3.10 LOAD Slider
- Keep existing `src/controls/load-slider.ts`
- Reservoir reloads to LOAD value on pile tap
- Depletion curve unchanged

### 3.11 Removed Controls Cleanup
- Verify all removed controls (ECHO, VELVET→renamed, TIME, ATMOSPHERE, DRIFT, ANCHOR) are fully gone from the UI and app wiring

**Files touched:** ~6 files modified/rewritten, ~2 new
**Verification:**
- 15 piles display per mood. Tap pile loads color. Tap rag wipes
- Brush contamination persists per slot
- THINNERS 0.0: hard edge, opaque, grain buried
- THINNERS 0.5: soft edge, translucent, grain visible through paint AND in paint texture
- THINNERS 1.0: no visible deposit, but surface becomes "wet" for next stroke
- Same LOAD at different THINNERS: visibly different deposit amounts

---

## Phase 4: Brush Bristle Physics

**Goal:** Brushes have bristles that respond to age. Each brush slot has age set in preparation.

### 4.1 BrushParams Struct — Define Final Shape Up Front
**To avoid 5 rounds of struct resizing and WGSL alignment bugs across Phases 3-7, define the complete final struct now with placeholder/default values for fields coming in later phases:**
```wgsl
struct BrushParams {
  center: vec2f,          // existing
  radius: f32,            // existing
  thinners: f32,          // Phase 3 (replaces softness)
  palette_K: vec3f,       // existing
  pigment_density: f32,   // Phase 3 (replaces base_opacity)
  falloff: f32,           // existing
  reservoir: f32,         // existing
  age: f32,               // Phase 4 (default 0.0 = new brush)
  bristle_seed: f32,      // Phase 4 (default 0.0)
  surface_absorption: f32,// Phase 5 (default 0.0)
  session_time: f32,      // Phase 6 (default 0.0)
  surface_dry_speed: f32, // Phase 6 (default 1.0)
  _pad: f32,              // alignment padding
}
```
- Update `PARAM_SIZE` in `src/painting/brush-engine.ts` once to match final struct size
- Fill `Float32Array` packing for all fields, defaulting future-phase fields to 0.0 or 1.0
- Each subsequent phase just writes real values into already-allocated slots — no struct resizing
- Update bind group layout once

### 4.2 Bristle Pattern in brush.wgsl
- Replace smooth `smoothstep` circle with bristle-aware kernel:
  - **Splay:** `effective_radius = radius * (1.0 + age * 0.3)`
  - **Edge noise:** simplex noise on angle × seed → `edge_roughness = noise * age * 0.15`
  - **Radial streaks:** `sin(angle * bristle_count + seed * 6.28)` where count = mix(5, 14, age)
  - Streaks deeper at outer edge: `edge_emphasis = smoothstep(0.3, 0.9, radial_pos)`
  - Final: `alpha * bristle_pattern`
- Thinners interaction: edge_softness and spread from Phase 3

### 4.3 Verify Regression — Age 0 = Current Behavior
- Age 0: splay=1, edge_roughness=0, bristle_pattern=1 → smooth circle
- Must produce identical output to pre-bristle brush
- Side-by-side screenshot comparison

### 4.4 Bristle Seed Per Session
- Each brush slot gets `Math.random()` seed at session start (Phase 2 → Phase 3 transition)
- Seed stored in session state, passed to shader

### 4.5 Brush Age Selector UI (Preparation Phase)
- In test canvas phase, show per-slot age selector: 3 dots (NEW / WORN / OLD)
- Defaults from doc: Detail=NEW, Small=WORN, Medium=WORN, Large=OLD, Wash=OLD
- Tap to select. Locked after START PAINTING
- Could be integrated into palette panel or as separate prep UI element

### 4.6 Bristle × Thinners Interaction
The four corners of mark-making (age × thinners):
```
           Thick (0.0)                Thin (1.0)
New (0.0)  Clean, hard, precise       Clean, soft, translucent
           → telephone poles           → smooth wash
Old (1.0)  Streaky, hard, textured    Streaky, soft, broken
           → textured impasto          → atmospheric whisper
```
- Old brush + thin paint: splay spreads thin paint wide, streaks create channels
  where thin paint flows, irregular edge amplified by paint spreading → broken, airy wash
- New brush + thick paint: tight bristles hold thick paint precisely, no splay,
  hard edges from both bristle tightness and paint thickness → clean, solid stroke
- This emerges naturally from bristle physics (Phase 4) + thinners physics (Phase 3)
  interacting in the same shader — no special interaction code needed

### 4.7 Bristle + Scrape Interaction
- Scrape mark character influenced by brush bristle texture (optional refinement)
- Old brush creates more irregular scrape marks

**Files touched:** ~4 files modified, ~1 new UI component
**Verification:**
- NEW brush (age 0): smooth circle, identical to current → regression passes
- WORN brush (age 0.5): 15% wider, subtle edge streaks
- OLD brush (age 1.0): 30% wider, strong radial bristle tracks, broken edge
- Different sessions produce different streak patterns (different seeds)
- OLD + THINNERS 0.7: wide broken atmospheric wash (the Beckett sky mark)
- NEW + THINNERS 0.0: tight precise opaque stroke (the Beckett figure mark)

---

## Phase 5: Surface Absorption

**Goal:** Surfaces absorb paint. First stroke is thinner. Scraping reveals deep stain. Heavy paint fills grain.

### 5.1 Absorption in Brush Shader
- In `brush.wgsl`:
  ```wgsl
  let bare_surface = 1.0 - saturate(existing_weight * 3.0);
  // Thinners increases absorption — thin medium soaks into raw surface
  let thinners_absorption = params.surface_absorption * (1.0 + params.thinners);
  // thinners 0.0: normal absorption
  // thinners 1.0: double absorption — the medium soaks in
  let absorbed = effective_alpha * thinners_absorption * bare_surface;
  let deposited = effective_alpha - absorbed;
  ```
- Use `deposited` instead of `effective_alpha` for K-M mixing
- Second stroke over painted area: `bare_surface ≈ 0` → no absorption → full deposit
- Thin paint on raw board stains deeply — medium carries pigment into wood fibers

### 5.2 Deep Stain from Absorption
- Absorbed paint leaves a color stain deeper than ghost retention
- Even aggressive scraping reveals absorbed stain, not bare surface
- Implement as a floor on the K value: `absorbed_stain = input_K * absorbed * 0.5`
- This stain persists after scrape — scrape ghost (15%) + absorbed stain

### 5.3 Surface Fill — Grain Modification
- In `composite.wgsl`:
  ```wgsl
  let grain_fill = saturate(paint_weight * 2.0);
  let effective_grain = grain_value * (1.0 - grain_fill * 0.7);
  ```
- Light wash: full grain visible
- Heavy paint: grain 70% filled — only deep valleys show
- This is a compositor change, not a brush shader change

### 5.4 Absorption × Surface Presets
- Board (0.15): moderate absorption, wood stain
- Canvas (0.10): low absorption, paint on peaks
- Paper (0.25): high absorption, deep stain, matte
- Smooth (0.05): minimal absorption, paint sits wet
- Woodblock (0.20): moderate-high absorption

**Files touched:** ~3 files modified (brush.wgsl, composite.wgsl, brush-engine.ts)
**Verification:**
- First stroke on Board is slightly thinner than on Smooth (side-by-side)
- Second stroke over first: full deposit (surface sealed)
- Scrape on Board: deep stain remains. Scrape on Smooth: closer to bare
- 5 heavy strokes: grain mostly hidden. 1 light wash: grain fully visible

---

## Phase 6: Paint Drying

**Goal:** Paint dries over real minutes. Wet paint mixes. Dry paint overlays. Scrape/wipe effectiveness changes.

### 6.1 Paint State Texture
- New `rg32float` texture at canvas resolution (same as accumulation)
  - R = session-relative seconds when pixel was last painted
  - G = thinners value at time of painting
- Ping-ponged alongside accumulation texture
- Managed in `src/painting/surface.ts` — create, resize, swap alongside accum
- **Resize preservation:** `resizeSurface()` already has complex logic to copy accum texture to temp before realloc and restore overlapping region. The paint state texture needs the same preservation logic — copy to temp, realloc, restore. Otherwise a browser resize destroys all drying state.
- ~16.6MB at 1920×1080

### 6.2 Wetness Calculation (Shared WGSL)
- New include: `src/shaders/common/wetness.wgsl` (or inline in each shader)
  ```wgsl
  fn calculate_wetness(paint_time: f32, current_time: f32, dry_speed: f32) -> f32
  ```
- Curve: 0-180s (wet) → 180-600s (tacky) → 600-1800s (set) → 1800s+ (dry)
- **Thinners accelerates drying** — turpentine evaporates fast:
  ```wgsl
  let thinners_dry_boost = 1.0 + paint_thinners_at_paint_time * 2.0;
  // thinners 0.0 at paint time → normal drying (1x)
  // thinners 0.5 → 2x faster (tacky at ~1.5 min instead of 3)
  // thinners 1.0 → 3x faster (tacky in ~1 min)
  let adjusted_age = age_seconds * surface_dry_speed * thinners_dry_boost;
  ```
- This reads `paint_thinners` from paint state G channel — the thinners value when
  that pixel was painted, NOT the current slider position. A thin wash stays a thin
  wash even if you crank thinners to 0 afterward.

### 6.3 Pure Medium Mode — "Oiling In" (deferred from Phase 3)
Now that the paint state texture exists, implement the full oiling-in behavior:
```wgsl
if (params.thinners > 0.9) {
  // Write timestamp to paint state (surface is now "wet")
  // Keep existing K and weight unchanged
  // Next stroke over this wet area will blend more
  textureStore(state_tex_write, gid.xy, vec4f(params.session_time, 1.0, 0.0, 0.0));
  textureStore(accum_write, gid.xy, existing);
  return;
}
```
Previously (Phase 3) this range just deposited near-zero pigment. Now it actively wets the surface, enabling the blending boost when painting into oiled areas.

### 6.4 Brush Shader — Wetness Modulates Blending
- Read paint state texture for existing paint's timestamp + thinners
- Calculate wetness of existing paint
- **Wet (>0.5):** Full K-M mixing — `blend = effective_alpha * wetness`
- **Tacky (0.1-0.5):** Partial mix + partial overlay
- **Dry (<0.1):** Pure overlay — `result = existing * (1-alpha) + new * alpha`
- Write current session_time + current thinners to paint state on every dab

### 6.5 Scrape Shader — Wetness + Thinners Modulate Effectiveness
- Read paint state, calculate wetness (includes thinners-accelerated drying)
- `scrape_power = mix(0.3, 1.0, wetness)` — wet=full, dry=30%
- **Thinners reduces scrapability** — thin paint has nothing to catch:
  ```wgsl
  let paint_thickness = existing_weight * (1.0 - paint_thinners * 0.5);
  let scrape_effectiveness = smoothstep(0.05, 0.3, paint_thickness) * scrape_power;
  // Thick paint: full scrape, knife catches, leaves ridges
  // Thin paint: knife slides over — nothing to remove
  ```
- Blade ridges scale with thickness: thick paint → visible ridges, thin paint → no ridges
- Update `src/shaders/brush/scrape.wgsl`
- **Pipeline layout change:** `src/painting/scrape-engine.ts` currently has 3 bind groups (params, accum ping-pong, grain). Add a 4th bind group for the paint state texture read. Update pipeline layout creation and dispatch code.

### 6.6 Wipe Shader — Wetness + Thinners Modulate Effectiveness
- Read paint state, calculate wetness (includes thinners-accelerated drying)
- **Thinners boosts wipe on wet paint** — thin wet paint lifts easily:
  ```wgsl
  let thin_lift_bonus = paint_thinners * 0.5;
  let wipe_effectiveness = (base_wipe + thin_lift_bonus) * wetness_factor;
  // Thin wet paint: very easy to wipe (bonus from thinners)
  // Thick wet paint: harder to wipe (no bonus)
  // Thin dry paint: can't wipe (wetness_factor kills it regardless)
  ```
- Update `src/shaders/brush/wipe.wgsl`
- **Pipeline layout change:** `src/painting/wipe-engine.ts` — same as scrape, add 4th bind group for paint state texture read.

### 6.7 Compositor — Visual Drying
- In `composite.wgsl` after paint-over-sky blend:
  - Wet sheen: `color = mix(color, color * 1.08, wetness * 0.04)`
  - Dry matte: slight desaturation `mix(color, vec3(grey), (1-wetness) * 0.025)`
- Requires reading paint state texture in compositor (add to bind group)

### 6.8 Paint State Persistence
- Write paint state alongside accum in every brush/scrape/wipe dispatch
- For brush: `result_time = select(old_time, session_time, alpha > 0.01)`
- For scrape/wipe: partially reset time toward current time? Or keep original? Design says keep original — scraping doesn't make paint "fresh"
- Save paint state in .ghz v4 format

### 6.9 Pause Handling
- In session timer (Phase 2.8): `visibilitychange` pauses elapsed time
- Leaving tab for 10 min doesn't advance drying — only active painting time counts

**Files touched:** ~8 files modified/new
**Verification:**
- Fresh paint (0-3 min): full K-M mixing, scrape lifts cleanly, wipe removes easily
- Tacky paint (3-10 min): partial mixing, scrape effective but smears, wipe harder
- Set paint (10-30 min): mostly overlay, scrape at 30-50%, wipe barely works
- Dry paint (30+ min): full overlay, scrape at 30%, wipe at 5%
- Paper dries faster than Smooth (surface-dependent)
- Tab hidden → drying pauses → tab shown → resumes from where it was

---

## Phase 7: Emergent Color Pickup

**Goal:** Replace ECHO slider with physics-based pickup. No new control — emerges from existing variables.

### 7.1 Pickup Formula in Brush Shader
- Four variables, all already computed by earlier phases — just multiply them:
  ```wgsl
  let surface_wetness = wetness;       // Phase 6: from paint state texture
  let brush_wetness = params.reservoir; // existing: current brush load
  let age_factor = params.age;          // Phase 4: old brushes drag more
  let fluidity = params.thinners;       // Phase 3: thin paint = more mixing

  let pickup = surface_wetness * brush_wetness
             * (0.3 + age_factor * 0.7)   // age 0→0.3, age 1→1.0
             * (0.2 + fluidity * 0.8);     // thinners 0→0.2, thinners 1→1.0
  ```
- **Thinners is the fluidity factor** — thin paint mixes readily with what's below.
  Thick paint sits on top even over wet surface. This is physically correct:
  thick impasto deposits pigment without disturbing what's beneath.
- Pickup modulates how much existing color mixes into the deposited color
- Maximum pickup scenario: wet old brush, thin paint, over fresh wet paint → ~0.5
- Zero pickup scenario: dry new brush, thick paint, over dry paint → ~0.0
- No slider. No parameter. Four physical variables that already exist.

### 7.2 Pickup Integration with K-M Blending
- The pickup amount blends existing K into the brush's active K
- This contamination feeds forward through subsequent dabs in the same stroke
- Effectively, the brush picks up surface color as you drag through wet paint

### 7.3 Remove ECHO References
- Verify all echo/ECHO references removed from state, shaders, UI
- No slider, no parameter — purely emergent

**Files touched:** ~2 files modified (brush.wgsl, brush-engine.ts)
**Verification:**
- Wet loaded old brush with thin paint over fresh paint: visible color pickup
- Dry new brush with thick paint over dry paint: no pickup
- Dragging through multiple wet colors: brush progressively contaminated

---

## Phase 8: Custom Moods & Polish

**Goal:** User-created moods, photo extraction, final polish.

### 8.1 OKLCH Custom Mood Picker
- New component: `src/controls/mood-creator.ts`
- Pick 5 base hues via OKLCH color picker (70% saturation cap)
- Auto-generate light (mix toward warm white), medium (as-is), dark (saturated dark)
- Auto-derive sky gradient (zenith=coolest light, horizon=warmest light)
- Set density slider (0-1)
- Name and save

### 8.2 Photo Extraction
- New file: `src/mood/photo-extract.ts`
- Web Worker with K-means clustering (5 clusters)
- Drop photo → extract 5 dominant hues → generate full mood
- Density estimated from photo contrast

### 8.3 Export-to-Mood
- Drop a GHH export PNG → extract 5 hues → generate mood
- Same K-means pipeline as photo extraction

### 8.4 Mood Save/Load
- LocalStorage or IndexedDB for custom moods
- Appear alongside presets in mood selection

### 8.5 .ghz v4 Format
- Final session format with all new state (paint state texture, brush ages, mood, absorption, drySpeed)
- Migration from v3 if needed
- Test save/load/resume

### 8.6 Final Polish
- Rag visual: ensure stain texture looks good at end-of-session
- Brush age selector UX polish
- Transition animations between phases
- Mobile/touch optimization for 15-pile grid
- Performance profiling (paint state texture read/write overhead)

**Files touched:** ~5 new files, ~3 modified
**Verification:** Custom mood creation works. Photo drop extracts reasonable palette. Save/resume preserves all state including drying times.

---

## Phase Dependency Graph

```
Phase 0 (Strip)
    ↓
Phase 1 (Moods)  ←── must exist before phase 2 can select them
    ↓
Phase 2 (Flow)   ←── needs moods + surfaces + session timer
    ↓
Phase 3 (Palette) ←── needs 15 piles from moods, needs flow for test/paint phases
    ↓
Phase 4 (Bristles) ←── needs brush slots from phase 3, age selector needs prep phase from phase 2
    ↓
Phase 5 (Absorption) ←── needs surface presets from phase 1, modifies brush shader
    ↓
Phase 6 (Drying) ←── needs session timer from phase 2, modifies brush/scrape/wipe shaders
    ↓
Phase 7 (Pickup) ←── needs drying (wetness) from phase 6, needs age from phase 4
    ↓
Phase 8 (Custom Moods) ←── needs mood system from phase 1, purely additive
```

Phases 4, 5, 6 modify different parts of the brush shader and could theoretically be parallelized, but ordering them sequentially avoids merge conflicts in brush.wgsl and lets each phase build on tested foundations.

---

## Critical Files (Most Modified)

| File | Phases | Changes |
|------|--------|---------|
| `src/shaders/brush/brush.wgsl` | 3, 4, 5, 6, 7 | Thinners (density/spread/grain/medium), bristles, absorption, drying, pickup |
| `src/shaders/brush/scrape.wgsl` | 3, 6 | Velvet→thinners rename, drying + thinners modulate effectiveness & ridges |
| `src/shaders/brush/wipe.wgsl` | 3, 6 | Velvet→thinners rename, drying + thinners modulate effectiveness |
| `src/shaders/composite/composite.wgsl` | 0, 5, 6 | Strip stages, grain fill, visual drying |
| `src/painting/brush-engine.ts` | 3, 4, 5, 6, 7 | Final BrushParams struct, contamination, state tex |
| `src/painting/scrape-engine.ts` | 3, 6 | Velvet→thinners rename, paint state texture bind group |
| `src/painting/wipe-engine.ts` | 3, 6 | Velvet→thinners rename, paint state texture bind group |
| `src/painting/palette.ts` | 3 | Rewrite for 15-pile system + contamination |
| `src/painting/surface.ts` | 6 | Paint state texture ping-pong + resize preservation |
| `src/app.ts` | 0, 2, 3 | Remove systems, gestures, session flow, palette |
| `src/state/scene-state.ts` | 0, 1, 2, 3 | Stripped + rebuilt (remove baseOpacity, velvet, echo) |
| `src/state/dirty-flags.ts` | 0 | Remove light flag and cascades |
| `src/controls/palette-panel.ts` | 3 | Full rewrite (15 piles + rag) |
| `src/controls/canvas-overlay.ts` | 0 | Remove deleted tool cursors |
| `src/compositor/compositor.ts` | 0, 6 | Remove light bind groups, add paint state texture |
| `src/export/scene-io.ts` | 1, 6, 8 | v4 format, migration from v2, paint state |
| `index.html` | 0, 2, 3 | Remove deleted elements, add new ones |

---

## New Files

| File | Phase | Purpose |
|------|-------|---------|
| `src/mood/moods.ts` | 1 | 7 preset moods, Mood interface |
| `src/mood/derive-atmosphere.ts` | 1 | Sky gradient from palette |
| `src/mood/photo-extract.ts` | 8 | K-means color extraction |
| `src/session/session-state.ts` | 2 | Phase state machine |
| `src/session/session-timer.ts` | 2 | Elapsed time with pause handling |
| `src/controls/mood-selector.ts` | 2 | Full-screen mood cards |
| `src/controls/mood-creator.ts` | 8 | OKLCH custom mood picker |
| `src/controls/thinners-slider.ts` | 3 | Renamed from velvet |
| `src/shaders/common/wetness.wgsl` | 6 | Shared wetness calculation |

---

## Deleted Files

| File | Phase | Reason |
|------|-------|--------|
| `src/painting/undo.ts` | 0 | Every mark permanent |
| `src/light/light-layer.ts` | 0 | Light is paint |
| `src/shaders/light/light-scatter.wgsl` | 0 | Light is paint |
| `src/shaders/light/bloom.wgsl` | 0 | Light is paint |
| `src/controls/light-wells.ts` | 0 | Light is paint |
| `src/controls/atmosphere-orb.ts` | 0 | Mood sets atmosphere |
| `src/controls/time-dial.ts` | 0 | Mood sets time |
| `src/controls/velvet-slider.ts` | 0 | Replaced by thinners |
| `src/controls/echo-slider.ts` | 0 | Replaced by physics |
| `src/controls/drift-field.ts` | 0 | Paintings don't animate |
| `src/controls/anchor-control.ts` | 0 | Chroma focus is a filter |
| `src/controls/horizon-control.ts` | 0 | You want a horizon, you paint it |
| `src/shaders/ui/orb.wgsl` | 0 | No atmosphere orb |
| `src/shaders/ui/dial.wgsl` | 0 | No time dial |

---

## GPU Memory Budget

| Texture | Format | Size @1920×1080 | Phase |
|---------|--------|-----------------|-------|
| Accumulation (existing) | rgba16float | ~16.6 MB | — |
| Paint state (new) | rg32float | ~16.6 MB | 6 |
| Undo snapshots (removed) | rgba16float × 30 | **-498 MB** | 0 |
| Light + bloom (removed) | rgba16float + rgba8 | **-~20 MB** | 0 |
| **Net change** | | **~-500 MB** | |

The app gets dramatically lighter on GPU memory despite adding a new texture.

---

## Build Order Summary

| Phase | Name | Scope | Builds On |
|-------|------|-------|-----------|
| 0 | Strip & Simplify | Remove undo, lights (atomic with compositor), 5 tools, 6 controls, simplify compositor | — |
| 1 | Mood System | 7 moods, atmosphere derivation, surface presets | 0 |
| 2 | Session Flow | Prepare/Test/Paint phases, session timer | 1 |
| 3 | Palette & Controls | 15 piles, rag, contamination, thinners | 2 |
| 4 | Bristle Physics | Brush age, splay, streaks, edge noise | 3 |
| 5 | Surface Absorption | First-stroke absorption, deep stain, grain fill | 1 |
| 6 | Paint Drying | State texture, wetness curve, blend modes, scrape/wipe | 2 |
| 7 | Emergent Pickup | Physics-based color pickup, no slider | 4, 6 |
| 8 | Custom Moods & Polish | OKLCH picker, photo extract, .ghz v4, polish | 1 |

---

## THINNERS Interaction Map

Thinners touches every phase. This is the single reference for how paint consistency
propagates through the system. Each row maps to the phase where it's implemented.

| System | Thinners LOW (thick, 0.0) | Thinners HIGH (thin, 1.0) | Phase |
|--------|---------------------------|---------------------------|-------|
| **Deposit** | Strong, opaque (density 1.0) | Weak, translucent (density 0.15) | 3 |
| **Edges** | Hard — paint stops where brush stops | Soft — feathers 40% beyond brush | 3 |
| **Grain deposition** | Even coverage (ignores grain) | Peaks only (grain baked into paint) | 3 |
| **Pure medium** | N/A | >0.9: wets surface without pigment ("oiling in") | 3 |
| **LOAD interaction** | LOAD × 1.0 = full pigment | LOAD × 0.15 = barely any pigment | 3 |
| **Bristle × thinners** | Tight hard precise (with new brush) | Wide broken atmospheric (with old brush) | 4 |
| **Absorption** | Normal (1×) | Double (2×) — medium soaks into surface | 5 |
| **Drying speed** | Slow (1×, tacky at 3 min) | Fast (3×, tacky at 1 min) | 6 |
| **Scrape** | Strong resistance, ridges | Knife slides over — nothing to catch | 6 |
| **Wipe (wet)** | Resists — rag can only thin it | Lifts almost completely | 6 |
| **Color pickup** | Low fluidity (0.2× factor) | High fluidity (1.0× factor) | 7 |
| **Visual** | Flat, solid, heavy | Textured, translucent, airy | 3,6 |
| **Multiple passes** | Each pass strong, quick buildup | Each pass light, slow buildup, glazing | 3 |

### The Painting Rhythm (Verification Scenario)

This sequence tests the full thinners integration across all phases:

```
1. THINNERS 0.6, LOAD 0.7, old large brush
   → Dip sky color LIGHT pile
   → Paint broad sky wash — thin, translucent, grain visible, bristle streaks
   → Board absorbs extra (1.6× absorption), deep stain
   → This wash will be tacky in ~1.5 min (3× drying from 0.6 thinners)

2. THINNERS 0.25, LOAD 0.5, worn medium brush
   → Tap rag. Dip grey MEDIUM pile
   → Paint ground — moderate opacity, some grain, slight softness
   → Where ground meets sky: wet-on-wet bleeding (sky still fresh)
   → Normal drying speed, tacky at ~2.5 min

3. THINNERS 0.05, LOAD 0.8, worn small brush
   → Tap rag. Dip dark pile
   → Paint figure — opaque, hard edge, confident mark
   → Sits ON TOP of now-tacky sky wash (sky painted 3 min ago, thin = fast dry)
   → Scrape a line through figure: thick paint resists, leaves ridges
   → Wipe the figure edge: thick paint resists wiping

4. THINNERS 0.8, LOAD 0.3, old wash brush
   → Tap rag. Dip warm LIGHT pile
   → One barely-there stroke near horizon — ghost mark
   → Grain fully visible through and IN the paint (peaks only)
   → Deep absorption stain (1.8× on board)
   → Will be dry in ~40 seconds (3× base + thin paint)
   → If you drag through wet area: maximum color pickup
     (thin paint, old brush, over fresh paint)
```

Four thinners settings. Four completely different marks. Each physically correct.
