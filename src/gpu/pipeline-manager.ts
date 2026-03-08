const renderPipelines = new Map<string, GPURenderPipeline>();
const computePipelines = new Map<string, GPUComputePipeline>();

export function getRenderPipeline(key: string): GPURenderPipeline | undefined {
  return renderPipelines.get(key);
}

export function getComputePipeline(key: string): GPUComputePipeline | undefined {
  return computePipelines.get(key);
}

export function createRenderPipeline(
  key: string,
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor
): GPURenderPipeline {
  const existing = renderPipelines.get(key);
  if (existing) return existing;
  const pipeline = device.createRenderPipeline(descriptor);
  renderPipelines.set(key, pipeline);
  return pipeline;
}

export function createComputePipeline(
  key: string,
  device: GPUDevice,
  descriptor: GPUComputePipelineDescriptor
): GPUComputePipeline {
  const existing = computePipelines.get(key);
  if (existing) return existing;
  const pipeline = device.createComputePipeline(descriptor);
  computePipelines.set(key, pipeline);
  return pipeline;
}

export function clearPipelines() {
  renderPipelines.clear();
  computePipelines.clear();
}
