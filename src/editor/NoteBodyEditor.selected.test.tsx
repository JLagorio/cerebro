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
import type {
  AuthorityError,
  EditorOperation,
  EditorSaveRequest,
  EditorSaveResult,
  SelectedEditorSnapshot,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';
import { makeEntry } from '@/test/factories';
import { sha256Hex } from '@/lib/sha256';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { NoteBodyEditor } from './NoteBodyEditor';
import type { EditorReadyInfo } from './MarkdownEditor';
import {
  __resetOpenPages,
  retainedDocumentOwner,
  flushOpenPages,
  announceExternalWrites,
} from './openPages';
import { sourceBodyDisplay } from './sourceBodyEdits';
import { useNavStore } from '@/stores/navStore';
import {
  sourceRequestFor,
  sourceVisitOrigin,
  useSourceNavigation,
  type SourceOpenRequest,
} from '@/app/sourceOpen';
import * as sourceReveal from './sourceReveal';

const vault = '/selected-mounted-toy';
const path = 'page.md';
const key = { vaultId: vault, path, ownerId: 'peek' };
const target = {
  workspaceId: '915781f1-6812-478c-8063-3f41322547f5',
  recordId: '76b64da5-34b6-45f2-8ab2-e2779227ace3',
};
const initial = '# Selected page\n\nOriginal paragraph.\n';
const budget = { timeout: 5000 };
const error: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'recovery_required',
  message: 'The original save needs recovery.',
  retryable: true,
};
const version = (
  body: string,
  revision = '1',
  metadataHash = 'a'.repeat(64),
): SelectedRecordVersion => ({
  kind: 'sqlite_metadata',
  ...target,
  metadataRevision: revision,
  metadataHash,
  bodyHash: sha256Hex(body),
});
const snapshot = (body = initial, current = version(body)): SelectedEditorSnapshot => ({
  path,
  target,
  body,
  observedBodyHash: sha256Hex(body),
  version: current,
  coherence: 'paired',
  editable: true,
});
/** Descriptive native replies only. Real paired service/exit86 tests establish
 * filesystem/SQLite durability; these cases exercise the actual mounted owner. */
function operation(request: EditorSaveRequest, body: string): EditorOperation {
  const current = version(body, '2');
  return {
    path,
    target,
    requestKey: request.requestKey,
    operationId: '351a1b0f-7b33-48c4-b96c-8dc6a702897e',
    version: current,
    receipt: {
      workspaceId: target.workspaceId,
      recordId: target.recordId,
      epoch: '2',
      previousRevision: '1',
      revision: '2',
      metadataBeforeHash: current.metadataHash,
      metadataAfterHash: current.metadataHash,
      bodyBeforeHash: sha256Hex(initial),
      bodyAfterHash: sha256Hex(body),
      actor: 'human',
      operation: 'page.body',
      at: '2026-10-24T00:00:00Z',
    },
  };
}
function applied(request: EditorSaveRequest, body: string): EditorSaveResult {
  const original = request.original ?? operation(request, body);
  return {
    kind: 'selected_applied',
    operation: original,
    currentVersion: original.version,
    reconcileRequired: false,
    recovery: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function currentOwner() {
  const owner = retainedDocumentOwner(key);
  if (!owner) throw new Error('actual mounted owner missing');
  return owner;
}
async function mount(extra: Partial<React.ComponentProps<typeof NoteBodyEditor>> = {}) {
  const ready = vi.fn<(info: EditorReadyInfo) => void>();
  const view = render(
    <NoteBodyEditor
      path={path}
      owner="peek"
      selectedTarget={target}
      debounceMs={20}
      onReady={ready}
      pageTitle="Selected page"
      pageChrome={<input aria-label="Stable metadata" defaultValue="retained metadata draft" />}
      {...extra}
    />,
  );
  await waitFor(
    () =>
      expect(
        ready.mock.calls.length > 0 || screen.queryByText("This page couldn't be loaded.") !== null,
      ).toBe(true),
    budget,
  );
  // Closed-API RED fails this assertion promptly after the actual unavailable
  // load result; a timeout is not used as evidence of a reached save boundary.
  expect(ready).toHaveBeenCalled();
  return { view, info: ready.mock.calls.at(-1)![0] };
}
async function source() {
  const button = await screen.findByRole('button', { name: 'Source' }, budget);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false), budget);
  fireEvent.click(button);
  return (await screen.findByRole(
    'textbox',
    { name: 'Page source' },
    budget,
  )) as HTMLTextAreaElement;
}
function editSource(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Page source' }), {
    target: { value: text },
  });
}
function append(info: EditorReadyInfo, text: string) {
  const last = info.editor.document.at(-1)!;
  info.editor.insertBlocks([{ type: 'paragraph', content: text }], last, 'after');
}
beforeAll(async () => {
  await import('./MarkdownEditor');
});
beforeEach(() => {
  vi.clearAllMocks();
  __resetOpenPages();
  // restoreAllMocks removes these spies after each case; recreate every IPC
  // fixture explicitly instead of relying on the one-time module spy mock.
  vi.spyOn(ipc, 'setPageFullWidth');
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    entries: [
      makeEntry({
        path,
        hash: sha256Hex(initial),
        authority: version(initial),
        properties: { full_width: false, code: '007' },
        relationships: { related: ['preserve'] },
      }),
    ],
    views: [],
    folders: [],
    status: 'ready',
    error: null,
    rescan: async () => undefined,
  });
  useUiStore.setState({ toasts: [] });
  // Legacy fallbacks let an unintegrated component reach its real writer. Each
  // selected read test asserts they were not used; there is no success branch
  // hidden in the native mock or test-only owner implementation.
  vi.spyOn(ipc, 'readNote').mockResolvedValue(initial);
  vi.spyOn(ipc, 'readNoteSource').mockResolvedValue({ content: initial, hash: sha256Hex(initial) });
  vi.spyOn(ipc, 'readEditorBody').mockResolvedValue(snapshot());
  vi.spyOn(ipc, 'calculateSheets').mockImplementation(async () => []);
  vi.spyOn(ipc, 'saveNoteBody').mockImplementation(async ({ body, editorRequest }) => {
    if (!editorRequest) throw new Error('selected request missing at actual saveNoteBody consumer');
    return applied(editorRequest, body);
  });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
});

it('mounted_selected_reads_complete_file_and_preserves_source_bytes_and_metadata_portal', async () => {
  const raw =
    '\ufeff---\r\ntype: not frontmatter here\r\n--- \t\r\n\r\n# Selected page\r\n\r\n<div>Exact 😀</div>\r\n';
  vi.mocked(ipc.readEditorBody).mockResolvedValue(snapshot(raw));
  vi.mocked(ipc.readNote).mockResolvedValue(raw);
  vi.mocked(ipc.readNoteSource).mockResolvedValue({ content: raw, hash: sha256Hex(raw) });
  const loaded = vi.fn();
  await mount({ onBodyLoaded: loaded });
  const metadata = screen.getByRole('textbox', { name: 'Stable metadata' });
  const textarea = await source();
  expect(textarea.value).toBe(sourceBodyDisplay(raw));
  expect(currentOwner().snapshot().latestDraft).toBe(raw);
  expect(currentOwner().snapshot().mergeBase?.raw).toBe(raw);
  expect(loaded).toHaveBeenCalledWith(path, raw);
  expect(screen.getByRole('textbox', { name: 'Stable metadata' })).toBe(metadata);
  expect(ipc.readEditorBody).toHaveBeenCalledWith(vault, path, target);
  expect(ipc.readNote).not.toHaveBeenCalled();
  expect(ipc.readNoteSource).not.toHaveBeenCalled();
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();
});

it('mounted_selected_native_ineligible_read_keeps_source_read_only', async () => {
  vi.mocked(ipc.readEditorBody).mockResolvedValue({
    ...snapshot(),
    editable: false,
    readOnlyReason: 'This selected record is not supported by the body writer.',
  });
  await mount();
  const textarea = await source();
  expect(textarea.readOnly).toBe(true);
  editSource('attempted text');
  expect(currentOwner().snapshot().generation).toBe(0);
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();
  expect(
    screen.getByText('This selected record is not supported by the body writer.'),
  ).toBeTruthy();
});

it('mounted_selected_pending_remount_reattaches_draft_without_a_guarded_body_read', async () => {
  const requests: EditorSaveRequest[] = [];
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ body, editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    requests.push(structuredClone(editorRequest));
    return { kind: 'selected_pending', operation: operation(editorRequest, body), error };
  });
  const first = await mount();
  await source();
  editSource('# Selected page\n\nOriginal A.\n');
  await waitFor(
    () => expect(currentOwner().snapshot().selectedSave?.status).toBe('pending'),
    budget,
  );
  const owner = currentOwner();
  expect(owner.snapshot().acknowledgedGeneration).toBe(0);
  first.view.unmount();
  vi.mocked(ipc.readEditorBody).mockClear().mockRejectedValue(new Error('pending guard'));
  vi.mocked(ipc.readNote).mockClear().mockRejectedValue(new Error('wrong legacy reader'));
  vi.mocked(ipc.readNoteSource).mockClear().mockRejectedValue(new Error('wrong legacy reader'));
  await mount();
  expect(currentOwner()).toBe(owner);
  expect(
    (await screen.findByRole('textbox', { name: 'Page source' })).getAttribute('readonly'),
  ).toBeNull();
  expect(
    (screen.getByRole('textbox', { name: 'Page source' }) as HTMLTextAreaElement).value,
  ).toContain('Original A');
  expect(ipc.readEditorBody).not.toHaveBeenCalled();
  expect(ipc.readNote).not.toHaveBeenCalled();
  expect(ipc.readNoteSource).not.toHaveBeenCalled();
  expect(
    screen.getAllByRole('status').some((node) => node.textContent?.includes('not yet confirmed')),
  ).toBe(true);
  const originalKey = requests[0].requestKey;
  fireEvent.click(await screen.findByRole('button', { name: 'Check save' }));
  await waitFor(() => expect(requests.at(-1)?.phase).toBe('resolve'));
  expect(requests.at(-1)?.requestKey).toBe(originalKey);
  await act(async () => {
    const report = await flushOpenPages();
    expect(report.unresolvedOwnerIds).toHaveLength(1);
  });
  expect(owner.snapshot().acknowledgedGeneration).toBe(0);
  expect(screen.queryByRole('button', { name: 'Save without a recovery copy' })).toBeNull();
});

it('mounted_selected_lost_reply_resolves_original_key_and_body_before_newer_typing', async () => {
  const calls: { request: EditorSaveRequest; body: string }[] = [];
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ body, editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    calls.push({ body, request: structuredClone(editorRequest) });
    if (calls.length === 1) throw new Error('reply lost after dispatch');
    return applied(editorRequest, body);
  });
  await mount();
  await source();
  const original = '# Selected page\n\nOriginal A.\n';
  const newer = '# Selected page\n\nNewer N.\n';
  editSource(original);
  await waitFor(
    () => expect(currentOwner().snapshot().selectedSave?.status).toBe('unknown'),
    budget,
  );
  editSource(newer);
  // Resolve explicitly before the existing debounce may dispatch; that same
  // retained owner must resolve A before a fresh key can carry N.
  fireEvent.click(await screen.findByRole('button', { name: 'Check save' }));
  await waitFor(() => expect(currentOwner().snapshot().acknowledgedGeneration).toBe(2), budget);
  expect(calls.map(({ body, request }) => [body, request.phase])).toEqual([
    [original, 'start'],
    [original, 'resolve'],
    [newer, 'start'],
  ]);
  expect(calls[1].request.requestKey).toBe(calls[0].request.requestKey);
  expect(calls[2].request.requestKey).not.toBe(calls[0].request.requestKey);
  expect(currentOwner().snapshot().latestDraft).toBe(newer);
});

it('mounted_selected_full_width_uses_verified_body_version_before_held_rescan', async () => {
  const scan = deferred<void>();
  const reply = deferred<EditorSaveResult>();
  const rescan = vi.fn(() => scan.promise);
  useVaultStore.setState({ rescan });
  let captured: { request: EditorSaveRequest; body: string } | undefined;
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ body, editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    captured = { request: structuredClone(editorRequest), body };
    return reply.promise;
  });
  vi.mocked(ipc.setPageFullWidth).mockImplementation(async (_vault, _path, expected) => ({
    kind: 'applied',
    fullWidth: true,
    version: { ...expected, metadataRevision: '3' },
  }));
  await mount();
  await source();
  editSource('# Selected page\n\nA.\n');
  let change!: Promise<boolean>;
  act(() => {
    change = useVaultStore.getState().patchFrontmatter(path, { full_width: true });
  });
  try {
    await waitFor(() => expect(captured).toBeDefined(), budget);
    expect(ipc.setPageFullWidth).not.toHaveBeenCalled();
    if (!captured) throw new Error('body dispatch missing');
    const ack = applied(captured.request, captured.body);
    await act(async () => {
      reply.resolve(ack);
      await Promise.resolve();
    });
    await waitFor(() => expect(ipc.setPageFullWidth).toHaveBeenCalledTimes(1), budget);
    expect(ipc.setPageFullWidth).toHaveBeenCalledWith(
      vault,
      path,
      version(captured.body, '2'),
      'wide',
    );
    expect(currentOwner().snapshot().acknowledgedGeneration).toBe(1);
    expect(rescan).toHaveBeenCalled();
  } finally {
    await act(async () => {
      reply.resolve({
        kind: 'selected_unchanged',
        version: version(captured?.body ?? initial, '2'),
      });
      scan.resolve();
      await change;
    });
  }
});

it('mounted_selected_projection_refusal_holds_full_width_until_real_metadata_reread', async () => {
  const scan = deferred<void>();
  let body = initial;
  let current = version(initial);
  const originalProperties = useVaultStore.getState().entries[0].properties;
  const rescan = vi.fn(async () => {
    await scan.promise;
    useVaultStore.setState({
      entries: [
        makeEntry({
          path,
          hash: current.bodyHash,
          authority: current,
          properties: { full_width: false, code: 'new metadata' },
          relationships: { related: ['new'] },
        }),
      ],
    });
  });
  useVaultStore.setState({ rescan });
  vi.mocked(ipc.readEditorBody).mockImplementation(async () => snapshot(body, current));
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ body: next, editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    body = next;
    current = version(next, '3', 'b'.repeat(64));
    return {
      kind: 'selected_applied',
      operation: operation(editorRequest, next),
      currentVersion: current,
      reconcileRequired: true,
      recovery: null,
    };
  });
  vi.mocked(ipc.setPageFullWidth).mockImplementation(async (_vault, _path, expected) => ({
    kind: 'unchanged',
    fullWidth: true,
    version: expected,
  }));
  await mount();
  await source();
  editSource('# Selected page\n\nA.\n');
  try {
    await act(async () => {
      expect(await useVaultStore.getState().patchFrontmatter(path, { full_width: true })).toBe(
        false,
      );
    });
    expect(currentOwner().snapshot().reconcileRequired).toBe(true);
    expect(ipc.setPageFullWidth).not.toHaveBeenCalled();
    expect(useVaultStore.getState().entries[0].properties).toBe(originalProperties);
    expect(useVaultStore.getState().entries[0].authority?.metadataHash).toBe('a'.repeat(64));
    await act(async () => {
      scan.resolve();
      await Promise.resolve();
    });
    await waitFor(
      () => expect(useVaultStore.getState().entries[0].properties.code).toBe('new metadata'),
      budget,
    );
    await waitFor(() => expect(currentOwner().snapshot().reconcileRequired).toBe(false), budget);
    expect(ipc.readEditorBody).toHaveBeenCalled();
    await act(async () => {
      expect(await useVaultStore.getState().patchFrontmatter(path, { full_width: true })).toBe(
        true,
      );
    });
    expect(ipc.setPageFullWidth).toHaveBeenLastCalledWith(vault, path, current, 'wide');
  } finally {
    await act(async () => {
      scan.resolve();
      await Promise.resolve();
    });
  }
});

it('mounted_selected_unknown_nonoverlap_requires_explicit_existing_whole_page_choice', async () => {
  const outside = '# Selected page\n\nOutside changed the original paragraph.\n';
  const requests: EditorSaveRequest[] = [];
  let body = initial;
  vi.mocked(ipc.readEditorBody).mockImplementation(async () => snapshot(body));
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ body: next, editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    requests.push(structuredClone(editorRequest));
    if (requests.length === 1) throw new Error('lost reply');
    if (requests.length === 2) {
      body = outside;
      return { kind: 'selected_outcome_unknown', error };
    }
    body = next;
    return applied(editorRequest, next);
  });
  const { info } = await mount();
  act(() => append(info, 'Local appended paragraph.'));
  await screen.findByRole('button', { name: 'Check save' }, budget);
  fireEvent.click(screen.getByRole('button', { name: 'Check save' }));
  const choices = await screen.findByRole('group', { name: 'Choose a version' }, budget);
  expect(choices.textContent).toContain('could not be confirmed');
  expect(choices.textContent).toContain('Local appended paragraph.');
  expect(choices.textContent).toContain('Outside changed the original paragraph.');
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(requests).toHaveLength(2);
  expect(currentOwner().snapshot().acknowledgedGeneration).toBe(0);
  expect(currentOwner().snapshot().selectedSave?.status).toBe('reconcile');
  fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
  await waitFor(() => expect(requests).toHaveLength(3), budget);
  expect(requests[2].phase).toBe('start');
  expect(requests[2].requestKey).not.toBe(requests[0].requestKey);
  expect(body).toContain('Local appended paragraph.');
  expect(body).not.toContain('Outside changed the original paragraph.');
});

it('mounted_selected_choice_read_crossed_by_typing_preserves_newer_draft_and_original_hold', async () => {
  const requests: EditorSaveRequest[] = [];
  let body = initial;
  vi.mocked(ipc.readEditorBody).mockImplementation(async () => snapshot(body));
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    requests.push(structuredClone(editorRequest));
    if (requests.length === 1) throw new Error('lost reply');
    body = '# Selected page\n\nOutside B.\n';
    return { kind: 'selected_outcome_unknown', error };
  });
  await mount();
  await source();
  editSource('# Selected page\n\nLocal A.\n');
  fireEvent.click(await screen.findByRole('button', { name: 'Check save' }, budget));
  await screen.findByRole('group', { name: 'Choose a version' }, budget);
  const heldRead = deferred<SelectedEditorSnapshot>();
  const reads = vi.mocked(ipc.readEditorBody).mock.calls.length;
  vi.mocked(ipc.readEditorBody).mockImplementationOnce(() => heldRead.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Use new' }));
  try {
    await waitFor(() =>
      expect(vi.mocked(ipc.readEditorBody).mock.calls.length).toBeGreaterThan(reads),
    );
    editSource('# Selected page\n\nNewer N while choice read waits.\n');
    await act(async () => {
      heldRead.resolve(snapshot(body));
      await heldRead.promise;
    });
    expect(currentOwner().snapshot()).toMatchObject({
      latestDraft: '# Selected page\n\nNewer N while choice read waits.\n',
      acknowledgedGeneration: 0,
      selectedSave: { status: 'reconcile', requestKey: requests[0].requestKey },
    });
    expect(screen.getByRole('group', { name: 'Choose a version' })).toBeTruthy();
    expect(requests).toHaveLength(2);
  } finally {
    heldRead.resolve(snapshot(body));
  }
});

it('mounted_selected_mode_switch_and_record_rebind_cannot_replace_a_pending_attempt', async () => {
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ body, editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    return { kind: 'selected_pending', operation: operation(editorRequest, body), error };
  });
  const { view } = await mount();
  await source();
  editSource('# Selected page\n\nPending A.\n');
  await waitFor(
    () => expect(currentOwner().snapshot().selectedSave?.status).toBe('pending'),
    budget,
  );
  const retained = currentOwner();
  const before = retained.snapshot();
  fireEvent.click(screen.getByRole('button', { name: 'Rich text' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('pending'));
  expect(retained.snapshot().latestDraft).toBe(before.latestDraft);
  expect(retained.snapshot().bodyFormat).toBe('source');
  view.rerender(
    <NoteBodyEditor
      path={path}
      owner="peek"
      selectedTarget={{ ...target, recordId: 'f951be52-91b2-4e82-a7b5-4c9df8afadfd' }}
      debounceMs={20}
    />,
  );
  await waitFor(
    () => expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull(),
    budget,
  );
  expect(retained.snapshot().latestDraft).toBe(before.latestDraft);
  expect(retained.snapshot().selectedSave?.requestKey).toBe(before.selectedSave?.requestKey);
  expect(retained.snapshot().acknowledgedGeneration).toBe(0);
});
// Additive mounted probe/control. Reuses this file's per-beforeEach IPC spies;
// no real native service, authority or filesystem durability is asserted.
it.each([
  { label: 'same_opening_control', roundTrip: false },
  { label: 'vault_round_trip_keeps_original_hold', roundTrip: true },
])('mounted_selected_choice_read_$label', async ({ roundTrip }) => {
  const requests: EditorSaveRequest[] = [];
  const local = '# Selected page\n\nLocal A must remain recoverable.\n';
  let body = initial;
  vi.mocked(ipc.readEditorBody).mockImplementation(async () => snapshot(body));
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    requests.push(structuredClone(editorRequest));
    if (requests.length === 1) throw new Error('lost reply');
    body = '# Selected page\n\nOutside B before click.\n';
    return { kind: 'selected_outcome_unknown', error };
  });
  await mount();
  await source();
  editSource(local);
  fireEvent.click(await screen.findByRole('button', { name: 'Check save' }, budget));
  await screen.findByRole('group', { name: 'Choose a version' }, budget);
  const owner = currentOwner();
  const before = owner.snapshot();
  const settle = vi.spyOn(owner, 'settleSelectedReconcile');
  const heldRead = deferred<SelectedEditorSnapshot>();
  const reads = vi.mocked(ipc.readEditorBody).mock.calls.length;
  vi.mocked(ipc.readEditorBody).mockImplementationOnce(() => heldRead.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Use new' }));
  try {
    await waitFor(() =>
      expect(vi.mocked(ipc.readEditorBody).mock.calls.length).toBeGreaterThan(reads),
    );
    await act(async () => {
      // Like the existing recovery-failure ABA regression, both updates may
      // batch to the original render while useVaultActionGuard observes each.
      if (roundTrip) {
        useVaultStore.setState({ vaultPath: '/selected-choice-other-vault' });
        useVaultStore.setState({ vaultPath: vault });
      }
      heldRead.resolve(snapshot(body));
      await heldRead.promise;
      // readBody resolves the click's outer await before this continuation.
      await Promise.resolve();
    });
    expect(requests).toHaveLength(2);
    if (roundTrip) {
      expect(settle).not.toHaveBeenCalled();
      expect(owner.snapshot()).toMatchObject({
        latestDraft: local,
        acknowledgedGeneration: before.acknowledgedGeneration,
        selectedSave: { status: 'reconcile', requestKey: requests[0].requestKey },
      });
      expect(screen.getByRole('group', { name: 'Choose a version' })).toBeTruthy();
    } else {
      expect(settle).toHaveBeenCalledTimes(1);
      expect(owner.snapshot().latestDraft).toBe(body);
      expect(owner.snapshot().acknowledgedGeneration).toBe(owner.snapshot().generation);
      expect(owner.snapshot().selectedSave).toBeUndefined();
    }
  } finally {
    heldRead.resolve(snapshot(body));
  }
});

// Real mounted consumers, with only the asynchronous IPC response held. The
// round trip changes the existing opening epoch while React can batch back to A.
const selectedReadOpenings = [
  { label: 'same_opening_control', roundTrip: false },
  { label: 'vault_round_trip_refuses_stale_read', roundTrip: true },
];

it.each(selectedReadOpenings)('mounted_selected_initial_read_$label', async ({ roundTrip }) => {
  const stale = '# Selected page\n\nHeld initial snapshot from the old opening.\n';
  const heldRead = deferred<SelectedEditorSnapshot>();
  vi.mocked(ipc.readEditorBody)
    .mockResolvedValue(snapshot())
    .mockImplementationOnce(() => heldRead.promise);
  const loaded = vi.fn();
  const ready = vi.fn();
  render(
    <NoteBodyEditor
      path={path}
      owner="peek"
      selectedTarget={target}
      pageTitle="Selected page"
      debounceMs={20}
      onBodyLoaded={loaded}
      onReady={ready}
    />,
  );
  try {
    await waitFor(() => expect(ipc.readEditorBody).toHaveBeenCalled(), budget);
    await act(async () => {
      if (roundTrip) {
        useVaultStore.setState({ vaultPath: '/selected-initial-other-vault' });
        useVaultStore.setState({ vaultPath: vault });
      }
      heldRead.resolve(snapshot(stale, version(stale, '2')));
      await heldRead.promise;
      await Promise.resolve();
    });
    if (roundTrip) {
      expect(loaded).not.toHaveBeenCalledWith(path, stale);
      expect(retainedDocumentOwner(key)?.snapshot().mergeBase?.raw).not.toBe(stale);
    } else {
      await waitFor(() => expect(ready).toHaveBeenCalled(), budget);
      expect(loaded).toHaveBeenCalledWith(path, stale);
      expect(currentOwner().snapshot().mergeBase?.raw).toBe(stale);
    }
    expect(ipc.saveNoteBody).not.toHaveBeenCalled();
  } finally {
    heldRead.resolve(snapshot(stale, version(stale, '2')));
  }
});

it.each(selectedReadOpenings)('mounted_selected_reconcile_read_$label', async ({ roundTrip }) => {
  const loaded = vi.fn();
  await mount({ onBodyLoaded: loaded });
  await source();
  loaded.mockClear();
  const owner = currentOwner();
  const before = owner.snapshot();
  const originalVersion = useVaultStore.getState().entries[0].authority;
  const adopt = vi.spyOn(owner, 'acceptExternal');
  const stale = '# Selected page\n\nHeld outside update from the old opening.\n';
  const heldRead = deferred<SelectedEditorSnapshot>();
  const reads = vi.mocked(ipc.readEditorBody).mock.calls.length;
  vi.mocked(ipc.readEditorBody).mockImplementationOnce(() => heldRead.promise);
  await act(async () => {
    await announceExternalWrites([path], async () => undefined);
  });
  try {
    await waitFor(
      () => expect(vi.mocked(ipc.readEditorBody).mock.calls.length).toBeGreaterThan(reads),
      budget,
    );
    await act(async () => {
      if (roundTrip) {
        useVaultStore.setState({ vaultPath: '/selected-reconcile-other-vault' });
        useVaultStore.setState({ vaultPath: vault });
      }
      heldRead.resolve(snapshot(stale, version(stale, '2')));
      await heldRead.promise;
      await Promise.resolve();
    });
    if (roundTrip) {
      expect(adopt).not.toHaveBeenCalled();
      expect(owner.snapshot()).toMatchObject({
        latestDraft: before.latestDraft,
        acknowledgedGeneration: before.acknowledgedGeneration,
        reconcileRequired: true,
      });
      expect(useVaultStore.getState().entries[0].authority).toEqual(originalVersion);
      expect(loaded).not.toHaveBeenCalledWith(path, stale);
    } else {
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(owner.snapshot().latestDraft).toBe(stale);
      expect(owner.snapshot().acknowledgedGeneration).toBe(owner.snapshot().generation);
      expect(owner.snapshot().reconcileRequired).toBe(false);
      expect(loaded).toHaveBeenCalledWith(path, stale);
    }
    expect(ipc.saveNoteBody).not.toHaveBeenCalled();
  } finally {
    heldRead.resolve(snapshot(stale, version(stale, '2')));
  }
});

it.each(selectedReadOpenings)(
  'mounted_selected_source_switch_read_$label',
  async ({ roundTrip }) => {
    await mount();
    const owner = currentOwner();
    const before = owner.snapshot();
    const present = vi.spyOn(owner, 'present');
    const stale = '# Selected page\r\n\r\nHeld exact source from the old opening.\r\n';
    const heldRead = deferred<SelectedEditorSnapshot>();
    const reads = vi.mocked(ipc.readEditorBody).mock.calls.length;
    vi.mocked(ipc.readEditorBody).mockImplementationOnce(() => heldRead.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    try {
      await waitFor(
        () => expect(vi.mocked(ipc.readEditorBody).mock.calls.length).toBeGreaterThan(reads),
        budget,
      );
      await act(async () => {
        if (roundTrip) {
          useVaultStore.setState({ vaultPath: '/selected-source-other-vault' });
          useVaultStore.setState({ vaultPath: vault });
        }
        heldRead.resolve(snapshot(stale, version(stale, '2')));
        await heldRead.promise;
        await Promise.resolve();
      });
      if (roundTrip) {
        expect(present).not.toHaveBeenCalled();
        expect(owner.snapshot().latestDraft).toBe(before.latestDraft);
        expect(owner.snapshot().bodyFormat).toBe('rich');
        expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull();
      } else {
        expect(present).toHaveBeenCalledWith(stale, 'source');
        expect(owner.snapshot().latestDraft).toBe(stale);
        expect(
          (screen.getByRole('textbox', { name: 'Page source' }) as HTMLTextAreaElement).value,
        ).toBe(sourceBodyDisplay(stale));
      }
      expect(owner.snapshot().generation).toBe(before.generation);
      expect(owner.snapshot().acknowledgedGeneration).toBe(before.acknowledgedGeneration);
      expect(ipc.saveNoteBody).not.toHaveBeenCalled();
    } finally {
      heldRead.resolve(snapshot(stale, version(stale, '2')));
    }
  },
);

// OFFSOURCE ONLY: append to NoteBodyEditor.selected.test.tsx after the root
// records its immediate preimage. Reuses its existing real mounted helpers and
// per-test IPC spies. No registered source is changed and no run is claimed.
// Do not suppress unhandled rejections: Vitest's default error collection is
// part of this probe. Both cases use the actual synchronous sheet registry.
it.each([
  { label: 'settled_child_control', refuses: false },
  { label: 'refused_child_reports_failure_and_keeps_original_attempt', refuses: true },
])('mounted_selected_terminal_choice_$label', async ({ refuses }) => {
  const { registerSheetDraft } = await import('@/sheet/pendingSheets');
  const requests: EditorSaveRequest[] = [];
  let body = initial;
  vi.mocked(ipc.readEditorBody).mockImplementation(async () => snapshot(body));
  vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ editorRequest }) => {
    if (!editorRequest) throw new Error('missing actual retained selected request');
    requests.push(structuredClone(editorRequest));
    if (requests.length === 1) throw new Error('lost original transport reply');
    body = '# Selected page\n\nOutside B for explicit comparison.\n';
    return { kind: 'selected_outcome_unknown', error };
  });
  const { info } = await mount();
  act(() => append(info, 'Local A must remain recoverable if its child refuses.'));
  fireEvent.click(await screen.findByRole('button', { name: 'Check save' }, budget));
  await screen.findByRole('group', { name: 'Choose a version' }, budget);
  const owner = currentOwner();
  expect(owner.snapshot().selectedSave?.status).toBe('reconcile');
  expect(requests).toHaveLength(2);
  const settlement = vi.spyOn(owner, 'settleSelectedReconcile');
  const exactChild = {
    cell: { row: 0, column: 0 },
    text: '  unresolved child text  ',
    origin: 'cell' as const,
  };
  let child: typeof exactChild | null = exactChild;
  const prepare = vi.fn(() => {
    if (refuses) return false;
    child = null;
    return true;
  });
  let unregister!: () => void;
  act(() => {
    unregister = registerSheetDraft(info.editor, 'selected-choice-child', prepare, () => child);
  });
  const before = owner.snapshot();
  expect(before.childDrafts?.sheets).toContain(exactChild.text);
  const reads = vi.mocked(ipc.readEditorBody).mock.calls.length;
  const calls = vi.mocked(ipc.saveNoteBody).mock.calls.length;
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Use new' }));
    await waitFor(() => expect(prepare).toHaveBeenCalled(), budget);
    if (refuses) {
      // Either the mounted alert or the application's existing toast channel
      // may explain the refusal. A rejected Promise alone is not human feedback.
      await waitFor(() => {
        const visible = screen
          .queryAllByRole('alert')
          .some((node) => /sheet.*(draft|cell)/i.test(node.textContent ?? ''));
        const toasted = useUiStore
          .getState()
          .toasts.some((item) => /sheet.*(draft|cell)/i.test(item.message));
        expect(visible || toasted).toBe(true);
      }, budget);
      expect(owner.snapshot()).toMatchObject({
        latestDraft: before.latestDraft,
        generation: before.generation,
        acknowledgedGeneration: before.acknowledgedGeneration,
        selectedSave: before.selectedSave,
        childDrafts: before.childDrafts,
      });
      expect(settlement).not.toHaveBeenCalled();
      expect(screen.getByRole('group', { name: 'Choose a version' })).toBeTruthy();
      expect(ipc.readEditorBody).toHaveBeenCalledTimes(reads);
    } else {
      await waitFor(() => expect(settlement).toHaveBeenCalledTimes(1), budget);
      expect(owner.snapshot()).toMatchObject({ latestDraft: body });
      expect(owner.snapshot().selectedSave).toBeUndefined();
      expect(owner.snapshot().acknowledgedGeneration).toBe(owner.snapshot().generation);
      expect(owner.snapshot().childDrafts).toEqual({});
    }
    expect(ipc.saveNoteBody).toHaveBeenCalledTimes(calls);
    expect(requests).toHaveLength(2);
    if (refuses) {
      // Resolving this same child must make the offered retry usable and clear
      // its old preparation error after the original local version is saved.
      prepare.mockImplementation(() => {
        child = null;
        return true;
      });
      vi.mocked(ipc.saveNoteBody).mockImplementation(async ({ body: nextBody, editorRequest }) => {
        if (!editorRequest) throw new Error('missing selected retry request');
        const result = applied(editorRequest, nextBody);
        body = nextBody;
        return result;
      });
      fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
      await waitFor(() => expect(settlement).toHaveBeenCalledTimes(1), budget);
      await waitFor(() => {
        expect(owner.snapshot().acknowledgedGeneration).toBe(owner.snapshot().generation);
      }, budget);
      expect(owner.snapshot().latestDraft).toBe(before.latestDraft);
      expect(owner.snapshot().selectedSave).toBeUndefined();
      expect(owner.snapshot().childDrafts).toEqual({});
      expect(ipc.saveNoteBody).toHaveBeenCalledTimes(calls + 1);
      await waitFor(() => {
        expect(
          screen
            .queryAllByRole('alert')
            .some((node) => /unsaved sheet cell/i.test(node.textContent ?? '')),
        ).toBe(false);
      }, budget);
    }
  } finally {
    // Clear only this test registration's local fixture before teardown. The
    // refusal assertions above run while the genuine retained payload exists.
    child = null;
    act(() => unregister());
  }
});

it.each(['body', 'property'] as const)(
  'mounted_selected_source_request_%s_stops_before_the_legacy_reveal_adapter',
  async (kind) => {
    useNavStore.getState().reset();
    useNavStore.getState().navigate({ kind: 'doc', path });
    useUiStore.setState({ detailPath: null });
    // pageTitle is deliberately absent: onReady still creates titleOwner.
    const { info } = await mount({ owner: undefined, pageTitle: undefined });
    const before = info.serialize();
    const locator: SourceOpenRequest['locator'] = {
      version: 1,
      vaultId: target.workspaceId,
      path,
      sourceHash: sha256Hex(initial),
      kind,
      quote: kind === 'body' ? 'Original paragraph.' : '007',
      prefix: '',
      suffix: '',
      ...(kind === 'body'
        ? {
            bodyUtf8Range: {
              start: initial.indexOf('Original'),
              end: initial.indexOf('Original') + 'Original paragraph.'.length,
            },
          }
        : { propertyKey: 'code' }),
    };
    const resolve = vi.spyOn(ipc, 'resolveSource').mockResolvedValue({ status: 'exact', locator });
    const propertyLookup = vi.spyOn(sourceReveal, 'hasSourcePropertyOwner');
    const request: SourceOpenRequest = {
      requestId: crypto.randomUUID(),
      locator,
      origin: sourceVisitOrigin(target.workspaceId),
      intent: 'full_page',
    };
    const navigation = renderHook(useSourceNavigation);
    await act(async () => {
      await navigation.result.current.openSource(request);
    });
    await waitFor(
      () => expect(sourceRequestFor(path, useNavStore.getState().active)?.status).toBeDefined(),
      budget,
    );
    expect(sourceRequestFor(path, useNavStore.getState().active)?.status).toBe('unsupported');
    // One resolution belongs to openSource's existing navigation admission.
    // The selected editor itself must stop before a second legacy resolution.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(propertyLookup).not.toHaveBeenCalled();
    expect(ipc.readNoteSource).not.toHaveBeenCalled();
    expect(ipc.saveNoteBody).not.toHaveBeenCalled();
    expect(info.serialize()).toBe(before);
  },
);
