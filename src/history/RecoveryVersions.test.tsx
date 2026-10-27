// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as ipc from '@/lib/ipc';
import { resetMockFs, createNote, peekFile } from '@/lib/mockIpc';
import { mockRecovery } from '@/lib/mockRecovery';
import { useVaultStore } from '@/stores/vaultStore';
import { RecoveryVersions } from './RecoveryVersions';
beforeEach(async () => {
  vi.restoreAllMocks();
  resetMockFs();
  useVaultStore.setState({ vaultPath: 'v' });
  await createNote('v', '', 'recovery', {}, 'before');
  mockRecovery.setEnabled('v', true);
  await ipc.saveNoteBody({ vault: 'v', path: 'recovery.md', body: 'after' });
});
it('loads selected exact bytes only on Preview and renders text safely', async () => {
  const read = vi.spyOn(ipc, 'readRecovery');
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
  expect((await screen.findByLabelText('Recovery copy text')).textContent).toBe('before');
  expect(read).toHaveBeenCalledTimes(1);
  expect(peekFile('recovery.md')).toBe('after');
});
it('shows a recovery read failure independently', async () => {
  vi.spyOn(ipc, 'listRecovery').mockRejectedValue(new Error('unavailable'));
  render(<RecoveryVersions path="recovery.md" />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'could not be read',
  );
});
it('requires explicit deletion and removes only the selected copy', async () => {
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete copy' }));
  expect(mockRecovery.status('v').entries).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete copy' }));
  await waitFor(() => expect(mockRecovery.status('v').entries).toBe(0));
  expect(peekFile('recovery.md')).toBe('after');
});

import { __resetOpenPages, onExternalWrite } from '@/editor/openPages';
import * as leave from '@/app/leaveGuard';
it('holds owners before target read and restore through refresh, and refuses stale target bytes', async () => {
  __resetOpenPages();
  const events: string[] = [];
  const stop = onExternalWrite('recovery.md', {
    pending: () => events.push('hold'),
    settled: () => events.push('release'),
  });
  const read = ipc.readNoteSource;
  vi.spyOn(ipc, 'readNoteSource').mockImplementation(async (...args) => {
    events.push('read');
    return read(...args);
  });
  const restore = ipc.restoreRecovery;
  vi.spyOn(ipc, 'restoreRecovery').mockImplementation(async (...args) => {
    events.push('write');
    return restore(...args);
  });
  vi.spyOn(useVaultStore.getState(), 'rescan').mockImplementation(async () => {
    events.push('scan');
  });
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore copy' }));
  await waitFor(() => expect(peekFile('recovery.md')).toBe('before'));
  await waitFor(() => expect(events).toEqual(['hold', 'read', 'write', 'scan', 'release']));
  stop();
});
it('native conflict remains visible and never reports successful restore', async () => {
  vi.spyOn(ipc, 'restoreRecovery').mockRejectedValue(new Error('stale_content'));
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore copy' }));
  expect((await screen.findByRole('alert')).textContent).toContain('stale_content');
  expect(screen.queryByRole('status')).toBeNull();
  expect(peekFile('recovery.md')).toBe('after');
});
it('vault change while the save barrier waits cannot restore the old origin', async () => {
  let release!: (value: boolean) => void;
  vi.spyOn(leave, 'saveBeforeAction').mockReturnValue(
    new Promise((done) => {
      release = done;
    }),
  );
  const restore = vi.spyOn(ipc, 'restoreRecovery');
  const view = render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore copy' }));
  await act(async () => {
    useVaultStore.setState({ vaultPath: 'other' });
    release(true);
  });
  expect(restore).not.toHaveBeenCalled();
  expect(peekFile('recovery.md')).toBe('after');
  view.unmount();
});
it('preview is bounded, renders markup as text, and export reads the selected exact copy', async () => {
  mockRecovery.clear('v');
  mockRecovery.capture(
    'v',
    'recovery.md',
    '<script>unsafe()</script>' + 'x'.repeat(21000),
    'after',
  );
  const read = vi.spyOn(ipc, 'readRecovery');
  const exportCopy = vi.spyOn(ipc, 'exportRecovery').mockResolvedValue('selected.txt');
  render(<RecoveryVersions path="recovery.md" />);
  const button = await screen.findByRole('button', { name: 'Preview' });
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect((await screen.findByLabelText('Recovery copy text')).textContent?.length).toBe(20000);
  expect(screen.getByText(/Preview truncated/)).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Export copy' }));
  await waitFor(() =>
    expect(exportCopy).toHaveBeenCalledWith(
      'v',
      'recovery.md',
      mockRecovery.list('v', 'recovery.md')[0].id,
    ),
  );
});
it('a vault round trip while restore waits never revives its old origin', async () => {
  let release!: (value: boolean) => void;
  vi.spyOn(leave, 'saveBeforeAction').mockReturnValue(
    new Promise((done) => {
      release = done;
    }),
  );
  const restore = vi.spyOn(ipc, 'restoreRecovery');
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore copy' }));
  await act(async () => {
    useVaultStore.setState({ vaultPath: 'other' });
    useVaultStore.setState({ vaultPath: 'v' });
    release(true);
  });
  expect(restore).not.toHaveBeenCalled();
  expect(peekFile('recovery.md')).toBe('after');
});
it('recovery restore offers an exact failure choice and ordinary Retry sends no bypass', async () => {
  const restore = vi
    .spyOn(ipc, 'restoreRecovery')
    .mockRejectedValue(new Error('recovery_required:nonce'));
  vi.spyOn(ipc, 'recoveryFailure').mockResolvedValue({
    reason: 'journal_storage_failed',
    expiresAt: Date.now() / 1000 + 60,
  });
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore copy' }));
  await screen.findByRole('button', { name: 'Restore without a recovery copy' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry restore' }));
  await screen.findByRole('button', { name: 'Restore without a recovery copy' });
  expect(restore.mock.calls.every((args) => args[4] === undefined)).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recovery copies' }));
  });
  expect(screen.getByRole('button', { name: 'Retry restore' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore without a recovery copy' })).toBeTruthy();
  restore.mockResolvedValue({
    kind: 'file',
    contentHash: 'accepted',
    recovery: { kind: 'without_copy' },
  });
  vi.spyOn(useVaultStore.getState(), 'rescan').mockResolvedValue();
  fireEvent.click(screen.getByRole('button', { name: 'Restore without a recovery copy' }));
  await waitFor(() => expect(restore.mock.calls.at(-1)?.[4]).toBe('nonce'));
});
it('failed list reads can be retried without remounting', async () => {
  vi.spyOn(ipc, 'listRecovery').mockRejectedValueOnce(new Error('offline'));
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry recovery read' }));
  expect(await screen.findByRole('button', { name: 'Preview' })).toBeTruthy();
});
it('an explicit restore permit refuses a changed current file without submitting a bypass', async () => {
  const restore = vi
    .spyOn(ipc, 'restoreRecovery')
    .mockRejectedValue(new Error('recovery_required:nonce'));
  vi.spyOn(ipc, 'recoveryFailure').mockResolvedValue({
    reason: 'pending_capacity',
    expiresAt: Date.now() / 1000 + 60,
  });
  render(<RecoveryVersions path="recovery.md" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore copy' }));
  const choose = await screen.findByRole('button', { name: 'Restore without a recovery copy' });
  await ipc.saveNoteBody({ vault: 'v', path: 'recovery.md', body: 'new outside bytes' });
  fireEvent.click(choose);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('current page changed'),
  );
  expect(restore).toHaveBeenCalledTimes(1);
  expect(peekFile('recovery.md')).toBe('new outside bytes');
});
it('restores diagram preimages using their exact raw-file hash rather than the Markdown source door', async () => {
  const path = 'diagram.mmd';
  const raw = '---\r\ntitle: Diagram\r\n---\r\ngraph TD\r\n A-->B\r\n';
  const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  fs.set(path, raw);
  await ipc.saveNoteBody({ vault: 'v', path, body: 'graph TD\n A-->C\n' });
  vi.spyOn(useVaultStore.getState(), 'rescan').mockResolvedValue();
  render(<RecoveryVersions path={path} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore copy' }));
  await waitFor(() => expect(peekFile(path)).toBe(raw), { timeout: 1000 });
  expect((await screen.findByRole('status')).textContent).toContain('Restored recovery copy.');
});

it.each(['resolve', 'reject'] as const)(
  'an older list %s cannot erase newer metadata after a save and scan',
  async (settlement) => {
    mockRecovery.clear('v');
    useVaultStore.setState({ entries: await ipc.scanVault('v') });
    let resolve!: (rows: Awaited<ReturnType<typeof ipc.listRecovery>>) => void;
    let reject!: (error: Error) => void;
    vi.spyOn(ipc, 'listRecovery').mockImplementationOnce(
      () =>
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        }),
    );
    const read = vi.spyOn(ipc, 'readRecovery');
    render(<RecoveryVersions path="recovery.md" />);
    await act(async () => {
      await ipc.saveNoteBody({ vault: 'v', path: 'recovery.md', body: 'newer saved bytes' });
      useVaultStore.setState({ entries: await ipc.scanVault('v') });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeNull());
    await act(async () => {
      if (settlement === 'resolve') resolve([]);
      else reject(new Error('old read failed'));
    });
    expect(screen.getAllByRole('button', { name: 'Preview' })).toHaveLength(1);
    expect(screen.queryByText('No retained recovery copies for this page.')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  },
);
it('manual Refresh discovers cleanup without fetching copy bodies', async () => {
  const read = vi.spyOn(ipc, 'readRecovery');
  render(<RecoveryVersions path="recovery.md" />);
  await screen.findByRole('button', { name: 'Preview' });
  await ipc.clearRecovery('v');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh recovery copies' }));
  await screen.findByText('No retained recovery copies for this page.');
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
it('a failed refresh of an empty list is unavailable until a later read succeeds', async () => {
  mockRecovery.clear('v');
  render(<RecoveryVersions path="recovery.md" />);
  await screen.findByText('No retained recovery copies for this page.');
  vi.spyOn(ipc, 'listRecovery').mockRejectedValueOnce(new Error('refresh offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh recovery copies' }));
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'could not be read',
  );
  expect(screen.queryByText('No retained recovery copies for this page.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh recovery copies' }));
  await screen.findByText('No retained recovery copies for this page.');
  expect(screen.queryByTestId('section-unavailable')).toBeNull();
});
