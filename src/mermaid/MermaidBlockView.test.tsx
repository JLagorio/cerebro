import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('an empty block shows the template grid, not an auto-opened textarea', () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    expect(screen.getByTestId('mermaid-template-grid')).toBeTruthy();
    expect(screen.queryByLabelText('Mermaid source')).toBeNull();
  });

  it('an empty block offers the template grid; picking the flowchart one enters editing visually with its code', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    expect(screen.getByTestId('mermaid-template-grid')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Flowchart' }));
    // Flowcharts open visual-first (M29.18) — the structural editor, not the
    // source textarea, is what appears right after picking the template.
    expect(await screen.findByTestId('structural-host')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const source = await screen.findByLabelText('Mermaid source');
    expect((source as HTMLTextAreaElement).value).toContain('flowchart TD');
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

  it('enters editing when the broken diagram is clicked', async () => {
    renderMock.mockResolvedValue({
      ok: false,
      message: 'Parse error on line 2:\nExpecting …',
      line: 2,
    });
    // Not flowchart-shaped: this exercises the plain code-editing path,
    // untangled from M29.18's visual mode (a `graph TD` header would parse as
    // visual-capable even with a broken second line, since a bad line just
    // goes opaque rather than failing the whole model).
    const code = 'sequenceDiagram\n  A-->';
    render(<MermaidBlockView code={code} onChangeCode={() => {}} />);
    await waitFor(() => screen.getByTestId('mermaid-error'));
    // The header still has its own "Edit" button, so target the error card
    // by testid rather than role to avoid an ambiguous query.
    await userEvent.click(screen.getByTestId('mermaid-error'));
    const textarea = screen.getByLabelText('Mermaid source');
    expect(textarea).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toBe(code);
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

describe('MermaidBlockView editing (M29.9)', () => {
  beforeEach(() => {
    // shouldAdvanceTime: bare useFakeTimers() hangs React's scheduler under
    // userEvent v14 (see InboxPage.test.tsx for the same fix).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="live"></svg>' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const user = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

  // These three tests deliberately type a non-flowchart-shaped diagram
  // (`sequenceDiagram`, not `graph TD`/`flowchart TD`): they exercise Stage
  // B's debounce/error/cancel mechanics, which are diagram-type-agnostic, and
  // a flowchart-shaped draft would flip `isVisualCapable` mid-session
  // (M29.18) and swap the textarea out from under an in-flight `type()` call.

  it('live-renders the draft after the debounce window', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'Blank' }));
    await user().type(screen.getByLabelText('Mermaid source'), 'sequenceDiagram');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(renderMock).toHaveBeenCalledWith('sequenceDiagram'));
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-live-preview').innerHTML).toContain('data-fake="live"'),
    );
  });

  it('keeps the last good render and shows a lined error while the draft is broken', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'Blank' }));
    await user().type(screen.getByLabelText('Mermaid source'), 'sequenceDiagram');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(screen.getByTestId('mermaid-live-preview')).toBeTruthy());

    renderMock.mockResolvedValue({ ok: false, message: 'Parse error on line 2: bad', line: 2 });
    await user().type(screen.getByLabelText('Mermaid source'), '\n  A -->');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(screen.getByTestId('mermaid-edit-error')).toBeTruthy());
    expect(screen.getByTestId('mermaid-edit-error').textContent).toContain('Line 2');
    // Stale-but-good svg is still on screen, dimmed — never a blank pane.
    expect(screen.getByTestId('mermaid-live-preview').innerHTML).toContain('data-fake="live"');
  });

  it('Done commits, Escape cancels', async () => {
    const onChangeCode = vi.fn();
    render(<MermaidBlockView code="" onChangeCode={onChangeCode} />);
    await user().click(screen.getByRole('button', { name: 'Blank' }));
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD');
    await user().click(screen.getByRole('button', { name: 'Done' }));
    expect(onChangeCode).toHaveBeenCalledWith('graph TD');

    await user().click(screen.getByRole('button', { name: 'Edit' }));
    await user().type(screen.getByLabelText('Mermaid source'), ' MORE');
    await user().keyboard('{Escape}');
    // Cancel: no second commit, editor closed.
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Mermaid source')).toBeNull();
  });

  it('does not resurrect a stale error when Edit reopens inside the debounce window (regression)', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'Blank' }));
    renderMock.mockResolvedValue({ ok: false, message: 'Parse error on line 2: bad', line: 2 });
    await user().type(screen.getByLabelText('Mermaid source'), 'sequenceDiagram\n  A-->');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(screen.getByTestId('mermaid-edit-error')).toBeTruthy());

    await user().keyboard('{Escape}');
    expect(screen.queryByLabelText('Mermaid source')).toBeNull();

    // Reopen immediately — well inside the 250ms debounce window, where a
    // debounce hoisted at the block level (rather than owned by the preview
    // itself) would still be settling on the broken text from the closed
    // session.
    await user().click(screen.getByRole('button', { name: 'Edit' }));

    // The textarea reflects the reverted (empty) draft...
    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).value).toBe('');
    // ...and the fresh preview must match it immediately, not lag behind
    // with the previous session's error.
    expect(screen.queryByTestId('mermaid-edit-error')).toBeNull();
  });
});

describe('MermaidBlockView visual/code mode (M29.18)', () => {
  it('flowcharts edit visually with a code toggle; other types go straight to code', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    render(<MermaidBlockView code={'flowchart TD\n  A[X] --> B[Y]'} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('structural-host')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect(screen.getByLabelText('Mermaid source')).toBeTruthy();
  });

  it('non-flowcharts have no visual mode', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    render(<MermaidBlockView code={'sequenceDiagram\n  A->>B: hi'} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Mermaid source')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show code' })).toBeNull();
  });
});
