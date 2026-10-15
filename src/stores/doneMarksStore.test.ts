import { beforeEach, expect, it, vi } from 'vitest';
import { useDoneMarksStore } from './doneMarksStore';
import { useUiStore } from './uiStore';
import { markId } from '@/engine/reminderState';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
let n = 0;
let vault = '';
const input = {
  lane: 'insight' as const,
  subject: 'concept.md',
  until: 'revision' as const,
  revision: 'v1',
};
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetMockFs();
  vault = `/done-${++n}`;
  useDoneMarksStore.getState().reset(null);
  useUiStore.setState({ toast: vi.fn(), dismissedInsights: [] });
});
it('marks the seen revision, returns the replaced mark and atomically restores it on Undo', async () => {
  await useDoneMarksStore.getState().hydrate(vault);
  expect(await useDoneMarksStore.getState().markDone(input)).toBeNull();
  const first = useDoneMarksStore.getState().marks[markId(input)];
  expect(useDoneMarksStore.getState().isDone('insight', 'concept.md', 'v1')).toBe(true);
  expect(useDoneMarksStore.getState().isDone('insight', 'concept.md', 'v2')).toBe(false);
  expect(await useDoneMarksStore.getState().markDone({ ...input, revision: 'v2' })).toEqual(first);
  const second = useDoneMarksStore.getState().marks[markId(input)];
  expect(await useDoneMarksStore.getState().undoDone(second, first)).toBe(true);
  expect(useDoneMarksStore.getState().marks[markId(input)]).toEqual(first);
});
it('never removes a newer mark from another window', async () => {
  await useDoneMarksStore.getState().hydrate(vault);
  await useDoneMarksStore.getState().markDone(input);
  const first = useDoneMarksStore.getState().marks[markId(input)];
  const newer = await ipc.doneMark(vault, { ...input, revision: 'v2' });
  expect(await useDoneMarksStore.getState().undoDone(first, null)).toBe(false);
  expect(useDoneMarksStore.getState().marks[markId(input)]).toEqual(newer.set);
});
it('imports old dismissals once and does not migrate a live mirror into another vault', async () => {
  localStorage.setItem('cerebro.dismissedInsights', JSON.stringify(['old.md']));
  const importer = vi.spyOn(ipc, 'doneMarksImport');
  await useDoneMarksStore.getState().hydrate(vault);
  expect(useDoneMarksStore.getState().isDone('insight', 'old.md')).toBe(true);
  await useDoneMarksStore.getState().markDone({ ...input, until: 'forever', revision: null });
  expect(JSON.parse(localStorage.getItem('cerebro.dismissedInsights')!)).toEqual(['old.md']);
  useDoneMarksStore.getState().reset(vault);
  await useDoneMarksStore.getState().hydrate(vault);
  expect(importer).toHaveBeenCalledOnce();
  await useDoneMarksStore.getState().hydrate(vault + 'b');
  expect(useDoneMarksStore.getState().isDone('insight', 'concept.md')).toBe(false);
});
it('holds back after a read failure and catches write failures', async () => {
  vi.spyOn(ipc, 'doneMarksRead').mockRejectedValueOnce(Error('disk'));
  await useDoneMarksStore.getState().hydrate(vault);
  expect(useDoneMarksStore.getState().status).toBe('error');
  expect(await useDoneMarksStore.getState().markDone(input)).toBe(false);
  useDoneMarksStore.getState().reset(vault);
  await useDoneMarksStore.getState().hydrate(vault);
  vi.spyOn(ipc, 'doneMark').mockRejectedValueOnce(Error('disk'));
  expect(await useDoneMarksStore.getState().markDone(input)).toBe(false);
  expect(useUiStore.getState().toast).toHaveBeenCalled();
});
it('does not let a late write change the next vault mirror', async () => {
  await useDoneMarksStore.getState().hydrate(vault);
  const real = ipc.doneMark;
  let finish!: () => void;
  vi.spyOn(ipc, 'doneMark').mockImplementation(async (...args) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return real(...args);
  });
  const pending = useDoneMarksStore.getState().markDone(input);
  await useDoneMarksStore.getState().hydrate(vault + 'b');
  finish();
  await pending;
  expect(useDoneMarksStore.getState().marks).toEqual({});
  expect(useUiStore.getState().dismissedInsights).toEqual([]);
});
