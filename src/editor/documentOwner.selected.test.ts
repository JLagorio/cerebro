import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentOwner, type DocumentWriter, type DocumentWriteResult } from './documentOwner';
import {
  __resetOpenPages,
  flushOpenPages,
  registerSaveParticipant,
  retainDocumentOwner,
  retainedDocumentOwner,
  releaseDocumentOwner,
  unresolvedOpenPages,
} from './openPages';
import type {
  AuthorityError,
  EditorOperation,
  EditorSaveRequest,
  EditorSaveResult,
  SelectedEditorTarget,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';
import { replaceSelectedTitle } from './selectedTitleDraft';

const key = { vaultId: '/selected-toy', path: 'page.md', ownerId: 'pane-a' };
const target: SelectedEditorTarget = {
  workspaceId: '8e934a37-4aa8-40f2-aeb6-7e1683c02991',
  recordId: '72a79040-9bb3-4b2e-a0e6-bc2d4b536352',
};
const error: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'recovery_required',
  message: 'The original selected save needs recovery.',
  retryable: true,
};
const version = (body: string): SelectedRecordVersion => ({
  kind: 'sqlite_metadata',
  ...target,
  metadataRevision: '9007199254740993',
  metadataHash: 'a'.repeat(64),
  bodyHash: sha256Hex(body),
});
/** Descriptive wire fixtures only. They grant no native authority and do not
 * assert filesystem/SQL durability; native real-service tests own that proof. */
const operation = (request: EditorSaveRequest, body: string): EditorOperation => ({
  target: { ...request.target },
  path: key.path,
  requestKey: request.requestKey,
  operationId: '2e4cbf43-089a-40da-867c-73743707aa37',
  version: version(body),
  receipt: {
    workspaceId: target.workspaceId,
    recordId: target.recordId,
    epoch: '9007199254740994',
    previousRevision: '9007199254740992',
    revision: '9007199254740993',
    metadataBeforeHash: 'a'.repeat(64),
    metadataAfterHash: 'a'.repeat(64),
    bodyBeforeHash: sha256Hex('initial'),
    bodyAfterHash: sha256Hex(body),
    actor: 'human',
    runId: null,
    approvedBy: null,
    operation: 'page.body',
    at: '2026-10-24T00:00:00Z',
  },
});
const pending = (request: EditorSaveRequest, body: string): EditorSaveResult => ({
  kind: 'selected_pending',
  operation: operation(request, body),
  error,
});
const applied = (
  request: EditorSaveRequest,
  body: string,
  reconcileRequired = false,
): EditorSaveResult => ({
  kind: 'selected_applied',
  operation: request.original ?? operation(request, body),
  currentVersion: version(body),
  reconcileRequired,
  recovery: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
interface Call {
  body: string;
  request: EditorSaveRequest;
  destination: typeof key;
}
function writer(
  reply: (call: Call, index: number) => Promise<DocumentWriteResult> | DocumentWriteResult,
) {
  const calls: Call[] = [];
  const write: DocumentWriter = async (body, _format, bypass, expectHash, destination, request) => {
    expect(bypass).toBeUndefined();
    expect(expectHash).toBeUndefined();
    expect(destination).toEqual(key);
    expect(request).toBeDefined();
    if (request === undefined || destination === undefined)
      throw new Error('missing selected request');
    const call = { body, request: structuredClone(request), destination: { ...destination } };
    calls.push(call);
    return reply(call, calls.length);
  };
  return { calls, write };
}
afterEach(() => {
  __resetOpenPages();
  vi.restoreAllMocks();
});

describe('selected retained DocumentOwner protocol', () => {
  it('selected_pending_retains_original_attempt_without_acknowledging_generation', async () => {
    const { calls, write } = writer(({ request, body }) => pending(request, body));
    const owner = new DocumentOwner(key, 'initial', write, target);
    owner.edit('original A', 'source');
    expect(await owner.flush()).toMatchObject({
      kind: 'pending',
      generation: 1,
      status: 'pending',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toMatchObject({ target, phase: 'start' });
    expect(calls[0].request.requestKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'original A',
      generation: 1,
      acknowledgedGeneration: 0,
      mergeBase: { raw: 'initial', canon: 'initial' },
      selectedSave: { status: 'pending', generation: 1, requestKey: calls[0].request.requestKey },
    });
  });

  it('selected_lost_reply_resolves_same_key_and_frozen_body_before_newer_edit', async () => {
    const { calls, write } = writer(({ request, body }, index) => {
      if (index === 1) throw new Error('transport closed after dispatch');
      return applied(request, body);
    });
    const owner = new DocumentOwner(key, 'initial', write, target);
    owner.edit('original A', 'source');
    expect(await owner.flush()).toMatchObject({
      kind: 'pending',
      status: 'unknown',
      generation: 1,
    });
    owner.edit('newer N', 'source');
    expect(owner.snapshot().acknowledgedGeneration).toBe(0);
    expect(await owner.retry()).toMatchObject({ kind: 'acknowledged', generation: 2 });
    expect(calls.map((call) => [call.body, call.request.phase])).toEqual([
      ['original A', 'start'],
      ['original A', 'resolve'],
      ['newer N', 'start'],
    ]);
    expect(calls[1].request.requestKey).toBe(calls[0].request.requestKey);
    expect(calls[1].request.original ?? null).toBeNull();
    expect(calls[2].request.requestKey).not.toBe(calls[0].request.requestKey);
    expect(owner.snapshot()).toMatchObject({ latestDraft: 'newer N', acknowledgedGeneration: 2 });
  });

  it('selected_two_retained_owners_same_bytes_have_distinct_attempt_keys', async () => {
    const calls: EditorSaveRequest[] = [];
    const write: DocumentWriter = async (
      body,
      _format,
      _bypass,
      _expect,
      _destination,
      request,
    ) => {
      expect(request).toBeDefined();
      if (!request) throw new Error('missing request');
      calls.push(structuredClone(request));
      return pending(request, body);
    };
    const left = new DocumentOwner(key, 'initial', write, target);
    const right = new DocumentOwner({ ...key, ownerId: 'pane-b' }, 'initial', write, target);
    left.edit('same A');
    right.edit('same A');
    expect((await left.flush()).kind).toBe('pending');
    expect((await right.flush()).kind).toBe('pending');
    expect(calls).toHaveLength(2);
    expect(calls[0].requestKey).not.toBe(calls[1].requestKey);
    expect(left.snapshot().acknowledgedGeneration).toBe(0);
    expect(right.snapshot().acknowledgedGeneration).toBe(0);
  });

  it('selected_remount_preserves_pending_attempt_and_actual_flush_remains_unresolved', async () => {
    const { calls, write } = writer(({ request, body }) => pending(request, body));
    const owner = retainDocumentOwner(key, 'initial', write, target);
    owner.edit('original A', 'source');
    expect((await owner.flush()).kind).toBe('pending');
    releaseDocumentOwner(owner);
    expect(retainedDocumentOwner(key)).toBe(owner);
    const again = retainDocumentOwner(key, 'stale reopened bytes', write, { ...target });
    expect(again).toBe(owner);
    // The real mounted editor registers this retained owner as a participant.
    // Retention alone intentionally reports unresolved state without dispatch.
    const unmount = registerSaveParticipant({
      key: again.key,
      identity: again,
      prepare: () => undefined,
      snapshot: () => again.snapshot(),
      flush: () => again.flush(),
    });
    const report = await flushOpenPages();
    unmount();
    expect(report.unresolvedOwnerIds).toHaveLength(1);
    expect(unresolvedOpenPages()[0].latestDraft).toBe('original A');
    expect(calls).toHaveLength(2);
    expect(calls[1].request).toMatchObject({
      phase: 'resolve',
      requestKey: calls[0].request.requestKey,
    });
    expect(calls[1].request.original).toEqual(operation(calls[0].request, 'original A'));
  });

  it('selected_retained_target_rebind_cannot_reassign_an_old_attempt', async () => {
    const { calls, write } = writer(({ request, body }) => pending(request, body));
    const owner = retainDocumentOwner(key, 'initial', write, target);
    owner.edit('original A');
    expect((await owner.flush()).kind).toBe('pending');
    const replacement = vi.fn<DocumentWriter>(async () => {
      throw new Error('replacement must not run');
    });
    const again = retainDocumentOwner(key, 'replacement record', replacement, {
      ...target,
      recordId: 'f9affeb3-c608-4bd2-99e8-94d2b00f28aa',
    });
    expect(again).toBe(owner);
    await again.retry();
    expect(replacement).not.toHaveBeenCalled();
    expect(owner.snapshot().latestDraft).toBe('original A');
    expect(owner.snapshot().acknowledgedGeneration).toBe(0);
    expect(calls[0].request.target).toEqual(target);
  });

  it('selected_refused_is_definite_but_transport_failure_remains_unknown', async () => {
    const refused = new DocumentOwner(
      key,
      'initial',
      async () => {
        throw {
          kind: 'selected_refused',
          error: { ...error, kind: 'unsupported_operation', message: 'Not eligible.' },
        };
      },
      target,
    );
    const lost = new DocumentOwner(
      { ...key, ownerId: 'pane-b' },
      'initial',
      async () => {
        throw new Error('transport lost');
      },
      target,
    );
    refused.edit('A');
    lost.edit('A');
    expect(await refused.flush()).toMatchObject({ kind: 'failed', code: 'Not eligible.' });
    expect(refused.snapshot().selectedSave).toBeUndefined();
    expect(await lost.flush()).toMatchObject({ kind: 'pending', status: 'unknown' });
    expect(lost.snapshot().failure).toBeNull();
    expect(lost.snapshot().acknowledgedGeneration).toBe(0);
  });

  it('selected_pending_cannot_be_retired_accepted_as_external_or_bypassed', async () => {
    const { calls, write } = writer(({ request, body }) => pending(request, body));
    const owner = new DocumentOwner(key, 'initial', write, target);
    owner.edit('original A');
    expect((await owner.flush()).kind).toBe('pending');
    expect(owner.recoveryBusy()).toBe(true);
    expect(owner.retireRecovery()).toBe(false);
    expect(owner.acceptExternal('unrelated external bytes')).toBe(false);
    expect(await owner.saveWithoutRecoveryCopy('not-a-permit', 1)).toMatchObject({
      kind: 'blocked',
      reason: 'choice',
    });
    expect(calls).toHaveLength(1);
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'original A',
      acknowledgedGeneration: 0,
    });
  });

  it('selected_known_applied_acknowledges_only_original_generation_then_reconciles', async () => {
    const reply = deferred<DocumentWriteResult>();
    const { calls, write } = writer(() => reply.promise);
    const owner = new DocumentOwner(key, 'initial', write, target);
    owner.edit('original A');
    const flush = owner.flush();
    expect(calls).toHaveLength(1);
    owner.edit('newer N');
    reply.resolve(applied(calls[0].request, 'original A', true));
    expect(await flush).toMatchObject({ kind: 'blocked', reason: 'reconcile' });
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'newer N',
      acknowledgedGeneration: 1,
      reconcileRequired: true,
    });
    expect((await owner.retry()).kind).toBe('blocked');
    expect(calls).toHaveLength(1);
  });

  it('selected_descriptor_lost_unchanged_is_current_observation_without_receipt', async () => {
    const { calls, write } = writer(({ body }, index) => {
      if (index === 1) throw new Error('reply lost');
      return { kind: 'selected_unchanged', version: version(body) };
    });
    const owner = new DocumentOwner(key, 'initial', write, target);
    owner.edit('A');
    expect((await owner.flush()).kind).toBe('pending');
    const result = await owner.retry();
    expect(result).toMatchObject({
      kind: 'acknowledged',
      generation: 1,
      write: { kind: 'selected_unchanged', version: version('A') },
    });
    if (result.kind !== 'acknowledged')
      throw new Error('expected actual observation acknowledgement');
    expect('operation' in result.write).toBe(false);
    expect(calls[1].request).toMatchObject({
      phase: 'resolve',
      requestKey: calls[0].request.requestKey,
    });
    expect(owner.snapshot().acknowledgedGeneration).toBe(1);
  });

  it('selected_outcome_unknown_cannot_automatically_start_a_new_write', async () => {
    const { calls, write } = writer((_call, index) => {
      if (index === 1) throw new Error('reply lost');
      return { kind: 'selected_outcome_unknown', error: { ...error, kind: 'source_changed' } };
    });
    const owner = new DocumentOwner(key, 'initial', write, target);
    owner.edit('original A');
    expect((await owner.flush()).kind).toBe('pending');
    owner.edit('newer N');
    expect(await owner.retry()).toMatchObject({ kind: 'blocked', reason: 'reconcile' });
    expect(await owner.flush()).toMatchObject({ kind: 'blocked', reason: 'reconcile' });
    expect(calls.map((call) => call.request.phase)).toEqual(['start', 'resolve']);
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'newer N',
      acknowledgedGeneration: 0,
      selectedSave: { status: 'reconcile' },
    });
  });

  it('legacy_retry_keeps_the_existing_five_argument_wire_and_ack_behavior', async () => {
    const calls: unknown[][] = [];
    const owner = new DocumentOwner(key, 'initial', async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error('unavailable');
      return { kind: 'file', contentHash: 'legacy-authoritative' };
    });
    owner.edit('first');
    expect((await owner.flush()).kind).toBe('failed');
    owner.edit('latest');
    expect(await owner.retry()).toMatchObject({
      kind: 'acknowledged',
      generation: 2,
      write: { kind: 'file', contentHash: 'legacy-authoritative' },
    });
    expect(calls.map((args) => [args[0], args.length])).toEqual([
      ['first', 5],
      ['latest', 5],
    ]);
    expect(owner.snapshot().selectedSave).toBeUndefined();
  });
});

describe('dependent selected transform expectations', () => {
  it('freezes the complete expected version into the actual first request', async () => {
    const { calls, write } = writer(({ request, body }) => applied(request, body));
    const owner = new DocumentOwner(key, 'initial', write, target);
    const expected = version('initial');
    expect(owner.expectSelectedVersion(expected)).toBe(true);
    owner.edit('checkbox A', 'source');
    await owner.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].request.expectedVersion).toEqual(expected);
  });
  it('cannot rebase expected version during a transport-unknown original attempt', async () => {
    const { calls, write } = writer(({ request, body }, index) => {
      if (index === 1) throw new Error('lost reply');
      return applied(request, body);
    });
    const owner = new DocumentOwner(key, 'initial', write, target);
    const expected = version('initial');
    expect(owner.expectSelectedVersion(expected)).toBe(true);
    owner.edit('checkbox A', 'source');
    expect(await owner.flush()).toMatchObject({ kind: 'pending', status: 'unknown' });
    expect(
      owner.expectSelectedVersion({
        ...version('newer body'),
        metadataRevision: '9007199254740994',
      }),
    ).toBe(false);
    await owner.retry();
    expect(calls).toHaveLength(2);
    expect(calls[1].request).toMatchObject({
      phase: 'resolve',
      requestKey: calls[0].request.requestKey,
      expectedVersion: expected,
    });
    expect(calls[1].body).toBe(calls[0].body);
  });
  it('only the validated explicit whole-page choice rebases the next dependent attempt', async () => {
    const { calls, write } = writer(({ request, body }, index) =>
      index === 1 ? { kind: 'selected_outcome_unknown', error } : applied(request, body),
    );
    const owner = new DocumentOwner(key, 'initial', write, target);
    expect(owner.expectSelectedVersion(version('initial'))).toBe(true);
    owner.edit('checkbox A', 'source');
    await owner.flush();
    const state = owner.snapshot();
    const observed = {
      path: key.path,
      target,
      body: 'new paired body',
      observedBodyHash: sha256Hex('new paired body'),
      version: { ...version('new paired body'), metadataRevision: '9007199254740994' },
      coherence: 'paired' as const,
      editable: true,
    };
    expect(owner.expectSelectedVersion(observed.version)).toBe(false);
    expect(
      owner.settleSelectedReconcile({
        requestKey: calls[0].request.requestKey,
        generation: state.generation,
        snapshot: observed,
        choice: 'mine',
      }),
    ).toBe(true);
    await owner.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].request).toMatchObject({ phase: 'start', expectedVersion: observed.version });
    expect(calls[1].request.requestKey).not.toBe(calls[0].request.requestKey);
  });
});

describe('explicit selected refusal comparison', () => {
  it('promotes only the idle failed original retry into the existing choice state without dispatch or rebase', async () => {
    const { calls, write } = writer(() => {
      throw {
        kind: 'selected_refused',
        error: {
          code: 'capability_unavailable',
          kind: 'stale_metadata',
          message: 'Canonical metadata changed.',
          retryable: true,
        },
      };
    });
    const owner = new DocumentOwner(key, 'initial', write, target);
    const expected = version('initial');
    expect(owner.expectSelectedVersion(expected)).toBe(true);
    owner.edit('# Authored title\n', 'source');
    expect(await owner.flush()).toMatchObject({ kind: 'failed' });
    const before = owner.snapshot();
    expect(owner.compareSelectedRefusal()).toBe(true);
    expect(owner.snapshot()).toMatchObject({
      latestDraft: before.latestDraft,
      generation: before.generation,
      acknowledgedGeneration: before.acknowledgedGeneration,
      selectedSave: {
        status: 'reconcile',
        requestKey: calls[0].request.requestKey,
        reason: 'refused',
      },
    });
    expect(calls).toHaveLength(1);
    expect(
      owner.expectSelectedVersion({ ...version('later'), metadataRevision: '9007199254740994' }),
    ).toBe(false);
    expect(await owner.flush()).toMatchObject({ kind: 'blocked', reason: 'reconcile' });
    expect(calls).toHaveLength(1);
  });
  it.each(['pending', 'unknown'] as const)(
    'does not convert a live %s original into a discardable/comparable retry',
    async (status) => {
      const { calls, write } = writer(({ request, body }) => {
        if (status === 'unknown') throw new Error('lost reply');
        return pending(request, body);
      });
      const owner = new DocumentOwner(key, 'initial', write, target);
      expect(owner.expectSelectedVersion(version('initial'))).toBe(true);
      owner.edit('# Authored title\n', 'source');
      await owner.flush();
      const before = owner.snapshot();
      expect(owner.compareSelectedRefusal()).toBe(false);
      expect(owner.snapshot()).toEqual(before);
      expect(owner.snapshot().selectedSave?.status).toBe(status);
      expect(calls).toHaveLength(1);
    },
  );

  it('selected_source_change_commits_the_latest_generation_over_unread_rich_typing', async () => {
    // M93.1 (BL-03, CX-OUT-20): rich typing is unread when the selected title
    // edits the same body as source. The one commit carries both, at the
    // latest generation, while the first attempt's reply is held.
    const held = deferred<EditorSaveResult>();
    const { calls, write } = writer(({ request, body }, index) =>
      index === 1 ? held.promise : applied(request, body),
    );
    const owner = new DocumentOwner(key, '# Title\n\nbody', write, target);
    let text = '# Title\n\nbody typed';
    const materialize = () => text;
    owner.touch(materialize);
    const first = owner.flush();
    text = '# Title\n\nbody typed more';
    owner.touch(materialize);
    owner.edit(replaceSelectedTitle(owner.snapshot().latestDraft, 'Renamed'), 'source');
    held.resolve(applied(calls[0].request, calls[0].body));
    await first;
    expect(calls.map((call) => call.body)).toEqual([
      '# Title\n\nbody typed',
      '# Renamed\n\nbody typed more',
    ]);
    const state = owner.snapshot();
    expect(state).toMatchObject({
      latestDraft: '# Renamed\n\nbody typed more',
      bodyFormat: 'source',
    });
    expect(state.acknowledgedGeneration).toBe(state.generation);
    expect(state.selectedSave).toBeUndefined();
  });
});
