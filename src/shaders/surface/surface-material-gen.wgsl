// Surface material generator — 512×512 height (r16float) + color (rgba8unorm)
// 4 material types: board, canvas, paper, gesso

fn mod289v3(x: vec3f) -> vec3f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v2(x: vec2f) -> vec2f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permuteV3(x: vec3f) -> vec3f { return mod289v3((x * 34.0 + 10.0) * x); }

fn snoise2d(v: vec2f) -> f32 {
  let C = vec4f(0.211324865405187, 0.366025403784439,
                -0.577350269189626, 0.024390243902439);
  var i = floor(v + dot(v, C.yy));
  let x0 = v - i + dot(i, C.xx);
  var i1: vec2f;
  if (x0.x > x0.y) { i1 = vec2f(1.0, 0.0); } else { i1 = vec2f(0.0, 1.0); }
  var x12 = vec4f(x0.x + C.x, x0.y + C.x, x0.x + C.z, x0.y + C.z);
  x12 = vec4f(x12.xy - i1, x12.zw);
  i = mod289v2(i);
  let p = permuteV3(permuteV3(vec3f(i.y, i.y + i1.y, i.y + 1.0)) +
                     vec3f(i.x, i.x + i1.x, i.x + 1.0));
  var m = max(vec3f(0.5) - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
  m = m * m; m = m * m;
  let x = 2.0 * fract(p * C.www) - 1.0;
  let h = abs(x) - 0.5;
  let ox = floor(x + 0.5);
  let a0 = x - ox;
  m *= vec3f(1.79284291400159) - 0.85373472095314 * (a0 * a0 + h * h);
  return 130.0 * dot(m, vec3f(a0.x * x0.x + h.x * x0.y,
                               a0.y * x12.x + h.y * x12.y,
                               a0.z * x12.z + h.z * x12.w));
}

struct SurfaceGenParams {
  grain_scale: f32,   // roughness (texture depth)
  tone: f32,
  seed: f32,
  material: u32,
  color_light: vec3f,
  grain_size: f32,    // 0-1, fine→coarse (narrow per-material range)
  color_dark: vec3f,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> params: SurfaceGenParams;
@group(0) @binding(1) var height_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var color_out: texture_storage_2d<rgba8unorm, write>;

// Board — domain-warped horizontal grain with knots
// grain_scale = roughness: sanded smooth (0) → raw wood grain (1)
// grain_size = frequency: tight grain (0) → wide grain (1), range 55→35
fn generate_board(uv: vec2f) -> vec2f {
  let rough = params.grain_scale;
  let base_freq = mix(55.0, 35.0, params.grain_size);

  // Primary warp — large-scale curves
  let warp1 = snoise2d(uv * vec2f(3.0, 0.5) + params.seed) * 0.4;
  let warp2 = snoise2d(uv * vec2f(8.0, 1.5) + params.seed * 2.0) * 0.1;
  let warped_uv = uv + vec2f(0.0, warp1 + warp2);

  // Primary grain lines
  let grain = snoise2d(warped_uv * vec2f(2.0, base_freq));

  // Heartwood/sapwood variation — broad color bands
  let band = snoise2d(uv * vec2f(1.5, 0.3) + params.seed * 0.5) * 0.5 + 0.5;
  let color_var = (band - 0.5) * mix(0.05, 0.18, rough);

  // Occasional knots — more visible at higher roughness
  let knot_chance = snoise2d(uv * 4.0 + params.seed * 3.0);
  let knot = select(0.0, snoise2d(uv * 40.0) * 0.3, knot_chance > 0.85);

  // Roughness scales grain depth
  let depth = mix(0.15, 0.7, rough);
  let height = (grain * depth + knot * rough) * 0.5 + 0.5;
  return vec2f(height, color_var);
}

// Fast hash for per-thread variation (no trig, pure ALU)
fn hash1(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453);
}

// Canvas — physically-based plain weave (Irawan & Marschner model)
// grain_scale = roughness: heavily gessoed/primed (0) → raw canvas (1)
// grain_size = thread density: fine weave (0, ~35 threads) → coarse weave (1, ~20 threads)
// Roughness controls weave depth, crimp height, and gap visibility.
fn generate_canvas(uv: vec2f) -> vec2f {
  let rough = params.grain_scale;
  let thread_count = mix(35.0, 20.0, params.grain_size);
  let s = params.seed;

  // Per-thread wobble — more irregular at higher roughness
  let wobble_amp = mix(0.001, 0.004, rough);
  let wobble = vec2f(
    snoise2d(uv * vec2f(2.0, thread_count * 0.12) + s) * wobble_amp,
    snoise2d(uv * vec2f(thread_count * 0.12, 2.0) + s + 73.0) * wobble_amp
  );
  let p = (uv + wobble) * thread_count;

  let cell = floor(p);
  let f = fract(p);
  let ix = i32(cell.x);
  let iy = i32(cell.y);

  // Per-thread thickness variation — more at higher roughness
  let thick_var = mix(0.04, 0.16, rough);
  let warp_thick = 1.0 + (hash1(cell.x * 7.31 + s) - 0.5) * thick_var;
  let weft_thick = 1.0 + (hash1(cell.y * 13.17 + s + 50.0) - 0.5) * thick_var;

  // Thread half-width: primed canvas fills gaps, raw canvas has open gaps
  let base_hw = mix(0.44, 0.33, rough);
  let warp_hw = base_hw * warp_thick;
  let weft_hw = base_hw * weft_thick;

  let dx = abs(f.x - 0.5);
  let dy = abs(f.y - 0.5);

  // Cross-section sharpness: primed = rounded soft, raw = sharp lenticular
  let sharpness = mix(1.2, 2.2, rough);
  let warp_t = clamp(dx / warp_hw, 0.0, 1.0);
  let weft_t = clamp(dy / weft_hw, 0.0, 1.0);
  let warp_profile = pow(max(0.0, cos(warp_t * 1.5707963)), sharpness);
  let weft_profile = pow(max(0.0, cos(weft_t * 1.5707963)), sharpness);

  let warp_on_top = ((ix + iy) & 1) == 0;

  // Crimp height scales with roughness: primed fills, raw weave undulates
  let crimp = mix(0.05, 0.22, rough);
  let warp_undulate = cos(f.y * 6.2831853) * crimp;
  let weft_undulate = cos(f.x * 6.2831853) * crimp;

  let base_h = 0.4;
  var h_warp: f32;
  var h_weft: f32;
  if (warp_on_top) {
    h_warp = warp_profile * (base_h + warp_undulate);
    h_weft = weft_profile * (base_h - weft_undulate);
  } else {
    h_warp = warp_profile * (base_h - warp_undulate);
    h_weft = weft_profile * (base_h + weft_undulate);
  }

  var height = max(h_warp, h_weft);

  // Micro-fiber noise — more visible on raw canvas
  let fiber = snoise2d(p * 10.0 + s * 3.0) * mix(0.01, 0.03, rough);
  height += fiber * step(0.05, height);

  // Normalize to 0-1: primed canvas is flatter (compressed range)
  let range = mix(0.3, 0.85, rough);
  height = saturate(height / (base_h + crimp) * range + (1.0 - range) * 0.5);

  // Color variation
  let is_warp = h_warp > h_weft;
  var color_var = select(-0.02, 0.02, is_warp) * rough;
  color_var += (hash1(cell.x * 3.71 + s * 2.0) - 0.5) * mix(0.01, 0.05, rough);
  color_var += (hash1(cell.y * 5.13 + s * 3.0) - 0.5) * mix(0.01, 0.05, rough);
  // Darker in gaps — more visible on raw canvas
  let gap_dark = mix(0.01, 0.08, rough);
  let in_gap = 1.0 - saturate(height * 4.0);
  color_var -= in_gap * gap_dark;

  return vec2f(height, color_var);
}

// Paper — isotropic multi-octave fbm
// grain_scale = roughness: hot-pressed smooth (0) → cold-pressed rough tooth (1)
// grain_size = fiber scale: fine tooth (0, freq 60) → coarse tooth (1, freq 35)
fn generate_paper(uv: vec2f) -> vec2f {
  let rough = params.grain_scale;
  let base_freq = mix(60.0, 35.0, params.grain_size);
  let s = params.seed;

  var height = 0.0;
  height += snoise2d(uv * base_freq + s) * 0.5;
  height += snoise2d(uv * base_freq * 2.0 + s * 2.0) * 0.3;
  height += snoise2d(uv * base_freq * 4.0 + s * 3.0) * 0.15;
  height += snoise2d(uv * base_freq * 8.0 + s * 4.0) * 0.08;

  // Roughness controls how the noise is shaped into tooth
  // Hot-pressed: very compressed, almost flat
  // Cold-pressed: full tooth depth, crisp peaks and valleys
  let shaping = mix(0.8, 0.4, rough);
  height = smoothstep(-shaping, shaping, height);

  // Roughness scales the final depth
  let depth = mix(0.15, 1.0, rough);
  height = mix(0.5, height, depth);

  // Fiber flecks — more visible on rougher paper
  let fleck = snoise2d(uv * base_freq * 1.5 + s * 5.0) * mix(0.02, 0.12, rough);
  let fiber = snoise2d(uv * base_freq * 0.3 + s * 6.0) * mix(0.01, 0.06, rough);

  return vec2f(height, fleck + fiber);
}

// Gesso — directional brush strokes + fine tooth
// grain_scale = roughness: sanded multi-coat (0) → single thick coat with marks (1)
// grain_size = stroke scale: fine marks (0, freq 45) → broad strokes (1, freq 25)
fn generate_gesso(uv: vec2f) -> vec2f {
  let rough = params.grain_scale;
  let base_freq = mix(45.0, 25.0, params.grain_size);
  let s = params.seed;

  // Directional brush strokes — more visible at higher roughness
  let stroke_dir = snoise2d(uv * 2.0 + s) * mix(0.1, 0.4, rough);
  let stroke_uv = uv + vec2f(stroke_dir, 0.0);
  let strokes = snoise2d(stroke_uv * vec2f(base_freq * 0.3, base_freq)) * mix(0.1, 0.5, rough);

  // Fine tooth — present at all roughness levels but scales
  let tooth = snoise2d(uv * base_freq * 2.5 + s * 2.0) * mix(0.08, 0.35, rough);

  let height = (strokes + tooth) * 0.5 + 0.5;

  // Color variation from uneven application thickness
  let color_var = snoise2d(uv * base_freq * 0.3 + s * 3.0) * mix(0.02, 0.08, rough)
                + strokes * mix(0.01, 0.04, rough);

  return vec2f(height, color_var);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(height_out);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2f(f32(dims.x), f32(dims.y));

  // Generate based on material type
  var result: vec2f;
  switch params.material {
    case 0u: { result = generate_board(uv); }
    case 1u: { result = generate_canvas(uv); }
    case 2u: { result = generate_paper(uv); }
    case 3u: { result = generate_gesso(uv); }
    default: { result = generate_board(uv); }
  }

  // Edge-blend 16px border for seamless tiling
  let border = 16.0 / f32(dims.x);
  let bx = smoothstep(0.0, border, uv.x) * smoothstep(0.0, border, 1.0 - uv.x);
  let by = smoothstep(0.0, border, uv.y) * smoothstep(0.0, border, 1.0 - uv.y);
  let blend = bx * by;

  // Offset sample for seamless tiling
  let offset_uv = fract(uv + 0.5);
  var result_offset: vec2f;
  switch params.material {
    case 0u: { result_offset = generate_board(offset_uv); }
    case 1u: { result_offset = generate_canvas(offset_uv); }
    case 2u: { result_offset = generate_paper(offset_uv); }
    case 3u: { result_offset = generate_gesso(offset_uv); }
    default: { result_offset = generate_board(offset_uv); }
  }

  let final_height = mix(result_offset.x, result.x, blend);
  let final_color_var = mix(result_offset.y, result.y, blend);

  // Height output
  textureStore(height_out, vec2i(gid.xy), vec4f(final_height, 0.0, 0.0, 0.0));

  // Color output — base color from tone lerp + per-pixel variation
  let base_color = mix(params.color_light, params.color_dark, params.tone);
  let color = clamp(base_color + vec3f(final_color_var), vec3f(0.0), vec3f(1.0));
  textureStore(color_out, vec2i(gid.xy), vec4f(color, 1.0));
}
