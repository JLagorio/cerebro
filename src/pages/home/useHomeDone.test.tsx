import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useDoneMarksStore } from '@/stores/doneMarksStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { markId } from '@/engine/reminderState';
import type { HomeRow } from '@/engine/homeLanes';
import { useHomeDone } from './useHomeDone';
const row: HomeRow = {
  subject: 'process:scout',
  path: null,
  title: 'Scout',
  done: {
    lane: 'run',
    subject: 'process:scout',
    until: 'revision',
    revision: '2026-07-28T11:30:00Z',
  },
};
beforeEach(() => {
  vi.restoreAllMocks();
  resetMockFs();
  useVaultStore.setState({ vaultPath: '/demo-vault' });
  useDoneMarksStore.getState().reset(null);
  useUiStore.setState({ toast: vi.fn() });
});
it('sends exactly the rendered revision and Undo restores the replaced mark', async () => {
  const old = await ipc.doneMark('/demo-vault', { ...row.done!, revision: '2026-07-26T12:00:00Z' });
  const write = vi.spyOn(ipc, 'doneMark');
  const { result } = renderHook(() => useHomeDone());
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    expect(await result.current.done(row)).toBe(true);
  });
  expect(write).toHaveBeenLastCalledWith('/demo-vault', row.done);
  const action = vi.mocked(useUiStore.getState().toast).mock.calls.at(-1)![1]!.action!;
  await act(async () => action.run());
  await waitFor(() =>
    expect(useDoneMarksStore.getState().marks[markId(row.done!)]).toEqual(old.set),
  );
});
it('Undo never removes a newer mark written after Done', async () => {
  const { result } = renderHook(() => useHomeDone());
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    await result.current.done(row);
  });
  const action = vi.mocked(useUiStore.getState().toast).mock.calls.at(-1)![1]!.action!;
  const newer = await ipc.doneMark('/demo-vault', {
    ...row.done!,
    revision: '2026-07-28T11:45:00Z',
  });
  await act(async () => action.run());
  await waitFor(() =>
    expect(useDoneMarksStore.getState().marks[markId(row.done!)]).toEqual(newer.set),
  );
});
it('a refused mark toasts and returns false without offering Undo', async () => {
  const { result } = renderHook(() => useHomeDone());
  await waitFor(() => expect(result.current.ready).toBe(true));
  vi.spyOn(ipc, 'doneMark').mockRejectedValueOnce(Error('disk unavailable'));
  await act(async () => {
    expect(await result.current.done(row)).toBe(false);
  });
  expect(useUiStore.getState().toast).toHaveBeenCalledWith(
    'Done could not be saved. Please try again.',
  );
});
it('an Undo action cannot cross to another vault', async () => {
  const { result } = renderHook(() => useHomeDone());
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    await result.current.done(row);
  });
  const action = vi.mocked(useUiStore.getState().toast).mock.calls.at(-1)![1]!.action!;
  const undo = vi.spyOn(ipc, 'doneUnmark');
  await act(async () => {
    useVaultStore.setState({ vaultPath: '/another' });
  });
  action.run();
  expect(undo).not.toHaveBeenCalled();
  expect(useUiStore.getState().toast).toHaveBeenLastCalledWith('Reopen this vault to undo Done.');
});

it('doneMany writes each revision once, reports one partial result, and one Undo restores exact pre-images', async () => {
  const second: HomeRow = {
    ...row,
    subject: 'process:other',
    done: { ...row.done!, subject: 'process:other' },
  };
  const third: HomeRow = {
    ...row,
    subject: 'process:failed',
    done: { ...row.done!, subject: 'process:failed' },
  };
  const old = await ipc.doneMark('/demo-vault', { ...row.done!, revision: '2026-07-26T12:00:00Z' });
  const real = ipc.doneMark;
  const write = vi
    .spyOn(ipc, 'doneMark')
    .mockImplementation((vault, input) =>
      input.subject === third.subject ? Promise.reject(Error('disk')) : real(vault, input),
    );
  const { result } = renderHook(() => useHomeDone());
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    expect(await result.current.doneMany([row, second, third, row])).toBe(true);
  });
  expect(write).toHaveBeenCalledTimes(3);
  const toast = vi.mocked(useUiStore.getState().toast);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast.mock.calls[0][0]).toBe("Marked 2 done · 1 couldn't be marked");
  const undo = vi.spyOn(ipc, 'doneUnmark');
  await act(async () => toast.mock.calls[0][1]!.action!.run());
  await waitFor(() => expect(undo).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(useDoneMarksStore.getState().marks[markId(row.done!)]).toEqual(old.set),
  );
  await waitFor(() =>
    expect(useDoneMarksStore.getState().marks[markId(second.done!)]).toBeUndefined(),
  );
});
it('doneMany catches an unexpected writer throw and never offers an empty Undo', async () => {
  const { result } = renderHook(() => useHomeDone());
  await waitFor(() => expect(result.current.ready).toBe(true));
  const write = vi
    .spyOn(useDoneMarksStore.getState(), 'markDoneResult')
    .mockRejectedValueOnce(Error('broken adapter'));
  await act(async () => {
    expect(await result.current.doneMany([row])).toBe(false);
  });
  expect(useUiStore.getState().toast).toHaveBeenCalledWith(
    "Marked 0 done · 1 couldn't be marked",
    undefined,
  );
  write.mockRestore();
});
it('a batch stops after switching away and back while its first mark is pending', async () => {
  const second: HomeRow = { ...row, done: { ...row.done!, subject: 'process:other' } };
  const { result } = renderHook(() => useHomeDone());
  await waitFor(() => expect(result.current.ready).toBe(true));
  const made = await ipc.doneMark('/demo-vault', row.done!);
  let release!: (value: typeof made) => void;
  const write = vi.spyOn(ipc, 'doneMark').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let task!: Promise<boolean>;
  act(() => {
    task = result.current.doneMany([row, second]);
  });
  act(() => {
    useVaultStore.setState({ vaultPath: '/elsewhere' });
  });
  act(() => {
    useVaultStore.setState({ vaultPath: '/demo-vault' });
  });
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    release(made);
    expect(await task).toBe(false);
  });
  expect(write).toHaveBeenCalledOnce();
  expect(useUiStore.getState().toast).not.toHaveBeenCalled();
});
