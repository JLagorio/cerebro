// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

vi.mock('@/engine/schema', () => ({
  buildSchema: vi.fn(() => ({ types: new Map() })),
}));
// Spy mode: implementations stay intact (delegating to mockIpc in the
// browser); individual tests override them to simulate the Tauri backend.
vi.mock('@/lib/ipc', { spy: true });
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { staleWords, type OpenReport } from '@/engine/batch';
import { observeScan, type ScanBaseline } from '@/engine/events';
import { onExternalWrite, registerFlush } from '@/editor/openPages';
import { buildSchema } from '@/engine/schema';
import * as ipc from '@/lib/ipc';
import * as mockBackend from '@/lib/mockIpc';
import { resetMockFs } from '@/lib/mockIpc';
import { sha256Hex } from '@/lib/sha256';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import {
  __resetRescans,
  getSchema,
  useEntry,
  useVaultStore,
  WRITE_WAIT_MS,
} from '@/stores/vaultStore';

/** An open that put nothing back (M60.6). */
const NOTHING_PUT_BACK: OpenReport = { unfinished: 0, restored: 0, kept: 0 };

function findEntry(path: string) {
  return useVaultStore.getState().entries.find((e) => e.path === path);
}

/** Make inTauri() report true; callers must exitTauri() in a finally block. */
function enterTauri(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}
function exitTauri(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

function mockFsDisk(): Map<string, string> {
  return (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
}

/** Every scan the store lands, through the trigger diff the way the runner
 * feeds it — the events it read, as [kind, path]. */
function observeStoreScans(): { events: Array<[string, string]>; stop: () => void } {
  const events: Array<[string, string]> = [];
  let baseline: ScanBaseline | null = null;
  const stop = useVaultStore.subscribe((s, prev) => {
    if (s.entriesVault === null) return;
    if (s.entries === prev.entries && s.entriesVault === prev.entriesVault) return;
    const scan = observeScan(baseline, s.entriesVault, s.entries);
    baseline = scan.baseline;
    events.push(...scan.events.map((e): [string, string] => [e.kind, e.path]));
  });
  return { events, stop };
}

beforeEach(() => {
  resetMockFs();
  vi.clearAllMocks();
  // The rescan coalescer and the write fence are module state: a test that
  // parked a scan or a write must not hold the next one behind it (M58.2).
  __resetRescans();
  useVaultStore.setState({
    vaultPath: null,
    entries: [],
    entriesVault: null,
    views: [],
    status: 'idle',
    error: null,
  });
});

describe('vaultStore', () => {
  it('openVault scans the demo vault into entries and views', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const s = useVaultStore.getState();
    expect(s.status).toBe('ready');
    expect(s.vaultPath).toBe('/demo-vault');
    expect(s.entries.length).toBeGreaterThan(50);
    expect(Array.isArray(s.views)).toBe(true);
    const item = findEntry('projects/guided-onboarding-ga/items/fld-1.md');
    expect(item?.title).toBe('First-run walkthrough GA');
    // M12.5 aftermath: no project.md markers in the demo vault — projects are
    // ordinary records, so folder containment resolves to null.
    expect(item?.project).toBeNull();
    // Task 10: directories load alongside entries for the file trees.
    expect(s.folders).toContain('projects/guided-onboarding-ga/items');
    expect(s.folders).toContain('inbox');
  });

  it('patchFrontmatter applies optimistically before the write resolves', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const pending = useVaultStore
      .getState()
      .patchFrontmatter('projects/guided-onboarding-ga/items/fld-1.md', {
        status: 'done',
        assignee: '[[sam-ito]]',
      });
    // Synchronously visible: scalar to properties, wikilink to relationships.
    expect(findEntry('projects/guided-onboarding-ga/items/fld-1.md')?.properties.status).toBe(
      'done',
    );
    expect(
      findEntry('projects/guided-onboarding-ga/items/fld-1.md')?.relationships.assignee,
    ).toEqual(['sam-ito']);
    await pending;
    // Survives the reconciling rescan because the mock disk was updated too.
    expect(findEntry('projects/guided-onboarding-ga/items/fld-1.md')?.properties.status).toBe(
      'done',
    );
    expect(
      findEntry('projects/guided-onboarding-ga/items/fld-1.md')?.relationships.assignee,
    ).toEqual(['sam-ito']);
  });

  it('patchFrontmatter with null deletes the field', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    await useVaultStore
      .getState()
      .patchFrontmatter('projects/guided-onboarding-ga/items/fld-1.md', { due: null });
    expect(
      findEntry('projects/guided-onboarding-ga/items/fld-1.md')?.properties,
    ).not.toHaveProperty('due');
  });

  it('patchFrontmatter surfaces a failed disk write as a toast and reverts', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.updateFrontmatter).mockRejectedValueOnce(new Error('disk full'));
    await useVaultStore
      .getState()
      .patchFrontmatter('projects/guided-onboarding-ga/items/fld-1.md', { status: 'done' });
    // Disk truth wins: the optimistic update is reverted by the rescan.
    expect(findEntry('projects/guided-onboarding-ga/items/fld-1.md')?.properties.status).toBe(
      'progress',
    );
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(
      "Couldn't save changes to projects/guided-onboarding-ga/items/fld-1.md",
    );
  });

  // Deviation test (Task 23, execution-log note 15a, reported): a stale
  // last-vault boot landed in a dead empty shell — status:'error' was
  // displayed nowhere. openVault failures now also enqueue a toast so the
  // ToastHost surfaces them the moment the shell renders.
  it('openVault surfaces a failed scan via toast alongside the error status', async () => {
    useUiStore.setState({ toasts: [] });
    vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('not a vault'));
    await useVaultStore.getState().openVault('/bad-vault');
    const s = useVaultStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('not a vault');
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      "Couldn't open vault: not a vault",
    );
  });

  // M49: measured 2026-09-28 — a window titled `test` held the demo vault's
  // entries and recorded the demo vault, because the first open's slow
  // start_watcher finished after the second's.
  it('a second open while the first is still starting its watcher wins, in the backend too', async () => {
    const started: string[] = [];
    let releaseFirst: () => void = () => undefined;
    vi.mocked(ipc.scanVault).mockImplementation(async (vault) =>
      vault === '/first' ? [] : mockBackend.scanVault(vault),
    );
    vi.mocked(ipc.startWatcher).mockImplementation((vault) => {
      started.push(vault);
      return vault === '/first'
        ? new Promise<OpenReport>((resolve) => (releaseFirst = () => resolve(NOTHING_PUT_BACK)))
        : Promise.resolve(NOTHING_PUT_BACK);
    });

    const first = useVaultStore.getState().openVault('/first');
    await vi.waitFor(() => expect(started).toEqual(['/first']));
    const second = useVaultStore.getState().openVault('/second');
    // Queued behind the first: started in the order asked, so the backend
    // ends on the vault asked for last.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(['/first']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(started).toEqual(['/first', '/second']);
    const s = useVaultStore.getState();
    expect(s.vaultPath).toBe('/second');
    expect(s.status).toBe('ready');
    expect(s.entries.length).toBeGreaterThan(50);
  });

  it('openVault and rescan name the vault their entries were scanned from (AUTOMATION-2b)', async () => {
    expect(useVaultStore.getState().entriesVault).toBeNull();
    await useVaultStore.getState().openVault('/demo-vault');
    expect(useVaultStore.getState().entriesVault).toBe('/demo-vault');
    const scanned = useVaultStore.getState().entries;
    await useVaultStore.getState().rescan();
    expect(useVaultStore.getState().entries).not.toBe(scanned);
    expect(useVaultStore.getState().entriesVault).toBe('/demo-vault');
  });

  // AUTOMATION-2b: the trigger diff ran across this window and read every
  // note in the new vault as just created. A reader can only avoid that if
  // the snapshot says which vault it is.
  it('an open moves vaultPath at once, but names its snapshot only when the entries land', async () => {
    let releaseWatcher: () => void = () => undefined;
    vi.mocked(ipc.startWatcher).mockImplementation((vault) =>
      vault === '/second'
        ? new Promise<OpenReport>((resolve) => (releaseWatcher = () => resolve(NOTHING_PUT_BACK)))
        : Promise.resolve(NOTHING_PUT_BACK),
    );
    try {
      await useVaultStore.getState().openVault('/first');
      const firstEntries = useVaultStore.getState().entries;
      expect(useVaultStore.getState().entriesVault).toBe('/first');

      const second = useVaultStore.getState().openVault('/second');
      await vi.waitFor(() => expect(vi.mocked(ipc.startWatcher)).toHaveBeenCalledWith('/second'));
      // The window — up to a minute on a vault with history (M49): the open
      // vault is /second, the entries are still /first's, and they say so.
      expect(useVaultStore.getState().vaultPath).toBe('/second');
      expect(useVaultStore.getState().entries).toBe(firstEntries);
      expect(useVaultStore.getState().entriesVault).toBe('/first');

      releaseWatcher();
      await second;
      expect(useVaultStore.getState().entries).not.toBe(firstEntries);
      expect(useVaultStore.getState().entriesVault).toBe('/second');
    } finally {
      vi.mocked(ipc.startWatcher).mockReset();
    }
  });

  // M53.30: the shell shows the last vault's records until the new scan
  // lands, and an inline edit wrote their path under the new vault, onto
  // whatever page sat at the same path there.
  it('an inline edit made while a vault opens writes nothing, and lands once its entries have', async () => {
    const PATH = 'projects/guided-onboarding-ga/items/fld-1.md';
    const STILL_OPENING = 'Not saved — the vault is still opening';
    const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
    let releaseWatcher: () => void = () => undefined;
    // Both vaults scan the demo vault, so the path names a page in each.
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    vi.mocked(ipc.startWatcher).mockImplementation((vault) =>
      vault === '/second'
        ? new Promise<OpenReport>((resolve) => (releaseWatcher = () => resolve(NOTHING_PUT_BACK)))
        : Promise.resolve(NOTHING_PUT_BACK),
    );
    try {
      await useVaultStore.getState().openVault('/first');
      const second = useVaultStore.getState().openVault('/second');
      await vi.waitFor(() => expect(vi.mocked(ipc.startWatcher)).toHaveBeenCalledWith('/second'));
      const { patchFrontmatter, setTitle } = useVaultStore.getState();
      const firstEntries = useVaultStore.getState().entries;
      useUiStore.setState({ toasts: [] });

      expect(await patchFrontmatter(PATH, { status: 'done' })).toBe(false);
      expect(toasts()).toEqual([STILL_OPENING]);
      useUiStore.setState({ toasts: [] });
      // A title cell commits on every blur: one left unchanged is no edit.
      expect(await setTitle(PATH, 'First-run walkthrough GA')).toBe(false);
      expect(toasts()).toEqual([]);
      expect(await setTitle(PATH, 'Renamed mid-open')).toBe(false);
      expect(toasts()).toEqual([STILL_OPENING]);
      // The toast on screen answers for every refusal behind it.
      expect(await patchFrontmatter(PATH, { status: 'todo' })).toBe(false);
      expect(toasts()).toEqual([STILL_OPENING]);
      expect(vi.mocked(ipc.updateFrontmatter)).not.toHaveBeenCalled();
      expect(vi.mocked(ipc.setNoteTitle)).not.toHaveBeenCalled();
      expect(useVaultStore.getState().entries).toBe(firstEntries);

      releaseWatcher();
      await second;
      expect(useVaultStore.getState().entriesVault).toBe('/second');
      expect(await patchFrontmatter(PATH, { status: 'done' })).toBe(true);
      expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalledWith('/second', PATH, {
        status: 'done',
      });
      expect(await setTitle(PATH, 'Renamed after the open')).toBe(true);
      expect(vi.mocked(ipc.setNoteTitle)).toHaveBeenCalledWith(
        '/second',
        PATH,
        'Renamed after the open',
      );
      expect(findEntry(PATH)?.properties.status).toBe('done');
      expect(findEntry(PATH)?.title).toBe('Renamed after the open');
    } finally {
      // A held watcher holds every later open behind it (`watcherQueue`).
      releaseWatcher();
      vi.mocked(ipc.scanVault).mockReset();
      vi.mocked(ipc.startWatcher).mockReset();
    }
  });

  it("an inline edit after a failed open says the vault didn't open, and writes nothing", async () => {
    const PATH = 'projects/guided-onboarding-ga/items/fld-1.md';
    const DID_NOT_OPEN = "Not saved — the vault didn't open";
    const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    try {
      await useVaultStore.getState().openVault('/first');
      vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('not a vault'));
      await useVaultStore.getState().openVault('/bad-vault');
      // The last vault's records stay on screen under the vault that failed.
      expect(useVaultStore.getState().status).toBe('error');
      expect(useVaultStore.getState().entriesVault).toBe('/first');
      useUiStore.setState({ toasts: [] });

      expect(await useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' })).toBe(false);
      expect(toasts()).toEqual([DID_NOT_OPEN]);
      useUiStore.setState({ toasts: [] });
      expect(await useVaultStore.getState().setTitle(PATH, 'Renamed')).toBe(false);
      expect(toasts()).toEqual([DID_NOT_OPEN]);
      expect(vi.mocked(ipc.updateFrontmatter)).not.toHaveBeenCalled();
      expect(vi.mocked(ipc.setNoteTitle)).not.toHaveBeenCalled();
    } finally {
      vi.mocked(ipc.scanVault).mockReset();
    }
  });

  // AUTOMATION-2b. rescan() scans `vaultPath`, which an open moves at once,
  // so a rescan inside the open's window lands the new vault's entries first.
  // The open's own scan, taken before it, then landed over them: the store
  // went back in time, and the trigger diff read the difference as an edit.
  it("a rescan inside an open's window is never rolled back by the open's older scan", async () => {
    const PATH = 'projects/guided-onboarding-ga/items/fld-1.md';
    let releaseWatcher: () => void = () => undefined;
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    vi.mocked(ipc.startWatcher).mockImplementation((vault) =>
      vault === '/second'
        ? new Promise<OpenReport>((resolve) => (releaseWatcher = () => resolve(NOTHING_PUT_BACK)))
        : Promise.resolve(NOTHING_PUT_BACK),
    );
    const scans = observeStoreScans();
    try {
      await useVaultStore.getState().openVault('/first');
      const second = useVaultStore.getState().openVault('/second');
      await vi.waitFor(() => expect(vi.mocked(ipc.startWatcher)).toHaveBeenCalledWith('/second'));
      // Inside the window, /second changes on disk and a rescan picks it up.
      await ipc.updateFrontmatter('/second', PATH, { probe: 'x' });
      await useVaultStore.getState().rescan();
      expect(useVaultStore.getState().entriesVault).toBe('/second');
      expect(findEntry(PATH)?.properties.probe).toBe('x');

      releaseWatcher();
      await second;
      expect(useVaultStore.getState().status).toBe('ready');
      expect(findEntry(PATH)?.properties.probe).toBe('x');
      // The first scan of each vault, and nothing read as an edit.
      expect(scans.events).toEqual([]);
    } finally {
      scans.stop();
      vi.mocked(ipc.scanVault).mockReset();
      vi.mocked(ipc.startWatcher).mockReset();
    }
  });

  it('a rescan asked for while another runs waits for it, then reads the disk again', async () => {
    const PATH = 'projects/guided-onboarding-ga/items/fld-1.md';
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    const scans = observeStoreScans();
    await useVaultStore.getState().openVault('/demo-vault');
    vi.mocked(ipc.scanVault).mockClear();
    // A job's finish() and a watcher event, say. The first rescan has read
    // the disk and is parked when the disk changes and the second is asked.
    let parked = false;
    let releaseScan: () => void = () => undefined;
    vi.mocked(ipc.scanVault).mockImplementationOnce(async (vault) => {
      const before = await mockBackend.scanVault(vault);
      parked = true;
      await new Promise<void>((resolve) => (releaseScan = resolve));
      return before;
    });
    try {
      const first = useVaultStore.getState().rescan();
      await vi.waitFor(() => expect(parked).toBe(true));
      await ipc.updateFrontmatter('/demo-vault', PATH, { probe: 'x' });
      const second = useVaultStore.getState().rescan();
      // It joins the running one rather than racing it.
      expect(second).toBe(first);
      releaseScan();
      await second;
      expect(findEntry(PATH)?.properties.probe).toBe('x');
      expect(vi.mocked(ipc.scanVault)).toHaveBeenCalledTimes(2);
      // One real edit, read once — never a second, backwards one.
      expect(scans.events).toEqual([['changed', PATH]]);
    } finally {
      scans.stop();
      vi.mocked(ipc.scanVault).mockReset();
    }
  });

  it('an open superseded before its scan ends never starts a watcher or sets entries', async () => {
    const started: string[] = [];
    let releaseScan: (entries: Awaited<ReturnType<typeof ipc.scanVault>>) => void = () => undefined;
    vi.mocked(ipc.scanVault).mockImplementation((vault) =>
      vault === '/first'
        ? new Promise((resolve) => (releaseScan = resolve))
        : mockBackend.scanVault(vault),
    );
    vi.mocked(ipc.startWatcher).mockImplementation(async (vault) => {
      started.push(vault);
      return NOTHING_PUT_BACK;
    });

    const first = useVaultStore.getState().openVault('/first');
    await useVaultStore.getState().openVault('/second');
    const secondEntries = useVaultStore.getState().entries;
    releaseScan([]);
    await first;

    expect(started).toEqual(['/second']);
    expect(useVaultStore.getState().vaultPath).toBe('/second');
    expect(useVaultStore.getState().entries).toBe(secondEntries);
  });

  it('createItem returns the new path and the entry appears after rescan', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const path = await useVaultStore.getState().createItem({
      folder: 'items',
      slug: 'fld-99',
      frontmatter: {
        type: 'Work item',
        key: 'FLD-99',
        status: 'todo',
        project: '[[guided-onboarding-ga]]',
      },
    });
    expect(path).toBe('items/fld-99.md');
    const entry = findEntry(path);
    expect(entry?.properties.key).toBe('FLD-99');
    expect(entry?.relationships.project).toEqual(['guided-onboarding-ga']);
  });

  it('createItem rescans even inside Tauri, where the watcher suppresses own writes', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    // Route IPC to the mock backend, then flip on Tauri detection: the store
    // must not rely on a vault-changed event (own-write suppression discards
    // it) and has to rescan itself.
    vi.mocked(ipc.createNote).mockImplementation(mockBackend.createNote);
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    vi.mocked(ipc.listViews).mockImplementation(mockBackend.listViews);
    vi.mocked(ipc.listCollections).mockImplementation(mockBackend.listCollections);
    vi.mocked(ipc.listFolders).mockImplementation(mockBackend.listFolders);
    enterTauri();
    try {
      const path = await useVaultStore.getState().createItem({
        folder: 'items',
        slug: 'fld-77',
        frontmatter: { type: 'Work item', key: 'FLD-77', status: 'todo' },
      });
      expect(path).toBe('items/fld-77.md');
      expect(findEntry(path)?.properties.key).toBe('FLD-77');
    } finally {
      exitTauri();
      vi.mocked(ipc.createNote).mockReset();
      vi.mocked(ipc.scanVault).mockReset();
      vi.mocked(ipc.listViews).mockReset();
      vi.mocked(ipc.listCollections).mockReset();
      vi.mocked(ipc.listFolders).mockReset();
    }
  });

  it('patchFrontmatter treats undefined exactly like null: the key is deleted on disk', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    await useVaultStore
      .getState()
      .patchFrontmatter('projects/guided-onboarding-ga/items/fld-1.md', { due: undefined });
    // Normalized to null before the IPC call: JSON serialization to Tauri
    // silently drops undefined keys, and the mock's yaml doc.set would write
    // `due: null` instead of deleting.
    expect(vi.mocked(ipc.updateFrontmatter)).toHaveBeenCalledWith(
      '/demo-vault',
      'projects/guided-onboarding-ga/items/fld-1.md',
      {
        due: null,
      },
    );
    expect(
      findEntry('projects/guided-onboarding-ga/items/fld-1.md')?.properties,
    ).not.toHaveProperty('due');
    expect(mockFsDisk().get('projects/guided-onboarding-ga/items/fld-1.md')).not.toMatch(/^due:/m);
  });

  it('rebinds the vault-changed listener after a failed bind and contains rescan errors', async () => {
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    vi.mocked(ipc.listViews).mockImplementation(mockBackend.listViews);
    vi.mocked(ipc.listCollections).mockImplementation(mockBackend.listCollections);
    vi.mocked(ipc.listFolders).mockImplementation(mockBackend.listFolders);
    vi.mocked(ipc.startWatcher).mockImplementation(mockBackend.startWatcher);
    enterTauri();
    try {
      // First bind fails: openVault errors, but must NOT latch watcherBound.
      listenMock.mockRejectedValueOnce(new Error('listen failed'));
      await useVaultStore.getState().openVault('/demo-vault');
      expect(useVaultStore.getState().status).toBe('error');

      // Second openVault retries the bind and succeeds.
      listenMock.mockResolvedValue(() => {});
      await useVaultStore.getState().openVault('/demo-vault');
      expect(useVaultStore.getState().status).toBe('ready');
      expect(listenMock).toHaveBeenCalledTimes(2);

      // A failing rescan inside the listener keeps the last good snapshot
      // and toasts (M14.8) — the app stays usable instead of flipping into
      // the dead error shell, and nothing becomes an unhandled rejection.
      const entriesBefore = useVaultStore.getState().entries;
      useUiStore.setState({ toasts: [] });
      const handler = listenMock.mock.calls[1][1] as () => void;
      vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('scan failed'));
      handler();
      await vi.waitFor(() => {
        expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
          "Couldn't refresh vault",
        );
      });
      expect(useVaultStore.getState().status).toBe('ready');
      expect(useVaultStore.getState().entries).toBe(entriesBefore);
    } finally {
      exitTauri();
      vi.mocked(ipc.scanVault).mockReset();
      vi.mocked(ipc.listViews).mockReset();
      vi.mocked(ipc.listCollections).mockReset();
      vi.mocked(ipc.listFolders).mockReset();
      vi.mocked(ipc.startWatcher).mockReset();
    }
  });

  it('getSchema memoizes buildSchema per entries reference', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const entries = useVaultStore.getState().entries;
    const a = getSchema(entries);
    const b = getSchema(entries);
    expect(a).toBe(b);
    expect(vi.mocked(buildSchema)).toHaveBeenCalledTimes(1);
  });

  it('useEntry returns the entry for a path', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const { result } = renderHook(() => useEntry('projects/guided-onboarding-ga/items/fld-1.md'));
    expect(result.current?.title).toBe('First-run walkthrough GA');
    const { result: missing } = renderHook(() => useEntry('items/nope.md'));
    expect(missing.current).toBeNull();
  });
});

/**
 * M55.2: an entry's hash is the identity of its bytes, and only the write
 * knows the bytes an inline edit landed. Until it answers, the optimistic
 * entry's hash is null, and the trigger diff compares nothing.
 */
describe('vaultStore content hash (M55.2)', () => {
  const PATH = 'projects/guided-onboarding-ga/items/fld-1.md';

  /** The store's snapshots, fed through the trigger diff as useJobRunner does. */
  function observeChanges(): {
    events: Array<{ kind: string; path: string; fields?: string[] }>;
    stop: () => void;
  } {
    const events: Array<{ kind: string; path: string; fields?: string[] }> = [];
    let baseline: ScanBaseline | null = null;
    const stop = useVaultStore.subscribe((s, prev) => {
      if (s.entriesVault === null) return;
      if (s.entries === prev.entries && s.entriesVault === prev.entriesVault) return;
      const scan = observeScan(baseline, s.entriesVault, s.entries);
      baseline = scan.baseline;
      for (const e of scan.events) {
        events.push(
          e.kind === 'changed'
            ? { kind: e.kind, path: e.path, fields: e.fields }
            : { kind: e.kind, path: e.path },
        );
      }
    });
    return { events, stop };
  }

  it('the optimistic entry has no hash, then takes the hash the write answered', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    expect(findEntry(PATH)?.hash).toBe(sha256Hex(mockFsDisk().get(PATH) ?? ''));
    enterTauri();
    try {
      vi.mocked(ipc.updateFrontmatter).mockResolvedValueOnce('h-written');
      const pending = useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' });
      expect(findEntry(PATH)?.hash).toBeNull();
      expect(await pending).toBe(true);
      // No rescan in Tauri: the optimistic entry stands, with the write's hash.
      expect(findEntry(PATH)?.hash).toBe('h-written');
      expect(findEntry(PATH)?.properties.status).toBe('done');
    } finally {
      exitTauri();
    }
  });

  it('in the browser, the hash is the sha256 of the bytes the mock wrote', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    await useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' });
    expect(findEntry(PATH)?.hash).toBe(sha256Hex(mockFsDisk().get(PATH) ?? ''));
  });

  it('a scan that landed before the write answered is not overwritten', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    enterTauri();
    try {
      vi.mocked(ipc.updateFrontmatter).mockImplementationOnce(async () => {
        // A scan lands while the write is in flight, as one that waited out
        // WRITE_WAIT_MS does (M58.2): it read the disk itself.
        useVaultStore.setState({
          entries: useVaultStore
            .getState()
            .entries.map((e) => (e.path === PATH ? { ...e, hash: 'h-scanned' } : e)),
        });
        return 'h-written';
      });
      expect(await useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' })).toBe(true);
      expect(findEntry(PATH)?.hash).toBe('h-scanned');
    } finally {
      exitTauri();
    }
  });

  it('a failed write leaves no hash of its own, and fires no event', async () => {
    const scans = observeChanges();
    try {
      await useVaultStore.getState().openVault('/demo-vault');
      const before = findEntry(PATH)?.hash;
      enterTauri();
      try {
        vi.mocked(ipc.updateFrontmatter).mockRejectedValueOnce(new Error('disk full'));
        vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('scan failed too'));
        expect(await useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' })).toBe(
          false,
        );
        // The revert's rescan failed as well: the optimistic entry is all the
        // store holds, and nothing named its bytes.
        expect(findEntry(PATH)?.hash).toBeNull();
      } finally {
        exitTauri();
      }
      // The next scan reads the old bytes back, and the old hash is no change.
      await useVaultStore.getState().rescan();
      expect(findEntry(PATH)?.hash).toBe(before);
      expect(scans.events).toEqual([]);
    } finally {
      scans.stop();
    }
  });

  it('setTitle clears the hash until its rescan reads the new bytes', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const pending = useVaultStore.getState().setTitle(PATH, 'Renamed');
    expect(findEntry(PATH)?.hash).toBeNull();
    expect(await pending).toBe(true);
    expect(findEntry(PATH)?.hash).toBe(sha256Hex(mockFsDisk().get(PATH) ?? ''));
  });

  // HEAD fired two: once for the optimistic millisecond stamp, and again for
  // the stamp the rescan brought.
  it('an in-app patch is one changed event, not two', async () => {
    const scans = observeChanges();
    try {
      await useVaultStore.getState().openVault('/demo-vault');
      await useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' });
      expect(scans.events).toEqual([{ kind: 'changed', path: PATH, fields: ['status'] }]);
    } finally {
      scans.stop();
    }
  });
});

/**
 * M58.2: one rescan at a time plus one trailing, and a write fence, so a scan
 * read before an inline edit never lands over it — in Tauri too, where no
 * reconcile scan follows the edit to put it back.
 */
describe('vaultStore rescans (M58.2)', () => {
  const PATH = 'projects/guided-onboarding-ga/items/fld-1.md';
  const REFRESH_FAILED = "Couldn't refresh vault";

  /** Route the IPC the store calls to the mock backend, so it works with
   *  inTauri() true. Returns the cleanup. */
  function routeToMockBackend(): () => void {
    vi.mocked(ipc.scanVault).mockImplementation(mockBackend.scanVault);
    vi.mocked(ipc.listViews).mockImplementation(mockBackend.listViews);
    vi.mocked(ipc.listCollections).mockImplementation(mockBackend.listCollections);
    vi.mocked(ipc.listFolders).mockImplementation(mockBackend.listFolders);
    vi.mocked(ipc.startWatcher).mockImplementation(mockBackend.startWatcher);
    vi.mocked(ipc.updateFrontmatter).mockImplementation(mockBackend.updateFrontmatter);
    vi.mocked(ipc.setNoteTitle).mockImplementation(mockBackend.setNoteTitle);
    listenMock.mockResolvedValue(() => undefined);
    return () => {
      for (const fn of [
        ipc.scanVault,
        ipc.listViews,
        ipc.listCollections,
        ipc.listFolders,
        ipc.startWatcher,
        ipc.updateFrontmatter,
        ipc.setNoteTitle,
      ]) {
        vi.mocked(fn).mockReset();
      }
      listenMock.mockReset();
    };
  }

  /** The next scanVault reads the disk now, then parks until released. */
  function parkNextScan(): { parked: () => boolean; release: () => void } {
    let parked = false;
    let release: () => void = () => undefined;
    vi.mocked(ipc.scanVault).mockImplementationOnce(async (vault) => {
      const before = await mockBackend.scanVault(vault);
      parked = true;
      await new Promise<void>((resolve) => (release = resolve));
      return before;
    });
    return { parked: () => parked, release: () => release() };
  }

  /** The next updateFrontmatter waits to be released, then writes. */
  function parkNextPatch(): { started: () => boolean; release: () => void } {
    let started = false;
    let release: () => void = () => undefined;
    vi.mocked(ipc.updateFrontmatter).mockImplementationOnce(async (vault, path, patch) => {
      started = true;
      await new Promise<void>((resolve) => (release = resolve));
      return mockBackend.updateFrontmatter(vault, path, patch);
    });
    return { started: () => started, release: () => release() };
  }

  /** Every value PATH's `field` takes in the store from now on. */
  function watchField(read: (s: ReturnType<typeof useVaultStore.getState>) => unknown): {
    seen: unknown[];
    stop: () => void;
  } {
    const seen: unknown[] = [];
    const stop = useVaultStore.subscribe((s, prev) => {
      if (s.entries !== prev.entries) seen.push(read(s));
    });
    return { seen, stop };
  }

  const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

  it('five rescans asked for while one runs make exactly two scans, and all resolve after the second lands', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    vi.mocked(ipc.scanVault).mockClear();
    const park = parkNextScan();
    const first = useVaultStore.getState().rescan();
    await vi.waitFor(() => expect(park.parked()).toBe(true));
    await ipc.updateFrontmatter('/demo-vault', PATH, { probe: 'x' });
    const resolvedWith: unknown[] = [];
    const five = Array.from({ length: 5 }, () =>
      useVaultStore
        .getState()
        .rescan()
        .then(() => resolvedWith.push(findEntry(PATH)?.properties.probe)),
    );
    park.release();
    await Promise.all([first, ...five]);
    expect(vi.mocked(ipc.scanVault)).toHaveBeenCalledTimes(2);
    // Each one saw the second scan, which read the disk after it was asked.
    expect(resolvedWith).toEqual(['x', 'x', 'x', 'x', 'x']);
  });

  it('a patch racing a parked scan that read before it never leaves the store (Tauri)', async () => {
    const scans = observeStoreScans();
    await useVaultStore.getState().openVault('/demo-vault');
    const cleanup = routeToMockBackend();
    enterTauri();
    try {
      vi.mocked(ipc.scanVault).mockClear();
      const park = parkNextScan();
      const scan = useVaultStore.getState().rescan();
      await vi.waitFor(() => expect(park.parked()).toBe(true));

      expect(await useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' })).toBe(true);
      const status = watchField(() => findEntry(PATH)?.properties.status);
      park.release();
      await scan;
      status.stop();

      // The parked scan was discarded and read again; the trailing one landed.
      expect(vi.mocked(ipc.scanVault)).toHaveBeenCalledTimes(2);
      expect(status.seen.length).toBeGreaterThan(0);
      expect(status.seen.every((v) => v === 'done')).toBe(true);
      expect(findEntry(PATH)?.properties.status).toBe('done');
      expect(findEntry(PATH)?.hash).toBe(sha256Hex(mockFsDisk().get(PATH) ?? ''));
      // One edit, one event: never a reverse one.
      expect(scans.events).toEqual([['changed', PATH]]);
    } finally {
      exitTauri();
      scans.stop();
      cleanup();
    }
  });

  it('setTitle racing a parked scan keeps the new title throughout (Tauri)', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const cleanup = routeToMockBackend();
    enterTauri();
    try {
      const park = parkNextScan();
      const scan = useVaultStore.getState().rescan();
      await vi.waitFor(() => expect(park.parked()).toBe(true));

      const title = watchField(() => findEntry(PATH)?.title);
      const renamed = useVaultStore.getState().setTitle(PATH, 'Renamed mid-scan');
      await vi.waitFor(() => expect(vi.mocked(ipc.setNoteTitle)).toHaveBeenCalled());
      park.release();
      expect(await renamed).toBe(true);
      await scan;
      title.stop();

      expect(title.seen.every((v) => v === 'Renamed mid-scan')).toBe(true);
      expect(findEntry(PATH)?.title).toBe('Renamed mid-scan');
    } finally {
      exitTauri();
      cleanup();
    }
  });

  it('a rescan asked for while a write is pending waits for it, then lands the edit', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const write = parkNextPatch();
    const patched = useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' });
    await vi.waitFor(() => expect(write.started()).toBe(true));
    vi.mocked(ipc.scanVault).mockClear();

    const scan = useVaultStore.getState().rescan();
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(ipc.scanVault)).not.toHaveBeenCalled();

    write.release();
    expect(await patched).toBe(true);
    await scan;
    expect(vi.mocked(ipc.scanVault)).toHaveBeenCalled();
    expect(findEntry(PATH)?.properties.status).toBe('done');
  });

  it('a write that never settles holds a rescan WRITE_WAIT_MS at most, and its late settle scans again', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const cleanup = routeToMockBackend();
    enterTauri();
    try {
      const write = parkNextPatch();
      const patched = useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' });
      await vi.waitFor(() => expect(write.started()).toBe(true));
      vi.mocked(ipc.scanVault).mockClear();

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const scan = useVaultStore.getState().rescan();
      await vi.advanceTimersByTimeAsync(WRITE_WAIT_MS - 1);
      expect(vi.mocked(ipc.scanVault)).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await scan;
      vi.useRealTimers();
      // The store shows disk truth: the write has not landed.
      expect(vi.mocked(ipc.scanVault)).toHaveBeenCalledTimes(1);
      expect(findEntry(PATH)?.properties.status).toBe('progress');

      write.release();
      expect(await patched).toBe(true);
      // The scan that landed past it is owed one more, which reads the edit.
      await vi.waitFor(() => expect(findEntry(PATH)?.properties.status).toBe('done'));
      expect(vi.mocked(ipc.scanVault)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      exitTauri();
      cleanup();
    }
  });

  it('a browser patch arms no WRITE_WAIT_MS timer: its fence ends before its own rescan', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect(await useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' })).toBe(true);
      expect(timers.mock.calls.some(([, ms]) => ms === WRITE_WAIT_MS)).toBe(false);
      expect(findEntry(PATH)?.properties.status).toBe('done');
    } finally {
      timers.mockRestore();
    }
  });

  it('two failed passes in one cycle toast once, and keep the last good snapshot', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const good = useVaultStore.getState().entries;
    useUiStore.setState({ toasts: [] });
    let release: () => void = () => undefined;
    let parked = false;
    vi.mocked(ipc.scanVault)
      .mockImplementationOnce(async () => {
        parked = true;
        await new Promise<void>((resolve) => (release = resolve));
        throw new Error('scan failed');
      })
      .mockRejectedValueOnce(new Error('scan failed again'));
    const first = useVaultStore.getState().rescan();
    await vi.waitFor(() => expect(parked).toBe(true));
    const trailing = useVaultStore.getState().rescan();
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(trailing).resolves.toBeUndefined();
    expect(vi.mocked(ipc.scanVault)).toHaveBeenCalledTimes(3);
    expect(toasts()).toEqual([REFRESH_FAILED]);
    expect(useVaultStore.getState().entries).toBe(good);
  });

  it('a failed pass followed by a good trailing pass toasts nothing', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const before = useVaultStore.getState().entries;
    useUiStore.setState({ toasts: [] });
    let release: () => void = () => undefined;
    let parked = false;
    vi.mocked(ipc.scanVault).mockImplementationOnce(async () => {
      parked = true;
      await new Promise<void>((resolve) => (release = resolve));
      throw new Error('scan failed');
    });
    const first = useVaultStore.getState().rescan();
    await vi.waitFor(() => expect(parked).toBe(true));
    void useVaultStore.getState().rescan();
    release();
    await first;
    expect(toasts()).toEqual([]);
    expect(useVaultStore.getState().entries).not.toBe(before);
  });

  it('rescans while the window is hidden', async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    const before = useVaultStore.getState().entries;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    try {
      await useVaultStore.getState().rescan();
      expect(useVaultStore.getState().entries).not.toBe(before);
      expect(useVaultStore.getState().status).toBe('ready');
    } finally {
      // Back to jsdom's own getters on the prototype.
      delete (document as unknown as Record<string, unknown>).visibilityState;
      delete (document as unknown as Record<string, unknown>).hidden;
    }
  });

  it('a reopen racing an inline edit lands no stale snapshot, and hands off to a trailing scan', async () => {
    const scans = observeStoreScans();
    await useVaultStore.getState().openVault('/demo-vault');
    const cleanup = routeToMockBackend();
    enterTauri();
    try {
      const write = parkNextPatch();
      const patched = useVaultStore.getState().patchFrontmatter(PATH, { status: 'done' });
      await vi.waitFor(() => expect(write.started()).toBe(true));
      const status = watchField(() => findEntry(PATH)?.properties.status);

      // RecordingBanner's Reopen vault, while the edit is still writing.
      const reopened = useVaultStore.getState().openVault('/demo-vault');
      await vi.waitFor(() => expect(vi.mocked(ipc.startWatcher)).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      // Its read predates the write, so it lands nothing yet.
      expect(useVaultStore.getState().status).toBe('scanning');
      expect(findEntry(PATH)?.properties.status).toBe('done');

      write.release();
      expect(await patched).toBe(true);
      await reopened;
      status.stop();

      expect(useVaultStore.getState().status).toBe('ready');
      expect(findEntry(PATH)?.properties.status).toBe('done');
      expect(status.seen.every((v) => v === 'done')).toBe(true);
      expect(scans.events).toEqual([['changed', PATH]]);
    } finally {
      exitTauri();
      scans.stop();
      cleanup();
    }
  });
});

/**
 * M60.6: a database-wide change is one batch. The store sends it in one IPC
 * call, shows patch ops at once, announces the pages it wrote, and on a
 * refusal toasts once and rescans; it never throws.
 */
describe('vaultStore.applyBatch (M60.6)', () => {
  const ITEM = 'projects/guided-onboarding-ga/items/fld-1.md';
  const OTHER = 'projects/guided-onboarding-ga/items/fld-2.md';

  beforeEach(async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    useUiStore.setState({ toasts: [] });
  });

  it('sends one IPC call, and shows patch ops before it answers', async () => {
    let answer: () => void = () => undefined;
    vi.mocked(ipc.applyBatch).mockImplementationOnce(
      (vault, ops) =>
        new Promise((resolve) => {
          answer = () => resolve(mockBackend.applyBatch(vault, ops));
        }),
    );
    const pending = useVaultStore.getState().applyBatch([
      { op: 'patch', path: ITEM, set: { status: 'done' } },
      { op: 'patch', path: OTHER, set: { status: 'done' } },
    ]);
    await vi.waitFor(() => expect(vi.mocked(ipc.applyBatch)).toHaveBeenCalled());
    expect(findEntry(ITEM)?.properties.status).toBe('done');
    expect(findEntry(OTHER)?.properties.status).toBe('done');
    expect(mockFsDisk().get(ITEM)).not.toMatch(/^status: done$/m);
    answer();
    const applied = await pending;
    expect(vi.mocked(ipc.applyBatch)).toHaveBeenCalledTimes(1);
    expect(applied?.files.map((f) => f.path)).toEqual([ITEM, OTHER]);
    expect(mockFsDisk().get(ITEM)).toMatch(/^status: done$/m);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('a refusal toasts once in the page title, rescans, and returns null', async () => {
    const before = mockFsDisk().get(ITEM);
    const title = findEntry(ITEM)?.title;
    const scans = vi.mocked(ipc.scanVault).mock.calls.length;
    const applied = await useVaultStore.getState().applyBatch([
      { op: 'patch', path: OTHER, set: { status: 'done' } },
      { op: 'patch', path: ITEM, set: { status: 'done' }, expectHash: '0'.repeat(64) },
    ]);
    expect(applied).toBeNull();
    expect(mockFsDisk().get(ITEM)).toBe(before);
    expect(findEntry(OTHER)?.properties.status).not.toBe('done');
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      `Nothing was changed: “${title}” changed while this was being prepared. Try again.`,
    ]);
    expect(vi.mocked(ipc.scanVault).mock.calls.length).toBeGreaterThan(scans);
  });

  it('never throws, whatever the backend rejects with', async () => {
    vi.mocked(ipc.applyBatch).mockRejectedValueOnce('the disk went away');
    await expect(
      useVaultStore.getState().applyBatch([{ op: 'delete', path: ITEM }]),
    ).resolves.toBeNull();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual(['the disk went away']);
  });

  it('refuses across vaults and while no vault is open, sending nothing', async () => {
    useVaultStore.setState({ vaultPath: '/elsewhere' });
    expect(await useVaultStore.getState().applyBatch([{ op: 'delete', path: ITEM }])).toBeNull();
    useVaultStore.setState({ vaultPath: null });
    expect(await useVaultStore.getState().applyBatch([{ op: 'delete', path: ITEM }])).toBeNull();
    expect(vi.mocked(ipc.applyBatch)).not.toHaveBeenCalled();
    expect(mockFsDisk().has(ITEM)).toBe(true);
  });

  it('lands the open pages first, and announces the pages it wrote', async () => {
    const order: string[] = [];
    const unflush = registerFlush(async () => {
      order.push('flush');
    });
    vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
      order.push('batch');
      return mockBackend.applyBatch(vault, ops);
    });
    const heard: string[] = [];
    const stop = onExternalWrite(ITEM, {
      pending: () => heard.push('pending'),
      settled: () => heard.push('settled'),
    });
    try {
      await useVaultStore.getState().applyBatch([{ op: 'body', path: ITEM, body: '\n# New\n' }]);
    } finally {
      unflush();
      stop();
    }
    expect(order).toEqual(['flush', 'batch']);
    expect(heard).toEqual(['pending', 'settled']);
  });

  it('an open that put a stopped change back says so, and rescans', async () => {
    vi.mocked(ipc.startWatcher).mockResolvedValueOnce({ unfinished: 3, restored: 2, kept: 1 });
    const scans = vi.mocked(ipc.scanVault).mock.calls.length;
    await useVaultStore.getState().openVault('/demo-vault');
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      'Cerebro stopped partway through a change to 3 pages, so it put them back as they were. ' +
        '1 had changed since and were left alone.',
    ]);
    expect(vi.mocked(ipc.scanVault).mock.calls.length - scans).toBe(2);
    expect(useVaultStore.getState().status).toBe('ready');
  });
});

/**
 * M60.7: a labelled batch is undoable. The store pushes it on the undo
 * stack and toasts the label with Undo; an unlabelled one pushes nothing,
 * and opening another vault clears the stack.
 */
describe('vaultStore.applyBatch undo (M60.7)', () => {
  const ITEM = 'projects/guided-onboarding-ga/items/fld-1.md';

  beforeEach(async () => {
    await useVaultStore.getState().openVault('/demo-vault');
    useUndoStore.getState().clear();
    useUiStore.setState({ toasts: [] });
  });

  it('a labelled batch pushes one entry and toasts its label with Undo', async () => {
    const before = mockFsDisk().get(ITEM);
    await useVaultStore
      .getState()
      .applyBatch([{ op: 'patch', path: ITEM, set: { status: 'done' } }], { undo: 'Set it' });
    expect(useUndoStore.getState().past.map((e) => e.label)).toEqual(['Set it']);
    const [toast] = useUiStore.getState().toasts;
    expect(toast.message).toBe('Set it');
    expect(toast.action?.label).toBe('Undo');
    toast.action?.run();
    await vi.waitFor(() => expect(mockFsDisk().get(ITEM)).toBe(before));
    expect(useUndoStore.getState().past).toEqual([]);
    expect(useUndoStore.getState().future).toHaveLength(1);
  });

  it('an unlabelled batch pushes nothing', async () => {
    await useVaultStore
      .getState()
      .applyBatch([{ op: 'patch', path: ITEM, set: { status: 'done' } }]);
    expect(useUndoStore.getState().past).toEqual([]);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('opening another vault clears the stack; reopening the same keeps it', async () => {
    await useVaultStore
      .getState()
      .applyBatch([{ op: 'patch', path: ITEM, set: { status: 'done' } }], { undo: 'Set it' });
    await useVaultStore.getState().openVault('/demo-vault');
    expect(useUndoStore.getState().past).toHaveLength(1);
    await useVaultStore.getState().openVault('/another-vault');
    expect(useUndoStore.getState().past).toEqual([]);
  });

  it('a refusal heard by the caller is not toasted by the store', async () => {
    const heard: string[] = [];
    const applied = await useVaultStore
      .getState()
      .applyBatch(
        [{ op: 'patch', path: ITEM, set: { status: 'done' }, expectHash: '0'.repeat(64) }],
        {
          onRefused: (message) => heard.push(message),
        },
      );
    expect(applied).toBeNull();
    expect(heard).toEqual([staleWords(ITEM)]);
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});
