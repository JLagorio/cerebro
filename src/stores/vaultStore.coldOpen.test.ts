// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorityError } from '@/lib/generated/workspace';
import type { Entry } from '@/engine/types';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));
vi.mock('@/lib/ipc', { spy: true });
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import * as ipc from '@/lib/ipc';
import * as mockBackend from '@/lib/mockIpc';
import { __resetRescans, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';

const PAGE = 'projects/guided-onboarding-ga/items/fld-1.md';
const PENDING: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'recovery_required',
  message: 'This workspace has an unfinished paired change.',
  retryable: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function title() {
  return useVaultStore.getState().entries.find((entry) => entry.path === PAGE)?.title;
}

beforeEach(() => {
  mockBackend.resetMockFs();
  vi.clearAllMocks();
  __resetRescans();
  useVaultStore.setState({
    vaultPath: null,
    entries: [],
    entriesVault: null,
    views: [],
    collections: [],
    folders: [],
    status: 'idle',
    error: null,
    scanObservation: null,
  });
  useUiStore.setState({ toasts: [] });
  vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
  vi.mocked(ipc.listViews).mockImplementation(mockBackend.listViews);
  vi.mocked(ipc.listCollections).mockImplementation(mockBackend.listCollections);
  vi.mocked(ipc.listFolders).mockImplementation(mockBackend.listFolders);
  vi.mocked(ipc.getPanelAgent).mockImplementation(mockBackend.getPanelAgent);
  vi.mocked(ipc.startWatcher).mockImplementation(mockBackend.startWatcher);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.mocked(ipc.scanVault).mockReset();
  vi.mocked(ipc.listViews).mockReset();
  vi.mocked(ipc.listCollections).mockReset();
  vi.mocked(ipc.listFolders).mockReset();
  vi.mocked(ipc.getPanelAgent).mockReset();
  vi.mocked(ipc.startWatcher).mockReset();
});

describe('selected cold-open recovery', () => {
  // Break caught: treating the selected pending scan refusal as a terminal open
  // failure makes the actual startup owner unreachable. Native paired tests pin
  // the refusal and recovery; this test covers the frontend orchestration.
  it('opens a selected pending workspace through startup before reading recovered entries', async () => {
    let pending = true;
    const order: string[] = [];
    vi.mocked(ipc.scanVault).mockImplementation(async (vault) => {
      order.push('scan');
      if (pending) throw PENDING;
      return mockBackend.scanVault(vault);
    });
    vi.mocked(ipc.startWatcher).mockImplementation(async (vault) => {
      order.push('startup');
      await mockBackend.setNoteTitle(vault, PAGE, 'Recovered page');
      pending = false;
      return null;
    });

    await useVaultStore.getState().openVault('/selected');

    expect(useVaultStore.getState().status).toBe('ready');
    expect(useVaultStore.getState().entriesVault).toBe('/selected');
    expect(title()).toBe('Recovered page');
    expect(order).toEqual(['scan', 'startup', 'scan']);
    expect(ipc.startWatcher).toHaveBeenCalledExactlyOnceWith('/selected');
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it.each([
    ['legacy text', 'This workspace has an unfinished paired change.'],
    ['Error message', new Error('recovery_required')],
    ['null', null],
    ['kind alone', { kind: 'recovery_required' }],
    ['wrong code', { ...PENDING, code: 'invalid_value' }],
    ['wrong kind', { ...PENDING, kind: 'invalid_metadata' }],
    ['missing message', { code: PENDING.code, kind: PENDING.kind, retryable: false }],
    ['non-string message', { ...PENDING, message: 1 }],
    ['missing retryable', { code: PENDING.code, kind: PENDING.kind, message: PENDING.message }],
    ['non-boolean retryable', { ...PENDING, retryable: 'false' }],
    ['unexpected retryable', { ...PENDING, retryable: true }],
  ])('does not dispatch startup for %s', async (_label, refusal) => {
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(refusal);

    await useVaultStore.getState().openVault('/refused');

    expect(useVaultStore.getState().status).toBe('error');
    expect(useVaultStore.getState().entriesVault).toBeNull();
    expect(ipc.startWatcher).not.toHaveBeenCalled();
    expect(ipc.listViews).not.toHaveBeenCalled();
    expect(ipc.listFolders).not.toHaveBeenCalled();
  });

  it('keeps an ordinary rescan read-only when selected recovery is required', async () => {
    await useVaultStore.getState().openVault('/selected');
    const entries = useVaultStore.getState().entries;
    vi.mocked(ipc.startWatcher).mockClear();
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(PENDING);

    await useVaultStore.getState().rescan();

    expect(ipc.startWatcher).not.toHaveBeenCalled();
    expect(useVaultStore.getState().entries).toBe(entries);
    expect(useVaultStore.getState().scanObservation?.outcome).toBe('unavailable');
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Couldn't refresh vault",
    ]);
  });

  it('preserves the previous snapshot while startup runs and surfaces its refusal', async () => {
    await useVaultStore.getState().openVault('/previous');
    const entries = useVaultStore.getState().entries;
    const startup = deferred<null>();
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(PENDING);
    vi.mocked(ipc.startWatcher).mockImplementationOnce(() => startup.promise);
    vi.mocked(ipc.startWatcher).mockClear();
    const opened = useVaultStore.getState().openVault('/selected');
    try {
      await vi.waitFor(() => expect(ipc.startWatcher).toHaveBeenCalledWith('/selected'));
      expect(useVaultStore.getState().status).toBe('scanning');
      expect(useVaultStore.getState().entries).toBe(entries);
      expect(useVaultStore.getState().entriesVault).toBe('/previous');
      startup.reject(new Error('Protected recovery requires its original retained copy.'));
      await opened;
      expect(useVaultStore.getState().status).toBe('error');
      expect(useVaultStore.getState().error).toBe(
        'Protected recovery requires its original retained copy.',
      );
      expect(useVaultStore.getState().entries).toBe(entries);
      expect(useVaultStore.getState().entriesVault).toBe('/previous');
      expect(ipc.startWatcher).toHaveBeenCalledTimes(1);
      expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
        "Couldn't open vault: Protected recovery requires its original retained copy.",
      ]);
    } finally {
      startup.resolve(null);
      await opened;
    }
  });

  it('ends a recovered open as unavailable when its first usable read fails', async () => {
    await useVaultStore.getState().openVault('/previous');
    const entries = useVaultStore.getState().entries;
    vi.mocked(ipc.scanVault)
      .mockRejectedValueOnce(PENDING)
      .mockRejectedValueOnce(new Error('Recovered metadata is unreadable.'));
    vi.mocked(ipc.startWatcher).mockResolvedValueOnce(null);

    await useVaultStore.getState().openVault('/selected');

    expect(useVaultStore.getState().status).toBe('error');
    expect(useVaultStore.getState().error).toBe('Recovered metadata is unreadable.');
    expect(useVaultStore.getState().entries).toBe(entries);
    expect(useVaultStore.getState().entriesVault).toBe('/previous');
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
      "Couldn't open vault: Recovered metadata is unreadable.",
    ]);
  });

  it('does not restart recovery when the post-startup read still refuses pending state', async () => {
    vi.mocked(ipc.scanVault).mockRejectedValue(PENDING);
    vi.mocked(ipc.startWatcher).mockResolvedValue(null);

    await useVaultStore.getState().openVault('/selected');

    expect(ipc.startWatcher).toHaveBeenCalledExactlyOnceWith('/selected');
    expect(ipc.scanVault).toHaveBeenCalledTimes(2);
    expect(useVaultStore.getState().status).toBe('error');
    expect(useVaultStore.getState().error).toBe(PENDING.message);
    expect(useVaultStore.getState().entriesVault).toBeNull();
  });

  it('discards a recovery refusal from an initial scan superseded by another open', async () => {
    const scan = deferred<Entry[]>();
    vi.mocked(ipc.scanVault).mockImplementation((vault) =>
      vault === '/first' ? scan.promise : mockBackend.scanVault(vault),
    );
    const first = useVaultStore.getState().openVault('/first');
    await useVaultStore.getState().openVault('/second');
    const entries = useVaultStore.getState().entries;
    scan.reject(PENDING);
    await first;

    expect(ipc.startWatcher).toHaveBeenCalledExactlyOnceWith('/second');
    expect(useVaultStore.getState().entries).toBe(entries);
    expect(useVaultStore.getState().entriesVault).toBe('/second');
    expect(useVaultStore.getState().status).toBe('ready');
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('does not recover a queued open that was superseded before startup dispatch', async () => {
    const firstStartup = deferred<null>();
    const started: string[] = [];
    vi.mocked(ipc.scanVault).mockImplementation((vault) =>
      vault === '/pending' ? Promise.reject(PENDING) : mockBackend.scanVault(vault),
    );
    vi.mocked(ipc.startWatcher).mockImplementation(async (vault) => {
      started.push(vault);
      if (vault === '/first') return firstStartup.promise;
      return null;
    });
    const first = useVaultStore.getState().openVault('/first');
    let pending: Promise<void> | undefined;
    let newest: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(started).toEqual(['/first']));
      pending = useVaultStore.getState().openVault('/pending');
      await vi.waitFor(() => expect(ipc.scanVault).toHaveBeenCalledWith('/pending'));
      newest = useVaultStore.getState().openVault('/newest');
      await vi.waitFor(() => expect(ipc.scanVault).toHaveBeenCalledWith('/newest'));
      firstStartup.resolve(null);
      await Promise.all([first, pending, newest]);
      expect(started).toEqual(['/first', '/newest']);
      expect(useVaultStore.getState().entriesVault).toBe('/newest');
      expect(useVaultStore.getState().status).toBe('ready');
    } finally {
      firstStartup.resolve(null);
      await Promise.all([first, pending, newest]);
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'keeps an early newer successful rescan when the recovered read later %ss',
    async (outcome) => {
      const recovered = deferred<Entry[]>();
      const readStarted = deferred<void>();
      vi.mocked(ipc.scanVault)
        .mockRejectedValueOnce(PENDING)
        .mockImplementationOnce(() => {
          readStarted.resolve();
          return recovered.promise;
        });
      vi.mocked(ipc.startWatcher).mockResolvedValueOnce(null);
      const opened = useVaultStore.getState().openVault('/selected');
      try {
        await Promise.race([readStarted.promise, opened]);
        expect(ipc.startWatcher).toHaveBeenCalledExactlyOnceWith('/selected');
        await mockBackend.setNoteTitle('/selected', PAGE, 'Newer observed page');
        await useVaultStore.getState().rescan();
        const entries = useVaultStore.getState().entries;
        expect(title()).toBe('Newer observed page');
        if (outcome === 'reject') recovered.reject(new Error('Older read unavailable.'));
        else recovered.resolve([]);
        await opened;
        expect(useVaultStore.getState().entries).toBe(entries);
        expect(useVaultStore.getState().status).toBe('ready');
        expect(useVaultStore.getState().error).toBeNull();
        expect(useUiStore.getState().toasts).toEqual([]);
      } finally {
        recovered.resolve([]);
        await opened;
      }
    },
  );

  it('ignores a failed recovered read after another vault supersedes its opening', async () => {
    const recovered = deferred<Entry[]>();
    const readStarted = deferred<void>();
    vi.mocked(ipc.scanVault)
      .mockRejectedValueOnce(PENDING)
      .mockImplementationOnce(() => {
        readStarted.resolve();
        return recovered.promise;
      });
    vi.mocked(ipc.startWatcher).mockResolvedValue(null);
    const first = useVaultStore.getState().openVault('/selected');
    try {
      await Promise.race([readStarted.promise, first]);
      expect(ipc.startWatcher).toHaveBeenCalledWith('/selected');
      await useVaultStore.getState().openVault('/newest');
      const entries = useVaultStore.getState().entries;
      recovered.reject(new Error('Retired opening failed.'));
      await first;
      expect(useVaultStore.getState().entries).toBe(entries);
      expect(useVaultStore.getState().entriesVault).toBe('/newest');
      expect(useVaultStore.getState().status).toBe('ready');
      expect(useUiStore.getState().toasts).toEqual([]);
    } finally {
      recovered.resolve([]);
      await first;
    }
  });

  it('keeps the original recovery report toast and refresh after startup', async () => {
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(PENDING);
    vi.mocked(ipc.startWatcher).mockResolvedValueOnce({ unfinished: 3, restored: 2, kept: 1 });

    await useVaultStore.getState().openVault('/selected');

    expect(useVaultStore.getState().status).toBe('ready');
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Cerebro stopped partway through a change to 3 pages, so it put them back as they were. ' +
        '1 had changed since and were left alone.',
    ]);
    expect(ipc.scanVault).toHaveBeenCalledTimes(3);
  });

  it('retries a failed listener bind after selected startup recovery', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(PENDING);
    vi.mocked(ipc.startWatcher).mockResolvedValue(null);
    listenMock.mockRejectedValueOnce(new Error('listen failed')).mockResolvedValue(() => {});

    await useVaultStore.getState().openVault('/selected');
    expect(useVaultStore.getState().status).toBe('error');
    expect(useVaultStore.getState().error).toBe('listen failed');
    expect(useVaultStore.getState().entriesVault).toBeNull();
    await useVaultStore.getState().openVault('/selected');

    expect(useVaultStore.getState().status).toBe('ready');
    expect(useVaultStore.getState().entriesVault).toBe('/selected');
    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(ipc.startWatcher).toHaveBeenCalledTimes(2);
  });
});
