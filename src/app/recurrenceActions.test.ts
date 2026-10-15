import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDateProperty } from '@/engine/dates';
import * as recurrence from '@/engine/recurrence';
import { __resetOpenPages, registerFlush, registerHold } from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { useVaultStore } from '@/stores/vaultStore';
import { detachOccurrence } from './recurrenceActions';

const SERIES = 'sessions/weekly-sync.md';
const content =
  '---\ntype: Session\nwindow:\n  start: 2026-07-28 09:00\n  end: 2026-07-28 09:15\nrepeat: FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4\n---\n\n# Weekly sync\n\nKeep this paragraph exactly.\n';
const occurrence = () => parseDateProperty({ start: '2026-08-04 09:00', end: '2026-08-04 09:15' })!;
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const messages = () => useUiStore.getState().toasts.map((row) => row.message);
const detach = () => detachOccurrence(SERIES, occurrence());

beforeEach(async () => {
  vi.restoreAllMocks();
  __resetOpenPages();
  resetMockFs();
  fs().set(
    'types/session.md',
    '---\ntype: Type\nfolder: new-sessions\nfields:\n  window: daterange\n  repeat: repeat\n---\n\n# Session\n',
  );
  fs().set(SERIES, content);
  await useVaultStore.getState().openVault('/demo-vault');
  useUndoStore.getState().clear();
  useUiStore.setState({ detailPath: SERIES, toasts: [] });
  useNavStore.setState({ selection: { kind: 'type', name: 'Session' } });
});
afterEach(() => {
  __resetOpenPages();
  vi.restoreAllMocks();
});

describe('detachOccurrence', () => {
  it('flushes before reading, applies one labelled batch, and opens only the new page', async () => {
    const changed = content.replace('exactly.', 'exactly, with this pending edit.');
    registerFlush(async () => {
      if (fs().get(SERIES) === content) fs().set(SERIES, changed);
    });
    const read = vi.spyOn(ipc, 'readNoteSource');
    const plan = vi.spyOn(recurrence, 'planDetach');
    const batch = vi.spyOn(ipc, 'applyBatch');
    const path = await detach();
    expect(path).not.toBeNull();
    expect(read).toHaveBeenCalledWith('/demo-vault', SERIES);
    expect(plan.mock.calls[0][1].content).toBe(changed);
    const planned = plan.mock.results[0].value!;
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][1]).toEqual(planned.ops);
    expect(planned.ops.map((op: { op: string }) => op.op)).toEqual(['patch', 'create']);
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(useUndoStore.getState().past[0].label).toBe(planned.label);
    expect(fs().get(SERIES)).toContain('EXDATE:20260804T090000');
    expect(fs().get(path!)).toContain('Split from');
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path });
    expect(useUiStore.getState().detailPath).toBeNull();
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(fs().get(SERIES)).toBe(changed);
    expect(fs().has(path!)).toBe(false);
  });

  it.each(['scanVault', 'readNoteSource'] as const)(
    'a failed %s writes nothing and keeps the page open',
    async (method) => {
      const before = new Map(fs());
      const batch = vi.spyOn(ipc, 'applyBatch');
      vi.spyOn(ipc, method).mockRejectedValueOnce(new Error('disk unavailable'));
      await expect(detach()).resolves.toBeNull();
      expect(batch).not.toHaveBeenCalled();
      expect(new Map(fs())).toEqual(before);
      expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Session' });
      expect(useUiStore.getState().detailPath).toBe(SERIES);
      expect(messages()).toEqual(["Couldn't make this event its own page: disk unavailable"]);
    },
  );

  it('a held save refuses before reading or changing the series', async () => {
    registerHold(() => SERIES);
    const read = vi.spyOn(ipc, 'readNoteSource');
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await detach()).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(messages()[0]).toContain('changes waiting on you');
  });

  it('a stale series refuses both writes and keeps its newer bytes', async () => {
    const apply = useVaultStore.getState().applyBatch;
    const newer = content.replace('exactly.', 'exactly, including an outside edit.');
    vi.spyOn(useVaultStore.getState(), 'applyBatch').mockImplementationOnce(
      async (ops, options) => {
        fs().set(SERIES, newer);
        return apply(ops, options);
      },
    );
    const beforePaths = [...fs().keys()];
    expect(await detach()).toBeNull();
    expect(fs().get(SERIES)).toBe(newer);
    expect([...fs().keys()]).toEqual(beforePaths);
    expect(useUndoStore.getState().past).toHaveLength(0);
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Session' });
    expect(messages()).toHaveLength(1);
  });

  it('a title changed between scan and read refuses the obsolete snapshot', async () => {
    const read = ipc.readNoteSource;
    const newer = content.replace('# Weekly sync', '# Renamed meeting');
    vi.spyOn(ipc, 'readNoteSource').mockImplementationOnce(async (...args) => {
      fs().set(SERIES, newer);
      return read(...args);
    });
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await detach()).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(fs().get(SERIES)).toBe(newer);
    expect(messages()).toEqual(['This event changed. Reopen the calendar and try again.']);
    expect(useUiStore.getState().detailPath).toBe(SERIES);
  });

  it('an occurrence no longer in the rule is refused without navigation', async () => {
    fs().set(SERIES, content.replace('COUNT=4', 'COUNT=2'));
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await detach()).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(messages()).toEqual(['This event changed. Reopen the calendar and try again.']);
    expect(useUiStore.getState().detailPath).toBe(SERIES);
  });

  it('a vault switch during the source read never starts a batch in the new vault', async () => {
    const read = ipc.readNoteSource;
    vi.spyOn(ipc, 'readNoteSource').mockImplementationOnce(async (...args) => {
      const source = await read(...args);
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other', entries: [] });
      return source;
    });
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await detach()).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(messages()).toEqual([]);
  });

  it('a refused batch does not close detail and produces only the store refusal', async () => {
    vi.spyOn(ipc, 'applyBatch').mockRejectedValueOnce(new Error('journal unavailable'));
    expect(await detach()).toBeNull();
    expect(fs().get(SERIES)).toBe(content);
    expect(useUiStore.getState().detailPath).toBe(SERIES);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain('journal unavailable');
  });

  it('a planner exception never escapes the human action', async () => {
    vi.spyOn(recurrence, 'planDetach').mockImplementationOnce(() => {
      throw new Error('invalid source');
    });
    const batch = vi.spyOn(ipc, 'applyBatch');
    await expect(detach()).resolves.toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(messages()).toEqual(["Couldn't make this event its own page: invalid source"]);
  });

  it('knowledge pages and templates cannot be detached', async () => {
    const batch = vi.spyOn(ipc, 'applyBatch');
    for (const path of ['knowledge/series.md', 'templates/series.md']) {
      fs().set(path, content);
      expect(await detachOccurrence(path, occurrence())).toBeNull();
      expect(fs().get(path)).toBe(content);
    }
    expect(batch).not.toHaveBeenCalled();
  });
});
