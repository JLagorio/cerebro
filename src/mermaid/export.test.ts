import { describe, expect, it, vi } from 'vitest';
import { copySvg, savePng, svgToPngBytes, viewBoxSize } from './export';

describe('viewBoxSize', () => {
  it('reads intrinsic size from the viewBox', () => {
    expect(viewBoxSize('<svg viewBox="0 0 320 180"></svg>')).toEqual({ width: 320, height: 180 });
  });
  it('falls back to a sane default when absent', () => {
    expect(viewBoxSize('<svg></svg>')).toEqual({ width: 800, height: 600 });
  });
});

describe('copySvg', () => {
  it('writes the svg text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await copySvg('<svg/>');
    expect(writeText).toHaveBeenCalledWith('<svg/>');
    vi.unstubAllGlobals();
  });
});

// jsdom has no createObjectURL/revokeObjectURL and no real canvas backend,
// so every svgToPngBytes test stubs those two seams. Image is stubbed with a
// minimal class whose `src` setter schedules onload/onerror on a microtask —
// the same shape the real element resolves on, without an actual decoder.
function stubObjectUrl(): void {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
}

class ErroringImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

class LoadingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

describe('svgToPngBytes', () => {
  it('rejects when the image fails to decode the svg', async () => {
    stubObjectUrl();
    vi.stubGlobal('Image', ErroringImage);
    await expect(svgToPngBytes('<svg/>')).rejects.toThrow('SVG failed to rasterise');
    vi.unstubAllGlobals();
  });

  it('rejects when the canvas has no 2d context', async () => {
    stubObjectUrl();
    vi.stubGlobal('Image', LoadingImage);
    // No `canvas` npm package installed under jsdom, so a real
    // HTMLCanvasElement#getContext('2d') already returns null here — no
    // further stubbing needed to exercise this branch.
    await expect(svgToPngBytes('<svg/>')).rejects.toThrow('canvas 2d unavailable');
    vi.unstubAllGlobals();
  });
});

describe('savePng', () => {
  it('propagates rasterisation failures to its caller', async () => {
    stubObjectUrl();
    vi.stubGlobal('Image', ErroringImage);
    await expect(savePng('<svg/>', 'diagram.png')).rejects.toThrow('SVG failed to rasterise');
    vi.unstubAllGlobals();
  });
});
