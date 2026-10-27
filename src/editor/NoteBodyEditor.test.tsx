import { MockRecovery, mockRecovery, type RecoveryRow } from '@/lib/mockRecovery';
import { PaneContext, useNavStore } from '@/stores/navStore';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy mode: every read still reaches the mock disk, and a case can count them.
vi.mock('@/lib/ipc', { spy: true });
import { makeEntry } from '@/engine/testHelpers';
import { calculateSheets, readNote, readNoteSource, saveNoteBody } from '@/lib/ipc';
import { sha256Hex } from '@/lib/sha256';
import { resetMockFs, saveNoteBody as mockSaveNoteBody } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { EditorReadyInfo } from './MarkdownEditor';
import { NoteBodyEditor, type SaveState } from './NoteBodyEditor';
import { pendingSheetDrafts, registerSheetDraft } from '@/sheet/pendingSheets';
import { resetSheetCache } from '@/sheet/useSheetWorkbook';
import {
  __resetOpenPages,
  announceExternalWrites,
  flushOpenPages,
  editorHoldersOf,
  unresolvedDocumentOwners,
  unresolvedOpenPages,
} from './openPages';

const PAGE = 'inbox/test-page.md';
const LOSSY_BODY = '# Page\n\n<div align="center">raw html island</div>\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

type ReadyInfo = EditorReadyInfo;

async function renderReady(
  path: string,
  props: { onSaveState?: (s: SaveState) => void } = {},
): Promise<ReadyInfo> {
  const onReady = vi.fn<(info: ReadyInfo) => void>();
  render(<NoteBodyEditor path={path} debounceMs={20} onReady={onReady} {...props} />);
  await waitFor(() => expect(onReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
  return onReady.mock.calls[0][0];
}

const appendParagraph = (editor: ReadyInfo['editor'], text: string) => {
  const last = editor.document[editor.document.length - 1];
  editor.insertBlocks([{ type: 'paragraph', content: text }], last, 'after');
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

/**
 * The budget for any assertion waiting on the debounce → save → rescan chain.
 *
 * `waitFor`'s 1s default has no margin for it: a 20ms debounce, an async
 * mock-fs write, and (where the store's `rescan` is not stubbed) a scan of the
 * whole mock disk all have to land, on a worker the full suite is running wide
 * enough to starve. It flaked at roughly one full-suite run in seven once M29's
 * mermaid modules joined MarkdownEditor's block graph (MarkdownEditor.tsx
 * registers a `mermaid` block) — but the thin budget was always the defect, and
 * the added load only found it.
 *
 * Named rather than spelled `{ timeout: 5_000 }` per site because it was
 * spelled per site once and two sites were missed — the title-sync assertion,
 * which then failed in CI (the worst case: it needs the rescan too, not just
 * the write), and the save-failure toast, which has the same shape and had not
 * been reached yet. If an assertion here waits on disk, it takes this.
 */
const DISK_ROUND_TRIP = { timeout: 5_000 };

// Warm the real lazy module before each test's disk assertion budget starts.
beforeAll(async () => {
  await import('./MarkdownEditor');
});

describe('NoteBodyEditor', () => {
  beforeEach(() => {
    resetSheetCache();
    vi.mocked(calculateSheets).mockImplementation(async (sheets) =>
      sheets.map((sheet) => ({
        ok: true,
        name: sheet.name,
        rows: 1,
        cols: 1,
        cells: [],
      })),
    );
    resetMockFs();
    fs().set(PAGE, '---\ntype: Doc\n---\n\n# Test page\n\nBody line here.\n');
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [],
      views: [],
      folders: [],
      status: 'ready',
      error: null,
    });
    useUiStore.setState({ toasts: [] });
  });
  afterEach(() => {
    cleanup();
    __resetOpenPages();
  });

  it('recovery storage failure retains the real editor draft and explicit bypass uses its existing writer', async () => {
    class Broken extends Map<string, RecoveryRow> {
      override set(): this {
        throw new Error('disk full');
      }
    }
    const journal = new MockRecovery(new Broken());
    journal.setEnabled('/demo-vault', true);
    const capture = vi
      .spyOn(mockRecovery, 'capture')
      .mockImplementation(journal.capture.bind(journal));
    const lookup = vi
      .spyOn(mockRecovery, 'failure')
      .mockImplementation(journal.failure.bind(journal));
    const before = fs().get(PAGE);
    const info = await renderReady(PAGE);
    act(() => appendParagraph(info.editor, 'Exact recovery draft.'));
    await screen.findByRole('button', { name: 'Save without a recovery copy' }, DISK_ROUND_TRIP);
    expect(fs().get(PAGE)).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() =>
      expect(vi.mocked(saveNoteBody).mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(
      vi.mocked(saveNoteBody).mock.calls.every(([args]) => args.recoveryBypass === undefined),
    ).toBe(true);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Save without a recovery copy' }, DISK_ROUND_TRIP),
    );
    await waitFor(() => expect(fs().get(PAGE)).toContain('Exact recovery draft.'), DISK_ROUND_TRIP);
    expect((await screen.findByRole('status')).textContent).toContain(
      'Saved without a recovery copy',
    );
    expect(vi.mocked(saveNoteBody).mock.calls.at(-1)?.[0].recoveryBypass).toMatch(/^mock-permit-/);
    expect(journal.status('/demo-vault').enabled).toBe(true);
    capture.mockRestore();
    lookup.mockRestore();
  });

  it('source presentation preserves raw prefix and unsupported bytes without mode-switch writes', async () => {
    const raw =
      '\ufeff---\r\ntitle: Exact\r\n--- \t\r\n\r\n# Page\r\n\r\n<div>keep😀</div>\r\nlast\r\n';
    fs().set(PAGE, raw);
    const mounted = render(
      <NoteBodyEditor
        path={PAGE}
        pageTitle="Page"
        debounceMs={20}
        pageChrome={<input aria-label="Stable metadata" defaultValue="draft" />}
      />,
    );
    await screen.findByRole('button', { name: 'Source' });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Source' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    const metadata = screen.getByRole('textbox', { name: 'Stable metadata' });
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = await screen.findByRole('textbox', { name: 'Page source' });
    expect((source as HTMLTextAreaElement).value).toBe('\n# Page\n\n<div>keep😀</div>\nlast\n');
    expect(fs().get(PAGE)).toBe(raw);
    expect(screen.getByRole('textbox', { name: 'Stable metadata' })).toBe(metadata);
    fireEvent.change(source, { target: { value: '\n# Page\n\n<div>keep😀</div>\nchanged\n' } });
    await waitFor(() => expect(fs().get(PAGE)).toBe(raw.replace('last', 'changed')));
    fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
    expect(screen.getByRole('textbox', { name: 'Page source' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('cannot');
    mounted.unmount();
  });

  it('source failures retain exact latest bytes across reopen and retry without another edit', async () => {
    const raw = '\ufeff---\r\ntype: Doc\r\n--- \t\r\n\r\n# Source\r\n<div>keep</div>\r\none\r\n';
    fs().set(PAGE, raw);
    await renderReady(PAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const textarea = await screen.findByRole('textbox', { name: 'Page source' });
    vi.mocked(saveNoteBody)
      .mockRejectedValueOnce(new Error('source offline'))
      .mockRejectedValueOnce(new Error('source still offline'));
    fireEvent.change(textarea, { target: { value: '\n# Source\n<div>keep</div>\nfirst\n' } });
    await screen.findByRole('button', { name: 'Retry save' });
    fireEvent.change(textarea, {
      target: { value: '\n# Source\n<div>keep</div>\nlatest exact\n' },
    });
    await waitFor(() =>
      expect(unresolvedDocumentOwners()[0].snapshot().failure?.generation).toBe(2),
    );
    expect(fs().get(PAGE)).toBe(raw);
    cleanup();
    await renderReady(PAGE);
    expect(
      (screen.getByRole('textbox', { name: 'Page source' }) as HTMLTextAreaElement).value,
    ).toContain('latest exact');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(fs().get(PAGE)).toBe(raw.replace('one', 'latest exact')));
  });

  it('clean source reopen rereads current authoritative raw bytes instead of retaining a body cache', async () => {
    const raw = '\ufeff# Source\r\n<div>first</div>\r\n';
    fs().set(PAGE, raw);
    await renderReady(PAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('textbox', { name: 'Page source' });
    cleanup();
    fs().set(PAGE, raw.replace('first', 'new outside'));
    await renderReady(PAGE);
    expect(
      (screen.getByRole('textbox', { name: 'Page source' }) as HTMLTextAreaElement).value,
    ).toBe('# Source\n<div>new outside</div>\n');
    expect(fs().get(PAGE)).toBe(raw.replace('first', 'new outside'));
  });

  it('source external overlap holds the latest raw draft and keeps current metadata on explicit Keep yours', async () => {
    const raw = '---\r\ntitle: Original\r\n---\r\n\r\n# Source\r\n<div>mine</div>\r\n';
    fs().set(PAGE, raw);
    await renderReady(PAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const textarea = await screen.findByRole('textbox', { name: 'Page source' });
    vi.mocked(saveNoteBody).mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(textarea, { target: { value: '\n# Source\n<div>local exact</div>\n' } });
    await screen.findByRole('button', { name: 'Retry save' });
    const outside = raw
      .replace('title: Original', 'title: Outside')
      .replace('<div>mine</div>', '<div>outside</div>');
    await act(async () => {
      fs().set(PAGE, outside);
      await announceExternalWrites([PAGE], async () => undefined);
    });
    await screen.findByTestId('merge-choice');
    fireEvent.change(screen.getByRole('textbox', { name: 'Page source' }), {
      target: { value: '\n# Source\n<div>newest exact</div>\n' },
    });
    fireEvent.click(screen.getByTestId('merge-keep-mine'));
    await waitFor(() =>
      expect(fs().get(PAGE)).toBe(outside.replace('<div>outside</div>', '<div>newest exact</div>')),
    );
  });

  it('switching a representable source back to rich preserves the metadata node and writes nothing', async () => {
    const before = fs().get(PAGE);
    const ready = vi.fn<(info: ReadyInfo) => void>();
    render(
      <NoteBodyEditor
        path={PAGE}
        pageTitle="Test page"
        pageChrome={<input aria-label="Mode metadata" defaultValue="local field" />}
        onReady={ready}
      />,
    );
    await waitFor(() => expect(ready).toHaveBeenCalled());
    const metadata = screen.getByRole('textbox', { name: 'Mode metadata' });
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('textbox', { name: 'Page source' });
    fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Mode metadata' })).toBe(metadata);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(fs().get(PAGE)).toBe(before);
  });

  it('stays clean after an untouched source round trip and its debounce window', async () => {
    const raw = '---\r\ntitle: Exact\r\n---\r\n\r\n# Test page\r\n\r\nBody stays.\r\n';
    fs().set(PAGE, raw);
    const states: SaveState[] = [];
    const callback = vi.fn<(info: ReadyInfo) => void>();
    render(
      <NoteBodyEditor
        path={PAGE}
        pageTitle="Test page"
        debounceMs={20}
        onReady={callback}
        onSaveState={(state) => states.push(state)}
      />,
    );
    await waitFor(() => expect(callback).toHaveBeenCalled());
    const writesBefore = vi.mocked(saveNoteBody).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('textbox', { name: 'Page source' });
    fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull());
    await act(settle);
    expect(vi.mocked(saveNoteBody).mock.calls).toHaveLength(writesBefore);
    expect(fs().get(PAGE)).toBe(raw);
    expect(unresolvedDocumentOwners()).toHaveLength(0);
    expect(states.at(-1)).toBe('idle');
  });

  it('retains source while related tabs hide the body without remounting metadata', async () => {
    const onReady = vi.fn<(info: ReadyInfo) => void>();
    const props = {
      path: PAGE,
      pageTitle: 'Test page',
      pageChrome: <input aria-label="Related tab metadata" defaultValue="draft" />,
      onReady,
    };
    const view = render(<NoteBodyEditor {...props} />);
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const before = fs().get(PAGE);
    const metadata = screen.getByRole('textbox', { name: 'Related tab metadata' });
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('textbox', { name: 'Page source' });
    view.rerender(<NoteBodyEditor {...props} bodyVisible={false} />);
    expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Related tab metadata' })).toBe(metadata);
    view.rerender(<NoteBodyEditor {...props} />);
    expect(screen.getByRole('textbox', { name: 'Page source' })).toBeTruthy();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(fs().get(PAGE)).toBe(before);
  });

  it('validates newer source typing again when rich conversion was already pending', async () => {
    const callback = vi.fn<(info: ReadyInfo) => void>();
    render(<NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={callback} />);
    await waitFor(() => expect(callback).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = await screen.findByRole('textbox', { name: 'Page source' });
    const info = callback.mock.calls[0][0];
    const present = info.presentMarkdown;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const conversion = vi.spyOn(info, 'presentMarkdown').mockImplementationOnce(async (...args) => {
      await pending;
      return present(...args);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
    await waitFor(() => expect(conversion).toHaveBeenCalledTimes(1));
    const newest = '# Test page\n\n<div>new raw source while converting</div>\n';
    fireEvent.change(source, { target: { value: newest } });
    await act(async () => {
      finish();
      await pending;
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cannot'));
    expect(
      (screen.getByRole('textbox', { name: 'Page source' }) as HTMLTextAreaElement).value,
    ).toBe(newest);
    expect(unresolvedDocumentOwners()[0].snapshot().latestDraft).toBe(newest);
  });

  it('rereads a source transition after an outside body was accepted during its older read', async () => {
    const initial = '---\r\ntitle: Kept\r\n--- \t\r\n\r\n# Page\r\n\r\nOriginal text.\r\n';
    fs().set(PAGE, initial);
    const callback = vi.fn<(info: ReadyInfo) => void>();
    render(<NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={callback} />);
    await waitFor(() => expect(callback).toHaveBeenCalled());
    let release!: (snapshot: Awaited<ReturnType<typeof readNoteSource>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof readNoteSource>>>((resolve) => {
      release = resolve;
    });
    let readStarted = false;
    vi.mocked(readNoteSource).mockImplementationOnce(() => {
      readStarted = true;
      return pending;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await waitFor(() => expect(readStarted).toBe(true));
    const outside = initial.replace('Original text.', 'Outside accepted during source read.');
    await act(async () => {
      fs().set(PAGE, outside);
      await announceExternalWrites([PAGE], async () => undefined);
    });
    await waitFor(() =>
      expect(callback.mock.calls[0][0].serialize()).toContain('Outside accepted'),
    );
    await act(async () => {
      release({ content: initial, hash: sha256Hex(initial) });
      await pending;
    });
    const source = await screen.findByRole('textbox', { name: 'Page source' });
    fireEvent.change(source, {
      target: { value: (source as HTMLTextAreaElement).value + '\nNew local line.\n' },
    });
    await act(() => flushOpenPages());
    expect(fs().get(PAGE)).toContain('Outside accepted during source read.');
    expect(fs().get(PAGE)).toContain('New local line.');
    expect(fs().get(PAGE)).toBe(outside + '\r\nNew local line.\r\n');
  });

  it('switching dirty rich text to source reconciles an outside body observed by the source read', async () => {
    const callback = vi.fn<(info: ReadyInfo) => void>();
    render(<NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={callback} />);
    await waitFor(() => expect(callback).toHaveBeenCalled());
    const info = callback.mock.calls[0][0];
    act(() =>
      info.editor.updateBlock(info.editor.document[1], { content: 'My retained rich draft.' }),
    );
    const outside = '# Test page\n\nOutside observed during switch.\n';
    fs().set(PAGE, outside);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('textbox', { name: 'Page source' });
    await screen.findByTestId('merge-choice');
    expect(
      (screen.getByRole('textbox', { name: 'Page source' }) as HTMLTextAreaElement).value,
    ).toContain('My retained rich draft.');
    expect(fs().get(PAGE)).toBe(outside);
  });

  it('loads the note body into the rich editor', async () => {
    await renderReady(PAGE);
    await waitFor(() => expect(screen.getByText('Body line here.')).toBeTruthy());
  });

  it('reports a failed body write against its complete retained identity', async () => {
    const info = await renderReady(PAGE);
    vi.mocked(saveNoteBody).mockRejectedValueOnce(new Error('disk_full'));
    act(() => appendParagraph(info.editor, 'Retain this exact failed body'));
    let report: Awaited<ReturnType<typeof flushOpenPages>>;
    await act(async () => {
      report = await flushOpenPages();
    });
    expect(report!.outcomes).toContainEqual(
      expect.objectContaining({
        kind: 'failed',
        code: 'disk_full',
        ownerId: JSON.stringify(['/demo-vault', PAGE, useNavStore.getState().active]),
      }),
    );
    expect(fs().get(PAGE)).not.toContain('Retain this exact failed body');
  });

  it('does not save the parent body when a focused sheet refuses preparation', async () => {
    const info = await renderReady(PAGE);
    const unregister = registerSheetDraft(info.editor, 'refused-cell', () => false);
    act(() => appendParagraph(info.editor, 'Parent waiting on its sheet'));
    let report: Awaited<ReturnType<typeof flushOpenPages>>;
    await act(async () => {
      report = await flushOpenPages();
    });
    expect(report!.outcomes).toContainEqual(
      expect.objectContaining({ kind: 'failed', code: 'prepare_failed' }),
    );
    expect(report!.unresolvedOwnerIds).toHaveLength(1);
    await act(settle);
    expect(fs().get(PAGE)).not.toContain('Parent waiting on its sheet');
    unregister();
    await act(() => flushOpenPages());
  });

  it('restores a refused real sheet cell after the whole page reparses, then saves it once', async () => {
    fs().set(PAGE, '# Sheet page\n\n```cerebro-sheet\n1\n```\n');
    const firstReady = vi.fn<(info: ReadyInfo) => void>();
    const first = render(<NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={firstReady} />);
    await waitFor(() => expect(firstReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
    const old = firstReady.mock.calls[0][0].editor;
    fireEvent.keyDown(screen.getByTestId('sheet-grid'), { key: 'x' });
    const exact = '  exact after full page remount  ';
    fireEvent.change(screen.getByTestId('sheet-cell-editor'), { target: { value: exact } });
    old.isEditable = false;
    let report!: Awaited<ReturnType<typeof flushOpenPages>>;
    await act(async () => {
      report = await flushOpenPages();
    });
    expect(report.unresolvedOwnerIds).toHaveLength(1);
    expect(pendingSheetDrafts(old)[0].draft.text).toBe(exact);
    const oldId = pendingSheetDrafts(old)[0].id;
    first.unmount();
    const nextReady = vi.fn<(info: ReadyInfo) => void>();
    render(<NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={nextReady} />);
    await waitFor(() => expect(nextReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
    const next = nextReady.mock.calls[0][0].editor;
    expect(next).not.toBe(old);
    expect(pendingSheetDrafts(next)[0]?.id).not.toBe(oldId);
    expect(pendingSheetDrafts(next)[0]?.draft.text).toBe(exact);
    expect(screen.getByTestId('sheet-cell-editor')).toHaveProperty('value', exact);
    expect(unresolvedOpenPages()).toHaveLength(1);
    await act(async () => {
      report = await flushOpenPages();
    });
    expect(report.unresolvedOwnerIds).toEqual([]);
    expect(fs().get(PAGE)).toContain(exact);
    expect(pendingSheetDrafts(next)).toEqual([]);
    act(() => next.undo());
    expect(nextReady.mock.calls[0][0].serialize()).not.toContain(exact);
  });

  it.each(['changed', 'ambiguous'] as const)(
    'retains the original cell without attaching it to an externally %s sheet',
    async (change) => {
      const initial = '# Sheet page\n\n```cerebro-sheet\n1\n```\n';
      fs().set(PAGE, initial);
      const firstReady = vi.fn<(info: ReadyInfo) => void>();
      const first = render(<NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={firstReady} />);
      await waitFor(() => expect(firstReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
      fireEvent.keyDown(screen.getByTestId('sheet-grid'), { key: 'x' });
      const exact = 'original-target-only';
      fireEvent.change(screen.getByTestId('sheet-cell-editor'), { target: { value: exact } });
      firstReady.mock.calls[0][0].editor.isEditable = false;
      await act(() => flushOpenPages());
      first.unmount();
      const outside =
        change === 'changed'
          ? initial.replace('\n1\n', '\n99\n')
          : initial + '\n```cerebro-sheet\n1\n```\n';
      fs().set(PAGE, outside);
      const nextReady = vi.fn<(info: ReadyInfo) => void>();
      render(<NoteBodyEditor path={PAGE} debounceMs={60_000} onReady={nextReady} />);
      await waitFor(() => expect(nextReady).toHaveBeenCalled(), DISK_ROUND_TRIP);
      let report!: Awaited<ReturnType<typeof flushOpenPages>>;
      await act(async () => {
        report = await flushOpenPages();
      });
      expect(report.unresolvedOwnerIds).toHaveLength(1);
      expect(
        pendingSheetDrafts(nextReady.mock.calls[0][0].editor).map((item) => item.draft.text),
      ).toEqual([exact]);
      expect(screen.queryByTestId('sheet-cell-editor')).toBeNull();
      expect(fs().get(PAGE)).toBe(outside);
    },
  );

  it('keeps metadata mounted while the live title projection changes and undoes', async () => {
    const ready = vi.fn<(info: EditorReadyInfo) => void>();
    render(
      <NoteBodyEditor
        path={PAGE}
        pageTitle="Test page"
        debounceMs={60_000}
        pageChrome={<input aria-label="Unfinished metadata" defaultValue="" />}
        onReady={ready}
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Unfinished metadata' });
    fireEvent.change(field, { target: { value: 'Still drafting' } });
    await waitFor(() => expect(ready).toHaveBeenCalled(), DISK_ROUND_TRIP);
    const owner = ready.mock.calls[0][0];
    expect(screen.getAllByRole('heading', { name: 'Test page' })).toHaveLength(1);
    expect(screen.queryByRole('textbox', { name: 'Document title' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Unfinished metadata' })).toBe(field);
    expect((field as HTMLInputElement).value).toBe('Still drafting');
    act(() => owner.editor.updateBlock(owner.editor.document[0], { type: 'paragraph' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Document title' })).toBeTruthy(),
    );
    expect(screen.queryByRole('heading', { name: 'Test page' })).toBeNull();
    act(() => owner.editor.undo());
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Document title' })).toBeNull(),
    );
    expect(screen.getAllByRole('heading', { name: 'Test page' })).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Unfinished metadata' })).toBe(field);
    expect((field as HTMLInputElement).value).toBe('Still drafting');
    expect(fs().get(PAGE)).toBe('---\ntype: Doc\n---\n\n# Test page\n\nBody line here.\n');
  });

  it('preserves an in-progress filename composition before reconciling an outside title', async () => {
    fs().set(PAGE, 'A body without a heading.\n');
    const ready = vi.fn<(info: EditorReadyInfo) => void>();
    render(
      <NoteBodyEditor path={PAGE} pageTitle="Test page" onReady={ready} debounceMs={60_000} />,
    );
    await waitFor(() => expect(ready).toHaveBeenCalled(), DISK_ROUND_TRIP);
    const fallback = screen.getByRole('textbox', { name: 'Document title' });
    fireEvent.compositionStart(fallback);
    fireEvent.change(fallback, { target: { value: '正在写标题' } });
    expect(fs().get(PAGE)).toBe('A body without a heading.\n');
    await act(async () => {
      fs().set(PAGE, '# Outside title\n\nA body without a heading.\n');
      await announceExternalWrites([PAGE], () => Promise.resolve());
    });
    await waitFor(() => expect(ready.mock.calls[0][0].serialize()).toContain('正在写标题'));
    expect(ready.mock.calls[0][0].serialize()).toContain('A body without a heading.');
    await act(() => flushOpenPages());
    expect(fs().get(PAGE)).toContain('正在写标题');
    expect(fs().get(PAGE)).toContain('Outside title');
  });

  it('persists a debounced edit and preserves the frontmatter', async () => {
    const { editor } = await renderReady(PAGE);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks([{ type: 'paragraph', content: 'Fresh words' }], last, 'after');
    await waitFor(() => expect(fs().get(PAGE)).toContain('Fresh words'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)!.startsWith('---\ntype: Doc\n---\n')).toBe(true);
  });

  it('saves an edit made as soon as the editor reports ready', async () => {
    render(
      <NoteBodyEditor
        path={PAGE}
        debounceMs={20}
        onReady={({ editor }) => appendParagraph(editor, 'Edited when ready')}
      />,
    );
    await waitFor(() => expect(fs().get(PAGE)).toContain('Edited when ready'), DISK_ROUND_TRIP);
  });

  it('an H1 edit syncs the entry title through the rescan', async () => {
    const { editor } = await renderReady(PAGE);
    editor.updateBlock(editor.document[0], { content: 'Renamed page' });
    await waitFor(() => {
      const entry = useVaultStore.getState().entries.find((e) => e.path === PAGE);
      expect(entry?.title).toBe('Renamed page');
    }, DISK_ROUND_TRIP);
  });

  it('warns when the file holds content the editor would drop', async () => {
    fs().set(PAGE, LOSSY_BODY);
    await renderReady(PAGE);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('raw HTML'));
  });

  /* The banner blamed raw HTML whatever the check found (M55.15). A link
     reference definition is markdown the editor drops, and holds no HTML. */
  it('names the cause when the file loses text that is not raw HTML', async () => {
    fs().set(PAGE, '# Page\n\nSee [the spec][spec].\n\n[spec]: https://example.com "The spec"\n');
    await renderReady(PAGE);
    const banner = await screen.findByTestId('lossy-import-banner');
    expect(banner.textContent).toContain("Parts of this file can't be shown in the rich editor.");
    expect(banner.textContent).not.toContain('HTML');
    expect(screen.getByRole('button', { name: /Edit anyway/ }).textContent).not.toContain('HTML');
  });

  /* A bare fence reopened as `javascript`, a word the file never had, and
     the page opened locked for it (M55.15). */
  it('opens a page with a bare code fence editable', async () => {
    fs().set(PAGE, '# Page\n\n```\nnpm install\n```\n');
    const { editor } = await renderReady(PAGE);
    await settle();
    expect(screen.queryByTestId('lossy-import-banner')).toBeNull();
    expect(editor.isEditable).toBe(true);
    expect(editor.document[1]).toMatchObject({ type: 'codeBlock', props: { language: '' } });
  });

  // The banner used to be the ENTIRE mitigation: the editor stayed live and
  // the first keystroke autosaved the raw HTML out of the file 500 ms later.
  it('mounts a lossy import read-only so an edit cannot reach disk', async () => {
    fs().set(PAGE, LOSSY_BODY);
    const { editor } = await renderReady(PAGE);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
    appendParagraph(editor, 'stray keystroke');
    await settle();
    expect(fs().get(PAGE)).toBe(LOSSY_BODY);
  });

  it('"Edit anyway" unlocks the editor and only then does a save land', async () => {
    fs().set(PAGE, LOSSY_BODY);
    const { editor } = await renderReady(PAGE);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Edit anyway/ }));
    appendParagraph(editor, 'deliberate edit');
    await waitFor(() => expect(fs().get(PAGE)).toContain('deliberate edit'), DISK_ROUND_TRIP);
  });

  // Autosave used to be entirely invisible — no dirty marker, no saved state.
  it('reports the save lifecycle so the host can show it', async () => {
    const states: SaveState[] = [];
    const { editor } = await renderReady(PAGE, { onSaveState: (s) => states.push(s) });
    appendParagraph(editor, 'Fresh words');
    await waitFor(() => expect(states).toContain('saved'), DISK_ROUND_TRIP);
    expect(states).toContain('dirty');
    expect(states.indexOf('dirty')).toBeLessThan(states.indexOf('saved'));
  });

  it('toasts when a save fails instead of rejecting silently', async () => {
    const { editor } = await renderReady(PAGE);
    // Force the write to fail: a read-only file map stand-in — drop the
    // path so mock saveNote's mustGet throws.
    fs().delete(PAGE);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks([{ type: 'paragraph', content: 'doomed edit' }], last, 'after');
    await waitFor(() => {
      const messages = useUiStore.getState().toasts.map((t) => t.message);
      // M49.6: the toast carries WHY, not just that.
      expect(messages.some((m) => m.startsWith("Couldn't save page: ") && m.length > 20)).toBe(
        true,
      );
    }, DISK_ROUND_TRIP);
  });

  it('retry_without_edit_uses_latest_draft', async () => {
    const save = vi.mocked(saveNoteBody);
    save.mockClear();
    save
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline again'));
    const info = await renderReady(PAGE);
    appendParagraph(info.editor, 'exact retained draft');
    await screen.findByRole('button', { name: 'Retry save' }, DISK_ROUND_TRIP);
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(save.mock.calls.length).toBe(2));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Retry save' }).closest('[role=alert]'),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(fs().get(PAGE)).toContain('exact retained draft'), DISK_ROUND_TRIP);
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull();
  });

  it('retains an unmounted failed draft for retry after reopening', async () => {
    vi.mocked(saveNoteBody).mockRejectedValueOnce(new Error('offline'));
    const info = await renderReady(PAGE);
    appendParagraph(info.editor, 'exact unmounted draft');
    await screen.findByRole('button', { name: 'Retry save' }, DISK_ROUND_TRIP);
    cleanup();
    const reopened = await renderReady(PAGE);
    expect(reopened.serialize()).toContain('exact unmounted draft');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(fs().get(PAGE)).toContain('exact unmounted draft'), DISK_ROUND_TRIP);
  });

  it('a delayed attachment read cannot erase a save acknowledged before its response', async () => {
    useVaultStore.setState({ rescan: async () => undefined });
    const original = '# Test page\n\nBody line here.\n';
    let finishWrite!: () => void;
    const writeReady = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    vi.mocked(saveNoteBody).mockImplementationOnce(async (args) => {
      await writeReady;
      return mockSaveNoteBody(args);
    });
    const first = await renderReady(PAGE);
    act(() =>
      first.editor.updateBlock(first.editor.document[1], { content: 'Acknowledged exact edit.' }),
    );
    await waitFor(() =>
      expect(unresolvedDocumentOwners()[0].snapshot().inFlightGeneration).not.toBeNull(),
    );
    cleanup();
    let releaseRead!: (body: string) => void;
    const staleRead = new Promise<string>((resolve) => {
      releaseRead = resolve;
    });
    const read = vi.mocked(readNote);
    read.mockClear();
    read.mockImplementationOnce(() => staleRead);
    const reopening = renderReady(PAGE);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishWrite();
      await writeReady;
    });
    await waitFor(() => expect(fs().get(PAGE)).toContain('Acknowledged exact edit.'));
    await waitFor(() => expect(unresolvedDocumentOwners()).toHaveLength(0));
    await act(async () => {
      releaseRead(original);
      await staleRead;
    });
    const second = await reopening;
    act(() => appendParagraph(second.editor, 'A later user edit.'));
    await waitFor(() => expect(fs().get(PAGE)).toContain('A later user edit.'));
    expect(fs().get(PAGE)).toContain('Acknowledged exact edit.');
    expect(second.serialize()).toContain('Acknowledged exact edit.');
  });

  it('attachment settlement resumes a coalesced draft held behind its earlier write', async () => {
    useVaultStore.setState({ rescan: async () => undefined });
    let finishWrite!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    vi.mocked(saveNoteBody).mockImplementationOnce(async (args) => {
      await pending;
      return mockSaveNoteBody(args);
    });
    const first = await renderReady(PAGE);
    act(() =>
      first.editor.updateBlock(first.editor.document[1], { content: 'First pending write.' }),
    );
    await waitFor(() =>
      expect(unresolvedDocumentOwners()[0].snapshot().inFlightGeneration).not.toBeNull(),
    );
    act(() =>
      first.editor.updateBlock(first.editor.document[1], { content: 'Latest coalesced draft.' }),
    );
    cleanup();
    const ready = vi.fn<(info: ReadyInfo) => void>();
    render(<NoteBodyEditor path={PAGE} debounceMs={20} onReady={ready} />);
    await waitFor(() =>
      expect(unresolvedDocumentOwners()[0].snapshot().reconcileRequired).toBe(true),
    );
    await act(async () => {
      finishWrite();
      await pending;
    });
    await waitFor(() => expect(ready).toHaveBeenCalled());
    expect(ready.mock.calls[0][0].serialize()).toContain('Latest coalesced draft.');
    await waitFor(() => expect(fs().get(PAGE)).toContain('Latest coalesced draft.'));
    expect(unresolvedDocumentOwners()).toHaveLength(0);
  });

  it('fresh attachment keeps a retained clean owner aligned with subsequent outside changes', async () => {
    useVaultStore.setState({ rescan: async () => undefined });
    let finishWrite!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    vi.mocked(saveNoteBody).mockImplementationOnce(async (args) => {
      await pending;
      return mockSaveNoteBody(args);
    });
    const first = await renderReady(PAGE);
    act(() =>
      first.editor.updateBlock(first.editor.document[1], {
        content: 'Acknowledged before attachment.',
      }),
    );
    await waitFor(() =>
      expect(unresolvedDocumentOwners()[0].snapshot().inFlightGeneration).not.toBeNull(),
    );
    cleanup();
    await act(async () => {
      finishWrite();
      await pending;
    });
    await waitFor(() => expect(unresolvedDocumentOwners()).toHaveLength(0));
    fs().set(PAGE, '# Test page\n\nOutside first.\n');
    const reopened = await renderReady(PAGE);
    await waitFor(() => expect(reopened.serialize()).toContain('Outside first.'));
    await act(async () => {
      fs().set(PAGE, '# Test page\n\nOutside second.\n');
      await announceExternalWrites([PAGE], async () => undefined);
    });
    await waitFor(() => expect(reopened.serialize()).toContain('Outside second.'));
    expect(screen.queryByTestId('merge-choice')).toBeNull();
    expect(fs().get(PAGE)).toBe('# Test page\n\nOutside second.\n');
  });

  it('refresh_failure_after_ack_is_not_save_failure', async () => {
    const states: SaveState[] = [];
    useVaultStore.setState({
      rescan: async () => {
        throw new Error('refresh offline');
      },
    });
    const info = await renderReady(PAGE, { onSaveState: (state) => states.push(state) });
    appendParagraph(info.editor, 'durable despite refresh');
    await waitFor(() => expect(states).toContain('saved'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)).toContain('durable despite refresh');
    expect(states).not.toContain('failed');
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull();
  });

  it('surfaces a load failure instead of an empty editor', async () => {
    render(<NoteBodyEditor path="nope/missing.md" debounceMs={20} />);
    await waitFor(() => expect(screen.getByText("This page couldn't be loaded.")).toBeTruthy());
    expect(useUiStore.getState().toasts.some((t) => t.message === "Couldn't load page")).toBe(true);
  });
});

/**
 * Outside writes land in the open page in place (M55.6).
 *
 * The agent writes straight to disk through its MCP tools while the file is
 * open. Its writes announce their path; any other change shows as a new
 * content hash. The page reads the body again and applies what changed as
 * edits: a clean page takes the write block by block, and a page with
 * unsaved typing merges three ways, leaving only overlaps as choices. One
 * onReady per test is one editor: nothing remounts.
 */
describe('NoteBodyEditor when the file changes underneath it', () => {
  const FILE = '---\ntype: Doc\n---\n\n# Test page\n\nFirst line.\n\nSecond line.\n';
  const withBody = (body: string) => `---\ntype: Doc\n---\n\n${body}`;
  const BODY = '# Test page\n\nFirst line.\n\nSecond line.\n';
  const AGENT = withBody(BODY.replace('First line.', 'First, by the agent.'));

  const hashed = (hash: string) =>
    useVaultStore.setState({
      entries: [makeEntry({ path: PAGE, filename: 'test-page.md', hash })],
    });

  beforeEach(() => {
    resetSheetCache();
    vi.mocked(calculateSheets).mockImplementation(async (sheets) =>
      sheets.map((sheet) => ({
        ok: true,
        name: sheet.name,
        rows: 1,
        cols: 1,
        cells: [],
      })),
    );
    resetMockFs();
    fs().set(PAGE, FILE);
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [],
      views: [],
      folders: [],
      status: 'ready',
      error: null,
      // Stubbed so a save's rescan does not replace the seeded entries with a
      // scan of the mock disk mid-assertion.
      rescan: vi.fn(async () => undefined),
    });
    useUiStore.setState({ toasts: [] });
    hashed('h1');
  });
  afterEach(() => {
    cleanup();
    __resetOpenPages();
  });

  interface Tracked {
    seen: ReadyInfo[];
    loadedBodies: string[];
  }

  /** Every editor this component mounts, newest last, and every body it pins. */
  async function renderTracking(debounceMs: number): Promise<Tracked> {
    const seen: ReadyInfo[] = [];
    const loadedBodies: string[] = [];
    render(
      <NoteBodyEditor
        path={PAGE}
        debounceMs={debounceMs}
        onReady={(i) => void seen.push(i)}
        onBodyLoaded={(_p, raw) => void loadedBodies.push(raw)}
      />,
    );
    await waitFor(() => expect(seen.length).toBe(1), DISK_ROUND_TRIP);
    return { seen, loadedBodies };
  }

  const ids = (info: ReadyInfo) => info.editor.document.map((b) => b.id);
  /** Every block that was there is still there, by id (a trailing paragraph
   *  the view adds on its first change may join them). */
  const keptAll = (info: ReadyInfo, before: string[]) =>
    expect(ids(info)).toEqual(expect.arrayContaining(before));
  const textOf = (info: ReadyInfo) => info.serialize();
  const blockWith = (info: ReadyInfo, text: string) => {
    const block = info.editor.document.find((b) => JSON.stringify(b.content).includes(text));
    if (block === undefined) throw new Error(`no block holds ${text}`);
    return block;
  };
  /** Type over a block, as the person would. */
  const typeOver = (info: ReadyInfo, holding: string, text: string) =>
    act(() => {
      info.editor.updateBlock(blockWith(info, holding), { content: text });
    });

  /** Announce a write to PAGE whose catch-up waits until `caughtUp()`. */
  function announcePending(): { announced: Promise<void>; caughtUp: () => void } {
    let caughtUp = () => {};
    const done = new Promise<void>((resolve) => {
      caughtUp = resolve;
    });
    let announced: Promise<void> = Promise.resolve();
    act(() => {
      announced = announceExternalWrites([PAGE], () => done);
    });
    return { announced, caughtUp };
  }

  /** The agent writes `file` to PAGE and announces it, caught up at once. */
  const agentWrites = (file: string) => {
    fs().set(PAGE, file);
    return act(() => announceExternalWrites([PAGE], async () => undefined));
  };

  /** Write, announce, and wait for the choice bar. */
  async function overlap(tracked: Tracked): Promise<void> {
    await typeOver(tracked.seen[0], 'First line.', 'First, typed by me.');
    await agentWrites(AGENT);
    await waitFor(() => expect(screen.getAllByTestId('merge-choice')).toHaveLength(1));
  }

  it('applies an announced write to a clean page in place, with no remount', async () => {
    const tracked = await renderTracking(20);
    const before = ids(tracked.seen[0]);
    const first = blockWith(tracked.seen[0], 'First line.').id;
    await agentWrites(AGENT);
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('First, by the agent.'));
    expect(tracked.seen).toHaveLength(1);
    keptAll(tracked.seen[0], before);
    expect(blockWith(tracked.seen[0], 'First, by the agent.').id).toBe(first);
    expect(tracked.loadedBodies.at(-1)).toContain('First, by the agent.');
    expect(screen.queryByTestId('merge-choices')).toBeNull();
  });

  it('applies a content-hash change nobody announced the same way', async () => {
    const tracked = await renderTracking(20);
    const before = ids(tracked.seen[0]);
    fs().set(PAGE, AGENT);
    act(() => hashed('h2'));
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('First, by the agent.'));
    expect(tracked.seen).toHaveLength(1);
    keptAll(tracked.seen[0], before);
  });

  it('reads a frontmatter-only change once and leaves the page alone', async () => {
    const tracked = await renderTracking(20);
    const before = ids(tracked.seen[0]);
    const reads = vi.mocked(readNote).mock.calls.length;
    fs().set(PAGE, FILE.replace('type: Doc', 'type: Doc\nstatus: done'));
    act(() => hashed('h2'));
    await waitFor(() => expect(vi.mocked(readNote).mock.calls.length).toBe(reads + 1));
    await settle();
    expect(vi.mocked(readNote).mock.calls.length).toBe(reads + 1);
    expect(ids(tracked.seen[0])).toEqual(before);
    expect(fs().get(PAGE)).toContain('status: done');
  });

  // M55 review: setTitle clears the hash before it rewrites the H1, so the
  // page hears h1 → null → h2. The hash after the null is a change, not a new
  // baseline, or the page keeps the old title and its next save reverts it.
  it('takes a rename that cleared the hash on its way, and a later save keeps it', async () => {
    const tracked = await renderTracking(20);
    const before = blockWith(tracked.seen[0], 'Test page').id;
    await act(async () => {
      expect(await useVaultStore.getState().setTitle(PAGE, 'Renamed page')).toBe(true);
    });
    expect(useVaultStore.getState().entries[0].hash).toBeNull();
    expect(fs().get(PAGE)).toContain('# Renamed page');
    // The rescan (stubbed here) brings the new bytes' hash.
    act(() => hashed('h2'));
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('# Renamed page'));
    expect(tracked.seen).toHaveLength(1);
    expect(blockWith(tracked.seen[0], 'Renamed page').id).toBe(before);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    await waitFor(() => expect(fs().get(PAGE)).toContain('Second, typed by me.'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)).toContain('# Renamed page');
    expect(fs().get(PAGE)).not.toContain('# Test page');
  });

  it('settles a dirty body before a table rename and retains both in the same editor', async () => {
    const tracked = await renderTracking(60_000);
    const info = tracked.seen[0];
    const before = ids(info);
    await typeOver(info, 'Second line.', 'My unsaved paragraph.');
    expect(fs().get(PAGE)).not.toContain('My unsaved paragraph.');
    await act(async () => {
      expect(await useVaultStore.getState().setTitle(PAGE, 'Renamed from table')).toBe(true);
    });
    await waitFor(() => expect(textOf(info)).toContain('# Renamed from table'));
    expect(fs().get(PAGE)).toContain('My unsaved paragraph.');
    expect(fs().get(PAGE)).toContain('# Renamed from table');
    expect(tracked.seen).toHaveLength(1);
    keptAll(info, before);
    expect(screen.queryByTestId('merge-choices')).toBeNull();
    await typeOver(info, 'First line.', 'A later paragraph.');
    await act(() => flushOpenPages());
    expect(fs().get(PAGE)).toContain('# Renamed from table');
    expect(fs().get(PAGE)).toContain('My unsaved paragraph.');
    expect(fs().get(PAGE)).toContain('A later paragraph.');
  });

  it('never re-applies its own save', async () => {
    const tracked = await renderTracking(20);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    await waitFor(() => expect(fs().get(PAGE)).toContain('Second, typed by me.'), DISK_ROUND_TRIP);
    const before = ids(tracked.seen[0]);
    // The save's rescan brings the new hash.
    act(() => hashed('h2'));
    await settle();
    expect(ids(tracked.seen[0])).toEqual(before);
    expect(tracked.seen).toHaveLength(1);
    expect(screen.queryByTestId('merge-choices')).toBeNull();
  });

  it('holds what is typed while a write lands, then merges it, and both reach disk', async () => {
    const tracked = await renderTracking(20);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    fs().set(PAGE, AGENT);
    const { announced, caughtUp } = announcePending();
    // The debounce fires while the write is catching up: held, not written.
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
    await act(async () => {
      caughtUp();
      await announced;
    });
    await waitFor(() => expect(fs().get(PAGE)).toContain('Second, typed by me.'), DISK_ROUND_TRIP);
    expect(fs().get(PAGE)).toContain('First, by the agent.');
    expect(textOf(tracked.seen[0])).toContain('First, by the agent.');
    expect(tracked.seen).toHaveLength(1);
    expect(screen.queryByTestId('merge-choices')).toBeNull();
  });

  it('shows one choice where both changed a block, and saves nothing while it is open', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    expect(screen.getByRole('group', { name: 'Choose a version' }).textContent).toContain(
      'Nothing saves until you do.',
    );
    expect(screen.getByTestId('merge-choice').textContent).toContain('First, typed by me.');
    expect(screen.getByTestId('merge-choice').textContent).toContain('First, by the agent.');
    expect(textOf(tracked.seen[0])).toContain('First, typed by me.');
    // More typing, landed by a turn's flush: held, so the disk keeps the agent's text.
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed too.');
    await act(() => flushOpenPages());
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
  });

  it('Keep yours writes yours', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    fireEvent.click(screen.getByTestId('merge-keep-mine'));
    expect(screen.queryByTestId('merge-choices')).toBeNull();
    await waitFor(() => expect(fs().get(PAGE)).toContain('First, typed by me.'), DISK_ROUND_TRIP);
    expect(tracked.seen).toHaveLength(1);
  });

  it('Use new takes the agent’s block and writes nothing', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    fireEvent.click(screen.getByTestId('merge-take-theirs'));
    expect(screen.queryByTestId('merge-choices')).toBeNull();
    expect(textOf(tracked.seen[0])).toContain('First, by the agent.');
    expect(textOf(tracked.seen[0])).not.toContain('typed by me');
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
    expect(tracked.seen).toHaveLength(1);
  });

  it('retains an unresolved choice on forced unmount instead of silently choosing mine', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    cleanup();
    await settle();
    expect(fs().get(PAGE)).toBe(AGENT);
    expect(unresolvedDocumentOwners()[0].snapshot().latestDraft).toContain('First, typed by me.');
    expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
  });

  it('lands a second write elsewhere while a choice is open, and keeps the choice', async () => {
    const tracked = await renderTracking(10_000);
    await overlap(tracked);
    const again = AGENT.replace('Second line.', 'Second, by the agent.');
    await agentWrites(again);
    await waitFor(() => expect(textOf(tracked.seen[0])).toContain('Second, by the agent.'));
    expect(screen.getAllByTestId('merge-choice')).toHaveLength(1);
    expect(textOf(tracked.seen[0])).toContain('First, typed by me.');
    expect(fs().get(PAGE)).toBe(again);
  });

  it('remounts a clean page read-only for a write the editor cannot show', async () => {
    const tracked = await renderTracking(20);
    await agentWrites(withBody(`${BODY}\n<div align="center">raw html island</div>\n`));
    await waitFor(() => expect(tracked.seen).toHaveLength(2), DISK_ROUND_TRIP);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
  });

  it('offers a dirty page the whole page for such a write, and Use new remounts', async () => {
    const tracked = await renderTracking(10_000);
    await typeOver(tracked.seen[0], 'Second line.', 'Second, typed by me.');
    const lossy = withBody(`${BODY}\n<div align="center">raw html island</div>\n`);
    await agentWrites(lossy);
    await waitFor(() => expect(screen.getAllByTestId('merge-choice')).toHaveLength(1));
    expect(tracked.seen).toHaveLength(1);
    fireEvent.click(screen.getByTestId('merge-take-theirs'));
    await waitFor(() => expect(tracked.seen).toHaveLength(2), DISK_ROUND_TRIP);
    await settle();
    expect(fs().get(PAGE)).toBe(lossy);
  });

  it('re-reads a locked lossy page', async () => {
    fs().set(PAGE, withBody(LOSSY_BODY));
    const tracked = await renderTracking(20);
    await waitFor(() => expect(screen.getByTestId('lossy-import-banner')).toBeTruthy());
    await agentWrites(withBody(LOSSY_BODY.replace('# Page', '# Page, renamed')));
    await waitFor(() => expect(tracked.seen).toHaveLength(2), DISK_ROUND_TRIP);
    expect(textOf(tracked.seen[1])).toContain('Page, renamed');
  });

  it.each(['while unmounted', 'after reopening'])(
    'retains the authoritative merge base when outside bytes change %s',
    async (when) => {
      vi.mocked(saveNoteBody).mockRejectedValueOnce(new Error('offline'));
      const first = await renderTracking(20);
      await typeOver(first.seen[0], 'First line.', 'My exact failed draft.');
      await screen.findByRole('button', { name: 'Retry save' });
      cleanup();
      if (when === 'while unmounted') fs().set(PAGE, AGENT);
      const reopened = await renderTracking(20);
      if (when === 'after reopening') await agentWrites(AGENT);
      await screen.findByTestId('merge-choice');
      expect(reopened.seen[0].serialize()).toContain('My exact failed draft.');
      expect(screen.getByTestId('merge-choice').textContent).toContain('First, by the agent.');
      expect(fs().get(PAGE)).toBe(AGENT);
      expect(unresolvedDocumentOwners()[0].snapshot().latestDraft).toContain(
        'My exact failed draft.',
      );
    },
  );

  it('coalesced writes stay held through external catch-up and an overlapping choice', async () => {
    let acknowledge!: (ack: import('./documentOwner').NoteWriteAck) => void;
    const response = new Promise<import('./documentOwner').NoteWriteAck>((resolve) => {
      acknowledge = resolve;
    });
    const save = vi.mocked(saveNoteBody);
    save.mockClear();
    save.mockImplementationOnce(async (args) => {
      await mockSaveNoteBody(args);
      return response;
    });
    const tracked = await renderTracking(20);
    await typeOver(tracked.seen[0], 'First line.', 'First local write.');
    await waitFor(() => expect(fs().get(PAGE)).toContain('First local write.'));
    fs().set(PAGE, AGENT);
    const { announced, caughtUp } = announcePending();
    await typeOver(tracked.seen[0], 'First local write.', 'Second exact local draft.');
    await act(async () => {
      acknowledge({ kind: 'file', contentHash: 'first authoritative ack' });
      await response;
    });
    await waitFor(() =>
      expect(unresolvedDocumentOwners()[0].snapshot().inFlightGeneration).toBeNull(),
    );
    expect(fs().get(PAGE)).toBe(AGENT);
    expect(save.mock.calls).toHaveLength(1);
    await act(async () => {
      caughtUp();
      await announced;
    });
    await screen.findByTestId('merge-choice');
    await typeOver(tracked.seen[0], 'Second line.', 'New typing while choice stays open.');
    const outcome = await unresolvedDocumentOwners()[0].flush();
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'choice' });
    expect(fs().get(PAGE)).toBe(AGENT);
    expect(tracked.seen[0].serialize()).toContain('Second exact local draft.');
    expect(tracked.seen[0].serialize()).toContain('New typing while choice stays open.');
  });

  it('a failed pending write rereads outside bytes and retains newer typing until a choice', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<import('./documentOwner').NoteWriteAck>((_, fail) => {
      reject = fail;
    });
    vi.mocked(saveNoteBody).mockImplementationOnce(() => pending);
    const tracked = await renderTracking(20);
    await typeOver(tracked.seen[0], 'First line.', 'Failed exact local draft.');
    await waitFor(() =>
      expect(unresolvedDocumentOwners()[0].snapshot().inFlightGeneration).not.toBeNull(),
    );
    await agentWrites(AGENT);
    await typeOver(tracked.seen[0], 'Second line.', 'New typing while failed write waits.');
    await act(async () => {
      reject(new Error('pending write failed'));
      await pending.catch(() => undefined);
    });
    await screen.findByTestId('merge-choice');
    expect(fs().get(PAGE)).toBe(AGENT);
    expect(tracked.seen[0].serialize()).toContain('Failed exact local draft.');
    expect(tracked.seen[0].serialize()).toContain('New typing while failed write waits.');
    fireEvent.click(screen.getByTestId('merge-keep-mine'));
    await waitFor(() => expect(fs().get(PAGE)).toContain('Failed exact local draft.'));
    expect(fs().get(PAGE)).toContain('New typing while failed write waits.');
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull();
  });

  it.each(['before', 'after'] as const)(
    'a fresh external read waits until the pending write lands %s the announced bytes',
    async (ordering) => {
      let finish!: () => void;
      const response = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.mocked(saveNoteBody).mockImplementationOnce(async (args) => {
        if (ordering === 'before') {
          const ack = await mockSaveNoteBody(args);
          await response;
          return ack;
        }
        await response;
        return mockSaveNoteBody(args);
      });
      const tracked = await renderTracking(20);
      await typeOver(tracked.seen[0], 'First line.', 'Pending local write.');
      await waitFor(() =>
        expect(unresolvedDocumentOwners()[0].snapshot().inFlightGeneration).not.toBeNull(),
      );
      await agentWrites(AGENT);
      expect(tracked.seen[0].serialize()).toContain('Pending local write.');
      await typeOver(tracked.seen[0], 'Second line.', 'Typed while reconciliation waits.');
      await act(async () => {
        finish();
        await response;
      });
      if (ordering === 'before') {
        await waitFor(() => expect(tracked.seen[0].serialize()).toContain('First, by the agent.'));
        await waitFor(() => expect(fs().get(PAGE)).toContain('Typed while reconciliation waits.'));
        expect(fs().get(PAGE)).toContain('First, by the agent.');
      } else {
        await waitFor(() => expect(fs().get(PAGE)).toContain('Typed while reconciliation waits.'));
        expect(fs().get(PAGE)).toContain('Pending local write.');
        expect(screen.queryByTestId('merge-choice')).toBeNull();
      }
    },
  );
  it('lands a pending edit when a turn flushes the open pages', async () => {
    const tracked = await renderTracking(10_000);
    appendParagraph(tracked.seen[0].editor, 'typed just before asking');
    await act(() => flushOpenPages());
    // Landed by the time the flush resolves, not ten seconds out.
    expect(fs().get(PAGE)).toContain('typed just before asking');
  });
});

it('holds the edited file under its pane or peek owner and releases on unmount (M65.8)', () => {
  const pane = useNavStore.getState().active;
  const mounted = render(
    <PaneContext value={pane}>
      <NoteBodyEditor path="a.md" />
    </PaneContext>,
  );
  expect(editorHoldersOf('a.md')).toEqual([pane]);
  mounted.unmount();
  expect(editorHoldersOf('a.md')).toEqual([]);
  const peek = render(<NoteBodyEditor path="a.md" owner="peek" />);
  expect(editorHoldersOf('a.md')).toEqual(['peek']);
  peek.unmount();
  expect(editorHoldersOf('a.md')).toEqual([]);
});
