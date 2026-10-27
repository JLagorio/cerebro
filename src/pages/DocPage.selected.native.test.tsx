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
import { sourceBodyDisplay } from '@/editor/sourceBodyEdits';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const vault = '/selected-page-native-toy';
const path = 'page.md';
const target = {
  workspaceId: 'a7aca232-dd01-4e1c-8053-abf09969e683',
  recordId: '137c9113-df0c-4af2-aab2-9432a482cb21',
};
const original =
  '\uFEFF\r\n\r\n---\r\ntype: Agent\r\ntitle: Body text only\r\ntools: [write_note]\r\n---\r\n# Native page\r\n\r\nExact body 😀.\r\n';
const budget = { timeout: 5000 };
const realRescan = useVaultStore.getState().rescan;
const unavailable: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'unsupported_operation',
  message: 'This canonical page type belongs to its own writer.',
  retryable: false,
};
let body: string;
let current: SelectedRecordVersion;
let editable: boolean;
let readFailure: AuthorityError | null;
let fullWidth: boolean;
let saveGate: ReturnType<typeof deferred<EditorSaveResult>> | null;
let lastSave: { body: string; editorRequest: EditorSaveRequest } | null;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function entry() {
  return makeEntry({
    path,
    title: 'Native page',
    type: null,
    properties: { grant: 'read_only', code: '007', ...(fullWidth ? { full_width: true } : {}) },
    hash: current.bodyHash,
    authority: { ...current },
  });
}
function snapshot(): SelectedEditorSnapshot {
  return {
    path,
    target,
    body,
    version: { ...current },
    observedBodyHash: sha256Hex(body),
    coherence: 'paired',
    editable,
    readOnlyReason: editable ? null : unavailable.message,
  };
}
/** Descriptive native wire fixture, not a receipt producer or a durability proof. */
function operation(input: { body: string; editorRequest: EditorSaveRequest }): EditorOperation {
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
      bodyBeforeHash: current.bodyHash,
      bodyAfterHash: version.bodyHash,
      actor: 'human',
      operation: 'page.body',
      at: '2026-10-24T00:00:00Z',
    },
  };
}
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function owner() {
  const found = retainedDocumentOwner({
    vaultId: vault,
    path,
    ownerId: useNavStore.getState().active,
  });
  if (!found) throw new Error('actual selected page owner missing');
  return found;
}
async function mountNative() {
  render(<DocPage selection={{ kind: 'doc', path }} />);
  // The old pre reader is a prompt, observable closed boundary, not a timeout RED.
  await waitFor(
    () =>
      expect(
        calls('read_editor_body').length > 0 || screen.queryByTestId('selected-body') !== null,
      ).toBe(true),
    budget,
  );
  expect(calls('read_editor_body')).toHaveLength(1);
  expect(calls('read_editor_body')[0][1]).toEqual({ vault, path, target });
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
beforeAll(async () => {
  await import('@/editor/MarkdownEditor');
});
beforeEach(() => {
  __resetOpenPages();
  __resetRescans();
  ipc.__resetPageWrites();
  useNavStore.getState().reset();
  useNavStore.getState().navigate({ kind: 'doc', path });
  body = original;
  current = {
    kind: 'sqlite_metadata',
    ...target,
    metadataRevision: '1',
    metadataHash: 'a'.repeat(64),
    bodyHash: sha256Hex(body),
  };
  editable = true;
  readFailure = null;
  fullWidth = false;
  saveGate = null;
  lastSave = null;
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    entries: [entry()],
    status: 'ready',
    error: null,
    views: [],
    collections: [],
    folders: [],
    rescan: realRescan,
  });
  useUiStore.setState({ toasts: [], detailPath: null, docPanelOpen: false });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case 'read_editor_body':
        if (readFailure) throw readFailure;
        return snapshot();
      case 'read_note':
        return body; // Old host can reach its observable RED boundary.
      case 'scan_vault':
        return [entry()];
      case 'list_views':
      case 'list_collections':
      case 'list_folders':
      case 'calculate_sheets':
        return [];
      case 'save_note': {
        expect(args.editorRequest).toBeDefined();
        expect('expectHash' in args).toBe(false);
        lastSave = args as unknown as { body: string; editorRequest: EditorSaveRequest };
        if (!saveGate) throw new Error('unexpected page save without a held test gate');
        const result = await saveGate.promise;
        if (result.kind === 'selected_applied') {
          body = lastSave.body;
          current = result.currentVersion;
        }
        return result;
      }
      case 'set_page_full_width':
        expect(args.expected).toEqual(current);
        fullWidth = args.mode === 'wide';
        current = {
          ...current,
          metadataRevision: (BigInt(current.metadataRevision) + 1n).toString(),
          metadataHash: 'b'.repeat(64),
        };
        return { kind: 'applied', fullWidth, version: current };
      default:
        throw new Error(`unexpected selected page native command: ${command}`);
    }
  });
});
afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  __resetOpenPages();
  __resetRescans();
  ipc.__resetPageWrites();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

it('native_page_dispatch_uses_exact_source_and_retains_the_editor_on_same_id_metadata_refresh', async () => {
  await mountNative();
  const textarea = await source();
  const retained = owner();
  expect(textarea.value).toBe(sourceBodyDisplay(original));
  expect(retained.snapshot().mergeBase?.raw).toBe(original);
  expect(retained.snapshot().latestDraft).toBe(original);
  expect(screen.queryByRole('button', { name: /Use.*title|Adopt.*title/i })).toBeNull();
  current = { ...current, metadataRevision: '2', metadataHash: 'c'.repeat(64) };
  await act(async () => {
    useVaultStore.setState({ entries: [entry()] });
  });
  expect(screen.getByRole('textbox', { name: 'Page source' })).toBe(textarea);
  expect(owner()).toBe(retained);
  expect(useVaultStore.getState().entries[0].properties.grant).toBe('read_only');
  expect(calls('save_note')).toHaveLength(0);
  expect(calls('read_note')).toHaveLength(0);
  expect(calls('read_note_source')).toHaveLength(0);
  expect(calls('update_frontmatter')).toHaveLength(0);
});

it('native_page_empty_body_is_readable_without_a_write_or_unavailable_state', async () => {
  body = '';
  current = { ...current, bodyHash: sha256Hex(body) };
  useVaultStore.setState({ entries: [entry()] });
  await mountNative();
  expect((await source()).value).toBe('');
  expect(owner().snapshot().mergeBase?.raw).toBe('');
  expect(document.querySelector('.section-unavailable')).toBeNull();
  expect(calls('save_note')).toHaveLength(0);
});

it('native_page_unsupported_writer_is_visible_and_cannot_be_unlocked_by_source_typing', async () => {
  editable = false;
  await mountNative();
  const textarea = await source();
  expect(textarea.readOnly).toBe(true);
  fireEvent.change(textarea, { target: { value: 'attempted write' } });
  expect(owner().snapshot().generation).toBe(0);
  expect(calls('save_note')).toHaveLength(0);
  expect(screen.getByText(unavailable.message)).toBeTruthy();
});

it('native_page_snapshot_refusal_is_unavailable_without_a_blank_editable_fallback', async () => {
  readFailure = {
    ...unavailable,
    kind: 'metadata_unavailable',
    message: 'Canonical metadata unavailable.',
  };
  await mountNative();
  const alert = await screen.findByRole('alert', {}, budget);
  expect(alert.classList.contains('section-unavailable')).toBe(true);
  expect(screen.queryByRole('textbox', { name: 'Page source' })).toBeNull();
  expect(screen.queryByTestId('selected-body')).toBeNull();
  expect(calls('read_note')).toHaveLength(0);
  expect(calls('save_note')).toHaveLength(0);
});

it.each(['applied', 'pending'] as const)(
  'native_page_full_width_settles_the_actual_body_owner_before_metadata_%s',
  async (outcome) => {
    await mountNative();
    const textarea = await source();
    const retained = owner();
    const edited = original.replace('Exact body', 'Human body');
    saveGate = deferred<EditorSaveResult>();
    fireEvent.change(textarea, { target: { value: sourceBodyDisplay(edited) } });
    fireEvent.click(screen.getByRole('button', { name: 'Page options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full width' }));
    await waitFor(() => expect(calls('save_note')).toHaveLength(1), budget);
    expect(calls('set_page_full_width')).toHaveLength(0);
    const input = lastSave;
    if (!input) throw new Error('actual native save input missing');
    const originalOperation = operation(input);
    expect(input.body).toBe(edited);
    expect(input.editorRequest).toMatchObject({ target, phase: 'start', original: null });
    await act(async () => {
      saveGate!.resolve(
        outcome === 'applied'
          ? {
              kind: 'selected_applied',
              operation: originalOperation,
              currentVersion: originalOperation.version,
              reconcileRequired: false,
              recovery: null,
            }
          : { kind: 'selected_pending', operation: originalOperation, error: unavailable },
      );
    });
    if (outcome === 'applied') {
      await waitFor(() => expect(calls('set_page_full_width')).toHaveLength(1), budget);
      expect(calls('set_page_full_width')[0][1]).toMatchObject({
        vault,
        path,
        expected: originalOperation.version,
        mode: 'wide',
      });
      expect(owner()).toBe(retained);
      expect(retained.snapshot().latestDraft).toBe(edited);
      expect(useVaultStore.getState().entries[0].properties.full_width).toBe(true);
    } else {
      await waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0), budget);
      expect(calls('set_page_full_width')).toHaveLength(0);
      expect(retained.snapshot()).toMatchObject({
        latestDraft: edited,
        acknowledgedGeneration: 0,
        selectedSave: { status: 'pending', requestKey: input.editorRequest.requestKey },
      });
    }
    if (outcome === 'pending') {
      const trace = calls('save_note').map(([, args]) => {
        const call = args as {
          vault: string;
          path: string;
          body: string;
          bodyFormat: string;
          editorRequest: EditorSaveRequest;
        };
        return {
          vault: call.vault,
          path: call.path,
          body: call.body,
          bodyFormat: call.bodyFormat,
          editorRequest: structuredClone(call.editorRequest),
        };
      });
      expect(trace).toEqual([
        {
          vault,
          path,
          body: edited,
          bodyFormat: 'source',
          editorRequest: input.editorRequest,
        },
        {
          vault,
          path,
          body: edited,
          bodyFormat: 'source',
          editorRequest: {
            ...input.editorRequest,
            phase: 'resolve',
            original: originalOperation,
          },
        },
      ]);
      expect(new Set(trace.map((call) => call.editorRequest.requestKey))).toEqual(
        new Set([input.editorRequest.requestKey]),
      );
      // Resolving Pending reuses the original operation; it is not a new write.
      expect(calls('save_note')).toHaveLength(2);
    } else {
      expect(calls('save_note')).toHaveLength(1);
    }
    expect(calls('update_frontmatter')).toHaveLength(0);
  },
);

it('native_page_stale_entry_snapshot_waits_for_matching_ready_vault_before_read_or_owner', async () => {
  const legacyRead = vi.spyOn(ipc, 'readNote');
  const selectedRead = vi.spyOn(ipc, 'readEditorBody');
  useVaultStore.setState({ entriesVault: '/previous-selected-vault', status: 'scanning' });
  await act(async () => {
    render(<DocPage selection={{ kind: 'doc', path }} />);
  });
  expect(legacyRead).not.toHaveBeenCalled();
  expect(selectedRead).not.toHaveBeenCalled();
  expect(
    retainedDocumentOwner({ vaultId: vault, path, ownerId: useNavStore.getState().active }),
  ).toBeUndefined();
  await act(async () => {
    useVaultStore.setState({ entriesVault: vault, status: 'ready' });
  });
  await waitFor(() => expect(calls('read_editor_body')).toHaveLength(1), budget);
  await source();
  expect(owner().selectedTarget).toEqual(target);
});

it('browser_selected_editor_transport_remains_explicitly_unsupported', async () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  await expect(ipc.readEditorBody(vault, path, target)).rejects.toMatchObject({
    code: 'capability_unavailable',
    kind: 'unsupported_operation',
    retryable: false,
  });
  await expect(
    ipc.saveNoteBody({
      vault,
      path,
      body: original,
      bodyFormat: 'source',
      editorRequest: {
        target,
        requestKey: 'f758f15c-82bc-490f-b5d3-3d621b415448',
        phase: 'start',
        original: null,
      },
    }),
  ).rejects.toMatchObject({
    kind: 'selected_refused',
    error: { kind: 'unsupported_operation', retryable: false },
  });
  expect(invoke).not.toHaveBeenCalled();
});
