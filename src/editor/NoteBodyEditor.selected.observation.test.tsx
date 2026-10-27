// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import type {
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
import { __resetOpenPages, retainedDocumentOwner } from './openPages';

const vault = '/selected-observation-toy';
const path = 'page.md';
const target = {
  workspaceId: 'a4d2071d-7e51-4e64-b1d7-91bf26c96862',
  recordId: '0e8e14bb-b135-4a41-b870-92db753e3182',
};
const key = { vaultId: vault, path, ownerId: 'peek' };
const initial = '# Page\n\nBefore.\n';
const draft = '# Page\n\nOriginal applied A.\n';
const budget = { timeout: 5000 };
const version = (body: string, metadataRevision: string): SelectedRecordVersion => ({
  kind: 'sqlite_metadata',
  ...target,
  metadataRevision,
  metadataHash: 'a'.repeat(64),
  bodyHash: sha256Hex(body),
});
function observed(body: string, metadataRevision: string): SelectedEditorSnapshot {
  return {
    path,
    target,
    body,
    observedBodyHash: sha256Hex(body),
    version: version(body, metadataRevision),
    coherence: 'paired',
    editable: true,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeAll(async () => {
  await import('./MarkdownEditor');
});
beforeEach(() => {
  __resetOpenPages();
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    status: 'ready',
    error: null,
    entries: [makeEntry({ path, hash: sha256Hex(initial), authority: version(initial, '1') })],
    views: [],
    folders: [],
    rescan: async () => undefined,
  });
  useUiStore.setState({ toasts: [] });
  vi.spyOn(ipc, 'readNote').mockResolvedValue(initial);
  vi.spyOn(ipc, 'readNoteSource').mockResolvedValue({ content: initial, hash: sha256Hex(initial) });
  vi.spyOn(ipc, 'readEditorBody').mockResolvedValue(observed(initial, '1'));
  vi.spyOn(ipc, 'calculateSheets').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
});

// Descriptive native replies exercise the actual mounted owner and observer.
// Native paired-service/exit86 tests own durability; this probe never supplies authority.
it.each([
  { label: 'same_opening_control', roundTrip: false },
  { label: 'vault_round_trip_keeps_applied_ack_but_refuses_old_observation', roundTrip: true },
])('mounted_selected_own_save_observation_$label', async ({ roundTrip }) => {
  const requests: EditorSaveRequest[] = [];
  const save = vi.spyOn(ipc, 'saveNoteBody').mockImplementation(async ({ body, editorRequest }) => {
    if (!editorRequest) throw new Error('missing actual retained selected request');
    requests.push(structuredClone(editorRequest));
    const current = version(body, '2');
    return {
      kind: 'selected_applied',
      currentVersion: current,
      reconcileRequired: false,
      recovery: null,
      operation: {
        path,
        target,
        requestKey: editorRequest.requestKey,
        operationId: 'c354b0d2-ea9f-40f0-8f48-33f739e64f17',
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
          bodyAfterHash: current.bodyHash,
          actor: 'human',
          operation: 'page.body',
          at: '2026-10-24T00:00:00Z',
        },
      },
    };
  });
  const loaded = vi.fn();
  const ready = vi.fn();
  render(
    <NoteBodyEditor
      path={path}
      owner="peek"
      selectedTarget={target}
      debounceMs={20}
      pageTitle="Page"
      onBodyLoaded={loaded}
      onReady={ready}
    />,
  );
  await waitFor(() => expect(ready).toHaveBeenCalled(), budget);
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  const source = await screen.findByRole('textbox', { name: 'Page source' }, budget);
  const owner = retainedDocumentOwner(key);
  if (!owner) throw new Error('real mounted owner missing');
  loaded.mockClear();
  const heldRead = deferred<SelectedEditorSnapshot>();
  const reads = vi.mocked(ipc.readEditorBody).mock.calls.length;
  vi.mocked(ipc.readEditorBody).mockImplementationOnce(() => heldRead.promise);
  fireEvent.change(source, { target: { value: draft } });
  try {
    await waitFor(
      () => expect(vi.mocked(ipc.readEditorBody).mock.calls.length).toBeGreaterThan(reads),
      budget,
    );
    await waitFor(() => expect(owner.snapshot().acknowledgedGeneration).toBe(1), budget);
    expect(save).toHaveBeenCalledTimes(1);
    expect(requests[0].phase).toBe('start');
    expect(loaded).not.toHaveBeenCalled();
    await act(async () => {
      if (roundTrip) {
        useVaultStore.setState({ vaultPath: '/selected-observation-other-vault' });
        useVaultStore.setState({ vaultPath: vault });
      }
      heldRead.resolve(observed(draft, '2'));
      await heldRead.promise;
      await Promise.resolve();
    });
    // Losing presentation ownership cannot erase a known native Applied ack,
    // convert it into Pending, or repeat the original body operation.
    expect(owner.snapshot()).toMatchObject({
      latestDraft: draft,
      generation: 1,
      acknowledgedGeneration: 1,
      mergeBase: { raw: draft, canon: draft },
    });
    expect(owner.snapshot().selectedSave).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(useVaultStore.getState().entries[0].authority).toEqual(version(draft, '2'));
    if (roundTrip) expect(loaded).not.toHaveBeenCalled();
    else expect(loaded).toHaveBeenCalledWith(path, draft);
  } finally {
    heldRead.resolve(observed(draft, '2'));
  }
});

it.each([
  { label: 'same_opening_drains_newer_draft_control', roundTrip: false },
  { label: 'vault_round_trip_keeps_original_ack_and_holds_newer_draft', roundTrip: true },
])('mounted_selected_native_save_await_$label', async ({ roundTrip }) => {
  const newer = '# Page\n\nNewer N must await reopened reconciliation.\n';
  const calls: { request: EditorSaveRequest; body: string }[] = [];
  const firstReply = deferred<EditorSaveResult>();
  const freshRead = deferred<SelectedEditorSnapshot>();
  const reply = (
    request: EditorSaveRequest,
    body: string,
    revision: '2' | '3',
  ): EditorSaveResult => {
    const current = version(body, revision);
    return {
      kind: 'selected_applied',
      currentVersion: current,
      reconcileRequired: false,
      recovery: null,
      operation: {
        path,
        target,
        requestKey: request.requestKey,
        operationId:
          revision === '2'
            ? '82d3238b-0386-49e7-8ea5-d22713b7289a'
            : 'a420b6e7-7088-456f-819d-37e58ff27a70',
        version: current,
        receipt: {
          workspaceId: target.workspaceId,
          recordId: target.recordId,
          epoch: revision,
          previousRevision: revision === '2' ? '1' : '2',
          revision,
          metadataBeforeHash: current.metadataHash,
          metadataAfterHash: current.metadataHash,
          bodyBeforeHash: sha256Hex(revision === '2' ? initial : draft),
          bodyAfterHash: current.bodyHash,
          actor: 'human',
          operation: 'page.body',
          at: '2026-10-24T00:00:00Z',
        },
      },
    };
  };
  const save = vi.spyOn(ipc, 'saveNoteBody').mockImplementation(async ({ body, editorRequest }) => {
    if (!editorRequest) throw new Error('missing actual selected request');
    calls.push({ request: structuredClone(editorRequest), body });
    return calls.length === 1 ? firstReply.promise : reply(editorRequest, body, '3');
  });
  const ready = vi.fn();
  const loaded = vi.fn();
  render(
    <NoteBodyEditor
      path={path}
      owner="peek"
      selectedTarget={target}
      debounceMs={20}
      pageTitle="Page"
      onBodyLoaded={loaded}
      onReady={ready}
    />,
  );
  await waitFor(() => expect(ready).toHaveBeenCalled(), budget);
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  const source = await screen.findByRole('textbox', { name: 'Page source' }, budget);
  const owner = retainedDocumentOwner(key);
  if (!owner) throw new Error('actual mounted owner missing');
  loaded.mockClear();
  const originalVersion = useVaultStore.getState().entries[0].authority;
  // Every post-ack observer/reconcile read is held. A new write cannot be
  // justified by an unseen fresh snapshot in the negative case.
  vi.mocked(ipc.readEditorBody).mockImplementation(() => freshRead.promise);
  fireEvent.change(source, { target: { value: draft } });
  try {
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), budget);
    expect(owner.snapshot()).toMatchObject({
      generation: 1,
      acknowledgedGeneration: 0,
      inFlightGeneration: 1,
    });
    fireEvent.change(source, { target: { value: newer } });
    await act(async () => {
      if (roundTrip) {
        useVaultStore.setState({ vaultPath: '/selected-save-await-other-vault' });
        useVaultStore.setState({ vaultPath: vault });
      }
      firstReply.resolve(reply(calls[0].request, draft, '2'));
      await firstReply.promise;
      await Promise.resolve();
    });
    await waitFor(
      () => expect(owner.snapshot().acknowledgedGeneration).toBeGreaterThanOrEqual(1),
      budget,
    );
    expect(owner.snapshot().latestDraft).toBe(newer);
    expect(owner.snapshot().selectedSave).toBeUndefined();
    expect(loaded).not.toHaveBeenCalled();
    if (roundTrip) {
      expect(save).toHaveBeenCalledTimes(1);
      expect(owner.snapshot()).toMatchObject({
        generation: 2,
        acknowledgedGeneration: 1,
        reconcileRequired: true,
        mergeBase: { raw: draft, canon: draft },
      });
      expect(useVaultStore.getState().entries[0].authority).toEqual(originalVersion);
    } else {
      await waitFor(() => expect(owner.snapshot().acknowledgedGeneration).toBe(2), budget);
      expect(save).toHaveBeenCalledTimes(2);
      expect(calls.map((call) => call.body)).toEqual([draft, newer]);
      expect(calls[1].request.requestKey).not.toBe(calls[0].request.requestKey);
      expect(useVaultStore.getState().entries[0].authority).toEqual(version(newer, '3'));
    }
  } finally {
    await act(async () => {
      if (calls[0]) firstReply.resolve(reply(calls[0].request, draft, '2'));
      freshRead.resolve(observed('# Page\n\nCurrent reopened outside body.\n', '4'));
      await owner.settleWrite();
    });
  }
});
