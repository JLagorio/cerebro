// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TitleCell } from './TitleCell';
import {
  __resetOpenPages,
  flushOpenPages,
  holdEditor,
  registerSaveParticipant,
  unresolvedOpenPages,
} from '@/editor/openPages';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import * as ipc from '@/lib/ipc';
vi.mock('@/lib/ipc', { spy: true });
const entry = makeEntry({ path: 'title.md', title: 'Before' });
beforeEach(() => {
  __resetOpenPages();
  useVaultStore.setState({
    vaultPath: '/field-vault',
    entriesVault: '/field-vault',
    status: 'ready',
    entries: [entry],
  });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
});
it('retains a focused refused title across unmount and offers Retry without a keystroke', async () => {
  const write = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const first = render(<TitleCell entry={entry} onCommit={write} />);
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: '  Exact title  ' },
  });
  await act(async () => {
    await flushOpenPages();
  });
  first.unmount();
  expect(unresolvedOpenPages()[0].latestDraft).toBe('  Exact title  ');
  render(<TitleCell entry={entry} onCommit={write} />);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveProperty('value', '  Exact title  ');
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving Title' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith('Exact title');
});
it('joins title Enter and Save and keeps an invalid focused title unresolved', async () => {
  let finish!: (saved: boolean) => void;
  const write = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  render(<TitleCell entry={entry} onCommit={write} />);
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds).toHaveLength(1);
  });
  expect(write).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveProperty('value', '   ');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  let save!: ReturnType<typeof flushOpenPages>;
  act(() => {
    save = flushOpenPages();
  });
  expect(write).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(true);
    await save;
  });
  expect(unresolvedOpenPages()).toEqual([]);
});
it('actual guarded setTitle can flush its open body without waiting on its own field', async () => {
  const setTitle = useVaultStore.getState().setTitle;
  const disk = vi.spyOn(ipc, 'setNoteTitle').mockResolvedValue(undefined);
  useVaultStore.setState({ rescan: vi.fn().mockResolvedValue(undefined) });
  const release = holdEditor(entry.path, 'body-owner');
  render(<TitleCell entry={entry} onCommit={(title) => setTitle(entry.path, title)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Actual guarded title' } });
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  release();
  expect(disk).toHaveBeenCalledWith('/field-vault', entry.path, 'Actual guarded title');
  expect(report.unresolvedOwnerIds).toEqual([]);
  expect(report.outcomes[0]).toMatchObject({ kind: 'committed', source: 'guarded_field' });
});
it.each(['Before', '  Before  '])(
  'restored semantic title settles as clean without an IPC write (%s)',
  async (final) => {
    const disk = vi.spyOn(ipc, 'setNoteTitle').mockResolvedValue(undefined);
    render(
      <TitleCell
        entry={entry}
        onCommit={(title) => useVaultStore.getState().setTitle(entry.path, title)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: final } });
    let report!: Awaited<ReturnType<typeof flushOpenPages>>;
    await act(async () => {
      report = await flushOpenPages();
    });
    expect(disk).not.toHaveBeenCalled();
    expect(report.outcomes[0].kind).toBe('clean');
    expect(report.unresolvedOwnerIds).toEqual([]);
    expect(screen.queryByRole('textbox')).toBeNull();
  },
);
it.each(['missing', 'vault', 'opening'])(
  'does not settle restored title when its target is %s',
  async (reason) => {
    const disk = vi.spyOn(ipc, 'setNoteTitle').mockResolvedValue(undefined);
    render(
      <TitleCell
        entry={entry}
        onCommit={(title) => useVaultStore.getState().setTitle(entry.path, title)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Before  ' } });
    act(() =>
      useVaultStore.setState(
        reason === 'missing'
          ? { entries: [] }
          : reason === 'vault'
            ? { vaultPath: '/different' }
            : { entriesVault: '/opening' },
      ),
    );
    await act(async () => {
      expect((await flushOpenPages()).unresolvedOwnerIds).toHaveLength(1);
    });
    expect(disk).not.toHaveBeenCalled();
    expect(unresolvedOpenPages()[0].latestDraft).toBe('  Before  ');
  },
);
it('settles restored title only after a conflicting body is resolved', async () => {
  let held = true;
  registerSaveParticipant({
    key: { vaultId: '/field-vault', path: entry.path, ownerId: 'body-conflict' },
    phase: 'body',
    prepare: () => undefined,
    snapshot: () => ({
      latestDraft: '# Conflicting body',
      generation: 1,
      acknowledgedGeneration: held ? 0 : 1,
      inFlightGeneration: null,
      failure: null,
    }),
    blocked: () => (held ? 'reconcile' : null),
    flush: async () => ({ kind: 'clean', ownerId: 'body-conflict', generation: 1 }),
  });
  const disk = vi.spyOn(ipc, 'setNoteTitle').mockResolvedValue(undefined);
  render(
    <TitleCell
      entry={entry}
      onCommit={(title) => useVaultStore.getState().setTitle(entry.path, title)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Before  ' } });
  await act(async () => {
    expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0);
  });
  expect(screen.getByRole('textbox')).toHaveProperty('value', '  Before  ');
  expect(disk).not.toHaveBeenCalled();
  held = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving Title' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(disk).not.toHaveBeenCalled();
  expect(unresolvedOpenPages()).toEqual([]);
});
it.each(['Changed', '  Changed  '])(
  'never reinterprets a real refusal as unchanged after an optimistic matching snapshot (%s)',
  async (retry) => {
    const write = vi.fn(async (title: string) => {
      useVaultStore.setState({ entries: [{ ...entry, title }] });
      return false;
    });
    render(<TitleCell entry={entry} onCommit={write} />);
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed' } });
    await act(async () => {
      await flushOpenPages();
    });
    if (retry === 'Changed')
      fireEvent.click(screen.getByRole('button', { name: 'Retry saving Title' }));
    else {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: retry } });
      await act(async () => {
        await flushOpenPages();
      });
    }
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(unresolvedOpenPages()).toHaveLength(1);
    expect(screen.getByRole('textbox')).toHaveProperty('value', retry);
  },
);
it('settles a corrected refused title against its authoritative saved value as clean', async () => {
  const disk = vi.spyOn(ipc, 'setNoteTitle').mockRejectedValueOnce(Error('write refused'));
  useVaultStore.setState({
    rescan: vi.fn(async () => {
      useVaultStore.setState({ entries: [entry] });
    }),
  });
  render(
    <TitleCell
      entry={entry}
      onCommit={(title) => useVaultStore.getState().setTitle(entry.path, title)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Refused new title' } });
  await act(async () => {
    await flushOpenPages();
  });
  expect(unresolvedOpenPages()).toHaveLength(1);
  expect(useVaultStore.getState().entries[0].title).toBe('Before');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Before  ' } });
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  expect(disk).toHaveBeenCalledTimes(1);
  expect(report.outcomes[0].kind).toBe('clean');
  expect(report.unresolvedOwnerIds).toEqual([]);
  expect(screen.queryByRole('textbox')).toBeNull();
});
