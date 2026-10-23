// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/ipc', { spy: true });

import { staleWords, type BatchApplied, type BatchOp, type FileResult } from '@/engine/batch';
import { EVICTED, revertOps, type RenameChange } from '@/engine/undoPlan';
import type { TrashedItem } from '@/engine/trash';
import * as ipc from '@/lib/ipc';
import { makeEntry } from '@/test/factories';
import { useUiStore, type ToastItem } from '@/stores/uiStore';
import { MAX_BYTES, MAX_ENTRIES, useUndoStore } from '@/stores/undoStore';
import { useVaultStore, type BatchOptions } from '@/stores/vaultStore';

const VAULT = '/demo-vault';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

/** The existing undo cases restore content, never move a page. */
function writtenPath(op: BatchOp): string {
  expect(op.op).not.toBe('rename');
  if (op.op === 'rename') throw new Error('A content undo must not rename a file');
  return op.path;
}

const file = (path: string, partial: Partial<FileResult> = {}): FileResult => ({
  path,
  beforeHash: H1,
  afterHash: H2,
  before: '---\nstatus: todo\n---\n',
  keys: [{ key: 'status', before: 'todo', after: 'done' }],
  trashed: null,
  restored: null,
  skipped: null,
  ...partial,
});

/** What an undo of `files` lands: each page back, the keys the other way. */
const undid = (files: FileResult[]): BatchApplied => ({
  batchId: 'u'.repeat(32),
  files: files.map((f) => ({
    ...f,
    beforeHash: f.afterHash,
    afterHash: f.beforeHash,
    before: '---\nstatus: done\n---\n',
    keys: f.keys.map((k) => ({ key: k.key, before: k.after, after: k.before })),
  })),
});

type Applier = (ops: BatchOp[], options?: BatchOptions) => Promise<BatchApplied | null>;

let calls: { ops: BatchOp[]; options?: BatchOptions }[];

function applying(answer: Applier) {
  const applyBatch = vi.fn(async (ops: BatchOp[], options?: BatchOptions) => {
    calls.push({ ops, options });
    return answer(ops, options);
  });
  useVaultStore.setState({ applyBatch });
  return applyBatch;
}

const toasts = (): ToastItem[] => useUiStore.getState().toasts;
const words = () => toasts().map((t) => t.message);

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  useUndoStore.getState().clear();
  useUiStore.setState({ toasts: [] });
  useVaultStore.setState({
    vaultPath: VAULT,
    entries: [
      makeEntry({ path: 'records/a.md', title: 'Alpha', hash: H2 }),
      makeEntry({ path: 'records/b.md', title: 'Beta', hash: H2 }),
    ],
    rescan: vi.fn(async () => {}),
  });
});

describe('undoStore (M60.7)', () => {
  it('a push clears redo', async () => {
    const id = useUndoStore.getState().pushBatch('First', VAULT, [file('records/a.md')]);
    applying(async (ops) => undid(ops.map((op) => file(writtenPath(op)))));
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(useUndoStore.getState().future.map((e) => e.id)).toEqual([id]);
    useUndoStore.getState().pushBatch('Second', VAULT, [file('records/b.md')]);
    expect(useUndoStore.getState().future).toEqual([]);
  });

  it('undo takes the newest at once, and a second press the next', async () => {
    const store = useUndoStore.getState();
    const older = store.pushBatch('Older', VAULT, [file('records/a.md')]);
    const newer = store.pushBatch('Newer', VAULT, [file('records/b.md')]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    applying(async (ops) => {
      await held;
      return undid(ops.map((op) => file(writtenPath(op))));
    });
    const first = store.undo();
    const second = store.undo();
    expect(useUndoStore.getState().past).toEqual([]);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls.map((c) => writtenPath(c.ops[0]))).toEqual(['records/b.md', 'records/a.md']);
    expect(useUndoStore.getState().future.map((e) => e.id)).toEqual([newer, older]);
  });

  it("a toast's Undo takes its own entry from anywhere", async () => {
    const store = useUndoStore.getState();
    const first = store.pushBatch('First', VAULT, [file('records/a.md')]);
    store.pushBatch('Second', VAULT, [file('records/b.md')]);
    applying(async (ops) => undid(ops.map((op) => file(writtenPath(op)))));
    expect(await store.undoEntry(first ?? -1)).toBe(true);
    expect(calls[0].ops).toEqual(revertOps([file('records/a.md')]));
    expect(useUndoStore.getState().past.map((e) => e.label)).toEqual(['Second']);
    expect(words()).toEqual(['Undid: First']);
    expect(toasts()[0].action?.label).toBe('Redo');
  });

  it('a failed request puts the entry back where it was', async () => {
    const store = useUndoStore.getState();
    store.pushBatch('First', VAULT, [file('records/a.md')]);
    const middle = store.pushBatch('Middle', VAULT, [file('records/b.md')]);
    store.pushBatch('Last', VAULT, [file('records/a.md')]);
    applying(async () => null);
    expect(await store.undoEntry(middle ?? -1)).toBe(false);
    expect(useUndoStore.getState().past.map((e) => e.label)).toEqual(['First', 'Middle', 'Last']);
    applying(async (_ops, options) => {
      options?.onRefused?.("Couldn't finish the change, so every page was put back: disk full");
      return null;
    });
    expect(await store.undoEntry(middle ?? -1)).toBe(false);
    expect(useUndoStore.getState().past.map((e) => e.label)).toEqual(['First', 'Middle', 'Last']);
    expect(words()).toEqual(["Couldn't finish the change, so every page was put back: disk full"]);
  });

  it('a refused entry drops off, naming who changed the page when recorded', async () => {
    useVaultStore.setState({
      entries: [makeEntry({ path: 'records/a.md', title: 'Alpha', hash: 'f'.repeat(64) })],
    });
    vi.mocked(ipc.pageAttribution).mockResolvedValueOnce({
      state: 'unattributed',
      kind: 'vault.write',
      actor: 'human:me',
      run_id: null,
      approved_by: null,
      at: '2026-10-14T09:00:00Z',
    });
    useUndoStore.getState().pushBatch('Renamed', VAULT, [file('records/a.md')]);
    applying(async (_ops, options) => {
      options?.onRefused?.(staleWords('records/a.md'));
      return null;
    });
    expect(await useUndoStore.getState().undo()).toBe(false);
    expect(useUndoStore.getState().past).toEqual([]);
    expect(useUndoStore.getState().future).toEqual([]);
    expect(words()).toEqual([
      'Nothing was undone: “Alpha” changed since (changed outside Cerebro).',
    ]);
  });

  it('an entry that kept every change drops off and says what it kept', async () => {
    useUndoStore.getState().pushBatch('Renamed', VAULT, [file('records/a.md')]);
    applying(async () => ({
      batchId: 'u'.repeat(32),
      files: [
        file('records/a.md', {
          beforeHash: H2,
          afterHash: H2,
          keys: [],
          skipped: { keys: ['status'], reason: null },
        }),
      ],
    }));
    expect(await useUndoStore.getState().undo()).toBe(false);
    expect(useUndoStore.getState().future).toEqual([]);
    expect(words()).toEqual(['Undid: Renamed. Kept 1 change made since: Status on “Alpha”']);
    expect(toasts()[0].action).toBeUndefined();
  });

  it('redo reverts the undo, and its toast carries Undo again', async () => {
    const id = useUndoStore.getState().pushBatch('Renamed', VAULT, [file('records/a.md')]);
    applying(async (ops) => undid(ops.map((op) => file(writtenPath(op)))));
    await useUndoStore.getState().undo();
    const inverse = useUndoStore.getState().future[0];
    expect(inverse.id).toBe(id);
    expect(await useUndoStore.getState().redo()).toBe(true);
    expect(calls[1].ops).toEqual(revertOps(inverse.kind === 'batch' ? inverse.files : []));
    expect(useUndoStore.getState().past.map((e) => e.id)).toEqual([id]);
    expect(words()).toEqual(['Undid: Renamed', 'Renamed']);
    expect(toasts()[1].action?.label).toBe('Undo');
  });

  it('caps evict the oldest, and an evicted Undo says git still has it', async () => {
    const store = useUndoStore.getState();
    const first = store.pushBatch('0', VAULT, [file('records/a.md')]);
    for (let i = 1; i <= MAX_ENTRIES; i++)
      store.pushBatch(String(i), VAULT, [file('records/a.md')]);
    expect(useUndoStore.getState().past).toHaveLength(MAX_ENTRIES);
    expect(useUndoStore.getState().past[0].label).toBe('1');
    applying(async () => null);
    expect(await store.undoEntry(first ?? -1)).toBe(false);
    expect(calls).toEqual([]);
    expect(words()).toEqual([EVICTED]);

    store.clear();
    const big = 'x'.repeat(MAX_BYTES / 2 + 1);
    store.pushBatch('Big one', VAULT, [file('records/a.md', { before: big })]);
    store.pushBatch('Big two', VAULT, [file('records/a.md', { before: big })]);
    expect(useUndoStore.getState().past.map((e) => e.label)).toEqual(['Big two']);
  });

  it('rename snapshots share the session cap and reject knowledge file restoration', () => {
    const change: RenameChange = {
      steps: [{ from: 'records/a.md', to: 'records/next.md' }],
      files: [{ path: 'records/b.md', before: '[[a]]', after: '[[next]]' }],
      anchors: [
        { path: 'knowledge/concepts/a.md', title: 'A', before: '[[a]]', after: '[[next]]' },
      ],
    };
    const store = useUndoStore.getState();
    expect(store.pushRename('Rename A', VAULT, change)).not.toBeNull();
    expect(
      store.pushRename('Bad write', VAULT, {
        ...change,
        files: [{ ...change.files[0], path: 'knowledge/concepts/a.md' }],
      }),
    ).toBeNull();
    expect(
      store.pushRename('Bad move', VAULT, {
        ...change,
        steps: [{ from: 'records/a.md', to: 'knowledge/concepts/a.md' }],
      }),
    ).toBeNull();
    const big = 'x'.repeat(MAX_BYTES / 2);
    store.pushRename('Large rename', VAULT, {
      ...change,
      files: [{ path: 'records/b.md', before: big, after: 'small' }],
    });
    store.pushRename('Newest rename', VAULT, {
      ...change,
      files: [{ path: 'records/b.md', before: big, after: 'small' }],
    });
    expect(useUndoStore.getState().past.map((entry) => entry.label)).toEqual(['Newest rename']);
    store.clear();
    expect(useUndoStore.getState().past).toEqual([]);
  });

  it('a vault switch while a request waits does not repopulate the cleared history', async () => {
    const store = useUndoStore.getState();
    store.pushBatch('First', VAULT, [file('records/a.md')]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    applying(async () => {
      await held;
      return null;
    });
    const task = store.undo();
    store.clear();
    useVaultStore.setState({ vaultPath: '/other-vault' });
    release();
    expect(await task).toBe(false);
    expect(useUndoStore.getState().past).toEqual([]);
    expect(useUndoStore.getState().future).toEqual([]);
  });

  it("clears, and refuses another vault's entry", async () => {
    useUndoStore.getState().pushBatch('Renamed', VAULT, [file('records/a.md')]);
    useVaultStore.setState({ vaultPath: '/other-vault' });
    applying(async () => null);
    expect(await useUndoStore.getState().undo()).toBe(false);
    expect(calls).toEqual([]);
    expect(useUndoStore.getState().past).toEqual([]);
    useUndoStore.getState().pushBatch('Again', '/other-vault', [file('records/a.md')]);
    useUndoStore.getState().clear();
    expect(useUndoStore.getState().past).toEqual([]);
  });

  it('never throws, and an empty stack says nothing', async () => {
    expect(await useUndoStore.getState().undo()).toBe(false);
    expect(await useUndoStore.getState().redo()).toBe(false);
    expect(words()).toEqual([]);
    useUndoStore.getState().pushBatch('Renamed', VAULT, [file('records/a.md')]);
    applying(async () => {
      throw new Error('boom');
    });
    await expect(useUndoStore.getState().undo()).resolves.toBe(false);
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(words()).toEqual(['boom']);
  });

  it('undoes a Trash move by restoring it, and redoes it under a new stamp', async () => {
    const item: TrashedItem = {
      stamp: '20261014T093000Z-a1b2',
      path: 'records/a.md',
      kind: 'file',
      title: 'Alpha',
      deletedAt: '2026-10-14T09:30:00Z',
      pages: 1,
    };
    const again = { ...item, stamp: '20261014T094000Z-c3d4' };
    vi.mocked(ipc.restoreFromTrash).mockResolvedValueOnce('records/a.md');
    vi.mocked(ipc.deleteNote).mockResolvedValueOnce(again);
    const id = useUndoStore.getState().pushTrash('Moved “Alpha” to Trash', VAULT, item);
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(ipc.restoreFromTrash).toHaveBeenCalledWith(VAULT, item.stamp);
    expect(words()).toEqual(['Undid: Moved “Alpha” to Trash']);
    expect(await useUndoStore.getState().redoEntry(id ?? -1)).toBe(true);
    expect(ipc.deleteNote).toHaveBeenCalledWith(VAULT, 'records/a.md');
    const back = useUndoStore.getState().past[0];
    expect(back.kind === 'trash' ? back.item.stamp : null).toBe(again.stamp);
  });

  it('never applies to knowledge/ or proposal decisions', () => {
    const store = useUndoStore.getState();
    expect(store.pushBatch('Bundle', VAULT, [file('knowledge/concepts/x.md')])).toBeNull();
    store.pushBatch('Mixed', VAULT, [file('knowledge/concepts/x.md'), file('records/a.md')]);
    const [entry] = useUndoStore.getState().past;
    expect(entry.kind === 'batch' ? entry.files.map((f) => f.path) : []).toEqual(['records/a.md']);
    const concept: TrashedItem = {
      stamp: '20261014T093000Z-a1b2',
      path: 'knowledge/concepts/x.md',
      kind: 'file',
      title: 'X',
      deletedAt: '2026-10-14T09:30:00Z',
      pages: 1,
    };
    expect(store.pushTrash('Moved “X” to Trash', VAULT, concept)).toBeNull();
    // Nothing on the knowledge surfaces or a proposal card reaches the stack
    // or labels a change undoable.
    // Filesystem reads preserve the audit without loading one-line ?raw
    // transforms under the same coverage cache keys as executable modules.
    const paths = ['knowledge', 'status'].flatMap((folder) =>
      readdirSync(join(__dirname, '..', folder), { recursive: true, encoding: 'utf8' })
        .filter((path) => /\.tsx?$/.test(path))
        .map((path) => `../${folder}/${path.replaceAll('\\', '/')}`),
    );
    paths.push('../agent/ProposalCard.tsx');
    expect(paths.length).toBeGreaterThan(3);
    for (const path of paths) {
      const source = readFileSync(join(__dirname, path), 'utf8');
      expect(source, path).not.toMatch(/undoStore|undoPlan|\bundo:\s/);
    }
  });
});
