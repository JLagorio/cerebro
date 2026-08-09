import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MermaidBlockView } from './MermaidBlockView';

vi.mock('./render', () => ({ renderMermaid: vi.fn() }));
import { renderMermaid } from './render';
const renderMock = vi.mocked(renderMermaid);

describe('MermaidBlockView', () => {
  it('renders the diagram through the core service', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="c"></svg>' });
    render(<MermaidBlockView code={'graph TD\n  A --> B'} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-block').innerHTML).toContain('data-fake="c"'),
    );
  });

  it('starts in editing mode when the code is empty', () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    expect(screen.getByLabelText('Mermaid source')).toBeTruthy();
  });

  it('commits the draft on Done', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    const onChangeCode = vi.fn();
    render(<MermaidBlockView code="" onChangeCode={onChangeCode} />);
    await userEvent.type(screen.getByLabelText('Mermaid source'), 'graph TD');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChangeCode).toHaveBeenCalledWith('graph TD');
  });

  it('surfaces the full render error, not just its first line', async () => {
    renderMock.mockResolvedValue({
      ok: false,
      message: 'Parse error on line 2:\nExpecting …',
      line: 2,
    });
    render(<MermaidBlockView code={'graph TD\n  A -->'} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-block').textContent).toContain('line 2'),
    );
  });

  it('opens the lightbox from the preview', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="d"></svg>' });
    render(<MermaidBlockView code="graph TD" onChangeCode={() => {}} />);
    await waitFor(() => screen.getByTestId('mermaid-diagram'));
    await userEvent.hover(screen.getByTestId('mermaid-diagram'));
    await userEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    expect(screen.getByTestId('lightbox-canvas')).toBeTruthy();
  });
});
