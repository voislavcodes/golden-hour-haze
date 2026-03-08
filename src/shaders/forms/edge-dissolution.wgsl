// Perceptual edge dissolution
// High luminance contrast edges hold longer than low contrast edges
// Color edges dissolve before value edges

fn luminance_edge(color_inside: vec3f, color_outside: vec3f) -> f32 {
  let lum_in = dot(color_inside, vec3f(0.2126, 0.7152, 0.0722));
  let lum_out = dot(color_outside, vec3f(0.2126, 0.7152, 0.0722));
  return abs(lum_in - lum_out);
}

fn chromatic_edge(color_inside: vec3f, color_outside: vec3f) -> f32 {
  // Measure chromatic difference (color without luminance)
  let lum_in = dot(color_inside, vec3f(0.2126, 0.7152, 0.0722));
  let lum_out = dot(color_outside, vec3f(0.2126, 0.7152, 0.0722));
  let chroma_in = color_inside - vec3f(lum_in);
  let chroma_out = color_outside - vec3f(lum_out);
  return length(chroma_in - chroma_out);
}

fn perceptual_dissolution(
  sdf_dist: f32,
  depth: f32,
  base_softness: f32,
  form_color: vec3f,
  bg_color: vec3f,
  dissolution_mask: f32,
  noise: f32,
) -> f32 {
  // Luminance contrast at edge determines how much it holds
  let lum_contrast = luminance_edge(form_color, bg_color);
  let chrom_contrast = chromatic_edge(form_color, bg_color);

  // High value contrast = edge holds (small softness multiplier)
  // High chroma-only contrast = edge dissolves first
  let hold_factor = clamp(lum_contrast * 3.0, 0.0, 1.0);
  let dissolve_factor = clamp(chrom_contrast * 2.0 - lum_contrast, 0.0, 1.0);

  // Depth increases overall dissolution
  let depth_dissolution = depth * depth * 2.0;

  // Compute effective softness per-pixel around the edge
  let effective_softness = base_softness
    * (1.0 + depth_dissolution)
    * (1.0 - hold_factor * 0.7)   // high lum contrast holds edge
    * (1.0 + dissolve_factor * 0.5) // pure color edges dissolve faster
    * (1.0 + dissolution_mask * 3.0) // brush-painted dissolution
    + noise * 0.02;                  // subtle noise on edge

  // Non-uniform dissolution: not just smoothstep, but shaped by contrast
  let edge = 1.0 - smoothstep(0.0, effective_softness, sdf_dist);

  return edge;
}
