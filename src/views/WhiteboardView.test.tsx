// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import type { Entry, Presentation, Schema } from '@/engine/types';
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
    overlay?: React.ReactNode;
  }) => {
    editorProps(props);
    return (
      <div>
        <textarea
          data-testid="fake-editor"
          aria-label="Canvas source"
          value={props.code}
          onChange={(e) => props.onChangeCode(e.target.value)}
        />
        {props.overlay}
      </div>
    );
  },
}));

/**
 * The canvas's WRITE CHANNEL, counted.
 *
 * Rendered `code` cannot answer "how many commits was that": React batches
 * synchronous state updates, so two `handleChange` calls in one handler
 * collapse into a single render and a two-step insertion would look exactly
 * like a one-step one (measured — the naive version of the test below passed
 * against a deliberately two-step implementation). The real hook is kept and
 * only its one write function is wrapped, so the counting instrument changes
 * no behaviour.
 */
const changes = vi.fn();
vi.mock('@/mermaid/useDiagramFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/mermaid/useDiagramFile')>();
  return {
    ...actual,
    useDiagramFile: (path: string) => {
      const file = actual.useDiagramFile(path);
      return {
        ...file,
        handleChange: (next: string) => {
          changes(next);
          file.handleChange(next);
        },
      };
    },
  };
});

/** The chips have their own suite; here only WHAT THEY ARE GIVEN matters. */
const overlayProps = vi.fn();
vi.mock('@/views/RecordChipOverlay', () => ({
  RecordChipOverlay: (props: { code: string; entries: Entry[]; schema: Schema }) => {
    overlayProps(props);
    return <div data-testid="fake-overlay" />;
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

/** A record the "Add record" tests place on the canvas. */
const shipV2 = makeEntry({ path: 'delivery/ship-v2.md', title: 'Ship v2', type: 'Task' });
const MAP = 'delivery/whiteboards/map.mmd';
const host = { folder: 'delivery', viewName: 'Map' };
const onMap: Presentation = { ...base, whiteboard: { file: MAP } };

describe('WhiteboardView', () => {
  beforeEach(async () => {
    resetMockFs();
    editorProps.mockClear();
    overlayProps.mockClear();
    changes.mockClear();
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

  describe('record cards (M29.47)', () => {
    const mount = (viewEntries: Entry[] = [shipV2]) =>
      render(
        <WhiteboardView entries={viewEntries} presentation={onMap} schema={schema} host={host} />,
      );

    it('Add record inserts a titled node and its click binding, and it reaches the file', async () => {
      fs().set(MAP, 'flowchart TD\n');
      mount();
      await screen.findByTestId('fake-editor');
      await userEvent.click(screen.getByTestId('whiteboard-add-record'));
      await userEvent.click(screen.getByTestId('whiteboard-add-option'));
      await waitFor(
        () => {
          const file = fs().get(MAP) ?? '';
          expect(file).toContain('Ship v2');
          expect(file).toContain('click');
          expect(file).toContain('delivery/ship-v2.md');
        },
        { timeout: 3000 },
      );
    });

    it('the insertion is ONE commit — no step where the node exists unbound', async () => {
      // Spec D10, and the reason `insertRecordNode` serializes once: two model
      // ops, one source, one onChangeCode, one undo step. Two commits would
      // leave an undo that strips the binding and keeps a node named after a
      // record.
      fs().set(MAP, 'flowchart TD\n');
      mount();
      await screen.findByTestId('fake-editor');
      await userEvent.click(screen.getByTestId('whiteboard-add-record'));
      await userEvent.click(screen.getByTestId('whiteboard-add-option'));
      expect(changes).toHaveBeenCalledTimes(1);
      const written = changes.mock.calls[0][0] as string;
      expect(written).toContain('Ship v2');
      expect(written).toContain('click');
      expect(written).toContain('delivery/ship-v2.md');
    });

    it('a record already on the canvas is not offered again', async () => {
      fs().set(MAP, 'flowchart TD\n  a[Ship v2]\n  click a "delivery/ship-v2.md"\n');
      mount();
      await screen.findByTestId('fake-editor');
      await userEvent.click(screen.getByTestId('whiteboard-add-record'));
      expect(screen.queryByTestId('whiteboard-add-option')).toBeNull();
      expect(screen.getByText('Every record is already on the canvas')).toBeTruthy();
    });

    it('an empty view says so rather than claiming the canvas holds everything', async () => {
      fs().set(MAP, 'flowchart TD\n');
      mount([]);
      await screen.findByTestId('fake-editor');
      await userEvent.click(screen.getByTestId('whiteboard-add-record'));
      expect(screen.getByText('This view has no records yet')).toBeTruthy();
    });

    it('typing narrows the offer through the app’s own fuzzy matcher', async () => {
      fs().set(MAP, 'flowchart TD\n');
      mount([shipV2, makeEntry({ path: 'delivery/beta.md', title: 'Beta program' })]);
      await screen.findByTestId('fake-editor');
      await userEvent.click(screen.getByTestId('whiteboard-add-record'));
      expect(screen.getAllByTestId('whiteboard-add-option')).toHaveLength(2);
      await userEvent.type(screen.getByLabelText('Find a record'), 'beta');
      const options = screen.getAllByTestId('whiteboard-add-option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toContain('Beta program');
    });

    it('the picker offers the view’s records; the chips resolve against the whole vault', async () => {
      fs().set(MAP, 'flowchart TD\n');
      mount();
      await screen.findByTestId('fake-overlay');
      // A node can name a record this tab's filter excludes — the chip still
      // has to resolve it, the same reasoning the link popover's vault-wide
      // corpus rests on (M29.38).
      const props = overlayProps.mock.calls.at(-1)![0] as { entries: Entry[] };
      expect(props.entries.some((e) => e.path === 'delivery/how-we-schedule.md')).toBe(true);
      // The OFFER, though, is exactly this view's rows — already filtered,
      // sorted and limited by the page that built them.
      await userEvent.click(screen.getByTestId('whiteboard-add-record'));
      const options = screen.getAllByTestId('whiteboard-add-option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toContain('Ship v2');
    });

    it('a canvas that is not a flowchart says so, and changes nothing', async () => {
      fs().set(MAP, 'gantt\n  title Roadmap\n');
      mount();
      await screen.findByTestId('fake-editor');
      await userEvent.click(screen.getByTestId('whiteboard-add-record'));
      await userEvent.click(screen.getByTestId('whiteboard-add-option'));
      expect(
        useUiStore
          .getState()
          .toasts.map((t) => t.message)
          .join(' '),
      ).toContain('flowchart');
      // A refusal is a TRUE no-op: no commit, so nothing to undo and nothing
      // for the autosave to write.
      expect(changes).not.toHaveBeenCalled();
      expect(fs().get(MAP)).toBe('gantt\n  title Roadmap\n');
    });
  });
});
