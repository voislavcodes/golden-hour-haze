// Dual Kawase bloom — fragment shader
// Used for both downsample and upsample passes

struct BloomParams {
  texel_size: vec2f,
  threshold: f32,
  pass_type: f32, // 0 = threshold, 1 = downsample, 2 = upsample
};

@group(0) @binding(0) var<uniform> params: BloomParams;
@group(0) @binding(1) var input_tex: texture_2d<f32>;
@group(0) @binding(2) var tex_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let x = f32(i32(vi) / 2) * 4.0 - 1.0;
  let y = f32(i32(vi) & 1) * 4.0 - 1.0;
  var out: VertexOutput;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let uv = in.uv;
  let ts = params.texel_size;

  if (params.pass_type < 0.5) {
    // Threshold pass
    let color = textureSample(input_tex, tex_sampler, uv);
    let brightness = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
    let contrib = max(brightness - params.threshold, 0.0);
    let soft = contrib * contrib / (contrib + 0.001);
    return vec4f(color.rgb * soft, 1.0);
  } else if (params.pass_type < 1.5) {
    // Dual Kawase downsample
    let c = textureSample(input_tex, tex_sampler, uv) * 4.0;
    let tl = textureSample(input_tex, tex_sampler, uv + vec2f(-ts.x, -ts.y));
    let tr = textureSample(input_tex, tex_sampler, uv + vec2f(ts.x, -ts.y));
    let bl = textureSample(input_tex, tex_sampler, uv + vec2f(-ts.x, ts.y));
    let br = textureSample(input_tex, tex_sampler, uv + vec2f(ts.x, ts.y));
    return (c + tl + tr + bl + br) / 8.0;
  } else {
    // Dual Kawase upsample
    let tl = textureSample(input_tex, tex_sampler, uv + vec2f(-ts.x, -ts.y) * 2.0);
    let t = textureSample(input_tex, tex_sampler, uv + vec2f(0.0, -ts.y) * 2.0);
    let tr = textureSample(input_tex, tex_sampler, uv + vec2f(ts.x, -ts.y) * 2.0);
    let l = textureSample(input_tex, tex_sampler, uv + vec2f(-ts.x, 0.0) * 2.0);
    let r = textureSample(input_tex, tex_sampler, uv + vec2f(ts.x, 0.0) * 2.0);
    let bl_ = textureSample(input_tex, tex_sampler, uv + vec2f(-ts.x, ts.y) * 2.0);
    let b = textureSample(input_tex, tex_sampler, uv + vec2f(0.0, ts.y) * 2.0);
    let br_ = textureSample(input_tex, tex_sampler, uv + vec2f(ts.x, ts.y) * 2.0);

    return (tl + tr + bl_ + br_) / 12.0 + (t + l + r + b) / 6.0;
  }
}
