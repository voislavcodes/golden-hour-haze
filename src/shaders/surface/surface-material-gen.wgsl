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
  grain_scale: f32,
  tone: f32,
  seed: f32,
  material: u32,
  color_light: vec3f,
  _pad0: f32,
  color_dark: vec3f,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> params: SurfaceGenParams;
@group(0) @binding(1) var height_out: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var color_out: texture_storage_2d<rgba8unorm, write>;

// Board — domain-warped horizontal grain with knots
fn generate_board(uv: vec2f) -> vec2f {
  let base_freq = mix(80.0, 25.0, params.grain_scale);

  // Primary warp — large-scale curves
  let warp1 = snoise2d(uv * vec2f(3.0, 0.5) + params.seed) * 0.4;
  // Secondary warp — smaller wobbles
  let warp2 = snoise2d(uv * vec2f(8.0, 1.5) + params.seed * 2.0) * 0.1;
  let warped_uv = uv + vec2f(0.0, warp1 + warp2);

  // Primary grain lines
  let grain = snoise2d(warped_uv * vec2f(2.0, base_freq));

  // Heartwood/sapwood variation — broad color bands
  let band = snoise2d(uv * vec2f(1.5, 0.3) + params.seed * 0.5) * 0.5 + 0.5;
  let color_var = (band - 0.5) * 0.15;

  // Occasional knots
  let knot_chance = snoise2d(uv * 4.0 + params.seed * 3.0);
  let knot = select(0.0, snoise2d(uv * 40.0) * 0.3, knot_chance > 0.85);

  let height = (grain * 0.7 + knot) * 0.5 + 0.5;
  return vec2f(height, color_var);
}

// Canvas — periodic woven thread pattern
fn generate_canvas(uv: vec2f) -> vec2f {
  let freq = mix(100.0, 40.0, params.grain_scale);

  // Warp and weft threads with wobble
  let wobble_x = snoise2d(uv * 3.0 + params.seed) * 0.02;
  let wobble_y = snoise2d(uv * 3.0 + params.seed + 100.0) * 0.02;
  let warp = sin((uv.x + wobble_x) * freq * 6.283);
  let weft = sin((uv.y + wobble_y) * freq * 6.283);

  // Crossings — where threads overlap creates texture
  let crossing = warp * weft;
  let thread_height = crossing * 0.5 + 0.5;

  // Slight random variation in thread thickness
  let variation = snoise2d(uv * freq * 0.5 + params.seed * 2.0) * 0.1;
  let color_var = variation;

  return vec2f(thread_height, color_var);
}

// Paper — isotropic multi-octave fbm
fn generate_paper(uv: vec2f) -> vec2f {
  let base_freq = mix(120.0, 30.0, params.grain_scale);
  let s = params.seed;

  var height = 0.0;
  height += snoise2d(uv * base_freq + s) * 0.5;
  height += snoise2d(uv * base_freq * 2.0 + s * 2.0) * 0.25;
  height += snoise2d(uv * base_freq * 4.0 + s * 3.0) * 0.125;
  height += snoise2d(uv * base_freq * 8.0 + s * 4.0) * 0.0625;

  // Soft shaping
  height = smoothstep(-0.6, 0.6, height);

  // Paper has very subtle color variation (fiber flecks)
  let fleck = snoise2d(uv * base_freq * 1.5 + s * 5.0) * 0.05;

  return vec2f(height, fleck);
}

// Gesso — subtle directional brush strokes + fine tooth
fn generate_gesso(uv: vec2f) -> vec2f {
  let base_freq = mix(80.0, 30.0, params.grain_scale);
  let s = params.seed;

  // Directional brush strokes (applied with a wide brush)
  let stroke_dir = snoise2d(uv * 2.0 + s) * 0.3;
  let stroke_uv = uv + vec2f(stroke_dir, 0.0);
  let strokes = snoise2d(stroke_uv * vec2f(base_freq * 0.3, base_freq)) * 0.4;

  // Fine tooth — high-frequency isotropic texture
  let tooth = snoise2d(uv * base_freq * 2.0 + s * 2.0) * 0.3;

  let height = (strokes + tooth) * 0.5 + 0.5;

  // Very subtle color variation from brush application
  let color_var = snoise2d(uv * base_freq * 0.2 + s * 3.0) * 0.03;

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
