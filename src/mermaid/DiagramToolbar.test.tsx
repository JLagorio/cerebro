import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DiagramToolbar } from './DiagramToolbar';

vi.mock('./render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="t"></svg>' }),
}));
vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue('/tmp/x.png'),
}));
import { copySvg } from './export';

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

  it('Show code flips its label with the panel', () => {
    mount({ showCode: true });
    expect(screen.getByRole('button', { name: 'Hide code' })).toBeTruthy();
  });

  it('Copy SVG renders through the cached service and hands the svg to export', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await vi.waitFor(() =>
      expect(vi.mocked(copySvg)).toHaveBeenCalledWith('<svg data-fake="t"></svg>'),
    );
  });
});
