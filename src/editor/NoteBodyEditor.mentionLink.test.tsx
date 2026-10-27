// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import {
  sourceVisitOrigin,
  useSourceNavigation,
  type SourceOpenRequest,
  type SourceOpenRecord,
} from '@/app/sourceOpen';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { useUndoStore } from '@/stores/undoStore';
import { NoteBodyEditor } from './NoteBodyEditor';
import type { EditorReadyInfo } from './MarkdownEditor';
import { __resetOpenPages, flushOpenPages } from './openPages';

vi.mock('@/lib/ipc', { spy: true });
const VAULT = '/demo-vault';
const PATH = 'notes/m97-source.md';
const TARGET = 'notes/m97-target.md';
const BEFORE = '# Source\n\n😀 Neon Orchard first, then Neon Orchard second.\n\nUntouched line.\n';
const AFTER =
  '# Source\n\n😀 Neon Orchard first, then [[m97-target|Neon Orchard]] second.\n\nUntouched line.\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const ROUND_TRIP = { timeout: 5_000 };

beforeAll(async () => {
  await import('./MarkdownEditor');
});
beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  mock.resetMockFs();
  fs().set(PATH, BEFORE);
  fs().set(TARGET, '# Neon Orchard\n\nTarget body.\n');
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ toasts: [], detailPath: null });
  useUndoStore.getState().clear();
  useNavStore.getState().reset();
  useNavStore.getState().navigate({ kind: 'doc', path: TARGET });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.resetAllMocks();
});

async function openMention(withIntent = true) {
  const page = await ipc.findSourceOccurrences(VAULT, TARGET, 'mention', null);
  if (page.status !== 'ready') throw new Error('Expected a measured occurrence page');
  const row = page.rows.filter((item) => item.location.path === PATH).at(-1);
  if (!row) throw new Error('Expected the second recorded raw occurrence');
  const target = await ipc.readNoteSource(VAULT, TARGET);
  const request: SourceOpenRequest = {
    requestId: crypto.randomUUID(),
    locator: row.location,
    origin: sourceVisitOrigin(row.location.vaultId),
    intent: 'full_page',
    ...(withIntent
      ? { mentionLink: { occurrenceId: row.id, targetPath: TARGET, targetHash: target.hash } }
      : {}),
  };
  const ready = vi.fn<(info: EditorReadyInfo) => void>();
  const view = render(<NoteBodyEditor path={PATH} debounceMs={60_000} onReady={ready} />);
  await waitFor(() => expect(ready).toHaveBeenCalled(), ROUND_TRIP);
  const navigation = renderHook(useSourceNavigation);
  await act(async () => {
    await navigation.result.current.openSource(request);
  });
  await screen.findByText('Source passage revealed.', {}, ROUND_TRIP);
  return { info: ready.mock.calls[0][0], view, ready };
}

it('keeps ordinary recorded-source navigation read-only', async () => {
  await openMention(false);
  expect(screen.queryByRole('button', { name: 'Insert link' })).toBeNull();
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it('inserts from the actual source owner, reconciles its existing editor, and undoes through the app', async () => {
  const { info, ready } = await openMention();
  fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));
  await waitFor(() => expect(fs().get(PATH)).toBe(AFTER), ROUND_TRIP);
  await waitFor(
    () => expect(info.serialize()).toContain('[[m97-target|Neon Orchard]]'),
    ROUND_TRIP,
  );
  expect(ready).toHaveBeenCalledOnce();
  expect(ipc.applyBatch).toHaveBeenCalledOnce();
  expect(useUndoStore.getState().past).toHaveLength(1);
  await act(async () => {
    await useUndoStore.getState().undo();
  });
  await waitFor(() => expect(fs().get(PATH)).toBe(BEFORE), ROUND_TRIP);
  await waitFor(() => expect(info.serialize()).not.toContain('[['), ROUND_TRIP);
  expect(screen.queryByRole('button', { name: 'Insert link' })).toBeNull();
});

it('cancels the source-owned intent without authoring a body or an Undo entry', async () => {
  await openMention();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel link' }));
  expect(screen.queryByRole('button', { name: 'Insert link' })).toBeNull();
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(useUndoStore.getState().past).toHaveLength(0);
});

it('does not dispatch a delayed source-owned action after its visit changes', async () => {
  await openMention();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
    entered = true;
    await gate;
    return mock.readNoteSource(vault, path);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));
  await waitFor(() => expect(entered).toBe(true));
  act(() => useNavStore.getState().navigate({ kind: 'doc', path: TARGET }));
  await act(async () => {
    release();
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Insert link' })).toBeNull());
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it('keeps new editor input made while preparing the link and never replaces it', async () => {
  const { info } = await openMention();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
    entered = true;
    await gate;
    return mock.readNoteSource(vault, path);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));
  await waitFor(() => expect(entered).toBe(true));
  act(() => {
    const last = info.editor.document.at(-1)!;
    info.editor.insertBlocks(
      [{ type: 'paragraph', content: 'My newer editor draft.' }],
      last,
      'after',
    );
  });
  await act(async () => {
    release();
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Insert link' })).toBeNull());
  expect(info.serialize()).toContain('My newer editor draft.');
  expect(info.serialize()).not.toContain('[[');
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  await act(async () => {
    await flushOpenPages();
  });
  expect(fs().get(PATH)).toContain('My newer editor draft.');
  expect(fs().get(PATH)).not.toContain('[[');
});

it('consumes duplicate activation once even while the existing batch writer waits', async () => {
  await openMention();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
    await gate;
    return mock.applyBatch(vault, ops);
  });
  const insert = screen.getByRole('button', { name: 'Insert link' });
  fireEvent.click(insert);
  fireEvent.click(insert);
  await waitFor(() => expect(ipc.applyBatch).toHaveBeenCalledOnce());
  await act(async () => {
    release();
  });
  await waitFor(() => expect(fs().get(PATH)).toBe(AFTER), ROUND_TRIP);
  expect(ipc.applyBatch).toHaveBeenCalledOnce();
  expect(useUndoStore.getState().past).toHaveLength(1);
});

it.each(['cancelled', 'applied'] as const)(
  'Back remounts the original mention request with its late %s outcome, never a permanent pending state',
  async (outcome) => {
    const { view, info } = await openMention();
    const pane = useNavStore.getState().active;
    const original = useNavStore.getState().readEntryState<SourceOpenRecord>('source.request')!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const applyBatch = useVaultStore.getState().applyBatch;
    if (outcome === 'cancelled') {
      vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
        entered = true;
        await gate;
        return mock.readNoteSource(vault, path);
      });
    } else {
      // Complete the REAL batch (including its owner barrier, write and Undo),
      // then hold only delivery of that result to the source action. Navigation
      // is now permitted; this is not a fabricated applied receipt.
      useVaultStore.setState({
        applyBatch: async (...args) => {
          const result = await applyBatch(...args);
          entered = true;
          await gate;
          return result;
        },
      });
    }
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));
      await waitFor(() => expect(entered).toBe(true), ROUND_TRIP);
      if (outcome === 'applied') {
        await waitFor(
          () => expect(info.serialize()).toContain('[[m97-target|Neon Orchard]]'),
          ROUND_TRIP,
        );
        await act(async () => {
          await flushOpenPages();
        });
        expect(fs().get(PATH)).toBe(AFTER);
        expect(useUndoStore.getState().past).toHaveLength(1);
      }
      act(() => useNavStore.getState().navigate({ kind: 'doc', path: TARGET }));
      await waitFor(() =>
        expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: TARGET }),
      );
      view.unmount();
      const unrelated = useNavStore.getPaneState(pane).history.at(-1);
      await act(async () => {
        release();
      });
      expect(useNavStore.getPaneState(pane).history.at(-1)).toBe(unrelated);
      expect(useNavStore.getState().readEntryState('source.request')).toBeUndefined();
      act(() => useNavStore.getState().back(pane));
      await waitFor(() =>
        expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: PATH }),
      );
      const ready = vi.fn<(value: EditorReadyInfo) => void>();
      render(<NoteBodyEditor path={PATH} debounceMs={60_000} onReady={ready} />);
      await waitFor(() => expect(ready).toHaveBeenCalled(), ROUND_TRIP);
      await waitFor(() => {
        const restored = useNavStore.getState().readEntryState<SourceOpenRecord>('source.request');
        expect(restored?.requestId).toBe(original.requestId);
        expect(restored?.mentionLink?.status).toBe(outcome);
      });
      expect(screen.getByTestId('source-reveal-status').textContent).toContain(
        outcome === 'applied' ? 'Mention linked.' : 'Link insertion cancelled.',
      );
      expect(screen.getByTestId('source-reveal-status').textContent).not.toContain(
        'Inserting link',
      );
      expect(screen.queryByRole('button', { name: 'Insert link' })).toBeNull();
      expect(fs().get(PATH)).toBe(outcome === 'applied' ? AFTER : BEFORE);
      expect(useUndoStore.getState().past).toHaveLength(outcome === 'applied' ? 1 : 0);
    } finally {
      release();
      useVaultStore.setState({ applyBatch });
    }
  },
);
