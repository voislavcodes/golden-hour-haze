import { getGPU } from './context.js';

export interface PingPongTexture {
  read: GPUTexture;
  write: GPUTexture;
  readView: GPUTextureView;
  writeView: GPUTextureView;
  swap(): void;
}

const textures = new Map<string, GPUTexture>();
const pingPongs = new Map<string, PingPongTexture>();

export function allocTexture(
  label: string,
  format: GPUTextureFormat,
  width: number,
  height: number,
  usage?: GPUTextureUsageFlags
): GPUTexture {
  const existing = textures.get(label);
  if (existing) {
    if (existing.width === width && existing.height === height) return existing;
    existing.destroy();
  }

  const { device } = getGPU();
  const tex = device.createTexture({
    label,
    size: { width, height },
    format,
    usage:
      usage ??
      (GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT),
  });
  textures.set(label, tex);
  return tex;
}

export function allocPingPong(
  label: string,
  format: GPUTextureFormat,
  width: number,
  height: number,
  usage?: GPUTextureUsageFlags
): PingPongTexture {
  const existing = pingPongs.get(label);
  if (existing && existing.read.width === width && existing.read.height === height) {
    return existing;
  }
  if (existing) {
    existing.read.destroy();
    existing.write.destroy();
  }

  const { device } = getGPU();
  const u =
    usage ??
    (GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT);

  let texA = device.createTexture({
    label: `${label}-A`,
    size: { width, height },
    format,
    usage: u,
  });
  let texB = device.createTexture({
    label: `${label}-B`,
    size: { width, height },
    format,
    usage: u,
  });

  const pp: PingPongTexture = {
    get read() { return texA; },
    get write() { return texB; },
    get readView() { return texA.createView(); },
    get writeView() { return texB.createView(); },
    swap() {
      [texA, texB] = [texB, texA];
    },
  };
  pingPongs.set(label, pp);
  return pp;
}

export function getTexture(label: string): GPUTexture | undefined {
  return textures.get(label);
}

export function destroyAll() {
  for (const t of textures.values()) t.destroy();
  textures.clear();
  for (const pp of pingPongs.values()) {
    pp.read.destroy();
    pp.write.destroy();
  }
  pingPongs.clear();
}

export function reallocAll(width: number, height: number) {
  for (const [label, tex] of textures) {
    const format = tex.format;
    const usage = tex.usage;
    tex.destroy();
    const { device } = getGPU();
    textures.set(
      label,
      device.createTexture({ label, size: { width, height }, format, usage })
    );
  }
  for (const [label, pp] of pingPongs) {
    const format = pp.read.format;
    const usage = pp.read.usage;
    pp.read.destroy();
    pp.write.destroy();
    // Re-create through allocPingPong
    pingPongs.delete(label);
    allocPingPong(label, format, width, height, usage);
  }
}
