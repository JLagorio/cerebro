import { describe, expect, it, vi } from 'vitest';
import {
  copySvg,
  inlineForeignObjects,
  savePng,
  svgToPngBytes,
  viewBoxSize,
  withBackground,
} from './export';

describe('viewBoxSize', () => {
  it('reads intrinsic size from the viewBox', () => {
    expect(viewBoxSize('<svg viewBox="0 0 320 180"></svg>')).toEqual({ width: 320, height: 180 });
  });
  it('falls back to a sane default when absent', () => {
    expect(viewBoxSize('<svg></svg>')).toEqual({ width: 800, height: 600 });
  });
});

describe('copySvg', () => {
  it('writes the svg text to the clipboard, on the ground the app shows it on', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await copySvg('<svg viewBox="0 0 10 20"></svg>');
    // MEASURED: 73.4% of a dark-theme export's pixels were fully transparent
    // and its lightest opaque pixel scored 1.06:1 against a white page.
    expect(writeText).toHaveBeenCalledWith(
      '<svg viewBox="0 0 10 20"><rect x="0" y="0" width="10" height="20" fill="#ffffff" data-cerebro-export-bg="true"/></svg>',
    );
    vi.unstubAllGlobals();
  });

  it('leaves the copy otherwise lossless — foreignObject labels are not flattened', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await copySvg('<svg viewBox="0 0 10 20"><foreignObject><p>Idea</p></foreignObject></svg>');
    expect(writeText.mock.calls[0][0]).toContain('<foreignObject>');
    vi.unstubAllGlobals();
  });
});

/**
 * The reason Copy PNG failed for every flowchart ever drawn (M29.53).
 *
 * MEASURED: PNG export failed for flowchart, ELK flowchart, class, state, ER,
 * journey and mindmap — every type mermaid draws with HTML labels — and worked
 * for sequence, gantt, pie, timeline, gitGraph and quadrant, which have none.
 * An <img> whose SVG holds a foreignObject taints the canvas, so toBlob raises
 * SecurityError and the export rejects into a generic failure toast.
 */
describe('inlineForeignObjects', () => {
  it('replaces an HTML label with centred SVG text carrying the same class', () => {
    const out = inlineForeignObjects(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">' +
        '<g class="label"><foreignObject width="60" height="20">' +
        '<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Idea</p></span></div>' +
        '</foreignObject></g></svg>',
    );
    expect(out).not.toContain('foreignObject');
    expect(out).toContain('<text');
    expect(out).toContain('x="30"');
    expect(out).toContain('y="10"');
    expect(out).toContain('class="nodeLabel"');
    expect(out).toContain('fill="currentColor"');
    expect(out).toContain('Idea');
  });

  it('keeps a multi-line label as one line per line', () => {
    const out = inlineForeignObjects(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">' +
        '<foreignObject width="60" height="20"><div xmlns="http://www.w3.org/1999/xhtml">' +
        '<p>One</p><p>Two</p></div></foreignObject></svg>',
    );
    const tspans = out.match(/<tspan/g) ?? [];
    expect(tspans).toHaveLength(2);
    expect(out).toContain('One');
    expect(out).toContain('Two');
    // The stack is centred on the box the label used to fill.
    expect(out).toContain('dy="-0.6em"');
  });

  it('leaves an svg with no HTML labels byte-identical', () => {
    const svg = '<svg viewBox="0 0 10 10"><text>Actor</text></svg>';
    expect(inlineForeignObjects(svg)).toBe(svg);
  });
});

describe('withBackground', () => {
  it('paints the viewBox, offsets and all', () => {
    expect(withBackground('<svg viewBox="-50 -10 650 371"></svg>', '#151821')).toContain(
      '<rect x="-50" y="-10" width="650" height="371" fill="#151821"',
    );
  });

  it('leaves a string that is not an svg alone', () => {
    expect(withBackground('not an svg', '#fff')).toBe('not an svg');
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
