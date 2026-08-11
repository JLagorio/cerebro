import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { MermaidBlockView } from './MermaidBlockView';

// Only the RENDERER is mocked: summarizeRenderError is pure string work the
// error banner's text depends on, and a whole-module factory would hand back
// undefined for it.
vi.mock('./render', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./render')>()),
  renderMermaid: vi.fn(),
}));
import { renderMermaid } from './render';
const renderMock = vi.mocked(renderMermaid);

// Spyable pass-through: the save-as-file tests assert the real mock-backend
// behavior (dedupe, raw bytes) AND need one rejection path on demand.
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, writeTextFile: vi.fn(actual.writeTextFile) };
});
import { writeTextFile } from '@/lib/ipc';
const writeTextFileMock = vi.mocked(writeTextFile);

/**
 * The visual pane renders the `code` PROP directly, never a `draft` (M29.18
 * defect 2) — an uncontrolled `onChangeCode={() => {}}` mock can no longer
 * exercise it meaningfully, since nothing ever flows back in. Any test that
 * needs to see the structural editor's content (as opposed to just its
 * presence) needs an actual round trip, hence this real-state wrapper.
 */
function Controlled({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  return <MermaidBlockView code={code} onChangeCode={setCode} />;
}

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
    render(<Controlled initialCode="" />);
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
    // Flowchart-shaped on purpose (M29.18 defect 4): a bad second line goes
    // opaque rather than failing the whole model, so this header STILL
    // parses as visual-capable even though the render itself is broken —
    // the exact case onErrorClick must force into code mode, since
    // StructuralEditor has no last-good svg to show and would open blank.
    const code = 'graph TD\n  A -->';
    render(<MermaidBlockView code={code} onChangeCode={() => {}} />);
    await waitFor(() => screen.getByTestId('mermaid-error'));
    // The header still has its own "Edit" button, so target the error card
    // by testid rather than role to avoid an ambiguous query.
    await userEvent.click(screen.getByTestId('mermaid-error'));
    const textarea = screen.getByLabelText('Mermaid source');
    expect(textarea).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toBe(code);
    expect(screen.queryByTestId('structural-host')).toBeNull();
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

  // Typing `graph TD` here — Stage B's own placeholder text — deliberately
  // exercises the mid-session case M29.18's latching fix targets: `editMode`
  // was captured as 'code' at the Blank click (entryMode('') is always
  // 'code', nothing to parse yet) and must NOT auto-promote just because the
  // draft becomes flowchart-shaped while the user is still typing.

  it('live-renders the draft after the debounce window', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'Blank' }));
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(renderMock).toHaveBeenCalledWith('graph TD'));
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-live-preview').innerHTML).toContain('data-fake="live"'),
    );
  });

  // The code pane's preview is a read-only sink like any other, and it
  // re-renders on every pause in typing — so the strip has to survive the
  // rewrite, not just the first paint (M29.38).
  it('a link in the live preview cannot navigate the app away, before or after a retype', async () => {
    const linked = (gen: string, target: string): string =>
      `<svg data-gen="${gen}"><g class="nodes">` +
      `<a href="${target}"><g class="node clickable"/></a>` +
      `<a xlink:href="${target}"><g class="node clickable"/></a></g></svg>`;
    const liveTargets = (root: ParentNode): string[] =>
      [...root.querySelectorAll('a')].flatMap((a) =>
        [...a.attributes].filter((at) => at.localName === 'href').map((at) => at.value),
      );

    renderMock.mockResolvedValue({ ok: true, svg: linked('1', 'notes/a.md') });
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'Blank' }));
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const preview = await screen.findByTestId('mermaid-live-preview');
    await waitFor(() => expect(preview.querySelector('svg')?.getAttribute('data-gen')).toBe('1'));
    expect(preview.querySelectorAll('a')).toHaveLength(2);
    expect(liveTargets(preview)).toEqual([]);

    renderMock.mockResolvedValue({ ok: true, svg: linked('2', 'https://example.com/') });
    await user().type(screen.getByLabelText('Mermaid source'), '\n  A --> B');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('mermaid-live-preview').querySelector('svg')?.getAttribute('data-gen'),
      ).toBe('2'),
    );
    expect(liveTargets(screen.getByTestId('mermaid-live-preview'))).toEqual([]);
  });

  it('keeps the last good render and shows a lined error while the draft is broken', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    await user().click(screen.getByRole('button', { name: 'Blank' }));
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD');
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
    await user().type(screen.getByLabelText('Mermaid source'), 'graph TD\n  A -->');
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

  it('editMode is latched at entry, not re-decided on every keystroke (M29.18.1)', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    // A non-flowchart-shaped code prop enters code mode at the door...
    render(<MermaidBlockView code={'sequenceDiagram\n  A->>B: hi'} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const source = screen.getByLabelText('Mermaid source') as HTMLTextAreaElement;
    // ...and typing a flowchart-shaped replacement mid-session — the exact
    // placeholder text Stage B invites — must not yank the textarea away for
    // the structural editor once the draft happens to become parseable.
    await userEvent.clear(source);
    await userEvent.type(source, 'flowchart TD\n  A[X] --> B[Y]');
    expect(screen.getByLabelText('Mermaid source')).toBeTruthy();
    expect(screen.queryByTestId('structural-host')).toBeNull();
    // The toggle appears (now visual-capable), but promotion stays opt-in.
    expect(screen.getByRole('button', { name: 'Show diagram' })).toBeTruthy();
  });

  it('visual mode renders the code prop directly, so an external code change (undo) is what "Show code" reflects', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });

    function ControlledBlock() {
      const [code, setCode] = useState('flowchart TD\n  A[Start] --> B[End]');
      return (
        <>
          <button onClick={() => setCode('flowchart TD\n  A[Undone] --> B[End]')}>
            External edit
          </button>
          <MermaidBlockView code={code} onChangeCode={setCode} />
        </>
      );
    }

    render(<ControlledBlock />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByTestId('structural-host')).toBeTruthy();

    // Simulate an external change landing mid-session (e.g. an undo
    // elsewhere) — the visual pane holds no draft of its own to fight it.
    await userEvent.click(screen.getByRole('button', { name: 'External edit' }));
    await waitFor(() =>
      expect(renderMock).toHaveBeenCalledWith('flowchart TD\n  A[Undone] --> B[End]'),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).value).toBe(
      'flowchart TD\n  A[Undone] --> B[End]',
    );
  });
});

describe('MermaidBlockView save as file (M29.22)', () => {
  const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

  beforeEach(async () => {
    resetMockFs();
    useUiStore.setState({ toasts: [] });
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    writeTextFileMock.mockClear();
    await useVaultStore.getState().openVault('/demo-vault');
  });

  it('writes the source to diagrams/<slug>.mmd and toasts the landing path', async () => {
    const code = 'sequenceDiagram\n  A->>B: hi';
    render(<MermaidBlockView code={code} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as file…' }));
    await waitFor(() => expect(toasts()).toContain('Saved to diagrams/sequence.mmd'));
    expect(writeTextFileMock).toHaveBeenCalledWith('/demo-vault', 'diagrams/sequence.mmd', code);
    // Verbatim bytes, and the new entry is scanned in.
    expect(fs().get('diagrams/sequence.mmd')).toBe(code);
    expect(useVaultStore.getState().entries.some((e) => e.path === 'diagrams/sequence.mmd')).toBe(
      true,
    );
  });

  it('dedupes against an existing file and toasts where it actually landed', async () => {
    const code = '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B';
    render(<MermaidBlockView code={code} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as file…' }));
    // The seeded demo vault already holds a flowchart-slugged sibling? No —
    // the first save claims flowchart.mmd; the second proves the dedupe.
    await waitFor(() => expect(toasts()).toContain('Saved to diagrams/flowchart.mmd'));
    await userEvent.click(screen.getByRole('button', { name: 'Save as file…' }));
    await waitFor(() => expect(toasts()).toContain('Saved to diagrams/flowchart-2.mmd'));
    expect(fs().get('diagrams/flowchart-2.mmd')).toBe(code);
  });

  it('is hidden while editing and on empty blocks', async () => {
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Save as file…' })).toBeNull();
    cleanup();
    render(<MermaidBlockView code={'graph TD\n  A --> B'} onChangeCode={() => {}} />);
    expect(screen.getByRole('button', { name: 'Save as file…' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('button', { name: 'Save as file…' })).toBeNull();
  });

  it('toasts the failure instead of throwing (store-invariant style)', async () => {
    writeTextFileMock.mockRejectedValueOnce(new Error('disk full'));
    render(<MermaidBlockView code={'graph TD\n  A --> B'} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as file…' }));
    await waitFor(() => expect(toasts()).toContain("Couldn't save diagram: disk full"));
  });
});

describe('MermaidBlockView full screen (M29.27)', () => {
  afterEach(cleanup);

  it('opens the full-screen editor from the header, wired to the block channel', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="fs"></svg>' });
    const onChangeCode = vi.fn();
    render(<MermaidBlockView code={'flowchart TD\n  A --> B'} onChangeCode={onChangeCode} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open full screen' }));
    expect(screen.getByTestId('fullscreen-diagram-editor')).toBeTruthy();
    // The wire is the whole point (spec D1): a structural op made full-screen
    // commits through the BLOCK's own onChangeCode, so BlockNote history gives
    // undo and the doc's autosave persists it — no second save path.
    await userEvent.click(screen.getByRole('button', { name: 'Add node' }));
    expect(onChangeCode).toHaveBeenCalledTimes(1);
    expect(onChangeCode).toHaveBeenCalledWith('flowchart TD\n  A --> B\n  n1[New step]');
    // The dialog closes back to the block.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('fullscreen-diagram-editor')).toBeNull();
  });

  it('hides Open full screen on an empty block, and KEEPS it while editing', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    render(<MermaidBlockView code="" onChangeCode={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Open full screen' })).toBeNull();
    cleanup();
    render(<MermaidBlockView code={'flowchart TD\n  A --> B'} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // It used to go away exactly when it was most wanted (M29.53): the button
    // that says "give me more room" was hidden the moment the user was working
    // in a 310px-wide block, and the only route was Done, then Open full
    // screen, then Edit again.
    expect(screen.getByRole('button', { name: 'Open full screen' })).toBeTruthy();
  });

  /**
   * The block's keyboard, delivered where the browser delivers it (M29.53).
   *
   * Every case fires at `document.body`, because that is where the shipped app
   * puts the keystroke: MEASURED, `document.activeElement` right after pressing
   * Edit is BODY, and after any click inside the visual pane it is
   * ProseMirror's root — an ANCESTOR of this block. The old handler was a React
   * onKeyDown on a wrapper div inside it, so it could not fire, and the tests
   * that "covered" Escape all typed into the source box first, i.e. the one
   * mode where focus IS inside the block.
   */
  describe('keys that arrive from outside the block', () => {
    it('Escape leaves the visual editor', async () => {
      renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
      render(<Controlled initialCode={'flowchart TD\n  A --> B'} />);
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(await screen.findByTestId('structural-host')).toBeTruthy();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('structural-host')).toBeNull());
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('⌘Z reaches the document history even with focus on the chrome that just changed it', async () => {
      renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
      const onUndo = vi.fn();
      const onRedo = vi.fn();
      render(
        <MermaidBlockView
          code={'flowchart TD\n  A --> B'}
          onChangeCode={() => {}}
          onUndo={onUndo}
          onRedo={onRedo}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await screen.findByTestId('structural-host');
      // The measured sequence: press + Node, regret it, ⌘Z. Focus is on the
      // button, so BlockNote never saw the key and the node stayed in the file.
      fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
      expect(onUndo).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
      expect(onRedo).toHaveBeenCalledTimes(1);
    });

    it("⌘Z inside the source box stays the textarea's own undo", async () => {
      renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
      const onUndo = vi.fn();
      render(
        <MermaidBlockView
          code={'sequenceDiagram\n  A->>B: hi'}
          onChangeCode={() => {}}
          onUndo={onUndo}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const source = await screen.findByLabelText('Mermaid source');
      fireEvent.keyDown(source, { key: 'z', metaKey: true });
      expect(onUndo).not.toHaveBeenCalled();
    });
  });

  it('flushes an uncommitted source draft when the block goes away', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    const onChangeCode = vi.fn();
    const { unmount } = render(
      <MermaidBlockView code={'sequenceDiagram\n  A->>B: hi'} onChangeCode={onChangeCode} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const source = await screen.findByLabelText('Mermaid source');
    await userEvent.clear(source);
    await userEvent.type(source, 'sequenceDiagram');
    expect(onChangeCode).not.toHaveBeenCalled();
    // Navigating away used to take the typed bytes with it: no prompt, no
    // dirty chip, no undo entry — the one code surface in the app with no
    // unmount flush (MEASURED against the .mmd page, which survives it).
    unmount();
    expect(onChangeCode).toHaveBeenCalledWith('sequenceDiagram');
  });

  it('a double-click on the picture opens the editor', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    render(<Controlled initialCode={'flowchart TD\n  A --> B'} />);
    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toBeTruthy());
    await userEvent.dblClick(screen.getByTestId('mermaid-diagram'));
    // The only way in was a 34x22px grey text link at the far right of the
    // header; every other content type in the document takes a click or a
    // double-click to edit.
    expect(await screen.findByTestId('structural-host')).toBeTruthy();
  });

  it('lets the app keep ⌘K while the source box is focused, and still silences plain keys', async () => {
    renderMock.mockResolvedValue({ ok: true, svg: '<svg></svg>' });
    render(<MermaidBlockView code={'sequenceDiagram\n  A->>B: hi'} onChangeCode={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const source = await screen.findByLabelText('Mermaid source');
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener('keydown', spy);
    try {
      fireEvent.keyDown(source, { key: 'k', metaKey: true });
      fireEvent.keyDown(source, { key: 'x' });
      fireEvent.keyDown(source, { key: 'b', metaKey: true });
    } finally {
      window.removeEventListener('keydown', spy);
    }
    // ⌘K is the app's; plain typing and ⌘B are the surrounding editor's, and
    // stopping those is the guard's whole stated reason.
    expect(seen).toEqual(['k']);
  });
});
