import { editorHoldersOf } from '@/editor/openPages';
import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs, writeTextFile } from '@/lib/mockIpc';
import { useUndoShortcuts } from '@/app/useUndoShortcuts';
import { useNavStore } from '@/stores/navStore';
import { useUndoStore } from '@/stores/undoStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DiagramPage } from './DiagramPage';

// Same stub the MermaidBlockView tests use: the page's panes (structural
// editor, live preview) all render through the shared core, and jsdom has no
// real mermaid.
vi.mock('@/mermaid/render', () => ({ renderMermaid: vi.fn() }));
import { renderMermaid } from '@/mermaid/render';
const renderMock = vi.mocked(renderMermaid);

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

/** The seeded demo-vault flowchart, mermaid config header included. */
const PIPELINE = 'diagrams/pipeline.mmd';

describe('DiagramPage', () => {
  beforeEach(async () => {
    resetMockFs();
    window.localStorage.clear();
    useUiStore.setState({ toasts: [] });
    useNavStore.setState({
      selection: { kind: 'diagram', path: PIPELINE },
      history: [navSeed({ kind: 'diagram', path: PIPELINE })],
      historyIndex: 0,
    });
    renderMock.mockResolvedValue({ ok: true, svg: '<svg data-fake="page"></svg>' });
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('loads a flowchart .mmd and opens in the structural editor', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    expect(await screen.findByTestId('structural-host')).toBeTruthy();
    expect(editorHoldersOf(PIPELINE)).toEqual([useNavStore.getState().active]);
    // Title from the filename stem (the scanner's), type from the source.
    expect(screen.getByTestId('diagram-title').textContent).toBe('Pipeline');
    expect(screen.getByText('Flowchart')).toBeTruthy();
    expect(screen.getByTestId('canvas-plane')).toBeTruthy();
    expect(screen.queryByTestId('code-overlay')).toBeNull();
    expect(screen.queryByTestId('diagram-convert')).toBeNull();
  });

  it('offers conversion only for a nonempty manual flowchart and leaves the source unchanged', async () => {
    const source =
      'flowchart LR\n%% cerebro:layout manual\n%% cerebro:pos A 100,100 B 400,100\nA[One] --> B[Two]\n';
    fs().set(PIPELINE, source);
    await useVaultStore.getState().rescan();
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    fireEvent.click(await screen.findByTestId('diagram-convert'));
    expect(screen.getByTestId('convert-board-dialog')).toBeTruthy();
    expect(fs().has('diagrams/pipeline.canvas')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(fs().has('diagrams/pipeline.canvas')).toBe(true));
    expect(fs().get(PIPELINE)).toBe(source);
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({
        kind: 'diagram',
        path: 'diagrams/pipeline.canvas',
      }),
    );
  });

  it('opens a non-flowchart .mmd in code mode with the source verbatim', async () => {
    const raw = 'sequenceDiagram\n  Alice->>Bob: hello\n';
    await writeTextFile('/demo-vault', 'diagrams/handshake.mmd', raw);
    await useVaultStore.getState().rescan();
    render(<DiagramPage selection={{ kind: 'diagram', path: 'diagrams/handshake.mmd' }} />);
    expect(await screen.findByTestId('code-overlay')).toBeTruthy();
    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).value).toBe(raw);
    expect(screen.queryByTestId('structural-host')).toBeNull();
    expect(screen.getByText('Sequence')).toBeTruthy();
  });

  it('shows the whole file in the overlay — the mermaid header is source, not frontmatter', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    await screen.findByTestId('structural-host');
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
    expect(textarea.value.startsWith('---\n')).toBe(true);
    expect(textarea.value).toContain('layout: elk');
  });

  it('debounce-saves overlay edits raw, preserving the leading config header', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
    await screen.findByTestId('structural-host');
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
    const edited = `${textarea.value}  D --> E[Ship]\n`;
    fireEvent.change(textarea, { target: { value: edited } });
    // Two debounces now sit in the path (overlay 250ms, page save 500ms), so
    // 'Unsaved' arrives when the overlay flows the edit out — waitFor, not
    // an immediate read.
    await waitFor(() =>
      expect(screen.getByTestId('diagram-save-state').textContent).toBe('Unsaved'),
    );
    await waitFor(() => expect(fs().get(PIPELINE)).toContain('E[Ship]'), { timeout: 3000 });
    const raw = fs().get(PIPELINE)!;
    // The raw round-trip: the header survived the save byte-for-byte.
    expect(raw.startsWith('---\nconfig:\n  layout: elk\n---\n')).toBe(true);
    expect(raw).toBe(edited);
    await waitFor(() => expect(screen.getByTestId('diagram-save-state').textContent).toBe('Saved'));
  });

  // M65.1: the page binds `diagram.undo`, which shadows the app's own undo,
  // so ⌘Z on the canvas steps the diagram back and never a database batch.
  it('⌘Z on the canvas undoes the diagram edit and leaves undoStore alone', async () => {
    const appUndo = vi.fn(async () => true);
    const before = useUndoStore.getState();
    useUndoStore.setState({
      undo: appUndo,
      past: [{ id: 1, label: 'Renamed', vault: '/demo-vault', at: 0, kind: 'batch', files: [] }],
    });
    try {
      renderHook(() => useUndoShortcuts());
      render(<DiagramPage selection={{ kind: 'diagram', path: PIPELINE }} />);
      await screen.findByTestId('structural-host');
      const original = fs().get(PIPELINE)!;
      fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
      const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: `${textarea.value}  D --> E[Ship]\n` } });
      await waitFor(() => expect(fs().get(PIPELINE)).toContain('E[Ship]'), { timeout: 3000 });
      const event = new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      screen.getAllByTestId('structural-host')[0]!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(fs().get(PIPELINE)).toBe(original), { timeout: 3000 });
      expect(appUndo).not.toHaveBeenCalled();
    } finally {
      useUndoStore.setState({ undo: before.undo, past: [] });
    }
  });

  // The tombstone keys on the READ failing, not on the entry lookup (M29.23):
  // the file is the truth, so only "nothing readable at this path" says gone.
  it('shows the empty state when the read fails', async () => {
    render(<DiagramPage selection={{ kind: 'diagram', path: 'diagrams/gone.mmd' }} />);
    expect(await screen.findByText('Diagram unavailable')).toBeTruthy();
  });

  it('opens a file the scanner has not adopted yet, titled from its stem', async () => {
    // Written but NOT rescanned — no entry exists for it.
    await writeTextFile('/demo-vault', 'diagrams/brand-new.mmd', 'sequenceDiagram\n  A->>B: x\n');
    expect(useVaultStore.getState().entries.some((e) => e.path === 'diagrams/brand-new.mmd')).toBe(
      false,
    );
    render(<DiagramPage selection={{ kind: 'diagram', path: 'diagrams/brand-new.mmd' }} />);
    expect(await screen.findByTestId('code-overlay')).toBeTruthy();
    expect(screen.getByTestId('diagram-title').textContent).toBe('Brand new');
  });

  // M29.23 CRITICAL regression net, now one debounce deeper: the overlay's
  // 250ms buffer flushes on ITS unmount (CodeOverlay cleanup), which feeds
  // handleChange, whose 500ms timer outlives the unmounted page and still
  // writes the OLD file's bytes to the OLD path — the App.tsx key guarantees
  // the whole chain belongs to the dying instance.
  it('a navigation mid-debounce flushes to the OLD file and never touches the new one', async () => {
    const A = 'diagrams/a.mmd';
    const B = 'diagrams/b.mmd';
    const A_RAW = 'sequenceDiagram\n  A->>A: a\n';
    const B_RAW = 'sequenceDiagram\n  B->>B: b\n';
    await writeTextFile('/demo-vault', A, A_RAW);
    await writeTextFile('/demo-vault', B, B_RAW);
    await useVaultStore.getState().rescan();

    // Mirror App.tsx: the page is KEYED on the selection path.
    const { rerender } = render(<DiagramPage key={A} selection={{ kind: 'diagram', path: A }} />);
    const textarea = (await screen.findByLabelText('Mermaid source')) as HTMLTextAreaElement;
    const edited = `${A_RAW}  A->>B: edited\n`;
    fireEvent.change(textarea, { target: { value: edited } });

    // Navigate to B inside BOTH debounce windows.
    rerender(<DiagramPage key={B} selection={{ kind: 'diagram', path: B }} />);
    await screen.findByTestId('code-overlay');

    // A received its pending edit; B is byte-identical to what was seeded.
    await waitFor(() => expect(fs().get(A)).toBe(edited), { timeout: 3000 });
    expect(fs().get(B)).toBe(B_RAW);
  });
});
