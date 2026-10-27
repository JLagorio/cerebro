// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetPageWrites, readEditorBody, saveNoteBody, settlePageWrites } from './ipc';
import { DocumentOwner } from '@/editor/documentOwner';
import type {
  AuthorityError,
  EditorSaveRequest,
  EditorSaveResult,
  SelectedEditorSnapshot,
} from './generated/workspace';
import { sha256Hex } from './sha256';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const target = {
  workspaceId: 'af29a10c-7208-419f-a350-61c45b82f89a',
  recordId: 'a796942a-9368-47a8-bf4c-143e9eb360b3',
};
const request: EditorSaveRequest = {
  target,
  requestKey: '460b3a2b-172e-4b6c-a492-342f8c36d25a',
  phase: 'start',
  original: null,
};
const body = '\uFEFF---\r\ntype: Agent\r\n---\r\n\r\n# Exact whole selected file\r\n';
const input = {
  vault: '/selected-ipc-toy',
  path: 'page.md',
  body,
  bodyFormat: 'source' as const,
  editorRequest: request,
};
const version = {
  kind: 'sqlite_metadata' as const,
  ...target,
  metadataRevision: '9007199254740993',
  metadataHash: 'a'.repeat(64),
  bodyHash: sha256Hex(body),
};
const error: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'unsupported_operation',
  message: 'Ordinary page editing is unavailable.',
  retryable: false,
};
beforeEach(() => {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
  invoke.mockReset();
  __resetPageWrites();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  __resetPageWrites();
});

it('selected_save_note_preserves_the_existing_flat_wire_with_exact_optional_request', async () => {
  const ack: EditorSaveResult = { kind: 'selected_unchanged', version };
  invoke.mockResolvedValueOnce(ack);
  const actual = await saveNoteBody(input);
  expect(actual).toEqual(ack);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith('save_note', {
    vault: input.vault,
    path: input.path,
    body,
    bodyFormat: 'source',
    recoveryBypass: undefined,
    editorRequest: request,
  });
  expect('expectHash' in invoke.mock.calls[0][1]).toBe(false);
});

it('selected_snapshot_keeps_exact_bom_crlf_and_yaml_looking_body_without_legacy_read', async () => {
  const snapshot: SelectedEditorSnapshot = {
    target,
    path: input.path,
    version: { ...version, bodyHash: sha256Hex('canonical before') },
    body,
    observedBodyHash: sha256Hex(body),
    coherence: 'external_change',
    editable: true,
    readOnlyReason: null,
  };
  invoke.mockResolvedValueOnce(snapshot);
  expect(await readEditorBody(input.vault, input.path, target)).toEqual(snapshot);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith('read_editor_body', {
    vault: input.vault,
    path: input.path,
    target,
  });
});

it('selected_refusal_is_an_error_with_its_structured_discriminant_while_transport_remains_unknown', async () => {
  const refused = { kind: 'selected_refused', error };
  invoke.mockRejectedValueOnce(refused);
  const caught: unknown = await saveNoteBody(input).catch((value: unknown) => value);
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ kind: 'selected_refused', error, message: error.message });
  const lost = new Error('transport reply lost');
  invoke.mockRejectedValueOnce(lost);
  await expect(saveNoteBody(input)).rejects.toBe(lost);
});

it('selected_preintent_retention_nonce_and_legacy_save_errors_keep_their_original_strings', async () => {
  invoke.mockRejectedValueOnce('recovery_required:exact-nonce');
  await expect(saveNoteBody(input)).rejects.toBe('recovery_required:exact-nonce');
  invoke.mockRejectedValueOnce('legacy unchanged refusal');
  await expect(saveNoteBody({ vault: '/legacy', path: 'page.md', body: 'legacy' })).rejects.toBe(
    'legacy unchanged refusal',
  );
});

it('selected_pending_transport_settlement_does_not_acknowledge_the_actual_retained_owner', async () => {
  invoke.mockImplementation(
    async (_command: string, args: { body: string; editorRequest?: EditorSaveRequest }) => {
      expect(args.editorRequest).toBeDefined();
      if (!args.editorRequest) throw new Error('selected request was dropped');
      const selected = args.editorRequest;
      return {
        kind: 'selected_pending',
        error,
        operation: {
          target: selected.target,
          path: input.path,
          requestKey: selected.requestKey,
          operationId: 'f392408b-f1f5-477b-9cb3-3049725ec31a',
          version,
          receipt: {
            workspaceId: target.workspaceId,
            recordId: target.recordId,
            epoch: '9007199254740994',
            previousRevision: '9007199254740992',
            revision: '9007199254740993',
            bodyBeforeHash: sha256Hex('before'),
            bodyAfterHash: sha256Hex(args.body),
            metadataBeforeHash: version.metadataHash,
            metadataAfterHash: version.metadataHash,
            actor: 'human',
            operation: 'page.body',
            at: '2026-10-24T00:00:00Z',
          },
        },
      } satisfies EditorSaveResult;
    },
  );
  const owner = new DocumentOwner(
    { vaultId: input.vault, path: input.path, ownerId: 'pane' },
    'before',
    (draft, format, recoveryBypass, _expected, destination, editorRequest) =>
      saveNoteBody({
        vault: destination?.vaultId ?? input.vault,
        path: destination?.path ?? input.path,
        body: draft,
        bodyFormat: format,
        recoveryBypass,
        ...{ editorRequest },
      }),
    target,
  );
  owner.edit(body, 'source');
  expect(await owner.flush()).toMatchObject({ kind: 'pending', status: 'pending' });
  expect(await settlePageWrites(100)).toBe(true);
  expect(owner.snapshot()).toMatchObject({
    latestDraft: body,
    acknowledgedGeneration: 0,
    selectedSave: { status: 'pending' },
  });
  expect(owner.retireRecovery()).toBe(false);
});
