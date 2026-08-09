import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { DiagramToolbar } from './DiagramToolbar';

vi.mock('./render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="t"></svg>' }),
}));
vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue('/tmp/x.png'),
}));
import { copySvg, savePng } from './export';

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';

function mount(overrides: Partial<Parameters<typeof DiagramToolbar>[0]> = {}) {
  const onChangeCode = vi.fn();
  render(
    <DiagramToolbar
      code={FLOW}
      onChangeCode={onChangeCode}
      mode="visual"
      showCode={false}
      onToggleShowCode={() => {}}
      onEditVisually={null}
      {...overrides}
    />,
  );
  return onChangeCode;
}

describe('DiagramToolbar', () => {
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
  });

  it('direction buttons rewrite the header surgically', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Direction LR' }));
    expect(onChangeCode).toHaveBeenCalledWith('flowchart LR\n  A[Start] --> B[End]');
  });

  it('the layout menu switches engines through frontmatter', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Layout engine' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'ELK' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A[Start] --> B[End]',
    );
  });

  it('+ Node appends a fresh node line', async () => {
    const onChangeCode = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Add node' }));
    expect(onChangeCode).toHaveBeenCalledWith(
      'flowchart TD\n  A[Start] --> B[End]\n  n1[New step]',
    );
  });

  it('hides the structural cluster over a read-only canvas, shows Edit visually when offered', () => {
    const onEditVisually = vi.fn();
    mount({ code: 'sequenceDiagram\n  A->>B: x', mode: 'code', onEditVisually });
    expect(screen.queryByRole('button', { name: 'Direction TD' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit visually' })).toBeTruthy();
  });

  it('Show code names the closed panel and reports the toggle', async () => {
    const onToggleShowCode = vi.fn();
    mount({ onToggleShowCode });
    expect(screen.queryByRole('button', { name: 'Hide code' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect(onToggleShowCode).toHaveBeenCalledTimes(1);
  });

  it('Show code flips its label with the panel', () => {
    mount({ showCode: true });
    expect(screen.getByRole('button', { name: 'Hide code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show code' })).toBeNull();
  });

  it('Copy SVG renders through the cached service and hands the svg to export', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await vi.waitFor(() =>
      expect(vi.mocked(copySvg)).toHaveBeenCalledWith('<svg data-fake="t"></svg>'),
    );
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('SVG copied');
  });

  it('toasts a specific failure when copy SVG rejects', async () => {
    vi.mocked(copySvg).mockRejectedValueOnce(new Error('denied'));
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await waitFor(() => expect(useUiStore.getState().toasts.length).toBe(1));
    expect(useUiStore.getState().toasts[0].message).toBe('Copy SVG failed');
  });

  it('does not toast success when save PNG resolves null (cancelled)', async () => {
    vi.mocked(savePng).mockResolvedValueOnce(null);
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Save PNG…' }));
    // Give the resolved promise's .then a turn to run, then confirm nothing
    // toasted: `undefined !== null` is what separates a completed copy from a
    // cancelled save, and only this asserts the distinction is still there.
    await waitFor(() => expect(vi.mocked(savePng)).toHaveBeenCalled());
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});
