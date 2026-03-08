function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Clean up after a brief delay to allow the download to start
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * Export the current canvas viewport as a PNG.
 */
export function exportViewport(canvas: HTMLCanvasElement): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to create blob from canvas'));
          return;
        }
        triggerDownload(blob, `ghz_${timestamp()}.png`);
        resolve();
      },
      'image/png',
    );
  });
}

/**
 * Export a hi-res render by reading pixels from a GPUTexture.
 * The texture must have COPY_SRC usage.
 */
export async function exportHiRes(
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
): Promise<void> {
  const bytesPerPixel = 4; // RGBA8
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256; // align to 256
  const bufferSize = bytesPerRow * height;

  const readbackBuffer = device.createBuffer({
    label: 'hires-readback',
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder({ label: 'hires-export-encoder' });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readbackBuffer, bytesPerRow, rowsPerImage: height },
    { width, height },
  );
  device.queue.submit([encoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const rawData = readbackBuffer.getMappedRange();

  // Copy pixel data, removing row padding
  const pixels = new Uint8ClampedArray(width * height * bytesPerPixel);
  const src = new Uint8Array(rawData);
  for (let row = 0; row < height; row++) {
    const srcOffset = row * bytesPerRow;
    const dstOffset = row * width * bytesPerPixel;
    pixels.set(src.subarray(srcOffset, srcOffset + width * bytesPerPixel), dstOffset);
  }

  readbackBuffer.unmap();
  readbackBuffer.destroy();

  // Draw to OffscreenCanvas and export as PNG
  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2d context from OffscreenCanvas');

  const imageData = new ImageData(pixels, width, height);
  ctx.putImageData(imageData, 0, 0);

  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  triggerDownload(blob, `ghz_hires_${timestamp()}.png`);
}
