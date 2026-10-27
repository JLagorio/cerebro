// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import type {
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
import { __resetOpenPages, unresolvedDocumentOwners, flushOpenPages } from '@/editor/openPages';
import { MyWorkLane } from './MyWorkLane';
const path = 'notes/plan.md';
const initial = '# Plan\n\n- [ ] Call vendor\n';
const changed = initial + '\nNew externally saved paragraph.\n';
const target = {
  workspaceId: '915781f1-6812-478c-8063-3f41322547f5',
  recordId: '76b64da5-34b6-45f2-8ab2-e2779227ace3',
};
let serial = 0;
let vault = '';
let body = initial;
let revision = '1';
const version = (): SelectedRecordVersion => ({
  kind: 'sqlite_metadata',
  ...target,
  metadataRevision: revision,
  metadataHash: 'a'.repeat(64),
  bodyHash: sha256Hex(body),
});
const snapshot = (): SelectedEditorSnapshot => ({
  path,
  target: { ...target },
  body,
  version: version(),
  observedBodyHash: sha256Hex(body),
  coherence: 'paired',
  editable: true,
});
function operation(request: EditorSaveRequest, text: string): EditorOperation {
  const after = {
    ...version(),
    metadataRevision: (BigInt(revision) + 1n).toString(),
    bodyHash: sha256Hex(text),
  };
  return {
    path,
    target: { ...request.target },
    requestKey: request.requestKey,
    operationId: '351a1b0f-7b33-48c4-b96c-8dc6a702897e',
    version: after,
    receipt: {
      workspaceId: target.workspaceId,
      recordId: target.recordId,
      epoch: after.metadataRevision,
      previousRevision: revision,
      revision: after.metadataRevision,
      metadataBeforeHash: after.metadataHash,
      metadataAfterHash: after.metadataHash,
      bodyBeforeHash: version().bodyHash,
      bodyAfterHash: after.bodyHash,
      actor: 'human:me',
      operation: 'page.body',
      at: '2026-10-26T00:00:00Z',
    },
  };
}
function applied(request: EditorSaveRequest, text: string): EditorSaveResult {
  const original = request.original ?? operation(request, text);
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
const lane = () => (
  <MyWorkLane now={new Date('2026-10-26T12:00:00Z')} ctx={{ today: '2026-10-26', weekStart: 0 }} />
);
beforeEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
  vault = '/selected-task-journey-' + ++serial;
  body = initial;
  revision = '1';
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    status: 'ready',
    error: null,
    entries: [makeEntry({ path, title: 'Plan', hash: sha256Hex(body), authority: version() })],
    views: [],
    folders: [],
    rescan: vi.fn(async () => {}),
  });
  useUiStore.setState({ homeTaskAssignee: '', toast: vi.fn() });
  vi.spyOn(ipc, 'supportsSelectedEditor').mockReturnValue(true);
  vi.spyOn(ipc, 'readEditorBody').mockImplementation(async () => snapshot());
  vi.spyOn(ipc, 'readNoteSource').mockResolvedValue({ content: initial, hash: sha256Hex(initial) });
  vi.spyOn(ipc, 'saveNote').mockImplementation(async (_vault, _path, text) => sha256Hex(text));
  // Descriptive injected native replies only. This exercises the actual Home
  // hook/retained owner/choice host, not filesystem durability or browser success.
  vi.spyOn(ipc, 'saveNoteBody').mockImplementation(async ({ body: text, editorRequest }) => {
    if (!editorRequest) throw new Error('missing selected request');
    const reply = applied(editorRequest, text);
    if (reply.kind === 'selected_applied') {
      body = text;
      revision = reply.currentVersion.metadataRevision;
    }
    return reply;
  });
  vi.mocked(ipc.saveNoteBody).mockImplementationOnce(async () => {
    body = changed;
    revision = '2';
    return {
      kind: 'selected_outcome_unknown',
      error: {
        code: 'capability_unavailable',
        kind: 'source_changed',
        message: 'Original outcome is unknown.',
        retryable: false,
      },
    };
  });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
});
async function terminal() {
  const view = render(lane());
  const checkbox = await screen.findByRole('checkbox', { name: 'Mark "Call vendor" done' });
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(
      vi.mocked(ipc.saveNoteBody).mock.calls.length + vi.mocked(ipc.saveNote).mock.calls.length,
    ).toBeGreaterThan(0),
  );
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
  expect(ipc.saveNote).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      unresolvedDocumentOwners().some(
        (owner) => owner.snapshot().selectedSave?.status === 'reconcile',
      ),
    ).toBe(true),
  );
  const owner = unresolvedDocumentOwners().find(
    (owner) => owner.selectedTarget?.recordId === target.recordId,
  )!;
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole('group', { name: 'Choose a version' })).not.toBeNull();
  return { view, owner };
}
it('outside-editor task outcome-unknown can Use new without another native write', async () => {
  const { owner } = await terminal();
  const group = screen.getByRole('group', { name: 'Choose a version' });
  expect(within(group).getByText('New externally saved paragraph.', { exact: false })).toBeTruthy();
  fireEvent.click(within(group).getByRole('button', { name: 'Use new' }));
  await waitFor(() => expect(owner.snapshot().selectedSave).toBeUndefined());
  await act(async () => {
    await flushOpenPages();
  });
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
  expect(unresolvedDocumentOwners()).toEqual([]);
});
it('outside-editor Keep yours creates a new attempt only after fresh paired version choice', async () => {
  const { owner } = await terminal();
  const first = vi.mocked(ipc.saveNoteBody).mock.calls[0][0];
  const chosen = version();
  fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
  await waitFor(() => expect(ipc.saveNoteBody).toHaveBeenCalledTimes(2));
  const next = vi.mocked(ipc.saveNoteBody).mock.calls[1][0];
  expect(next.body).toBe(initial.replace('[ ]', '[x]'));
  expect(next.vault).toBe(vault);
  expect(next.path).toBe(path);
  expect(next.editorRequest).toMatchObject({ target, phase: 'start', expectedVersion: chosen });
  expect(next.editorRequest?.requestKey).not.toBe(first.editorRequest?.requestKey);
  await waitFor(() => expect(owner.snapshot().selectedSave).toBeUndefined());
  expect(owner.snapshot().generation).toBe(owner.snapshot().acknowledgedGeneration);
});
it('terminal task owner and whole-page choice survive Home unmount and remount', async () => {
  const { view, owner } = await terminal();
  const requestKey = owner.snapshot().selectedSave?.requestKey;
  view.unmount();
  render(lane());
  await screen.findByRole('checkbox', { name: 'Mark "Call vendor" done' });
  await act(async () => {
    await Promise.resolve();
  });
  expect(unresolvedDocumentOwners()).toContain(owner);
  expect(owner.snapshot().selectedSave?.requestKey).toBe(requestKey);
  expect(screen.queryByRole('group', { name: 'Choose a version' })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Use new' }));
  await waitFor(() => expect(owner.snapshot().selectedSave).toBeUndefined());
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
  expect(unresolvedDocumentOwners()).toEqual([]);
});
it('changed selected observation refreshes the task choice before a second explicit Keep yours', async () => {
  const { owner } = await terminal();
  body = changed + '\nChanged again before choosing.\n';
  revision = '3';
  const chosen = version();
  fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
  expect(owner.snapshot().selectedSave?.status).toBe('reconcile');
  expect(
    within(screen.getByRole('group', { name: 'Choose a version' })).getByText(
      'Changed again before choosing.',
      { exact: false },
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
  await waitFor(() => expect(ipc.saveNoteBody).toHaveBeenCalledTimes(2));
  expect(vi.mocked(ipc.saveNoteBody).mock.calls[1][0].editorRequest).toMatchObject({
    phase: 'start',
    expectedVersion: chosen,
  });
});
it('a stale vault-roundtrip choice read cannot settle or rebase the original task attempt', async () => {
  const { owner } = await terminal();
  const requestKey = owner.snapshot().selectedSave?.requestKey;
  const delayed = deferred<SelectedEditorSnapshot>();
  const calls = vi.mocked(ipc.readEditorBody).mock.calls.length;
  vi.mocked(ipc.readEditorBody).mockImplementationOnce(() => delayed.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Keep yours' }));
  await waitFor(() => expect(ipc.readEditorBody).toHaveBeenCalledTimes(calls + 1));
  act(() => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: vault });
  });
  await act(async () => delayed.resolve(snapshot()));
  expect(ipc.saveNoteBody).toHaveBeenCalledOnce();
  expect(owner.snapshot().selectedSave).toMatchObject({ status: 'reconcile', requestKey });
});
