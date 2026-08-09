import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderSpy = vi.fn();
const initializeSpy = vi.fn();
const registerSpy = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...a: unknown[]) => initializeSpy(...a),
    render: (...a: unknown[]) => renderSpy(...a),
    registerLayoutLoaders: (...a: unknown[]) => registerSpy(...a),
  },
}));
vi.mock('@mermaid-js/layout-elk', () => ({ default: [] }));

async function freshModule() {
  vi.resetModules();
  return import('./render');
}

beforeEach(() => {
  renderSpy.mockReset().mockResolvedValue({ svg: '<svg data-fake="1"></svg>' });
  initializeSpy.mockReset();
  registerSpy.mockReset();
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
});

describe('extractErrorLine', () => {
  it('finds the line in mermaid parse errors', async () => {
    const { extractErrorLine } = await freshModule();
    expect(extractErrorLine('Parse error on line 7:\nxyz')).toBe(7);
    expect(extractErrorLine('Error: something else entirely')).toBeNull();
  });
});
