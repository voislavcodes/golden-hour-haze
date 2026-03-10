// .ghz save/load — V4 project file format
// Saves accumulation texture (rgba16float) + paint state texture (rg32float) + scene state

import { getGPU } from '../gpu/context.js';
import { getReadTexture, getStateReadTexture, getAccumPP, getStatePP, swapSurface, getSurfaceWidth, getSurfaceHeight } from '../painting/surface.js';
import { sceneStore, type SceneState } from '../state/scene-state.js';

interface GHZProject {
  version: number;
  canvas: {
    width: number;
    height: number;
  };
  scene: SceneState;
  hasState?: boolean;  // v4: whether paint state texture is included
}

/** Read a GPU texture back to CPU */
async function readTexture(texture: GPUTexture, w: number, h: number, bytesPerPixel: number): Promise<ArrayBuffer> {
  const { device } = getGPU();
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
    version: 4,
    canvas: { width: w, height: h },
    scene,
    hasState: true,
  };

  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  const accumData = await readTexture(getReadTexture(), w, h, 8);       // rgba16float = 8 bpp
  const stateData = await readTexture(getStateReadTexture(), w, h, 8);  // rg32float = 8 bpp

  // Format: [4 bytes header length][header JSON][accum binary][state binary]
  const totalSize = 4 + headerBytes.byteLength + accumData.byteLength + stateData.byteLength;
  const output = new ArrayBuffer(totalSize);
  const view = new DataView(output);
  view.setUint32(0, headerBytes.byteLength, true);
  new Uint8Array(output, 4, headerBytes.byteLength).set(headerBytes);
  new Uint8Array(output, 4 + headerBytes.byteLength, accumData.byteLength).set(new Uint8Array(accumData));
  new Uint8Array(output, 4 + headerBytes.byteLength + accumData.byteLength).set(new Uint8Array(stateData));

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
  const header = JSON.parse(headerJson) as GHZProject;

  // Support v2 and v4
  if (header.version !== 2 && header.version !== 4) {
    console.error('Unsupported project version:', header.version);
    return;
  }

  // Restore scene state
  sceneStore.set(header.scene);

  // Backward compat — old files without surface params or new fields
  if (!header.scene.surface) {
    sceneStore.update(() => ({
      surface: { grainSize: 0.3, directionality: 0.7, intensity: 0.08, mode: 'standard' as const, absorption: 0.15, drySpeed: 1.0 },
    }));
  } else if (header.scene.surface.absorption === undefined) {
    sceneStore.update((s) => ({
      surface: { ...s.surface, absorption: 0.15, drySpeed: 1.0 },
    }));
  }
  // Ensure mood field exists
  if (!(header.scene as any).mood) {
    sceneStore.update(() => ({ mood: 'Golden Hour' }));
  }

  const accumBpp = 8; // rgba16float
  const accumBytesPerRow = Math.ceil(header.canvas.width * accumBpp / 256) * 256;
  const accumSize = accumBytesPerRow * header.canvas.height;

  // Upload accumulation data
  const accumData = new Uint8Array(arrayBuffer, 4 + headerLength, accumSize);
  const accumPP = getAccumPP();
  device.queue.writeTexture(
    { texture: accumPP.write },
    accumData,
    { bytesPerRow: accumBytesPerRow },
    { width: header.canvas.width, height: header.canvas.height }
  );

  // Upload paint state data if present (v4)
  if (header.hasState) {
    const stateBpp = 8; // rg32float
    const stateBytesPerRow = Math.ceil(header.canvas.width * stateBpp / 256) * 256;
    const stateOffset = 4 + headerLength + accumSize;
    if (stateOffset + stateBytesPerRow * header.canvas.height <= arrayBuffer.byteLength) {
      const stateData = new Uint8Array(arrayBuffer, stateOffset, stateBytesPerRow * header.canvas.height);
      const statePP = getStatePP();
      device.queue.writeTexture(
        { texture: statePP.write },
        stateData,
        { bytesPerRow: stateBytesPerRow },
        { width: header.canvas.width, height: header.canvas.height }
      );
    }
  }

  swapSurface();
}
