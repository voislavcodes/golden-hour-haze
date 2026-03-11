// .ghz save/load — V5 project file format
// Saves accumulation texture (rgba16float) + paint state texture (rgba32float) + scene state

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
    version: 5,
    canvas: { width: w, height: h },
    scene,
    hasState: true,
  };

  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  const accumData = await readTexture(getReadTexture(), w, h, 8);        // rgba16float = 8 bpp
  const stateData = await readTexture(getStateReadTexture(), w, h, 16);  // rgba32float = 16 bpp

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

  // Support v2, v4, and v5
  if (header.version !== 2 && header.version !== 4 && header.version !== 5) {
    console.error('Unsupported project version:', header.version);
    return;
  }

  // Restore scene state
  sceneStore.set(header.scene);

  // Backward compat — migrate old surface params to new material system
  const surf = header.scene.surface as any;
  if (!surf || surf.directionality !== undefined || surf.mode !== undefined) {
    // Old format: grainSize/directionality/mode → new material system
    let material: 'board' | 'canvas' | 'paper' | 'gesso' = 'board';
    if (surf) {
      if (surf.mode === 'woodblock') {
        material = 'board';
      } else if (surf.directionality > 0.6) {
        material = surf.grainSize > 0.5 ? 'canvas' : 'board';
      } else if (surf.grainSize < 0.2) {
        material = 'gesso';
      } else {
        material = 'paper';
      }
    }
    sceneStore.update(() => ({
      surface: {
        material,
        tone: 0.3,
        grainScale: surf?.grainSize ?? 0.5,
        grainSize: 0.5,
        seed: Math.random() * 1000,
        intensity: surf?.intensity ?? 0.08,
        absorption: surf?.absorption ?? 0.15,
        drySpeed: surf?.drySpeed ?? 1.0,
      },
    }));
  } else if (surf.material === undefined) {
    // Partially migrated — fill defaults
    sceneStore.update(() => ({
      surface: {
        material: 'board' as const,
        tone: 0.3,
        grainScale: 0.5,
        grainSize: 0.5,
        seed: Math.random() * 1000,
        intensity: 0.08,
        absorption: 0.15,
        drySpeed: 1.0,
      },
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

  // Upload paint state data if present (v4 or v5)
  if (header.hasState) {
    const w = header.canvas.width;
    const h = header.canvas.height;
    const stateOffset = 4 + headerLength + accumSize;

    if (header.version >= 5) {
      // v5: rgba32float = 16 bpp — direct load
      const stateBpp = 16;
      const stateBytesPerRow = Math.ceil(w * stateBpp / 256) * 256;
      if (stateOffset + stateBytesPerRow * h <= arrayBuffer.byteLength) {
        const stateData = new Uint8Array(arrayBuffer, stateOffset, stateBytesPerRow * h);
        const statePP = getStatePP();
        device.queue.writeTexture(
          { texture: statePP.write },
          stateData,
          { bytesPerRow: stateBytesPerRow },
          { width: w, height: h }
        );
      }
    } else {
      // v4: rg32float (8 bpp) → expand to rgba32float (16 bpp)
      const oldBpp = 8;
      const newBpp = 16;
      const oldBytesPerRow = Math.ceil(w * oldBpp / 256) * 256;
      const newBytesPerRow = Math.ceil(w * newBpp / 256) * 256;
      if (stateOffset + oldBytesPerRow * h <= arrayBuffer.byteLength) {
        const src = new Float32Array(arrayBuffer, stateOffset, (oldBytesPerRow / 4) * h);
        const expanded = new Float32Array((newBytesPerRow / 4) * h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const si = y * (oldBytesPerRow / 4) + x * 2;
            const di = y * (newBytesPerRow / 4) + x * 4;
            expanded[di] = src[si];         // R: session_time
            expanded[di + 1] = src[si + 1]; // G: thinners
            // B (oil) and A stay 0.0
          }
        }
        const statePP = getStatePP();
        device.queue.writeTexture(
          { texture: statePP.write },
          expanded,
          { bytesPerRow: newBytesPerRow },
          { width: w, height: h }
        );
      }
    }
  }

  swapSurface();
}
