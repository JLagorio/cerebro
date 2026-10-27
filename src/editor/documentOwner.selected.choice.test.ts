import { expect, it } from 'vitest';
import { DocumentOwner, type DocumentWriter } from './documentOwner';
import type { EditorSaveRequest, SelectedEditorSnapshot } from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';

const key = { vaultId: '/selected-choice-toy', path: 'page.md', ownerId: 'pane' };
const target = {
  workspaceId: '8c936c56-b678-414c-b8a3-e02a2ed24221',
  recordId: '4528cc87-eb16-4dd3-be48-614428b05e57',
};
const error = {
  code: 'capability_unavailable' as const,
  kind: 'source_changed' as const,
  message: 'The original save cannot be confirmed.',
  retryable: false,
};
const snapshot = (body = 'current outside'): SelectedEditorSnapshot => ({
  target,
  path: key.path,
  body,
  observedBodyHash: sha256Hex(body),
  editable: true,
  coherence: 'paired',
  version: {
    kind: 'sqlite_metadata',
    ...target,
    metadataRevision: '3',
    metadataHash: 'a'.repeat(64),
    bodyHash: sha256Hex(body),
  },
});
/** Descriptive wire reads only; real native service tests establish durability. */
async function unknownOwner() {
  const requests: EditorSaveRequest[] = [];
  const bodies: string[] = [];
  const write: DocumentWriter = async (body, _format, _bypass, _hash, _destination, request) => {
    if (!request) throw new Error('missing selected request');
    requests.push(structuredClone(request));
    bodies.push(body);
    if (requests.length === 1) throw new Error('lost transport reply');
    if (requests.length === 2) return { kind: 'selected_outcome_unknown', error };
    return { kind: 'selected_unchanged', version: snapshot(body).version };
  };
  const owner = new DocumentOwner(key, 'before', write, target);
  owner.edit('mine', 'source');
  expect(await owner.flush()).toMatchObject({ kind: 'pending', status: 'unknown' });
  expect(await owner.retry()).toMatchObject({ kind: 'blocked', reason: 'reconcile' });
  const choice = {
    requestKey: requests[0].requestKey,
    generation: 1,
    snapshot: snapshot(),
    choice: 'mine' as const,
  };
  return { owner, requests, bodies, choice };
}

it('owner_unknown_choice_requires_exact_request_key_generation_target_path_and_read_hash', async () => {
  const { owner, choice } = await unknownOwner();
  const before = owner.snapshot();
  for (const changed of [
    { ...choice, requestKey: '166bd3ba-35c6-4662-b45b-341310bc0f02' },
    { ...choice, generation: 0 },
    { ...choice, snapshot: { ...choice.snapshot, path: 'replacement.md' } },
    { ...choice, snapshot: { ...choice.snapshot, target: { ...target, recordId: 'other' } } },
    {
      ...choice,
      snapshot: { ...choice.snapshot, version: { ...choice.snapshot.version, recordId: 'other' } },
    },
    { ...choice, snapshot: { ...choice.snapshot, observedBodyHash: sha256Hex('other') } },
    {
      ...choice,
      snapshot: {
        ...choice.snapshot,
        version: { ...choice.snapshot.version, bodyHash: sha256Hex('other') },
      },
    },
    { ...choice, snapshot: { ...choice.snapshot, editable: false } },
  ]) {
    expect(owner.settleSelectedReconcile(changed)).toBe(false);
    expect(owner.snapshot()).toEqual(before);
  }
  owner.edit('newer typing', 'source');
  expect(owner.settleSelectedReconcile(choice)).toBe(false);
  expect(owner.snapshot()).toMatchObject({
    latestDraft: 'newer typing',
    acknowledgedGeneration: 0,
    selectedSave: { status: 'reconcile', requestKey: choice.requestKey },
  });
  expect(owner.settleSelectedReconcile({ ...choice, generation: 2 })).toBe(true);
  expect(owner.snapshot()).toMatchObject({
    latestDraft: 'newer typing',
    generation: 2,
    acknowledgedGeneration: 0,
    mergeBase: { raw: 'current outside', canon: 'current outside' },
  });
  expect(owner.snapshot().selectedSave).toBeUndefined();
});

it('owner_unknown_choice_cannot_cancel_an_unresolved_transport_attempt', async () => {
  let request: EditorSaveRequest | undefined;
  const owner = new DocumentOwner(
    key,
    'before',
    async (_body, _format, _bypass, _hash, _destination, input) => {
      request = input;
      throw new Error('transport reply lost');
    },
    target,
  );
  owner.edit('mine');
  expect(await owner.flush()).toMatchObject({ kind: 'pending', status: 'unknown' });
  if (!request) throw new Error('selected request was not dispatched');
  const before = owner.snapshot();
  expect(
    owner.settleSelectedReconcile({
      requestKey: request.requestKey,
      generation: 1,
      snapshot: snapshot(),
      choice: 'theirs',
    }),
  ).toBe(false);
  expect(owner.snapshot()).toEqual(before);
  owner.finishReconcile();
  expect(owner.acceptExternal('current outside')).toBe(false);
  expect(owner.snapshot().selectedSave?.status).toBe('unknown');
});

it('owner_unknown_use_current_does_not_start_a_new_write', async () => {
  const { owner, requests, choice } = await unknownOwner();
  expect(
    owner.settleSelectedReconcile({
      ...choice,
      choice: 'theirs',
      snapshot: { ...choice.snapshot, editable: false },
    }),
  ).toBe(true);
  expect(owner.snapshot()).toMatchObject({
    latestDraft: 'current outside',
    reconcileRequired: false,
    mergeBase: { raw: 'current outside', canon: 'current outside' },
  });
  expect(owner.snapshot().acknowledgedGeneration).toBe(owner.snapshot().generation);
  expect(await owner.flush()).toMatchObject({ kind: 'clean' });
  expect(requests).toHaveLength(2);
});

it('owner_unknown_keep_mine_uses_a_new_key_only_after_explicit_choice', async () => {
  const { owner, requests, bodies, choice } = await unknownOwner();
  owner.finishReconcile();
  expect(await owner.flush()).toMatchObject({ kind: 'blocked', reason: 'reconcile' });
  expect(requests).toHaveLength(2);
  expect(owner.settleSelectedReconcile(choice)).toBe(true);
  expect(requests).toHaveLength(2);
  expect(await owner.flush()).toMatchObject({ kind: 'acknowledged' });
  expect(bodies).toEqual(['mine', 'mine', 'mine']);
  expect(requests[1]).toMatchObject({ phase: 'resolve', requestKey: requests[0].requestKey });
  expect(requests[2].phase).toBe('start');
  expect(requests[2].requestKey).not.toBe(requests[0].requestKey);
});

it('owner_unknown_choice_cannot_cancel_a_native_pending_operation', async () => {
  let request: EditorSaveRequest | undefined;
  const owner = new DocumentOwner(
    key,
    'before',
    async (body, _format, _bypass, _hash, _destination, input) => {
      if (!input) throw new Error('missing selected request');
      request = input;
      const current = snapshot(body).version;
      return {
        kind: 'selected_pending',
        error,
        operation: {
          path: key.path,
          target,
          requestKey: input.requestKey,
          operationId: '665a74b3-cafd-4d3d-9b0d-59830b33c0e9',
          version: current,
          receipt: {
            workspaceId: target.workspaceId,
            recordId: target.recordId,
            epoch: '3',
            previousRevision: '2',
            revision: current.metadataRevision,
            metadataBeforeHash: current.metadataHash,
            metadataAfterHash: current.metadataHash,
            bodyBeforeHash: sha256Hex('before'),
            bodyAfterHash: current.bodyHash,
            actor: 'human',
            operation: 'page.body',
            at: '2026-10-24T00:00:00Z',
          },
        },
      };
    },
    target,
  );
  owner.edit('mine');
  expect(await owner.flush()).toMatchObject({ kind: 'pending', status: 'pending' });
  if (!request) throw new Error('selected request was not dispatched');
  const before = owner.snapshot();
  expect(
    owner.settleSelectedReconcile({
      requestKey: request.requestKey,
      generation: 1,
      snapshot: snapshot(),
      choice: 'theirs',
    }),
  ).toBe(false);
  expect(owner.snapshot()).toEqual(before);
});
