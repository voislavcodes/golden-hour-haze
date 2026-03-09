// .ghz save/load — V2 project file format
// Saves accumulation texture (raw rgba16float) + scene state

import { getGPU } from '../gpu/context.js';
import { getReadTexture, getAccumPP, swapAccum, getSurfaceWidth, getSurfaceHeight } from '../painting/surface.js';
import { sceneStore, type SceneState } from '../state/scene-state.js';

interface GHZProject {
  version: 2;
  canvas: {
    width: number;
    height: number;
  };
  scene: Omit<SceneState, 'anchor'> & { anchor: SceneState['anchor'] };
}

/** Read accumulation texture back to CPU */
async function readAccumTexture(): Promise<ArrayBuffer> {
  const { device } = getGPU();
  const texture = getReadTexture();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();
  const bytesPerPixel = 8; // rgba16float = 4 * 2 bytes
  const bytesPerRow = Math.ceil(w * bytesPerPixel / 256) * 256; // 256-byte alignment

  const buffer = device.createBuffer({
    size: bytesPerRow * h,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow },
    { width: w, height: h }
  );
  device.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ);
  const data = buffer.getMappedRange().slice(0);
  buffer.unmap();
  buffer.destroy();
  return data;
}

/** Save .ghz project file */
export async function saveProject(): Promise<void> {
  const scene = sceneStore.get();
  const w = getSurfaceWidth();
  const h = getSurfaceHeight();

  const header: GHZProject = {
    version: 2,
    canvas: { width: w, height: h },
    scene,
  };

  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  const accumData = await readAccumTexture();

  // Format: [4 bytes header length][header JSON][accum binary data]
  const totalSize = 4 + headerBytes.byteLength + accumData.byteLength;
  const output = new ArrayBuffer(totalSize);
  const view = new DataView(output);
  view.setUint32(0, headerBytes.byteLength, true);
  new Uint8Array(output, 4, headerBytes.byteLength).set(headerBytes);
  new Uint8Array(output, 4 + headerBytes.byteLength).set(new Uint8Array(accumData));

  const blob = new Blob([output], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `ghz_${ts}.ghz`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Load .ghz project file */
export async function loadProject(file: File): Promise<void> {
  const { device } = getGPU();
  const arrayBuffer = await file.arrayBuffer();
  const view = new DataView(arrayBuffer);
  const headerLength = view.getUint32(0, true);
  const headerBytes = new Uint8Array(arrayBuffer, 4, headerLength);
  const headerJson = new TextDecoder().decode(headerBytes);
  const header: GHZProject = JSON.parse(headerJson);

  if (header.version !== 2) {
    console.error('Unsupported project version:', header.version);
    return;
  }

  // Restore scene state
  sceneStore.set(header.scene);

  // Upload accumulation data to texture
  const accumData = new Uint8Array(arrayBuffer, 4 + headerLength);
  const accumPP = getAccumPP();
  const bytesPerPixel = 8;
  const bytesPerRow = Math.ceil(header.canvas.width * bytesPerPixel / 256) * 256;

  device.queue.writeTexture(
    { texture: accumPP.write },
    accumData,
    { bytesPerRow },
    { width: header.canvas.width, height: header.canvas.height }
  );
  swapAccum();
}
