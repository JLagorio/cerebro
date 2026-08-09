import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FullScreenDiagramEditor } from './FullScreenDiagramEditor';

vi.mock('./render', () => ({
  renderMermaid: vi.fn().mockResolvedValue({ ok: true, svg: '<svg data-fake="f"></svg>' }),
}));
vi.mock('./export', () => ({
  copySvg: vi.fn().mockResolvedValue(undefined),
  copyPng: vi.fn().mockResolvedValue(undefined),
  savePng: vi.fn().mockResolvedValue(null),
}));
import { renderMermaid } from './render';
const renderMock = vi.mocked(renderMermaid);

const FLOW = 'flowchart TD\n  A[Start] --> B[End]';
const SEQ = 'sequenceDiagram\n  A->>B: x';

describe('FullScreenDiagramEditor', () => {
  it('a flowchart latches visual: structural editor inside the plane, overlay closed', async () => {
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    const plane = screen.getByTestId('canvas-plane');
    expect(plane.querySelector('[data-testid="structural-host"]')).toBeTruthy();
    // DiagramToolbar owns the controls — the built-in row must not double up.
    expect(screen.queryByTestId('structural-toolbar')).toBeNull();
    expect(screen.queryByTestId('code-overlay')).toBeNull();
    expect(screen.getByTestId('diagram-toolbar')).toBeTruthy();
  });

  it('a non-flowchart latches code: read-only canvas, overlay open, Edit visually absent', async () => {
    render(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain(
        'data-fake="f"',
      ),
    );
    expect(screen.getByTestId('code-overlay')).toBeTruthy();
    expect(screen.queryByTestId('structural-host')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit visually' })).toBeNull();
  });

  it('Show code toggles the overlay, and overlay edits flow out debounced', async () => {
    const onChangeCode = vi.fn();
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={onChangeCode} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const source = screen.getByLabelText('Mermaid source') as HTMLTextAreaElement;
    expect(source.value).toBe(FLOW);
    fireEvent.change(source, { target: { value: `${FLOW}\n  B --> C[More]` } });
    await waitFor(() => expect(onChangeCode).toHaveBeenCalledWith(`${FLOW}\n  B --> C[More]`));
    // Scoped to the toolbar on purpose: with the panel open, CodeOverlay's own
    // close IconButton (M29.25) carries the same accessible name, so an
    // unscoped getByRole matches two buttons and throws.
    await userEvent.click(
      within(screen.getByTestId('diagram-toolbar')).getByRole('button', { name: 'Hide code' }),
    );
    expect(screen.queryByTestId('code-overlay')).toBeNull();
  });

  it('demotes to code when the source stops being a flowchart, and opens the overlay', async () => {
    const { rerender } = render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    rerender(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('code-overlay')).toBeTruthy());
    expect(screen.queryByTestId('structural-host')).toBeNull();
    // Explicit promotion is offered — the latch never promotes on its own.
    rerender(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} />);
    expect(screen.queryByTestId('structural-host')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Edit visually' }));
    expect(
      screen.getByTestId('canvas-plane').querySelector('[data-testid="structural-host"]'),
    ).toBeTruthy();
  });

  it('a broken source in code mode keeps the last good svg and names the line', async () => {
    renderMock.mockResolvedValueOnce({ ok: true, svg: '<svg data-fake="good"></svg>' });
    const { rerender } = render(<FullScreenDiagramEditor code={SEQ} onChangeCode={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain('good'),
    );
    renderMock.mockResolvedValueOnce({ ok: false, message: 'Parse error on line 2:', line: 2 });
    rerender(<FullScreenDiagramEditor code={`${SEQ}\n  broken`} onChangeCode={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('fullscreen-render-error')).toBeTruthy());
    expect(screen.getByTestId('fullscreen-render-error').textContent).toContain('Line 2:');
    expect(screen.getByTestId('fullscreen-readonly-diagram').innerHTML).toContain('good');
  });

  it('renders the title when a host passes one', () => {
    render(<FullScreenDiagramEditor code={FLOW} onChangeCode={() => {}} title="Pipeline" />);
    expect(screen.getByText('Pipeline')).toBeTruthy();
  });
});
