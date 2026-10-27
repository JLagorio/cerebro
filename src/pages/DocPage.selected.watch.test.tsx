// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { DocPage } from './DocPage';
import * as ipc from '@/lib/ipc';
import type {
  AuthorityError,
  EditorOperation,
  EditorSaveRequest,
  EditorSaveResult,
  SelectedEditorSnapshot,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';
import { makeEntry } from '@/test/factories';
import { __resetRescans, useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { __resetOpenPages, retainedDocumentOwner } from '@/editor/openPages';

// Only the actual native transports are replaced. Store, IPC adapter, page,
// lazy editor, owner, debounce, reconciliation and save protocol stay real.
const native = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, () => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: () => void) => {
    native.events.set(event, handler);
    return () => native.events.delete(event);
  },
}));

const vault = '/selected-watch-native-toy';
const path = 'page.md';
const target = {
  workspaceId: 'a7aca232-dd01-4e1c-8053-abf09969e683',
  recordId: '137c9113-df0c-4af2-aab2-9432a482cb21',
};
const initial = '# Native watch\n\nOriginal A.\n';
const local = '# Native watch\n\nLocal L.\n';
const newer = '# Native watch\n\nNewer L2.\n';
const outside =
  '\uFEFF\r\n---\r\ntools: [write_note]\r\n---\r\n# Native watch\r\n\r\nOutside B 😀.\r\n';
const outsideDisplay = '\uFEFF\n---\ntools: [write_note]\n---\n# Native watch\n\nOutside B 😀.\n';
const latest = '# Native watch\n\nOutside C.\n';
const budget = { timeout: 5000 };
const realRescan = useVaultStore.getState().rescan;
const sourceChanged: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'source_changed',
  message: 'The visible body no longer matches its canonical pair.',
  retryable: true,
};
const unreadable: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'metadata_unavailable',
  message: 'Canonical metadata unavailable.',
  retryable: true,
};
type SaveInput = {
  vault: string;
  path: string;
  body: string;
  bodyFormat: string;
  editorRequest: EditorSaveRequest;
};
let nextNativeCallback = 0;
let nativeCallbacks = new Map<number, (event: unknown) => void>();
const nativeEvents = new Set([
  'vault-changed',
  'tauri://drag-enter',
  'tauri://drag-over',
  'tauri://drag-drop',
  'tauri://drag-leave',
]);
let body: string;
let current: SelectedRecordVersion;
let scanFailure: AuthorityError | null;
let laterFailure: boolean;
let readBody: () => Promise<SelectedEditorSnapshot>;
let scan: () => Promise<ReturnType<typeof entry>[]>;
let save: (input: SaveInput) => Promise<EditorSaveResult>;
let metadataWrite: () => Promise<Awaited<ReturnType<typeof ipc.setPageFullWidth>>>;
let retainedViews: ipc.RawList[];
let viewsFailure: AuthorityError | null;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function entry() {
  return makeEntry({
    path,
    title: 'Native watch',
    type: null,
    properties: { grant: 'read_only', code: '007' },
    hash: current.bodyHash,
    authority: { ...current },
  });
}
function snapshot(): SelectedEditorSnapshot {
  return {
    path,
    target: { workspaceId: current.workspaceId, recordId: current.recordId },
    body,
    version: { ...current },
    observedBodyHash: sha256Hex(body),
    coherence: sha256Hex(body) === current.bodyHash ? 'paired' : 'external_change',
    editable: true,
    readOnlyReason: null,
  };
}
/** Descriptive native reply only; native paired-service tests own durability. */
function operation(input: SaveInput): EditorOperation {
  const version = { ...current, metadataRevision: '2', bodyHash: sha256Hex(input.body) };
  return {
    path,
    target,
    requestKey: input.editorRequest.requestKey,
    operationId: 'b09ede38-997b-470b-b54a-e8601115ba32',
    version,
    receipt: {
      ...target,
      epoch: '2',
      previousRevision: current.metadataRevision,
      revision: '2',
      metadataBeforeHash: current.metadataHash,
      metadataAfterHash: current.metadataHash,
      bodyBeforeHash: sha256Hex(body),
      bodyAfterHash: version.bodyHash,
      actor: 'human',
      operation: 'page.body',
      at: '2026-10-24T00:00:00Z',
    },
  };
}
function applied(input: SaveInput): EditorSaveResult {
  const original = input.editorRequest.original ?? operation(input);
  body = input.body;
  current = original.version;
  return {
    kind: 'selected_applied',
    operation: original,
    currentVersion: current,
    reconcileRequired: false,
    recovery: null,
  };
}
const calls = (command: string) => native.invoke.mock.calls.filter(([name]) => name === command);
const saveInputs = () => calls('save_note').map(([, args]) => args as SaveInput);
function owner() {
  const found = retainedDocumentOwner({
    vaultId: vault,
    path,
    ownerId: useNavStore.getState().active,
  });
  if (!found) throw new Error('actual selected page owner missing');
  return found;
}
function noLegacyOrMetadataWrite() {
  expect(calls('read_note')).toHaveLength(0);
  expect(calls('read_note_source')).toHaveLength(0);
  expect(calls('update_frontmatter')).toHaveLength(0);
  expect(calls('set_page_full_width')).toHaveLength(0);
  expect(useVaultStore.getState().entries[0].properties).toEqual({
    grant: 'read_only',
    code: '007',
  });
}
/** The second call joins the callback's cycle before its first microtask.
 * Await the real coalescer, without sleeping or replacing store.rescan. */
function watch() {
  const handler = native.events.get('vault-changed');
  if (!handler) throw new Error('actual vault-changed listener was not bound');
  handler();
  return realRescan();
}
async function observe() {
  await act(async () => {
    await watch();
  });
}
async function mountSource(expectedSource = initial) {
  await act(async () => {
    await useVaultStore.getState().openVault(vault);
  });
  const opened = useVaultStore.getState();
  expect(
    opened.status,
    JSON.stringify({
      error: opened.error?.slice(0, 600),
      commands: native.invoke.mock.calls.slice(0, 16).map(([command]) => command),
      events: [...native.events.keys()].slice(0, 8),
    }),
  ).toBe('ready');
  render(<DocPage selection={{ kind: 'doc', path }} />);
  const button = await screen.findByRole('button', { name: 'Source' }, budget);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false), budget);
  fireEvent.click(button);
  const textarea = (await screen.findByRole(
    'textbox',
    { name: 'Page source' },
    budget,
  )) as HTMLTextAreaElement;
  expect(textarea.value).toBe(expectedSource);
  return textarea;
}
async function advanceAutosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}
beforeAll(async () => {
  await import('@/editor/MarkdownEditor');
});
beforeEach(() => {
  __resetOpenPages();
  __resetRescans();
  ipc.__resetPageWrites();
  useNavStore.getState().reset();
  useNavStore.getState().navigate({ kind: 'doc', path });
  body = initial;
  current = {
    kind: 'sqlite_metadata',
    ...target,
    metadataRevision: '1',
    metadataHash: 'a'.repeat(64),
    bodyHash: sha256Hex(initial),
  };
  scanFailure = null;
  laterFailure = false;
  retainedViews = [];
  viewsFailure = null;
  readBody = async () => snapshot();
  scan = async () => {
    if (scanFailure) throw scanFailure;
    return [entry()];
  };
  save = async () => {
    throw new Error('unexpected selected body write');
  };
  metadataWrite = async () => {
    throw new Error('unexpected selected metadata write');
  };
  useVaultStore.setState({
    vaultPath: null,
    entriesVault: null,
    entries: [],
    status: 'idle',
    error: null,
    views: [],
    collections: [],
    folders: [],
    rescan: realRescan,
  });
  useUiStore.setState({ toasts: [], detailPath: null, docPanelOpen: false });
  // Both the module mock and an actual Tauri core import reach one strict transport.
  nextNativeCallback = 0;
  nativeCallbacks = new Map();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: native.invoke,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    transformCallback: (callback: (event: unknown) => void) => {
      const id = ++nextNativeCallback;
      nativeCallbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => nativeCallbacks.delete(id),
  };
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, id: number) => nativeCallbacks.delete(id),
  };
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'plugin:event|listen': {
        expect(nativeEvents.has(String(args.event))).toBe(true);
        const callback = nativeCallbacks.get(args.handler as number);
        if (!callback) throw new Error('native event callback was not registered');
        expect(args.target).toEqual(
          args.event === 'vault-changed' ? { kind: 'Any' } : { kind: 'Webview', label: 'main' },
        );
        if (args.event === 'vault-changed')
          native.events.set('vault-changed', () =>
            callback({ event: 'vault-changed', payload: null }),
          );
        return args.handler;
      }
      case 'plugin:event|unlisten':
        expect(nativeEvents.has(String(args.event))).toBe(true);
        expect(typeof args.eventId).toBe('number');
        return null;
      case 'read_editor_body':
        expect(args).toEqual({
          vault,
          path,
          target: { workspaceId: current.workspaceId, recordId: current.recordId },
        });
        return readBody();
      case 'scan_vault':
        return scan();
      case 'list_views':
        expect(args).toEqual({ vault });
        if (viewsFailure) throw viewsFailure;
        return retainedViews;
      case 'list_collections':
      case 'calculate_sheets':
        return [];
      case 'list_folders':
        if (laterFailure) throw unreadable;
        return ['kept-folder'];
      case 'start_watcher':
      case 'panel_agent':
        return null;
      case 'save_note':
        expect(args.editorRequest).toBeDefined();
        expect('expectHash' in args).toBe(false);
        return save(structuredClone(args) as SaveInput);
      case 'set_page_full_width':
        return metadataWrite();
      default:
        throw new Error(`unexpected selected watch command: ${command}`);
    }
  });
});
afterEach(async () => {
  await act(async () => cleanup());
  __resetOpenPages();
  __resetRescans();
  ipc.__resetPageWrites();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__;
  vi.restoreAllMocks();
});

// Catches a failed full-vault refresh swallowing the delivered native event.
it.each(['scan', 'folders'] as const)(
  'selected_watch_%s_failure_observes_exact_external_body_without_replacing_owner',
  async (failureAt) => {
    const textarea = await mountSource();
    const retained = owner();
    const canonical = structuredClone(current);
    const beforeReads = calls('read_editor_body').length;
    const beforeEntries = useVaultStore.getState().entries;
    body = outside;
    if (failureAt === 'scan') scanFailure = sourceChanged;
    else laterFailure = true;
    await observe();
    expect(calls('read_editor_body')).toHaveLength(beforeReads + 1);
    expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
    expect(owner()).toBe(retained);
    expect(textarea.value).toBe(outsideDisplay);
    expect(retained.snapshot()).toMatchObject({
      latestDraft: outside,
      mergeBase: { raw: outside, canon: outside },
      reconcileRequired: false,
    });
    expect(useVaultStore.getState()).toMatchObject({
      status: 'ready',
      entriesVault: vault,
      folders: ['kept-folder'],
    });
    expect(useVaultStore.getState().entries[0].authority).toEqual(canonical);
    expect(useVaultStore.getState().entries[0].hash).toBe(canonical.bodyHash);
    expect(useVaultStore.getState().entries[0].properties).toEqual(beforeEntries[0].properties);
    expect(
      useUiStore.getState().toasts.filter((t) => t.message === "Couldn't refresh vault"),
    ).toHaveLength(1);
    await act(async () => useUiStore.setState({ toasts: [] }));
    // A page body was observed, but the whole workspace is still unavailable
    // to refresh. Its persistent notice must survive the transient toast.
    expect(
      screen
        .getAllByRole('alert')
        .some(
          (alert) =>
            alert.classList.contains('section-unavailable') &&
            /vault|workspace/i.test(alert.textContent ?? ''),
        ),
    ).toBe(true);
    expect(calls('save_note')).toHaveLength(0);
    noLegacyOrMetadataWrite();
  },
);

// Catches autosave losing local bytes before the person picks a whole page.
it.each(['Use new', 'Keep yours'] as const)(
  'selected_watch_dirty_source_%s_preserves_the_actual_draft_until_choice',
  async (choice) => {
    const textarea = await mountSource();
    const retained = owner();
    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: local } });
    body = outside;
    scanFailure = sourceChanged;
    await observe();
    const choices = screen.getByRole('group', { name: 'Choose a version' });
    expect(choices.textContent).toContain('Local L.');
    expect(choices.textContent).toContain('Outside B 😀.');
    expect(textarea.value).toBe(local);
    expect(owner()).toBe(retained);
    expect(retained.snapshot().latestDraft).toBe(local);
    await advanceAutosave();
    expect(calls('save_note')).toHaveLength(0);
    save = async (input) => applied(input);
    fireEvent.click(screen.getByRole('button', { name: choice }));
    await advanceAutosave();
    expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
    expect(owner()).toBe(retained);
    if (choice === 'Use new') {
      expect(textarea.value).toBe(outsideDisplay);
      expect(retained.snapshot().latestDraft).toBe(outside);
      expect(calls('save_note')).toHaveLength(0);
    } else {
      expect(saveInputs()).toHaveLength(1);
      expect(saveInputs()[0]).toMatchObject({
        vault,
        path,
        body: local,
        bodyFormat: 'source',
        editorRequest: { target, phase: 'start', original: null },
      });
      expect(retained.snapshot().latestDraft).toBe(local);
      expect(retained.snapshot().acknowledgedGeneration).toBe(retained.snapshot().generation);
    }
    noLegacyOrMetadataWrite();
  },
);

// A successful scan with a changed hash reaches today's reconcile pipeline,
// making this a separate causal RED for the missing persistent Retry read UI.
it('selected_watch_failed_body_read_keeps_draft_and_full_width_blocked_until_retry_without_typing', async () => {
  const textarea = await mountSource();
  const retained = owner();
  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: local } });
  const before = retained.snapshot();
  const beforeReads = calls('read_editor_body').length;
  body = outside;
  current = { ...current, bodyHash: sha256Hex(outside) };
  readBody = async () => {
    throw unreadable;
  };
  await observe();
  expect(calls('read_editor_body').length).toBeGreaterThan(beforeReads);
  expect(retained.snapshot()).toMatchObject({
    latestDraft: local,
    mergeBase: before.mergeBase,
    generation: before.generation,
    acknowledgedGeneration: before.acknowledgedGeneration,
    reconcileRequired: true,
  });
  const retry = screen.getByRole('button', { name: 'Retry read' });
  expect(retry.closest('[role="alert"]')?.classList.contains('section-unavailable')).toBe(true);
  await act(async () => useUiStore.setState({ toasts: [] }));
  await advanceAutosave();
  expect(screen.getByRole('button', { name: 'Retry read' })).toBe(retry);
  await act(async () => {
    expect(await useVaultStore.getState().patchFrontmatter(path, { full_width: true })).toBe(false);
  });
  expect(calls('set_page_full_width')).toHaveLength(0);
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(owner()).toBe(retained);
  readBody = async () => snapshot();
  const readsBeforeRetry = calls('read_editor_body').length;
  await act(async () => fireEvent.click(retry));
  expect(calls('read_editor_body')).toHaveLength(readsBeforeRetry + 1);
  expect(screen.queryByRole('button', { name: 'Retry read' })).toBeNull();
  expect(screen.getByRole('group', { name: 'Choose a version' }).textContent).toContain(
    'Outside B',
  );
  expect(retained.snapshot().generation).toBe(before.generation);
  expect(retained.snapshot().latestDraft).toBe(local);
  expect(calls('save_note')).toHaveLength(0);
  noLegacyOrMetadataWrite();
});

// Catches a failed scan bypassing the vault opening guard. The positive control
// requires this same rejection to invalidate an owner in its original opening.
it.each([false, true])('selected_watch_late_failed_scan_round_trip_%s', async (roundTrip) => {
  const textarea = await mountSource();
  const retained = owner();
  const beforeReads = calls('read_editor_body').length;
  const pending = deferred<ReturnType<typeof entry>[]>();
  scan = () => pending.promise;
  body = outside;
  let cycle!: Promise<void>;
  await act(async () => {
    cycle = watch();
    await Promise.resolve();
  });
  const scans = calls('scan_vault').length;
  expect(scans).toBeGreaterThan(1);
  await act(async () => {
    if (roundTrip) {
      useVaultStore.setState({ vaultPath: '/selected-watch-other-vault' });
      useVaultStore.setState({ vaultPath: vault });
    }
    pending.reject(sourceChanged);
    await cycle;
  });
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(owner()).toBe(retained);
  expect(calls('read_editor_body')).toHaveLength(beforeReads + (roundTrip ? 0 : 1));
  expect(retained.snapshot().latestDraft).toBe(roundTrip ? initial : outside);
  expect(calls('save_note')).toHaveLength(0);
  if (roundTrip) {
    expect(
      useUiStore.getState().toasts,
      JSON.stringify(useUiStore.getState().toasts.map((toast) => toast.message)),
    ).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Retry read' })).toBeNull();
  }
});

// Catches a response whose initiating opening has gone away, even if the path
// has returned by the time it resolves. Same-opening B must still be admitted.
it.each([false, true])('selected_watch_late_body_read_round_trip_%s', async (roundTrip) => {
  const textarea = await mountSource();
  const retained = owner();
  const beforeReads = calls('read_editor_body').length;
  const pending = deferred<SelectedEditorSnapshot>();
  body = outside;
  const reply = snapshot();
  scanFailure = sourceChanged;
  readBody = () => pending.promise;
  await observe();
  expect(calls('read_editor_body')).toHaveLength(beforeReads + 1);
  expect(retained.snapshot().reconcileRequired).toBe(true);
  await act(async () => {
    if (roundTrip) {
      useVaultStore.setState({ vaultPath: '/selected-watch-other-vault' });
      useVaultStore.setState({ vaultPath: vault });
    }
    pending.resolve(reply);
    await pending.promise;
  });
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(owner()).toBe(retained);
  expect(retained.snapshot()).toMatchObject({
    latestDraft: roundTrip ? initial : outside,
    reconcileRequired: roundTrip,
    acknowledgedGeneration: roundTrip ? 0 : 1,
  });
  expect(calls('save_note')).toHaveLength(0);
});

// Catches unbounded reads on a burst and a stale B response overwriting newer
// typing. The existing running/trailing loop must finish with current C.
it('selected_watch_burst_and_newer_typing_need_one_current_trailing_body_read', async () => {
  const textarea = await mountSource();
  const retained = owner();
  vi.useFakeTimers();
  const beforeReads = calls('read_editor_body').length;
  const pending = deferred<SelectedEditorSnapshot>();
  body = outside;
  const stale = snapshot();
  scanFailure = sourceChanged;
  let first = true;
  readBody = () => {
    if (!first) return Promise.resolve(snapshot());
    first = false;
    return pending.promise;
  };
  await observe();
  expect(calls('read_editor_body')).toHaveLength(beforeReads + 1);
  fireEvent.change(textarea, { target: { value: newer } });
  body = latest;
  await act(async () => {
    await Promise.all([watch(), watch(), watch(), watch()]);
  });
  expect(calls('read_editor_body')).toHaveLength(beforeReads + 1);
  expect(retained.snapshot().reconcileRequired).toBe(true);
  await act(async () => {
    pending.resolve(stale);
    await pending.promise;
  });
  expect(calls('read_editor_body')).toHaveLength(beforeReads + 2);
  expect(retained.snapshot().latestDraft).toBe(newer);
  expect(retained.snapshot().acknowledgedGeneration).toBe(0);
  expect(textarea.value).toBe(newer);
  const choices = screen.getByRole('group', { name: 'Choose a version' });
  expect(choices.textContent).toContain('Newer L2.');
  expect(choices.textContent).toContain('Outside C.');
  expect(choices.textContent).not.toContain('Outside B');
  await advanceAutosave();
  expect(calls('save_note')).toHaveLength(0);
  noLegacyOrMetadataWrite();
});

// Watch observations cannot retire a pending/transport-unknown original or
// turn newer typing into an acknowledgement. Check save may Resolve that exact
// original; the only Start remains the first payload, key and target.
it.each(['pending', 'unknown'] as const)(
  'selected_watch_preserves_%s_original_across_newer_typing_and_explicit_resolve',
  async (status) => {
    const textarea = await mountSource();
    const retained = owner();
    vi.useFakeTimers();
    let original: EditorOperation | null = null;
    save = async (input) => {
      original ??= operation(input);
      if (status === 'unknown') throw new Error('transport reply lost');
      return { kind: 'selected_pending', operation: original, error: unreadable };
    };
    fireEvent.change(textarea, { target: { value: local } });
    await advanceAutosave();
    expect(saveInputs()).toHaveLength(1);
    const first = structuredClone(saveInputs()[0]);
    expect(first.editorRequest).toMatchObject({ target, phase: 'start', original: null });
    expect(retained.snapshot().selectedSave?.status).toBe(status);
    fireEvent.change(textarea, { target: { value: newer } });
    body = outside;
    scanFailure = sourceChanged;
    const beforeReads = calls('read_editor_body').length;
    await observe();
    await advanceAutosave();
    expect(calls('read_editor_body')).toHaveLength(beforeReads);
    // Resolving the same original is legitimate, including if the existing
    // autosave drain asks before the explicit click. No fresh Start is allowed.
    const expectedResolve = {
      ...first,
      editorRequest: {
        ...first.editorRequest,
        phase: 'resolve',
        original: status === 'pending' ? original : null,
      },
    };
    expect(saveInputs().length).toBeLessThanOrEqual(2);
    for (const input of saveInputs().slice(1)) expect(input).toEqual(expectedResolve);
    expect(retained.snapshot()).toMatchObject({
      latestDraft: newer,
      acknowledgedGeneration: 0,
      selectedSave: { status, requestKey: first.editorRequest.requestKey },
    });
    const beforeResolve = saveInputs().length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check save' })));
    expect(saveInputs()).toHaveLength(beforeResolve + 1);
    expect(saveInputs().at(-1)).toEqual(expectedResolve);
    expect(saveInputs().filter((input) => input.editorRequest.phase === 'start')).toHaveLength(1);
    expect(retained.snapshot().latestDraft).toBe(newer);
    expect(retained.snapshot().acknowledgedGeneration).toBe(0);
    noLegacyOrMetadataWrite();
  },
);

// A current native Applied acknowledgement survives the observer's failed
// refresh/read. Only its own generation is acknowledged; newer typing is held.
it('selected_watch_failed_refresh_preserves_original_applied_ack_and_newer_dirty_generation', async () => {
  const textarea = await mountSource();
  const retained = owner();
  vi.useFakeTimers();
  const reply = deferred<EditorSaveResult>();
  let original: EditorOperation | null = null;
  save = async (input) => {
    if (original) throw new Error('a second Start escaped the observation hold');
    original = operation(input);
    const result = await reply.promise;
    if (result.kind === 'selected_applied') {
      body = input.body;
      current = result.currentVersion;
    }
    return result;
  };
  fireEvent.change(textarea, { target: { value: local } });
  await advanceAutosave();
  expect(saveInputs()).toHaveLength(1);
  const first = saveInputs()[0];
  const recorded = original as EditorOperation | null;
  if (!recorded) throw new Error('actual original request was not dispatched');
  fireEvent.change(textarea, { target: { value: newer } });
  scanFailure = sourceChanged;
  readBody = async () => {
    throw unreadable;
  };
  await observe();
  await act(async () => {
    reply.resolve({
      kind: 'selected_applied',
      operation: recorded,
      currentVersion: recorded.version,
      reconcileRequired: false,
      recovery: { kind: 'pending', id: 'retained-original-copy', evicted: null },
    });
    await reply.promise;
    await retained.settleWrite();
  });
  await advanceAutosave();
  expect(saveInputs(), JSON.stringify(saveInputs())).toHaveLength(1);
  expect(saveInputs()[0]).toEqual(first);
  expect(retained.snapshot()).toMatchObject({
    generation: 2,
    acknowledgedGeneration: 1,
    latestDraft: newer,
    mergeBase: { raw: local, canon: local },
    reconcileRequired: true,
    recoveryAck: {
      generation: 1,
      outcome: { kind: 'pending', id: 'retained-original-copy', evicted: null },
    },
  });
  expect(retained.snapshot().selectedSave).toBeUndefined();
  expect(useVaultStore.getState().entries[0].authority).toEqual(recorded.version);
  expect(screen.getByRole('button', { name: 'Retry read' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  noLegacyOrMetadataWrite();
});

// Failed outcomes need the same write fence as successful scans. The old
// rejection must not make a page read across a pending metadata operation.
it('selected_watch_failed_scan_crossed_by_full_width_waits_for_its_fenced_trailing_scan', async () => {
  const textarea = await mountSource();
  const retained = owner();
  const beforeReads = calls('read_editor_body').length;
  const oldScan = deferred<ReturnType<typeof entry>[]>();
  const metadata = deferred<Awaited<ReturnType<typeof ipc.setPageFullWidth>>>();
  const originalVersion = structuredClone(current);
  scan = () => oldScan.promise;
  metadataWrite = () => metadata.promise;
  let cycle!: Promise<void>;
  let change!: Promise<boolean>;
  await act(async () => {
    cycle = watch();
    await Promise.resolve();
  });
  expect(calls('scan_vault')).toHaveLength(2);
  await act(async () => {
    change = useVaultStore.getState().patchFrontmatter(path, { full_width: true });
  });
  await waitFor(() => expect(calls('set_page_full_width')).toHaveLength(1), budget);
  expect(calls('set_page_full_width')[0][1]).toEqual({
    vault,
    path,
    expected: originalVersion,
    mode: 'wide',
  });
  body = outside;
  await act(async () => {
    oldScan.reject(sourceChanged);
    await Promise.resolve();
  });
  expect(calls('read_editor_body')).toHaveLength(beforeReads);
  expect(retained.snapshot().latestDraft).toBe(initial);
  scan = async () => {
    throw sourceChanged;
  };
  current = { ...current, metadataRevision: '2', metadataHash: 'b'.repeat(64) };
  await act(async () => {
    metadata.resolve({ kind: 'applied', fullWidth: true, version: current });
    expect(await change).toBe(true);
    await cycle;
  });
  expect(calls('read_editor_body').length).toBeGreaterThan(beforeReads);
  expect(calls('read_editor_body').length).toBeLessThanOrEqual(beforeReads + 2);
  expect(retained.snapshot().latestDraft).toBe(outside);
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(useVaultStore.getState().entries[0].properties.full_width).toBe(true);
  expect(calls('save_note')).toHaveLength(0);
  expect(calls('update_frontmatter')).toHaveLength(0);
});

// A newer opening's completed scan outranks an older failed rescan, even
// when both openings use the same vault path. This also guards stale notices.
it('selected_watch_old_failed_scan_cannot_notify_a_newer_same_path_opening', async () => {
  await mountSource();
  const oldScan = deferred<ReturnType<typeof entry>[]>();
  scan = () => oldScan.promise;
  let cycle!: Promise<void>;
  await act(async () => {
    cycle = watch();
    await Promise.resolve();
  });
  expect(calls('scan_vault')).toHaveLength(2);
  scan = async () => [entry()];
  await act(async () => {
    await useVaultStore.getState().openVault(vault);
  });
  await screen.findByRole('button', { name: 'Source' }, budget);
  const readsAfterOpening = calls('read_editor_body').length;
  await act(async () => {
    oldScan.reject(sourceChanged);
    await cycle;
  });
  expect(calls('read_editor_body')).toHaveLength(readsAfterOpening);
  expect(useVaultStore.getState().status).toBe('ready');
  expect(
    useUiStore.getState().toasts,
    JSON.stringify(useUiStore.getState().toasts.map((toast) => toast.message)),
  ).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Retry read' })).toBeNull();
  expect(calls('save_note')).toHaveLength(0);
});

// A path reused for another canonical record must not inherit an old body's
// accepted bytes, released hold or reread error from the previous identity.
it.each(['body', 'error'] as const)(
  'selected_watch_late_%s_response_cannot_cross_same_path_record_replacement',
  async (response) => {
    await mountSource();
    const retained = owner();
    const pending = deferred<SelectedEditorSnapshot>();
    const beforeReads = calls('read_editor_body').length;
    body = outside;
    const oldBody = snapshot();
    // Existing hash ingress isolates the identity guard from the new signal.
    current = { ...current, bodyHash: sha256Hex(outside) };
    readBody = () => pending.promise;
    await observe();
    expect(calls('read_editor_body').length).toBeGreaterThan(beforeReads);
    body = latest;
    current = {
      ...current,
      recordId: '23c60562-0c2d-4f49-b8fa-ae3d7c8d9ce8',
      bodyHash: sha256Hex(latest),
    };
    const replacement = structuredClone(current);
    readBody = async () => snapshot();
    await act(async () => {
      useVaultStore.setState({ entries: [entry()] });
    });
    await act(async () => {
      if (response === 'body') pending.resolve(oldBody);
      else pending.reject(unreadable);
      await pending.promise.catch(() => undefined);
    });
    expect(retained.snapshot()).toMatchObject({
      latestDraft: initial,
      acknowledgedGeneration: 0,
      mergeBase: { raw: initial, canon: initial },
      reconcileRequired: true,
    });
    expect(useVaultStore.getState().entries[0].authority).toEqual(replacement);
    expect(screen.queryByRole('button', { name: 'Retry read' })).toBeNull();
    expect(calls('save_note')).toHaveLength(0);
    expect(calls('read_note')).toHaveLength(0);
  },
);

/** Matches the generated native presentation DTO. It describes a complete
 * observation; the authoritative version deliberately remains canonical A. */
function externalObservationEntry() {
  const observedBodyHash = sha256Hex(body);
  return {
    ...entry(),
    hash: observedBodyHash,
    bodyObservation: {
      observedBodyHash,
      coherence:
        observedBodyHash === current.bodyHash ? ('paired' as const) : ('external_change' as const),
    },
  };
}
function unpairedStatuses() {
  return [...screen.queryAllByRole('status'), ...screen.queryAllByRole('alert')].filter((notice) =>
    /not (?:yet )?reconciled|external(?:ly)? (?:changed|change)|unpaired/i.test(
      notice.textContent ?? '',
    ),
  );
}

// The real cold open must consume scan, retained list scope and startup before
// a matching selected page can mount. No test seeds ready/entries provenance.
it('selected_external_observation_cold_open_reaches_existing_editor_with_retained_scopes_without_adoption', async () => {
  const canonical = structuredClone(current);
  body = outside;
  const projectPath = 'projects/toy/project.md';
  const collectionPath = 'kept-folder/kept-folder.md';
  const projectHash = sha256Hex('# Project\n');
  const collectionHash = sha256Hex('# Kept folder\n');
  const scoped = [
    makeEntry({
      path: projectPath,
      project: projectPath,
      hash: projectHash,
      authority: {
        ...canonical,
        recordId: '3a653e93-9948-47fb-b5d2-cc1112e8703c',
        bodyHash: projectHash,
      },
      bodyObservation: { coherence: 'paired', observedBodyHash: projectHash },
    }),
    makeEntry({
      path: collectionPath,
      type: 'Collection',
      title: 'Kept folder',
      hash: collectionHash,
      authority: {
        ...canonical,
        recordId: 'df6137c5-5ad2-43d4-93be-71fe7c190716',
        bodyHash: collectionHash,
      },
      bodyObservation: { coherence: 'paired', observedBodyHash: collectionHash },
    }),
  ];
  scan = async () => [externalObservationEntry(), ...scoped];
  retainedViews = [
    {
      id: 'project-work',
      yaml: 'name: Project work\n',
      project: projectPath,
      collection: null,
      path: 'projects/toy/views/project-work.yml',
    },
    {
      id: 'kept-list',
      yaml: 'name: Kept list\n',
      project: null,
      collection: 'kept-folder',
      path: 'kept-folder/kept-list.list.yml',
    },
  ];
  expect(useVaultStore.getState()).toMatchObject({
    status: 'idle',
    entriesVault: null,
    entries: [],
  });
  const textarea = await mountSource(outsideDisplay);
  const retained = owner();
  expect(useVaultStore.getState()).toMatchObject({
    status: 'ready',
    vaultPath: vault,
    entriesVault: vault,
  });
  expect(useVaultStore.getState().entries).toHaveLength(3);
  expect(useVaultStore.getState().entries[0]).toMatchObject({
    hash: sha256Hex(outside),
    authority: canonical,
    bodyObservation: { coherence: 'external_change', observedBodyHash: sha256Hex(outside) },
  });
  expect(
    useVaultStore
      .getState()
      .views.map(({ id, project, collection, path }) => ({ id, project, collection, path })),
  ).toEqual([
    {
      id: 'project-work',
      project: projectPath,
      collection: null,
      path: 'projects/toy/views/project-work.yml',
    },
    {
      id: 'kept-list',
      project: null,
      collection: 'kept-folder',
      path: 'kept-folder/kept-list.list.yml',
    },
  ]);
  expect(useVaultStore.getState().collections.some(({ folder }) => folder === 'kept-folder')).toBe(
    true,
  );
  expect(calls('start_watcher')).toHaveLength(1);
  expect(calls('list_views')).toHaveLength(1);
  expect(calls('read_editor_body').length).toBeGreaterThan(0);
  expect(retained.snapshot()).toMatchObject({
    latestDraft: outside,
    mergeBase: { raw: outside },
    generation: 0,
    acknowledgedGeneration: 0,
  });
  await act(async () => {
    await retained.flush();
  });
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(calls('save_note')).toHaveLength(0);
  noLegacyOrMetadataWrite();
  await act(async () => useUiStore.setState({ toasts: [] }));
  // Content is readable, but its canonical pair is still A. This persistent
  // accessible distinction must survive transient toast removal.
  expect(unpairedStatuses().length).toBeGreaterThan(0);
});

it.each(['scan', 'views'] as const)(
  'selected_external_observation_cold_%s_failure_is_workspace_unavailable_without_an_editor_or_empty_success',
  async (failureAt) => {
    body = outside;
    scan = async () => {
      if (failureAt === 'scan') throw unreadable;
      return [externalObservationEntry()];
    };
    if (failureAt === 'views') viewsFailure = unreadable;
    await act(async () => {
      await useVaultStore.getState().openVault(vault);
    });
    render(<DocPage selection={{ kind: 'doc', path }} />);
    expect(useVaultStore.getState()).toMatchObject({ status: 'error', entriesVault: null });
    expect(screen.getByRole('alert').textContent).toContain('Workspace unavailable');
    expect(screen.getByRole('alert').classList.contains('section-unavailable')).toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull();
    expect(
      retainedDocumentOwner({ vaultId: vault, path, ownerId: useNavStore.getState().active }),
    ).toBeUndefined();
    expect(calls('read_editor_body')).toHaveLength(0);
    expect(calls('start_watcher')).toHaveLength(0);
    expect(calls('save_note')).toHaveLength(0);
  },
);

it('selected_external_observation_B_then_C_uses_observed_hash_with_fixed_canonical_A_and_same_owner', async () => {
  scan = async () => [externalObservationEntry()];
  const textarea = await mountSource();
  const retained = owner();
  const canonical = structuredClone(current);
  for (const [raw, display] of [
    [outside, outsideDisplay],
    [latest, latest],
  ]) {
    body = raw;
    const reads = calls('read_editor_body').length;
    await observe();
    await waitFor(() => expect(retained.snapshot().latestDraft).toBe(raw), budget);
    expect(calls('read_editor_body').length).toBeGreaterThan(reads);
    expect(owner()).toBe(retained);
    expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
    expect(textarea.value).toBe(display);
    expect(useVaultStore.getState().entries[0]).toMatchObject({
      hash: sha256Hex(raw),
      authority: canonical,
      bodyObservation: { coherence: 'external_change', observedBodyHash: sha256Hex(raw) },
    });
    expect(retained.snapshot()).toMatchObject({ mergeBase: { raw }, reconcileRequired: false });
    expect(retained.snapshot().generation).toBe(retained.snapshot().acknowledgedGeneration);
  }
  await act(async () => {
    await retained.flush();
  });
  expect(calls('save_note')).toHaveLength(0);
  noLegacyOrMetadataWrite();
  expect(unpairedStatuses().length).toBeGreaterThan(0);
});

it('selected_external_observation_failed_scan_then_complete_B_clears_unavailable_without_fabricating_pairing', async () => {
  scan = async () => {
    if (scanFailure) throw scanFailure;
    return [externalObservationEntry()];
  };
  const textarea = await mountSource();
  const retained = owner();
  const canonical = structuredClone(current);
  const complete = useVaultStore.getState().entries;
  body = outside;
  scanFailure = unreadable;
  await observe();
  await waitFor(() => expect(retained.snapshot().latestDraft).toBe(outside), budget);
  expect(useVaultStore.getState().entries).toBe(complete);
  expect(screen.getByRole('button', { name: 'Retry refresh' })).toBeTruthy();
  scanFailure = null;
  await observe();
  await waitFor(() => expect(retained.snapshot().reconcileRequired).toBe(false), budget);
  expect(screen.queryByRole('button', { name: 'Retry refresh' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry read' })).toBeNull();
  expect(owner()).toBe(retained);
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(textarea.value).toBe(outsideDisplay);
  expect(useVaultStore.getState()).toMatchObject({ status: 'ready', entriesVault: vault });
  expect(useVaultStore.getState().entries[0]).toMatchObject({
    hash: sha256Hex(outside),
    authority: canonical,
    bodyObservation: { coherence: 'external_change', observedBodyHash: sha256Hex(outside) },
  });
  await act(async () => {
    await retained.flush();
    useUiStore.setState({ toasts: [] });
  });
  expect(calls('save_note')).toHaveLength(0);
  noLegacyOrMetadataWrite();
  expect(unpairedStatuses().length).toBeGreaterThan(0);
});

it.each([false, true])(
  'selected_external_observation_successful_scan_cannot_cross_vault_round_trip_%s',
  async (roundTrip) => {
    scan = async () => [externalObservationEntry()];
    const textarea = await mountSource();
    const retained = owner();
    const beforeEntries = useVaultStore.getState().entries;
    const beforeReads = calls('read_editor_body').length;
    body = outside;
    const pending = deferred<ReturnType<typeof entry>[]>();
    const reply = [externalObservationEntry()];
    scan = () => pending.promise;
    let cycle!: Promise<void>;
    await act(async () => {
      cycle = watch();
      await Promise.resolve();
    });
    expect(calls('scan_vault')).toHaveLength(2);
    await act(async () => {
      if (roundTrip) {
        useVaultStore.setState({ vaultPath: '/selected-observation-away' });
        useVaultStore.setState({ vaultPath: vault });
      }
      pending.resolve(reply);
      await cycle;
    });
    if (roundTrip) {
      expect(useVaultStore.getState().entries).toBe(beforeEntries);
      expect(calls('read_editor_body')).toHaveLength(beforeReads);
      expect(retained.snapshot().latestDraft).toBe(initial);
    } else {
      await waitFor(() => expect(retained.snapshot().latestDraft).toBe(outside), budget);
      expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
      expect(useVaultStore.getState().entries[0].hash).toBe(sha256Hex(outside));
    }
    expect(owner()).toBe(retained);
    expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
    expect(calls('save_note')).toHaveLength(0);
  },
);

// A successful observed scan must preserve the same generation fence already
// covered for failed scans: stale B cannot replace newer typing; trailing C wins.
it('selected_external_observation_successful_burst_reads_current_C_and_preserves_newer_generation', async () => {
  scan = async () => [externalObservationEntry()];
  const textarea = await mountSource();
  const retained = owner();
  const canonical = structuredClone(current);
  vi.useFakeTimers();
  body = outside;
  const stale = snapshot();
  const pending = deferred<SelectedEditorSnapshot>();
  let first = true;
  readBody = () => {
    if (!first) return Promise.resolve(snapshot());
    first = false;
    return pending.promise;
  };
  const beforeReads = calls('read_editor_body').length;
  await observe();
  expect(calls('read_editor_body')).toHaveLength(beforeReads + 1);
  fireEvent.change(textarea, { target: { value: newer } });
  body = latest;
  await act(async () => {
    await Promise.all([watch(), watch(), watch()]);
  });
  expect(calls('read_editor_body')).toHaveLength(beforeReads + 1);
  await act(async () => {
    pending.resolve(stale);
    await pending.promise;
  });
  expect(calls('read_editor_body')).toHaveLength(beforeReads + 2);
  expect(owner()).toBe(retained);
  expect(retained.snapshot()).toMatchObject({ latestDraft: newer, acknowledgedGeneration: 0 });
  expect(textarea.value).toBe(newer);
  const choices = screen.getByRole('group', { name: 'Choose a version' });
  expect(choices.textContent).toContain('Newer L2.');
  expect(choices.textContent).toContain('Outside C.');
  expect(choices.textContent).not.toContain('Outside B');
  expect(useVaultStore.getState().entries[0]).toMatchObject({
    authority: canonical,
    hash: sha256Hex(latest),
    bodyObservation: { coherence: 'external_change', observedBodyHash: sha256Hex(latest) },
  });
  await advanceAutosave();
  expect(calls('save_note')).toHaveLength(0);
  noLegacyOrMetadataWrite();
});

it.each(['body', 'error'] as const)(
  'selected_external_observation_late_%s_response_cannot_cross_same_path_record_identity',
  async (response) => {
    scan = async () => [externalObservationEntry()];
    await mountSource();
    const retained = owner();
    const pending = deferred<SelectedEditorSnapshot>();
    const beforeReads = calls('read_editor_body').length;
    body = outside;
    const oldReply = snapshot();
    readBody = () => pending.promise;
    await observe();
    expect(calls('read_editor_body')).toHaveLength(beforeReads + 1);
    body = latest;
    current = { ...current, recordId: '23c60562-0c2d-4f49-b8fa-ae3d7c8d9ce8' };
    const replacement = structuredClone(current);
    readBody = async () => snapshot();
    await act(async () => {
      useVaultStore.setState({ entries: [externalObservationEntry()] });
    });
    await act(async () => {
      if (response === 'body') pending.resolve(oldReply);
      else pending.reject(unreadable);
      await pending.promise.catch(() => undefined);
    });
    expect(retained.snapshot()).toMatchObject({
      latestDraft: initial,
      acknowledgedGeneration: 0,
      mergeBase: { raw: initial, canon: initial },
      reconcileRequired: true,
    });
    expect(useVaultStore.getState().entries[0]).toMatchObject({
      authority: replacement,
      hash: sha256Hex(latest),
      bodyObservation: { coherence: 'external_change', observedBodyHash: sha256Hex(latest) },
    });
    expect(screen.queryByRole('button', { name: 'Retry read' })).toBeNull();
    expect(calls('save_note')).toHaveLength(0);
    expect(calls('read_note')).toHaveLength(0);
  },
);

// Presentation-only Entry drift cannot retire a notice established by the
// editor's native read. A current paired read after a complete scan can.
it('selected_external_observation_status_waits_for_current_paired_read_even_when_observed_hash_is_unchanged', async () => {
  body = outside;
  scan = async () => [externalObservationEntry()];
  const textarea = await mountSource(outsideDisplay);
  const retained = owner();
  expect(unpairedStatuses().length).toBeGreaterThan(0);
  const reads = calls('read_editor_body').length;
  const pairedVersion = { ...current, metadataRevision: '2', bodyHash: sha256Hex(outside) };
  await act(async () => {
    useVaultStore.setState({
      entries: [
        {
          ...externalObservationEntry(),
          authority: pairedVersion,
          bodyObservation: { coherence: 'paired', observedBodyHash: sha256Hex(outside) },
        },
      ],
    });
  });
  expect(calls('read_editor_body')).toHaveLength(reads);
  expect(unpairedStatuses().length).toBeGreaterThan(0);
  current = pairedVersion;
  const pending = deferred<SelectedEditorSnapshot>();
  const paired = snapshot();
  readBody = () => pending.promise;
  await observe();
  expect(calls('read_editor_body')).toHaveLength(reads + 1);
  expect(unpairedStatuses().length).toBeGreaterThan(0);
  await act(async () => {
    pending.resolve(paired);
    await pending.promise;
  });
  await waitFor(() => expect(unpairedStatuses()).toHaveLength(0), budget);
  expect(owner()).toBe(retained);
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(retained.snapshot().latestDraft).toBe(outside);
  expect(calls('save_note')).toHaveLength(0);
  noLegacyOrMetadataWrite();
});

it('selected_external_observation_matching_owner_ack_clears_status_even_if_following_refresh_and_body_read_fail', async () => {
  body = outside;
  scan = async () => {
    if (scanFailure) throw scanFailure;
    return [externalObservationEntry()];
  };
  const textarea = await mountSource(outsideDisplay);
  const retained = owner();
  expect(unpairedStatuses().length).toBeGreaterThan(0);
  vi.useFakeTimers();
  const pending = deferred<EditorSaveResult>();
  let original: EditorOperation | null = null;
  save = async (input) => {
    original = operation(input);
    const reply = await pending.promise;
    if (reply.kind === 'selected_applied') {
      body = input.body;
      current = reply.currentVersion;
    }
    return reply;
  };
  // The textarea displays LF; the edit keeps the external body's CRLF style.
  const rawLocal = '# Native watch\r\n\r\nLocal L.\r\n';
  fireEvent.change(textarea, { target: { value: local } });
  await advanceAutosave();
  expect(saveInputs()).toHaveLength(1);
  expect(textarea.value).toBe(local);
  expect(saveInputs()[0]).toMatchObject({ body: rawLocal, bodyFormat: 'source' });
  const recorded = original as EditorOperation | null;
  if (!recorded) throw new Error('actual original did not start');
  scanFailure = unreadable;
  readBody = async () => {
    throw unreadable;
  };
  await act(async () => {
    pending.resolve({
      kind: 'selected_applied',
      operation: recorded,
      currentVersion: recorded.version,
      reconcileRequired: false,
      recovery: null,
    });
    await pending.promise;
    await retained.settleWrite();
  });
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 1,
    latestDraft: rawLocal,
    mergeBase: { raw: rawLocal, canon: rawLocal },
  });
  expect(retained.snapshot().selectedSave).toBeUndefined();
  expect(useVaultStore.getState().entries[0].authority).toEqual(recorded.version);
  expect(unpairedStatuses()).toHaveLength(0);
  // Failed observer reads still require their separate persistent notice;
  // they cannot undo the known original acknowledgement or repeat its write.
  await advanceAutosave();
  expect(screen.getByRole('button', { name: 'Retry read' })).toBeTruthy();
  expect(owner()).toBe(retained);
  expect(saveInputs()).toHaveLength(1);
  noLegacyOrMetadataWrite();
});

it.each(['pending', 'unknown'] as const)(
  'selected_external_observation_%s_original_cannot_clear_status_or_adopt_the_draft',
  async (status) => {
    body = outside;
    scan = async () => [externalObservationEntry()];
    const textarea = await mountSource(outsideDisplay);
    const retained = owner();
    const canonical = structuredClone(current);
    expect(unpairedStatuses().length).toBeGreaterThan(0);
    vi.useFakeTimers();
    save = async (input) => {
      if (status === 'unknown') throw new Error('original transport reply lost');
      return { kind: 'selected_pending', operation: operation(input), error: unreadable };
    };
    // Match exact owner/request bytes, separately from the LF textarea view.
    const rawLocal = '# Native watch\r\n\r\nLocal L.\r\n';
    fireEvent.change(textarea, { target: { value: local } });
    await advanceAutosave();
    expect(saveInputs()).toHaveLength(1);
    expect(textarea.value).toBe(local);
    expect(saveInputs()[0]).toMatchObject({ body: rawLocal, bodyFormat: 'source' });
    expect(retained.snapshot()).toMatchObject({
      latestDraft: rawLocal,
      acknowledgedGeneration: 0,
      selectedSave: { status },
      mergeBase: { raw: outside, canon: outside },
    });
    expect(useVaultStore.getState().entries[0].authority).toEqual(canonical);
    expect(unpairedStatuses().length).toBeGreaterThan(0);
    noLegacyOrMetadataWrite();
  },
);

const cleanRichOutside = '# Native watch\r\n\r\nOutside B 😀.\r\n';
async function mountCleanExternal(presentation: 'rich' | 'source' = 'source') {
  body = presentation === 'rich' ? cleanRichOutside : outside;
  scan = async () => [externalObservationEntry()];
  if (presentation === 'source') return mountSource(outsideDisplay);
  await act(async () => {
    await useVaultStore.getState().openVault(vault);
  });
  expect(useVaultStore.getState()).toMatchObject({ status: 'ready', entriesVault: vault });
  render(<DocPage selection={{ kind: 'doc', path }} />);
  const sourceButton = await screen.findByRole('button', { name: 'Source' }, budget);
  await waitFor(() => expect((sourceButton as HTMLButtonElement).disabled).toBe(false), budget);
  await waitFor(
    () =>
      expect(
        retainedDocumentOwner({
          vaultId: vault,
          path,
          ownerId: useNavStore.getState().active,
        }),
      ).toBeDefined(),
    budget,
  );
  expect(owner().snapshot().bodyFormat).toBe('rich');
  return null;
}
function cleanSaveAction() {
  const button = screen.queryByRole('button', { name: 'Save this text' });
  expect(
    button,
    'An externally observed clean body needs an explicit existing-owner save action.',
  ).not.toBeNull();
  if (button === null) throw new Error('Save this text action missing');
  return button;
}
function expectNoEnabledCleanSave() {
  const button = screen.queryByRole('button', { name: 'Save this text' });
  if (button !== null) expect((button as HTMLButtonElement).disabled).toBe(true);
}

// A clean local generation is not a canonical receipt. Loading and flushing
// external B must remain nonmutating even after the explicit action exists.
it('selected_clean_external_save_read_and_clean_flush_never_adopt_B', async () => {
  await mountCleanExternal();
  const retained = owner();
  const before = retained.snapshot();
  await act(async () => {
    await retained.flush();
    await retained.flush();
  });
  expect(owner()).toBe(retained);
  expect(retained.snapshot()).toMatchObject({
    latestDraft: outside,
    generation: before.generation,
    acknowledgedGeneration: before.acknowledgedGeneration,
    mergeBase: { raw: outside, canon: outside },
  });
  expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
  expect(unpairedStatuses().length).toBeGreaterThan(0);
  expect(saveInputs()).toHaveLength(0);
  noLegacyOrMetadataWrite();
});

it.each(['source', 'rich'] as const)(
  'selected_clean_external_save_%s_action_dispatches_exact_raw_once_through_the_retained_owner',
  async (presentation) => {
    await mountCleanExternal(presentation);
    const retained = owner();
    const before = retained.snapshot();
    const raw = presentation === 'source' ? outside : cleanRichOutside;
    expect(before.generation).toBe(before.acknowledgedGeneration);
    expect(before.mergeBase?.raw).toBe(raw);
    if (presentation === 'rich') expect(before.mergeBase?.canon).not.toBe(raw);
    await act(async () => {
      await retained.flush();
    });
    expect(saveInputs()).toHaveLength(0);
    save = async (input) => applied(input);
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(() => expect(saveInputs()).toHaveLength(1), budget);
    await act(async () => {
      await retained.settleWrite();
    });
    const input = saveInputs()[0];
    expect(input).toMatchObject({
      vault,
      path,
      body: raw,
      bodyFormat: presentation,
      editorRequest: { target, phase: 'start', original: null },
    });
    expect(input.editorRequest.requestKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect('expectHash' in input).toBe(false);
    expect(owner()).toBe(retained);
    expect(retained.snapshot()).toMatchObject({
      generation: before.generation + 1,
      acknowledgedGeneration: before.generation + 1,
      mergeBase: { raw, canon: before.mergeBase?.canon },
    });
    expect(retained.snapshot().latestDraft).toBe(before.latestDraft);
    expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(raw));
    expectNoEnabledCleanSave();
    await act(async () => {
      await retained.flush();
      await retained.flush();
    });
    expect(saveInputs()).toHaveLength(1);
    noLegacyOrMetadataWrite();
  },
);

it('selected_clean_external_save_repeat_click_cannot_enqueue_a_second_generation_while_original_is_in_flight', async () => {
  await mountCleanExternal();
  const retained = owner();
  const before = retained.snapshot();
  const pending = deferred<EditorSaveResult>();
  let original: EditorOperation | null = null;
  save = async (input) => {
    original = operation(input);
    return pending.promise;
  };
  const button = cleanSaveAction();
  try {
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(saveInputs()).toHaveLength(1), budget);
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(saveInputs()).toHaveLength(1);
    expect(retained.snapshot()).toMatchObject({
      generation: before.generation + 1,
      acknowledgedGeneration: before.acknowledgedGeneration,
      inFlightGeneration: before.generation + 1,
      latestDraft: outside,
    });
  } finally {
    await act(async () => {
      const recorded = original as EditorOperation | null;
      pending.resolve(
        recorded
          ? {
              kind: 'selected_applied',
              operation: recorded,
              currentVersion: recorded.version,
              reconcileRequired: false,
              recovery: null,
            }
          : { kind: 'selected_unchanged', version: current },
      );
      await retained.settleWrite();
    });
  }
});

it.each(['pending', 'unknown'] as const)(
  'selected_clean_external_save_%s_original_resolves_same_frozen_raw_generation_and_request',
  async (status) => {
    await mountCleanExternal();
    const retained = owner();
    const before = retained.snapshot();
    let original: EditorOperation | null = null;
    save = async (input) => {
      original ??= operation(input);
      if (status === 'unknown') throw new Error('explicit clean save reply lost');
      return { kind: 'selected_pending', operation: original, error: unreadable };
    };
    const button = cleanSaveAction();
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(retained.snapshot().selectedSave?.status).toBe(status), budget);
    const first = structuredClone(saveInputs()[0]);
    expect(first).toMatchObject({
      body: outside,
      bodyFormat: 'source',
      editorRequest: { target, phase: 'start', original: null },
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(saveInputs()).toHaveLength(1);
    expect(retained.snapshot()).toMatchObject({
      generation: before.generation + 1,
      acknowledgedGeneration: before.acknowledgedGeneration,
      selectedSave: { status, requestKey: first.editorRequest.requestKey },
    });
    save = async (input) => applied(input);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check save' }));
    });
    await waitFor(
      () => expect(retained.snapshot().acknowledgedGeneration).toBe(before.generation + 1),
      budget,
    );
    expect(saveInputs()).toHaveLength(2);
    expect(saveInputs()[1]).toEqual({
      ...first,
      editorRequest: {
        ...first.editorRequest,
        phase: 'resolve',
        original: status === 'pending' ? original : null,
      },
    });
    expect(
      saveInputs().filter(({ editorRequest }) => editorRequest.phase === 'start'),
    ).toHaveLength(1);
    expect(owner()).toBe(retained);
    expect(retained.snapshot()).toMatchObject({
      latestDraft: outside,
      generation: before.generation + 1,
    });
    expect(retained.snapshot().selectedSave).toBeUndefined();
    noLegacyOrMetadataWrite();
  },
);

it.each(['pending', 'unknown'] as const)(
  'selected_clean_external_save_%s_keeps_original_B_when_newer_typing_arrives',
  async (status) => {
    const textarea = await mountCleanExternal();
    if (textarea === null) throw new Error('actual source textarea missing');
    const retained = owner();
    let original: EditorOperation | null = null;
    save = async (input) => {
      original ??= operation(input);
      if (status === 'unknown') throw new Error('original clean save reply lost');
      return { kind: 'selected_pending', operation: original, error: unreadable };
    };
    const button = cleanSaveAction();
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(retained.snapshot().selectedSave?.status).toBe(status), budget);
    const first = structuredClone(saveInputs()[0]);
    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: local } });
    const rawLocal = '# Native watch\r\n\r\nLocal L.\r\n';
    await act(async () => {
      fireEvent.click(button);
    });
    expect(retained.snapshot()).toMatchObject({
      generation: 2,
      acknowledgedGeneration: 0,
      latestDraft: rawLocal,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check save' }));
    });
    expect(saveInputs()).toHaveLength(2);
    expect(saveInputs()[1]).toEqual({
      ...first,
      editorRequest: {
        ...first.editorRequest,
        phase: 'resolve',
        original: status === 'pending' ? original : null,
      },
    });
    expect(saveInputs()[1].body).toBe(outside);
    expect(retained.snapshot()).toMatchObject({
      generation: 2,
      acknowledgedGeneration: 0,
      latestDraft: rawLocal,
    });
    expect(retained.snapshot().selectedSave?.requestKey).toBe(first.editorRequest.requestKey);
    noLegacyOrMetadataWrite();
  },
);

it.each(['child_draft', 'reconcile_hold', 'preparation', 'representation_mismatch'] as const)(
  'selected_clean_external_save_%s_cannot_enqueue_until_the_existing_owner_guard_is_clear',
  async (guard) => {
    await mountCleanExternal();
    const retained = owner();
    const before = retained.snapshot();
    const button = cleanSaveAction();
    let release = () => {};
    await act(async () => {
      if (guard === 'child_draft') {
        retained.setChildDrafts('clean-save-probe', 'exact unresolved cell');
        release = () => retained.setChildDrafts('clean-save-probe', null);
      } else if (guard === 'reconcile_hold') {
        retained.holdForReconcile();
        release = () => retained.finishReconcile();
      } else if (guard === 'preparation') release = retained.beginPreparation();
      else {
        retained.present('unproven current source presentation', 'source');
        release = () => retained.present(outside, 'source');
      }
      fireEvent.click(button);
    });
    expect(saveInputs()).toHaveLength(0);
    expect(retained.snapshot().generation).toBe(before.generation);
    expect(retained.snapshot().acknowledgedGeneration).toBe(before.acknowledgedGeneration);
    expect(retained.snapshot().mergeBase).toEqual(before.mergeBase);
    await act(async () => {
      release();
      await retained.settleWrite();
    });
    expect(saveInputs()).toHaveLength(0);
    expect(retained.snapshot().generation).toBe(before.generation);
    save = async (input) => applied(input);
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(() => expect(saveInputs()).toHaveLength(1), budget);
    expect(saveInputs()[0].body).toBe(outside);
    expect(owner()).toBe(retained);
    noLegacyOrMetadataWrite();
  },
);

it('selected_clean_external_save_source_composition_blocks_then_allows_the_same_exact_observed_text', async () => {
  const textarea = await mountCleanExternal();
  if (textarea === null) throw new Error('actual source textarea missing');
  const retained = owner();
  const button = cleanSaveAction();
  fireEvent.compositionStart(textarea);
  await act(async () => {
    fireEvent.click(button);
  });
  expect(saveInputs()).toHaveLength(0);
  expect(retained.snapshot()).toMatchObject({
    generation: 0,
    acknowledgedGeneration: 0,
    latestDraft: outside,
  });
  fireEvent.compositionEnd(textarea);
  save = async (input) => applied(input);
  await act(async () => {
    fireEvent.click(cleanSaveAction());
  });
  await waitFor(() => expect(saveInputs()).toHaveLength(1), budget);
  expect(saveInputs()[0].body).toBe(outside);
  noLegacyOrMetadataWrite();
});

it.each(['opening', 'record_identity'] as const)(
  'selected_clean_external_save_stale_%s_action_cannot_write_or_enqueue_on_the_old_owner',
  async (changed) => {
    await mountCleanExternal();
    const retained = owner();
    const button = cleanSaveAction();
    await act(async () => {
      if (changed === 'opening') {
        useVaultStore.setState({ vaultPath: '/clean-save-away' });
        useVaultStore.setState({ vaultPath: vault });
      } else {
        current = { ...current, recordId: '23c60562-0c2d-4f49-b8fa-ae3d7c8d9ce8' };
        useVaultStore.setState({ entries: [externalObservationEntry()] });
      }
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(saveInputs()).toHaveLength(0);
    expect(retained.snapshot()).toMatchObject({ generation: 0, acknowledgedGeneration: 0 });
    expect(retained.snapshot().mergeBase?.raw).toBe(outside);
  },
);

it('selected_clean_external_save_native_read_only_snapshot_has_no_action_that_can_admit_a_write', async () => {
  readBody = async () => ({
    ...snapshot(),
    editable: false,
    readOnlyReason: 'This body belongs to another writer.',
  });
  const textarea = await mountCleanExternal();
  if (textarea === null) throw new Error('actual source textarea missing');
  expect(textarea.readOnly).toBe(true);
  expectNoEnabledCleanSave();
  const button = screen.queryByRole('button', { name: 'Save this text' });
  if (button !== null) fireEvent.click(button);
  await act(async () => {
    await owner().flush();
  });
  expect(owner().snapshot()).toMatchObject({ generation: 0, acknowledgedGeneration: 0 });
  expect(saveInputs()).toHaveLength(0);
  noLegacyOrMetadataWrite();
});

it('selected_clean_external_save_dirty_source_keeps_the_normal_edit_generation_instead_of_forcing_observed_B', async () => {
  const textarea = await mountCleanExternal();
  if (textarea === null) throw new Error('actual source textarea missing');
  const retained = owner();
  const button = cleanSaveAction();
  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: local } });
  await act(async () => {
    fireEvent.click(button);
  });
  const rawLocal = '# Native watch\r\n\r\nLocal L.\r\n';
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 0,
    latestDraft: rawLocal,
  });
  expect(saveInputs()).toHaveLength(0);
  save = async (input) => applied(input);
  await advanceAutosave();
  expect(saveInputs()).toHaveLength(1);
  expect(saveInputs()[0].body).toBe(rawLocal);
  expect(retained.snapshot()).toMatchObject({ generation: 1, acknowledgedGeneration: 1 });
  noLegacyOrMetadataWrite();
});

it('selected_clean_external_save_external_C_before_dispatch_keeps_the_human_B_payload_without_a_body_CAS', async () => {
  await mountCleanExternal();
  const retained = owner();
  const button = cleanSaveAction();
  const reads = calls('read_editor_body').length;
  body = latest;
  save = async (input) => {
    // A silent external C arrived after observation B. There is no new read
    // or expectHash deciding whether the person's explicit B may be sent.
    expect(calls('read_editor_body')).toHaveLength(reads);
    expect(input.body).toBe(outside);
    expect('expectHash' in input).toBe(false);
    return applied(input);
  };
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(retained.snapshot().acknowledgedGeneration).toBe(1), budget);
  expect(saveInputs()).toHaveLength(1);
  expect(saveInputs()[0].body).toBe(outside);
  expect(owner()).toBe(retained);
  noLegacyOrMetadataWrite();
});

it('selected_clean_external_save_terminal_unknown_keeps_B_until_existing_choice_then_allows_a_new_C_intent', async () => {
  await mountCleanExternal();
  const retained = owner();
  save = async () => {
    throw new Error('clean B original reply lost');
  };
  const button = cleanSaveAction();
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(retained.snapshot().selectedSave?.status).toBe('unknown'), budget);
  const first = structuredClone(saveInputs()[0]);
  body = latest;
  save = async () => ({ kind: 'selected_outcome_unknown', error: sourceChanged });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check save' }));
  });
  await screen.findByRole('group', { name: 'Choose a version' }, budget);
  expect(retained.snapshot().selectedSave?.status).toBe('reconcile');
  expect(saveInputs()).toHaveLength(2);
  expect(saveInputs()[1]).toEqual({
    ...first,
    editorRequest: { ...first.editorRequest, phase: 'resolve', original: null },
  });
  await act(async () => {
    fireEvent.click(button);
  });
  expect(saveInputs()).toHaveLength(2);
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 0,
    latestDraft: outside,
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Use new' }));
  });
  await waitFor(() => expect(retained.snapshot().selectedSave).toBeUndefined(), budget);
  const chosen = retained.snapshot();
  expect(chosen.latestDraft).toBe(latest);
  expect(chosen.generation).toBe(chosen.acknowledgedGeneration);
  expect(saveInputs()).toHaveLength(2);
  expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
  save = async (input) => applied(input);
  await act(async () => {
    fireEvent.click(cleanSaveAction());
  });
  await waitFor(
    () => expect(retained.snapshot().acknowledgedGeneration).toBe(chosen.generation + 1),
    budget,
  );
  expect(saveInputs()).toHaveLength(3);
  expect(saveInputs()[2]).toMatchObject({
    body: latest,
    editorRequest: { phase: 'start', original: null, target },
  });
  expect(saveInputs()[2].editorRequest.requestKey).not.toBe(first.editorRequest.requestKey);
  expect(owner()).toBe(retained);
  noLegacyOrMetadataWrite();
});

function admitCleanRichRecoveryDetails(nonce: string) {
  const transport = native.invoke.getMockImplementation();
  if (!transport) throw new Error('actual strict native transport missing');
  native.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'recovery_failure') {
      expect(args).toEqual({ vault, path, nonce });
      return { reason: 'copy_storage_unavailable', expiresAt: Math.floor(Date.now() / 1000) + 60 };
    }
    return transport(command, args);
  });
}

// Native admission is descriptive here; these prove UI/owner preservation of
// the frozen raw B and existing request/bypass through a definite refusal.
it.each(['retry', 'bypass'] as const)(
  'selected_clean_external_save_rich_%s_after_definite_refusal_keeps_raw_payload_key_and_presentation',
  async (next) => {
    await mountCleanExternal('rich');
    const retained = owner();
    const before = retained.snapshot();
    const nonce = 'clean-rich-copy-failure';
    admitCleanRichRecoveryDetails(nonce);
    save = async () => {
      throw new Error(`recovery_required:${nonce}`);
    };
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(
      () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
      budget,
    );
    const first = structuredClone(saveInputs()[0]);
    expect(first).toMatchObject({
      body: cleanRichOutside,
      bodyFormat: 'rich',
      editorRequest: { phase: 'start', original: null, target },
    });
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 0,
      latestDraft: before.latestDraft,
    });
    expect(before.latestDraft).not.toBe(cleanRichOutside);
    save = async (input) => applied(input);
    if (next === 'retry') {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
      });
    } else {
      const bypass = await screen.findByRole(
        'button',
        { name: 'Save without a recovery copy' },
        budget,
      );
      await act(async () => {
        fireEvent.click(bypass);
      });
    }
    await waitFor(() => expect(retained.snapshot().acknowledgedGeneration).toBe(1), budget);
    expect(saveInputs()).toHaveLength(2);
    expect(saveInputs()[1]).toMatchObject({
      body: cleanRichOutside,
      bodyFormat: 'rich',
      editorRequest: first.editorRequest,
      recoveryBypass: next === 'bypass' ? nonce : undefined,
    });
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 1,
      latestDraft: before.latestDraft,
      mergeBase: { raw: cleanRichOutside, canon: before.mergeBase?.canon },
    });
    expect(retained.snapshot().failure).toBeNull();
    expect(retained.snapshot().selectedSave).toBeUndefined();
    await act(async () => {
      await retained.flush();
    });
    expect(saveInputs()).toHaveLength(2);
    expect(owner()).toBe(retained);
    noLegacyOrMetadataWrite();
  },
);

it('selected_clean_external_save_rich_refusal_then_real_source_edit_invalidates_old_bypass_and_frozen_generation', async () => {
  await mountCleanExternal('rich');
  const retained = owner();
  const nonce = 'clean-rich-old-payload';
  admitCleanRichRecoveryDetails(nonce);
  save = async () => {
    throw new Error(`recovery_required:${nonce}`);
  };
  await act(async () => {
    fireEvent.click(cleanSaveAction());
  });
  await waitFor(
    () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
    budget,
  );
  const first = structuredClone(saveInputs()[0]);
  const source = screen.getByRole('button', { name: 'Source' });
  await act(async () => {
    fireEvent.click(source);
  });
  const textarea = (await screen.findByRole(
    'textbox',
    { name: 'Page source' },
    budget,
  )) as HTMLTextAreaElement;
  expect(textarea.value).toBe('# Native watch\n\nOutside B 😀.\n');
  expect(retained.snapshot().latestDraft).toBe(cleanRichOutside);
  vi.useFakeTimers();
  fireEvent.change(textarea, { target: { value: local } });
  const rawLocal = '# Native watch\r\n\r\nLocal L.\r\n';
  expect(retained.snapshot()).toMatchObject({
    generation: 2,
    acknowledgedGeneration: 0,
    latestDraft: rawLocal,
  });
  await act(async () => {
    expect(await retained.saveWithoutRecoveryCopy(nonce, 1)).toMatchObject({ kind: 'blocked' });
  });
  expect(saveInputs()).toHaveLength(1);
  save = async (input) => applied(input);
  await advanceAutosave();
  expect(saveInputs()).toHaveLength(2);
  expect(saveInputs()[1]).toMatchObject({
    body: rawLocal,
    bodyFormat: 'source',
    recoveryBypass: undefined,
  });
  expect(saveInputs()[1].editorRequest.requestKey).not.toBe(first.editorRequest.requestKey);
  expect(retained.snapshot()).toMatchObject({
    generation: 2,
    acknowledgedGeneration: 2,
    latestDraft: rawLocal,
  });
  noLegacyOrMetadataWrite();
});

it('selected_clean_external_save_rich_pending_remount_resolves_original_raw_with_its_canonical_presentation', async () => {
  await mountCleanExternal('rich');
  const retained = owner();
  const before = retained.snapshot();
  let original: EditorOperation | null = null;
  save = async (input) => {
    original ??= operation(input);
    return { kind: 'selected_pending', operation: original, error: unreadable };
  };
  await act(async () => {
    fireEvent.click(cleanSaveAction());
  });
  await waitFor(() => expect(retained.snapshot().selectedSave?.status).toBe('pending'), budget);
  const first = structuredClone(saveInputs()[0]);
  await act(async () => {
    cleanup();
  });
  render(<DocPage selection={{ kind: 'doc', path }} />);
  const check = await screen.findByRole('button', { name: 'Check save' }, budget);
  expect(owner()).toBe(retained);
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 0,
    latestDraft: before.latestDraft,
  });
  save = async (input) => applied(input);
  await act(async () => {
    fireEvent.click(check);
  });
  await waitFor(() => expect(retained.snapshot().acknowledgedGeneration).toBe(1), budget);
  expect(saveInputs()).toHaveLength(2);
  expect(saveInputs()[1]).toEqual({
    ...first,
    editorRequest: { ...first.editorRequest, phase: 'resolve', original },
  });
  expect(saveInputs()[1].body).toBe(cleanRichOutside);
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 1,
    latestDraft: before.latestDraft,
    mergeBase: { raw: cleanRichOutside, canon: before.mergeBase?.canon },
  });
  noLegacyOrMetadataWrite();
});

// Independent source-review probes. These preserve the existing transport-only
// harness and use public controls. Root exclusively registers and executes them.
it.each(['retry', 'bypass'] as const)(
  'selected_clean_external_save_independent_refusal_source_view_only_%s_preserves_original_intent',
  async (next) => {
    await mountCleanExternal('rich');
    const retained = owner();
    const nonce = 'clean-rich-view-only';
    admitCleanRichRecoveryDetails(nonce);
    save = async () => {
      throw new Error(`recovery_required:${nonce}`);
    };
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(
      () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
      budget,
    );
    const first = structuredClone(saveInputs()[0]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    });
    const textarea = (await screen.findByRole(
      'textbox',
      { name: 'Page source' },
      budget,
    )) as HTMLTextAreaElement;
    expect(textarea.value).toBe('# Native watch\n\nOutside B 😀.\n');
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 0,
      latestDraft: cleanRichOutside,
      bodyFormat: 'source',
    });
    expect(saveInputs()).toHaveLength(1);
    // A presentation switch alone has neither changed nor invalidated B.
    save = async (input) => applied(input);
    if (next === 'retry') {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
      });
    } else {
      const bypass = await screen.findByRole(
        'button',
        { name: 'Save without a recovery copy' },
        budget,
      );
      await act(async () => {
        fireEvent.click(bypass);
      });
    }
    await waitFor(() => expect(retained.snapshot().acknowledgedGeneration).toBe(1), budget);
    expect(saveInputs()).toHaveLength(2);
    expect(saveInputs()[1]).toMatchObject({
      body: cleanRichOutside,
      bodyFormat: 'rich',
      editorRequest: first.editorRequest,
      recoveryBypass: next === 'bypass' ? nonce : undefined,
    });
    expect(owner()).toBe(retained);
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 1,
      latestDraft: cleanRichOutside,
      mergeBase: { raw: cleanRichOutside, canon: cleanRichOutside },
    });
    await act(async () => {
      await retained.flush();
    });
    expect(saveInputs()).toHaveLength(2);
    noLegacyOrMetadataWrite();
  },
);

it('selected_clean_external_save_independent_refused_rich_B_survives_external_C_observation', async () => {
  await mountCleanExternal('rich');
  const retained = owner();
  const before = retained.snapshot();
  const nonce = 'clean-rich-observed-after-refusal';
  admitCleanRichRecoveryDetails(nonce);
  save = async () => {
    throw new Error(`recovery_required:${nonce}`);
  };
  await act(async () => {
    fireEvent.click(cleanSaveAction());
  });
  await waitFor(
    () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
    budget,
  );
  const first = structuredClone(saveInputs()[0]);
  const failure = retained.snapshot().failure;
  const reads = calls('read_editor_body').length;
  body = latest;
  const observed = snapshot();
  const pending = deferred<SelectedEditorSnapshot>();
  readBody = () => pending.promise;
  await observe();
  await waitFor(() => expect(calls('read_editor_body').length).toBe(reads + 1), budget);
  await act(async () => {
    pending.resolve(observed);
    await pending.promise;
  });
  // No edit or Use new occurred. The refused B generation is still owned,
  // regardless of whether the presentation offers a choice or retains its hold.
  expect(owner()).toBe(retained);
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 0,
    latestDraft: before.latestDraft,
    failure,
  });
  expect(saveInputs()).toHaveLength(1);
  expect(saveInputs()[0]).toEqual(first);
  expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
  noLegacyOrMetadataWrite();
});

it.each([false, true])(
  'selected_clean_external_save_independent_late_refusal_feedback_respects_opening_round_trip_%s',
  async (roundTrip) => {
    await mountCleanExternal();
    const retained = owner();
    const pending = deferred<EditorSaveResult>();
    save = () => pending.promise;
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(() => expect(saveInputs()).toHaveLength(1), budget);
    const first = structuredClone(saveInputs()[0]);
    await act(async () => {
      if (roundTrip) {
        useVaultStore.setState({ vaultPath: '/clean-save-feedback-away' });
        useVaultStore.setState({ vaultPath: vault });
      }
      useUiStore.setState({ toasts: [] });
    });
    await act(async () => {
      pending.reject({ kind: 'selected_refused', error: sourceChanged });
      await pending.promise.catch(() => undefined);
      await retained.settleWrite();
    });
    // The retained original still records its refusal; only feedback belonging
    // to the current opening may enter this opening's global toast list.
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 0,
      failure: { code: sourceChanged.message },
    });
    expect(saveInputs()).toHaveLength(1);
    expect(saveInputs()[0]).toEqual(first);
    const feedback = useUiStore
      .getState()
      .toasts.filter((item) => item.message.startsWith("Couldn't save page:"));
    expect(feedback).toHaveLength(roundTrip ? 0 : 1);
  },
);

it.each(['retry', 'bypass'] as const)(
  'selected_clean_external_save_review_repair_source_refusal_rich_view_only_%s_preserves_original_and_current_canon',
  async (next) => {
    body = cleanRichOutside;
    scan = async () => [externalObservationEntry()];
    await mountSource('# Native watch\n\nOutside B 😀.\n');
    const retained = owner();
    const nonce = 'clean-source-rich-view-only';
    admitCleanRichRecoveryDetails(nonce);
    save = async () => {
      throw new Error(`recovery_required:${nonce}`);
    };
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(
      () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
      budget,
    );
    const first = structuredClone(saveInputs()[0]);
    expect(first).toMatchObject({ body: cleanRichOutside, bodyFormat: 'source' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
    });
    await waitFor(() => expect(retained.snapshot().bodyFormat).toBe('rich'), budget);
    const richCanon = retained.snapshot().latestDraft;
    expect(richCanon).not.toBe(cleanRichOutside);
    expect(retained.snapshot()).toMatchObject({ generation: 1, acknowledgedGeneration: 0 });
    save = async (input) => applied(input);
    if (next === 'retry') {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
      });
    } else {
      const bypass = await screen.findByRole(
        'button',
        { name: 'Save without a recovery copy' },
        budget,
      );
      await act(async () => {
        fireEvent.click(bypass);
      });
    }
    await waitFor(() => expect(retained.snapshot().acknowledgedGeneration).toBe(1), budget);
    expect(saveInputs()).toHaveLength(2);
    expect(saveInputs()[1]).toMatchObject({
      body: cleanRichOutside,
      bodyFormat: 'source',
      editorRequest: first.editorRequest,
      recoveryBypass: next === 'bypass' ? nonce : undefined,
    });
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 1,
      latestDraft: richCanon,
      bodyFormat: 'rich',
      mergeBase: { raw: cleanRichOutside, canon: richCanon },
    });
    await act(async () => {
      await retained.flush();
    });
    expect(saveInputs()).toHaveLength(2);
    expect(owner()).toBe(retained);
    noLegacyOrMetadataWrite();
  },
);

it.each([
  { label: 'keep_B_over_text_C', choice: 'Keep yours', observed: latest },
  { label: 'take_text_C', choice: 'Use new', observed: latest },
  {
    label: 'keep_raw_CRLF_B_over_format_only_LF_C',
    choice: 'Keep yours',
    observed: '# Native watch\n\nOutside B 😀.\n',
  },
] as const)(
  'selected_clean_external_save_review_repair_owned_rich_choice_$label',
  async ({ choice, observed }) => {
    await mountCleanExternal('rich');
    const retained = owner();
    const before = retained.snapshot();
    const nonce = 'clean-rich-whole-page-choice';
    admitCleanRichRecoveryDetails(nonce);
    save = async () => {
      throw new Error(`recovery_required:${nonce}`);
    };
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(
      () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
      budget,
    );
    const first = structuredClone(saveInputs()[0]);
    const failure = retained.snapshot().failure;
    body = observed;
    await observe();
    await waitFor(
      () => expect(screen.queryByRole('group', { name: 'Choose a version' })).not.toBeNull(),
      budget,
    );
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 0,
      latestDraft: before.latestDraft,
      failure,
    });
    expect(saveInputs()).toHaveLength(1);
    save = async (input) => applied(input);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: choice }));
    });
    if (choice === 'Keep yours') {
      await waitFor(() => expect(retained.snapshot().acknowledgedGeneration).toBe(1), budget);
      expect(saveInputs()).toHaveLength(2);
      expect(saveInputs()[1]).toMatchObject({
        body: cleanRichOutside,
        bodyFormat: 'rich',
        editorRequest: first.editorRequest,
      });
      expect(retained.snapshot()).toMatchObject({
        generation: 1,
        acknowledgedGeneration: 1,
        latestDraft: before.latestDraft,
        mergeBase: { raw: cleanRichOutside, canon: before.mergeBase?.canon },
      });
      expect(owner()).toBe(retained);
    } else {
      await waitFor(() => expect(owner().snapshot().mergeBase?.raw).toBe(observed), budget);
      expect(owner().snapshot().generation).toBe(owner().snapshot().acknowledgedGeneration);
      expect(owner().snapshot().failure).toBeNull();
      expect(saveInputs()).toHaveLength(1);
      expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
    }
    await act(async () => {
      await owner().flush();
    });
    expect(saveInputs()).toHaveLength(choice === 'Keep yours' ? 2 : 1);
    noLegacyOrMetadataWrite();
  },
);

// Independent follow-up: the repair's direct Keep yours retry must keep the
// same live presentation/barrier checks as the explicit originating action.
it.each([
  'native_read_only',
  'native_read_only_after_choice',
  'composition',
  'preparation',
] as const)(
  'selected_clean_external_save_independent_retry_choice_live_%s_cannot_dispatch_or_queue',
  async (guard) => {
    await mountCleanExternal('rich');
    const retained = owner();
    const before = retained.snapshot();
    const nonce = 'clean-rich-choice-live-guard';
    admitCleanRichRecoveryDetails(nonce);
    save = async () => {
      throw new Error(`recovery_required:${nonce}`);
    };
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(
      () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
      budget,
    );
    const first = structuredClone(saveInputs()[0]);
    body = latest;
    let editable = guard !== 'native_read_only';
    readBody = async () => ({
      ...snapshot(),
      editable,
      readOnlyReason: editable ? null : 'This page is now read-only.',
    });
    await observe();
    await screen.findByRole('group', { name: 'Choose a version' }, budget);
    const observeKnownEditability = async () => {
      // An identical completed scan intentionally skips the body read. Deliver
      // the changed native snapshot through the existing failed/recovered scan
      // observation path before judging the current presentation's guard.
      const beforeRead = calls('read_editor_body').length;
      scan = async () => {
        throw unreadable;
      };
      await observe();
      await waitFor(
        () => expect(calls('read_editor_body').length).toBeGreaterThan(beforeRead),
        budget,
      );
      await waitFor(() => expect(retained.snapshot().reconcileRequired).toBe(false), budget);
      const failedRead = calls('read_editor_body').length;
      scan = async () => [externalObservationEntry()];
      await observe();
      await waitFor(
        () => expect(calls('read_editor_body').length).toBeGreaterThan(failedRead),
        budget,
      );
      await waitFor(() => expect(retained.snapshot().reconcileRequired).toBe(false), budget);
      await waitFor(() => {
        const reason = screen.queryByText('This page is now read-only.');
        if (editable) expect(reason).toBeNull();
        else expect(reason).not.toBeNull();
      }, budget);
    };
    if (guard === 'native_read_only_after_choice') {
      editable = false;
      await observeKnownEditability();
    }
    let release = () => {};
    if (guard === 'preparation') {
      await act(async () => {
        release = retained.beginPreparation();
      });
    }
    if (guard === 'composition') {
      const input = document.querySelector('[contenteditable="true"]');
      if (!input) throw new Error('actual rich editor input missing');
      fireEvent.compositionStart(input);
      release = () => {
        fireEvent.compositionEnd(input);
      };
    }
    save = async (input) => applied(input);
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
      });
      expect(saveInputs()).toHaveLength(1);
      expect(retained.snapshot()).toMatchObject({
        generation: 1,
        acknowledgedGeneration: 0,
        latestDraft: before.latestDraft,
        failure: { code: `recovery_required:${nonce}` },
      });
      expect(screen.queryByRole('group', { name: 'Choose a version' })).not.toBeNull();
    } finally {
      await act(async () => {
        release();
      });
    }
    if (!editable) {
      editable = true;
      await observeKnownEditability();
    }
    await act(async () => {
      await retained.settleWrite();
    });
    expect(saveInputs()).toHaveLength(1);
    // Becoming available cannot retroactively authorize the blocked click.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
    });
    await waitFor(() => expect(retained.snapshot().acknowledgedGeneration).toBe(1), budget);
    expect(saveInputs()).toHaveLength(2);
    expect(saveInputs()[1]).toMatchObject({
      body: cleanRichOutside,
      bodyFormat: 'rich',
      editorRequest: first.editorRequest,
    });
    noLegacyOrMetadataWrite();
  },
);

it('selected_clean_external_save_independent_source_refusal_C_then_B_read_cannot_acknowledge_original', async () => {
  await mountCleanExternal('source');
  const retained = owner();
  const nonce = 'clean-source-read-back-to-intent';
  admitCleanRichRecoveryDetails(nonce);
  save = async () => {
    throw new Error(`recovery_required:${nonce}`);
  };
  await act(async () => {
    fireEvent.click(cleanSaveAction());
  });
  await waitFor(
    () => expect(retained.snapshot().failure?.code).toBe(`recovery_required:${nonce}`),
    budget,
  );
  const first = structuredClone(saveInputs()[0]);
  const failure = retained.snapshot().failure;
  body = latest;
  await observe();
  await screen.findByRole('group', { name: 'Choose a version' }, budget);
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 0,
    latestDraft: outside,
    failure,
  });
  body = outside;
  const observed = snapshot();
  const reads = calls('read_editor_body').length;
  const pending = deferred<SelectedEditorSnapshot>();
  readBody = () => pending.promise;
  await observe();
  await waitFor(() => expect(calls('read_editor_body').length).toBe(reads + 1), budget);
  await act(async () => {
    pending.resolve(observed);
    await pending.promise;
  });
  // The observed text equals B again, but the canonical pair is still A.
  // A read alone cannot settle the person's failed canonical-adoption intent.
  expect(retained.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 0,
    latestDraft: outside,
    failure,
  });
  expect(saveInputs()).toHaveLength(1);
  expect(saveInputs()[0]).toEqual(first);
  expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
  noLegacyOrMetadataWrite();
});

it.each(['source', 'rich'] as const)(
  'selected_clean_external_save_independent_terminal_unknown_keep_equal_%s_still_adopts_original_raw_B',
  async (presentation) => {
    await mountCleanExternal(presentation);
    const retained = owner();
    const before = retained.snapshot();
    const rawB = presentation === 'source' ? outside : cleanRichOutside;
    save = async () => {
      throw new Error('explicit clean adoption original reply lost');
    };
    await act(async () => {
      fireEvent.click(cleanSaveAction());
    });
    await waitFor(() => expect(retained.snapshot().selectedSave?.status).toBe('unknown'), budget);
    const first = structuredClone(saveInputs()[0]);
    expect(first).toMatchObject({
      body: rawB,
      bodyFormat: presentation,
      editorRequest: { phase: 'start', original: null },
    });
    // Source still observes exact B. Rich observes an LF-only spelling of B
    // matching its visible canon. Neither read supplies canonical adoption.
    body = presentation === 'source' ? rawB : before.latestDraft;
    save = async () => ({ kind: 'selected_outcome_unknown', error: sourceChanged });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check save' }));
    });
    await screen.findByRole('group', { name: 'Choose a version' }, budget);
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 0,
      latestDraft: before.latestDraft,
    });
    expect(saveInputs()).toHaveLength(2);
    expect(saveInputs()[1]).toEqual({
      ...first,
      editorRequest: { ...first.editorRequest, phase: 'resolve', original: null },
    });
    expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
    const pending = deferred<EditorSaveResult>();
    let restarted: SaveInput | null = null;
    save = async (input) => {
      restarted = structuredClone(input);
      return pending.promise;
    };
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
      });
      await waitFor(() => expect(saveInputs()).toHaveLength(3), budget);
      const next = saveInputs()[2];
      expect(next).toMatchObject({
        body: rawB,
        bodyFormat: presentation,
        editorRequest: { target, phase: 'start', original: null },
      });
      expect(next.editorRequest.requestKey).not.toBe(first.editorRequest.requestKey);
      expect(retained.snapshot()).toMatchObject({
        generation: 1,
        acknowledgedGeneration: 0,
        latestDraft: before.latestDraft,
      });
      expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(initial));
    } finally {
      await act(async () => {
        const input = restarted as SaveInput | null;
        pending.resolve(input ? applied(input) : { kind: 'selected_unchanged', version: current });
        await retained.settleWrite();
      });
    }
    expect(retained.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 1,
      latestDraft: before.latestDraft,
      mergeBase: { raw: rawB, canon: before.mergeBase?.canon },
    });
    expect(useVaultStore.getState().entries[0].authority?.bodyHash).toBe(sha256Hex(rawB));
    await act(async () => {
      await retained.flush();
    });
    expect(saveInputs()).toHaveLength(3);
    noLegacyOrMetadataWrite();
  },
);
