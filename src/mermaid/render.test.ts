import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderSpy = vi.fn();
const initializeSpy = vi.fn();
const registerSpy = vi.fn();
const iconPackSpy = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...a: unknown[]) => initializeSpy(...a),
    render: (...a: unknown[]) => renderSpy(...a),
    registerLayoutLoaders: (...a: unknown[]) => registerSpy(...a),
    registerIconPacks: (...a: unknown[]) => iconPackSpy(...a),
  },
}));
vi.mock('@mermaid-js/layout-elk', () => ({ default: [] }));
vi.mock('@iconify-json/lucide', () => ({
  icons: { prefix: 'lucide', icons: { rocket: { body: '<path d="fake"/>' } } },
}));

async function freshModule() {
  vi.resetModules();
  return import('./render');
}

beforeEach(() => {
  renderSpy.mockReset().mockResolvedValue({ svg: '<svg data-fake="1"></svg>' });
  initializeSpy.mockReset();
  registerSpy.mockReset();
  iconPackSpy.mockReset();
});

describe('renderMermaid', () => {
  it('renders through mermaid with strict security and base theme', async () => {
    const { renderMermaid } = await freshModule();
    const result = await renderMermaid('graph TD\n  A --> B');
    expect(result).toEqual({ ok: true, svg: '<svg data-fake="1"></svg>' });
    expect(initializeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', theme: 'base', startOnLoad: false }),
    );
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it('returns errors as values with the parse line extracted', async () => {
    renderSpy.mockRejectedValue(new Error('Parse error on line 3:\n...bad...'));
    const { renderMermaid } = await freshModule();
    const result = await renderMermaid('graph TD\n  A -->');
    expect(result).toEqual({
      ok: false,
      message: 'Parse error on line 3:\n...bad...',
      line: 3,
    });
  });

  it('serves repeat renders of the same code from the cache', async () => {
    const { renderMermaid } = await freshModule();
    await renderMermaid('graph TD\n  A --> B');
    await renderMermaid('graph TD\n  A --> B');
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('retries after a load failure and does not cache it', async () => {
    registerSpy.mockImplementationOnce(() => {
      throw new Error('chunk load failed');
    });
    const { renderMermaid } = await freshModule();

    const first = await renderMermaid('graph TD\n  A --> B');
    expect(first).toEqual({ ok: false, message: 'chunk load failed', line: null });
    expect(renderSpy).not.toHaveBeenCalled();

    const second = await renderMermaid('graph TD\n  A --> B');
    expect(second).toEqual({ ok: true, svg: '<svg data-fake="1"></svg>' });
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('dedups concurrent calls for the same code into a single render', async () => {
    let resolveRender!: (v: { svg: string }) => void;
    const deferred = new Promise<{ svg: string }>((resolve) => {
      resolveRender = resolve;
    });
    renderSpy.mockReturnValueOnce(deferred);
    const { renderMermaid } = await freshModule();

    const p1 = renderMermaid('graph TD\n  A --> B');
    const p2 = renderMermaid('graph TD\n  A --> B');
    resolveRender({ svg: '<svg data-fake="1"></svg>' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ ok: true, svg: '<svg data-fake="1"></svg>' });
    expect(r2).toEqual({ ok: true, svg: '<svg data-fake="1"></svg>' });
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});

describe('icon packs', () => {
  it('registers the lucide pack once, lazily, under the name mermaid will resolve', async () => {
    const { renderMermaid } = await freshModule();
    await renderMermaid('graph TD\n  A --> B');
    await renderMermaid('graph TD\n  A --> C');
    expect(iconPackSpy).toHaveBeenCalledTimes(1);
    const packs = iconPackSpy.mock.calls[0][0] as {
      name: string;
      loader: () => Promise<unknown>;
    }[];
    expect(packs).toHaveLength(1);
    // `name` is what `lucide:` in diagram source resolves against — it
    // overrides the pack's own prefix, so this string IS the contract.
    expect(packs[0].name).toBe('lucide');
    // The loader is the lazy edge: calling it must yield the pack's icons.
    const icons = (await packs[0].loader()) as { prefix: string };
    expect(icons.prefix).toBe('lucide');
  });
});

describe('extractErrorLine', () => {
  it('finds the line in mermaid parse errors', async () => {
    const { extractErrorLine } = await freshModule();
    expect(extractErrorLine('Parse error on line 7:\nxyz')).toBe(7);
    expect(extractErrorLine('Error: something else entirely')).toBeNull();
  });
});
