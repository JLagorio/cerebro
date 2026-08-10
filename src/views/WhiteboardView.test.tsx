// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Entry, Presentation } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import { parseFlowchart } from '@/mermaid/flowchart/model';
import { isManualLayout } from '@/mermaid/flowchart/views';
import { makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { WhiteboardView } from './WhiteboardView';

/**
 * The real editor drags in the render chain, and jsdom cannot render mermaid.
 * The stand-in is a textarea on the same `code`/`onChangeCode` contract, so a
 * test can still make an EDIT and watch it reach disk — the lifecycle is what
 * this file is about, not the drawing.
 */
const editorProps = vi.fn();
vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({
  FullScreenDiagramEditor: (props: {
    code: string;
    onChangeCode: (next: string) => void;
    title?: string;
    embedded?: boolean;
    entries?: Entry[];
    onOpenPath?: (path: string) => void;
  }) => {
    editorProps(props);
    return (
      <textarea
        data-testid="fake-editor"
        aria-label="Canvas source"
        value={props.code}
        onChange={(e) => props.onChangeCode(e.target.value)}
      />
    );
  },
}));

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

const base: Presentation = {
  type: 'whiteboard',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [],
};

const schema = buildSchema([]);
const entries = [makeEntry({ path: 'delivery/launch.md', title: 'Launch', type: 'Task' })];

describe('WhiteboardView', () => {
  beforeEach(async () => {
    resetMockFs();
    editorProps.mockClear();
    useUiStore.setState({ toasts: [] });
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('renders the unavailable face when it has no host (a dashboard block)', () => {
    render(<WhiteboardView entries={entries} presentation={base} schema={schema} host={null} />);
    expect(screen.getByTestId('whiteboard-unavailable')).toBeTruthy();
  });

  it('first open creates the canvas file and persists its path', async () => {
    const onPresentationChange = vi.fn();
    render(
      <WhiteboardView
        entries={entries}
        presentation={base}
        schema={schema}
        host={{ folder: 'delivery', viewName: 'Launch map' }}
        onPresentationChange={onPresentationChange}
      />,
    );
    await waitFor(() =>
      expect(onPresentationChange).toHaveBeenCalledWith({
        ...base,
        whiteboard: { file: 'delivery/whiteboards/launch-map.mmd' },
      }),
    );
    // The seed is measured, not assumed: an empty flowchart the visual editor
    // can open, already in manual layout so a dropped node stays dropped.
    const seed = fs().get('delivery/whiteboards/launch-map.mmd')!;
    expect(seed).toContain('flowchart TD');
    const model = parseFlowchart(seed);
    expect(model).not.toBeNull();
    expect(isManualLayout(model!)).toBe(true);
  });

  it('a root-level list creates under whiteboards/ with no leading slash', async () => {
    const onPresentationChange = vi.fn();
    render(
      <WhiteboardView
        entries={entries}
        presentation={base}
        schema={schema}
        host={{ folder: '', viewName: 'Sketch' }}
        onPresentationChange={onPresentationChange}
      />,
    );
    await waitFor(() =>
      expect(onPresentationChange).toHaveBeenCalledWith({
        ...base,
        whiteboard: { file: 'whiteboards/sketch.mmd' },
      }),
    );
  });

  it('creates exactly once, even across re-renders', async () => {
    const onPresentationChange = vi.fn();
    const view = (
      <WhiteboardView
        entries={entries}
        presentation={base}
        schema={schema}
        // A fresh object literal per render, like ListPage's: the guard has to
        // be a ref, not effect deps.
        host={{ folder: 'delivery', viewName: 'Map' }}
        onPresentationChange={onPresentationChange}
      />
    );
    const { rerender } = render(view);
    rerender(view);
    await waitFor(() => expect(onPresentationChange).toHaveBeenCalled());
    expect(onPresentationChange).toHaveBeenCalledTimes(1);
    expect([...fs().keys()].filter((k) => k.startsWith('delivery/whiteboards/'))).toHaveLength(1);
  });

  it('creates nothing when the surface cannot persist the pointer', async () => {
    render(
      <WhiteboardView
        entries={entries}
        presentation={base}
        schema={schema}
        host={{ folder: 'delivery', viewName: 'Map' }}
      />,
    );
    // A canvas written to disk that no view file points at is litter: a
    // read-only host waits instead of creating an orphan on every open.
    await waitFor(() => expect(screen.getByTestId('whiteboard-creating')).toBeTruthy());
    expect([...fs().keys()].filter((k) => k.includes('whiteboards/'))).toHaveLength(0);
  });

  it('renders the editor over an existing file, embedded and titled by the view', async () => {
    fs().set('delivery/whiteboards/map.mmd', 'flowchart TD\n  a[Hello]\n');
    render(
      <WhiteboardView
        entries={entries}
        presentation={{ ...base, whiteboard: { file: 'delivery/whiteboards/map.mmd' } }}
        schema={schema}
        host={{ folder: 'delivery', viewName: 'Map' }}
      />,
    );
    await waitFor(() =>
      expect((screen.getByTestId('fake-editor') as HTMLTextAreaElement).value).toContain(
        'a[Hello]',
      ),
    );
    const props = editorProps.mock.calls.at(-1)![0];
    expect(props.title).toBe('Map');
    expect(props.embedded).toBe(true);
    // The link popover's corpus is the VAULT, not this view's filtered rows:
    // a whiteboard may link a spec the list does not contain (M29.38).
    expect(props.entries.some((e: Entry) => e.path === 'diagrams/pipeline.mmd')).toBe(true);
    expect(typeof props.onOpenPath).toBe('function');
  });

  it('edits on the canvas reach the file', async () => {
    fs().set('delivery/whiteboards/map.mmd', 'flowchart TD\n');
    render(
      <WhiteboardView
        entries={entries}
        presentation={{ ...base, whiteboard: { file: 'delivery/whiteboards/map.mmd' } }}
        schema={schema}
        host={{ folder: 'delivery', viewName: 'Map' }}
      />,
    );
    const textarea = (await screen.findByTestId('fake-editor')) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'flowchart TD\n  a[Drawn]\n' } });
    await waitFor(() => expect(fs().get('delivery/whiteboards/map.mmd')).toContain('a[Drawn]'), {
      timeout: 3000,
    });
  });

  /**
   * The M29.23 keyed-mount contract, travelling with useDiagramFile: the
   * canvas subtree is keyed on the FILE, so re-pointing the tab is a true
   * unmount and the pending flush still belongs to the file it was editing.
   * Without the key the surviving instance's refs point at the new file and
   * the old canvas's last edit is written into it.
   */
  it('re-pointing the tab mid-debounce flushes to the OLD file and never touches the new one', async () => {
    const A = 'delivery/whiteboards/a.mmd';
    const B = 'delivery/whiteboards/b.mmd';
    const A_RAW = 'flowchart TD\n  a[A]\n';
    const B_RAW = 'flowchart TD\n  b[B]\n';
    fs().set(A, A_RAW);
    fs().set(B, B_RAW);
    const host = { folder: 'delivery', viewName: 'Map' };
    const { rerender } = render(
      <WhiteboardView
        entries={entries}
        presentation={{ ...base, whiteboard: { file: A } }}
        schema={schema}
        host={host}
      />,
    );
    const textarea = (await screen.findByTestId('fake-editor')) as HTMLTextAreaElement;
    const edited = `${A_RAW}  a --> c[Edited]\n`;
    fireEvent.change(textarea, { target: { value: edited } });

    rerender(
      <WhiteboardView
        entries={entries}
        presentation={{ ...base, whiteboard: { file: B } }}
        schema={schema}
        host={host}
      />,
    );
    await waitFor(() =>
      expect((screen.getByTestId('fake-editor') as HTMLTextAreaElement).value).toBe(B_RAW),
    );
    await waitFor(() => expect(fs().get(A)).toBe(edited), { timeout: 3000 });
    expect(fs().get(B)).toBe(B_RAW);
  });

  it('a pointer at a missing file shows the tombstone with a fresh-canvas action', async () => {
    const onPresentationChange = vi.fn();
    render(
      <WhiteboardView
        entries={entries}
        presentation={{ ...base, whiteboard: { file: 'delivery/whiteboards/gone.mmd' } }}
        schema={schema}
        host={{ folder: 'delivery', viewName: 'Map' }}
        onPresentationChange={onPresentationChange}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('whiteboard-tombstone')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Start a new canvas' }));
    // Clearing the pointer to the in-memory null re-arms create-on-open.
    expect(onPresentationChange).toHaveBeenCalledWith({
      ...base,
      whiteboard: { file: null },
    });
  });
});
