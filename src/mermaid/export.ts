import { exportPng as ipcExportPng } from '@/lib/ipc';

/**
 * Diagram export (M29.4). SVG is the lossless copy; PNG rasterises at 2×
 * through an offscreen canvas. Mermaid svgs are viewBox-sized (no width/height
 * attributes), and an <img> from such an svg reports 0×0 in some engines —
 * so intrinsic size comes from the viewBox, not the image.
 */
export function viewBoxSize(svg: string): { width: number; height: number } {
  const m = svg.match(/viewBox="[\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
  if (m === null) return { width: 800, height: 600 };
  return { width: Math.ceil(Number(m[1])), height: Math.ceil(Number(m[2])) };
}

export async function svgToPngBytes(svg: string, scale = 2): Promise<Uint8Array> {
  const { width, height } = viewBoxSize(svg);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG failed to rasterise'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width * scale);
    canvas.height = Math.max(1, height * scale);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('canvas 2d unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob === null) throw new Error('PNG encode failed');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Both copy functions let clipboard/rasterise failures propagate to the
// caller instead of toasting here — unlike the store-layer copyText pattern
// (actions catch and toast in place). The lightbox (M29.5) is the only
// caller, and it needs the rejection itself to show a diagram-specific
// error, not a generic one raised from inside this module.

export async function copySvg(svg: string): Promise<void> {
  await navigator.clipboard.writeText(svg);
}

export async function copyPng(svg: string): Promise<void> {
  const bytes = await svgToPngBytes(svg);
  // `bytes` types as Uint8Array<ArrayBufferLike>, and BlobPart wants a view
  // backed by a concrete ArrayBuffer (not SharedArrayBuffer) — re-wrapping
  // resolves the generic, same pattern mockIpc.ts uses for exportPng.
  await navigator.clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    }),
  ]);
}

/** Save through the native dialog. Resolves to the chosen path, or null on cancel. */
export async function savePng(svg: string, defaultName: string): Promise<string | null> {
  const bytes = await svgToPngBytes(svg);
  return ipcExportPng(defaultName, bytes);
}
