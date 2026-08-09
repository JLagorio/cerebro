import { describe, expect, it, vi } from 'vitest';
import { copySvg, viewBoxSize } from './export';

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
