import { describe, expect, it, vi } from 'vitest';
import type { RunActionAccessView, SetRunActionAccessResult } from '@/lib/generated/actions';
import {
  createRunActionAccessSession,
  type RunActionAccessApi,
  type AccessSelection,
} from './managedActionAccessSession';

const view: RunActionAccessView = {
  runId: 'original-durable-run',
  accessRevision: 'access-a',
  accessRequestId: 'request-a',
  accounts: [],
  definitions: [],
  grants: [
    {
      grantId: 'exact-grant',
      revision: 3,
      connectionId: 'connection-a',
      accountId: 'alice',
      actionId: 'github:read',
      definitionDigest: 'definition-a',
      available: true,
      inputScope: { kind: 'exact_canonical_input', inputDigest: 'original-input-digest' },
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function setup() {
  const api = {
    read: vi.fn<RunActionAccessApi['read']>().mockResolvedValue(view),
    set: vi.fn<RunActionAccessApi['set']>().mockResolvedValue({
      state: 'changed',
      view: { ...view, accessRequestId: null, accessRevision: 'access-b' },
      sourceCurrent: true,
      requestClosed: true,
    }),
  };
  return { api, session: createRunActionAccessSession(41, 'request-a', api) };
}

describe('original-run managed action access', () => {
  it('loads the exact run and preserves an exact-input grant without reconstructing its hidden input', async () => {
    const { api, session } = setup();
    await session.refresh();
    expect(api.read).toHaveBeenCalledExactlyOnceWith(41);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'ready',
      view,
      selections: [{ kind: 'preserve', grantId: 'exact-grant', expectedRevision: 3 }],
    });
    await session.save();
    expect(api.set).toHaveBeenCalledExactlyOnceWith(41, {
      expectedAccessRevision: 'access-a',
      completeRequestId: 'request-a',
      selections: [{ kind: 'preserve', grantId: 'exact-grant', expectedRevision: 3 }],
    });
  });
  it('keeps a failed read unavailable instead of reporting empty access', async () => {
    const { api, session } = setup();
    api.read.mockRejectedValue(new Error('private transport detail'));
    await session.refresh();
    await session.save();
    expect(session.getSnapshot()).toMatchObject({ phase: 'unavailable', view: null });
    expect(session.getSnapshot().failure).toMatch(/unavailable/i);
    expect(JSON.stringify(session.getSnapshot())).not.toContain('private transport');
    expect(api.set).not.toHaveBeenCalled();
  });
  it('preserves an unavailable unrevoked grant until the person explicitly removes it', async () => {
    const { api, session } = setup();
    api.read.mockResolvedValue({ ...view, grants: [{ ...view.grants[0], available: false }] });
    await session.refresh();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'ready',
      selections: [{ kind: 'preserve', grantId: 'exact-grant', expectedRevision: 3 }],
    });
    await session.save();
    expect(api.set).toHaveBeenCalledWith(41, {
      expectedAccessRevision: 'access-a',
      completeRequestId: 'request-a',
      selections: [{ kind: 'preserve', grantId: 'exact-grant', expectedRevision: 3 }],
    });
  });
  it('will not answer a replacement request or borrow another durable run', async () => {
    const { api, session } = setup();
    api.read.mockResolvedValueOnce({ ...view, accessRequestId: 'replacement-request' });
    await session.refresh();
    await session.save();
    expect(session.getSnapshot().phase).toBe('closed');
    expect(api.set).not.toHaveBeenCalled();
    const next = setup();
    await next.session.refresh();
    next.api.read.mockResolvedValue({ ...view, runId: 'another-durable-run' });
    await next.session.refresh();
    await next.session.save();
    expect(next.session.getSnapshot().phase).toBe('closed');
    expect(next.api.set).not.toHaveBeenCalled();
  });
  it('holds one write with a frozen choice even after its consumers unmount', async () => {
    const { api, session } = setup();
    await session.refresh();
    const result = deferred<SetRunActionAccessResult>();
    api.set.mockReturnValue(result.promise);
    const off = session.subscribe(vi.fn());
    const pending = session.save();
    off();
    session.select([]);
    await session.save();
    await session.refresh();
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().phase).toBe('saving');
    result.resolve({
      state: 'changed',
      view: { ...view, accessRequestId: null },
      sourceCurrent: false,
      requestClosed: false,
    });
    await pending;
    expect(session.getSnapshot()).toMatchObject({
      phase: 'saved',
      sourceCurrent: false,
      requestClosed: false,
    });
    await session.save();
    expect(api.set).toHaveBeenCalledTimes(1);
  });
  it.each(['lost acknowledgement', 'commit unknown'])(
    'requires explicit current-access reload after %s and never resends automatically',
    async (mode) => {
      const { api, session } = setup();
      await session.refresh();
      if (mode === 'commit unknown')
        api.set.mockResolvedValue({ state: 'commit_unknown', message: 'private native detail' });
      else api.set.mockRejectedValue(new Error('private native detail'));
      await session.save();
      await session.save();
      expect(session.getSnapshot().phase).toBe('unknown');
      expect(JSON.stringify(session.getSnapshot())).not.toContain('private native');
      expect(api.set).toHaveBeenCalledTimes(1);
      api.read.mockResolvedValue({ ...view, accessRevision: 'observed-c', grants: [] });
      await session.refresh();
      expect(session.getSnapshot()).toMatchObject({
        phase: 'ready',
        selections: [],
        view: { accessRevision: 'observed-c' },
      });
      expect(session.getSnapshot().notice).toMatch(/review/i);
      expect(api.set).toHaveBeenCalledTimes(1);
    },
  );
  it('retains the chosen exact JSON text until an explicit save without parsing numbers', async () => {
    const { api, session } = setup();
    await session.refresh();
    const input = '{"value":9007199254740993.000000000001}';
    const selections = [
      {
        kind: 'new' as const,
        selection: {
          connectionId: 'connection-a',
          accountId: 'alice',
          accountRevision: 2,
          revocationGeneration: 0,
          actionId: 'github:read',
          definitionDigest: 'definition-a',
          inputScope: { kind: 'exact_canonical_input' as const, input },
        },
      },
    ];
    session.select(selections);
    selections[0].selection.inputScope.input = 'changed by a different caller';
    await session.save();
    expect(api.set.mock.calls[0]?.[1].selections).toEqual([
      {
        kind: 'new',
        selection: {
          ...selections[0].selection,
          inputScope: { kind: 'exact_canonical_input', input },
        },
      },
    ]);
    expect(session.getSnapshot().selections).toEqual([]);
  });
  it('requires a fresh read after a revision refusal and never renders arbitrary backend text', async () => {
    const { api, session } = setup();
    await session.refresh();
    api.set.mockResolvedValue({
      state: 'refused',
      error: {
        code: 'revision_conflict',
        message: 'private backend detail',
        retryDisposition: 'refresh',
      },
    });
    await session.save();
    await session.save();
    expect(session.getSnapshot().phase).toBe('unavailable');
    expect(session.getSnapshot().failure).toMatch(/changed|refresh/i);
    expect(JSON.stringify(session.getSnapshot())).not.toContain('private backend');
    expect(api.set).toHaveBeenCalledTimes(1);
  });
  it('treats a mismatched known-commit response as uncertain rather than acknowledging another run', async () => {
    const { api, session } = setup();
    await session.refresh();
    api.set.mockResolvedValue({
      state: 'changed',
      view: { ...view, runId: 'other-run' },
      sourceCurrent: true,
      requestClosed: true,
    });
    await session.save();
    expect(session.getSnapshot().phase).toBe('unknown');
    expect(session.getSnapshot().requestClosed).toBeNull();
  });
  it('rejects an unknown scope in native metadata instead of describing it as all valid inputs', async () => {
    const { api, session } = setup();
    api.read.mockResolvedValue({
      ...view,
      grants: [{ ...view.grants[0], inputScope: { kind: 'unknown_scope' } }],
    } as unknown as RunActionAccessView);
    await session.refresh();
    await session.save();
    expect(session.getSnapshot().phase).toBe('unavailable');
    expect(api.set).not.toHaveBeenCalled();
  });
  it('catches a malformed edited scope and never widens it or submits it', async () => {
    const { api, session } = setup();
    await session.refresh();
    const invalid = [
      {
        kind: 'new',
        selection: {
          connectionId: 'a',
          accountId: 'alice',
          accountRevision: 1,
          revocationGeneration: 0,
          actionId: 'read',
          definitionDigest: 'd',
          inputScope: { kind: 'unknown_scope' },
        },
      },
    ] as unknown as AccessSelection[];
    expect(() => session.select(invalid)).not.toThrow();
    await expect(session.save()).resolves.toBeUndefined();
    expect(session.getSnapshot().phase).toBe('unavailable');
    expect(api.set).not.toHaveBeenCalled();
  });
  it('does not throw or call native set when a consumer corrupts the pending selection', async () => {
    const { api, session } = setup();
    await session.refresh();
    session.getSnapshot().selections[0] = { kind: 'unexpected' } as unknown as AccessSelection;
    await expect(session.save()).resolves.toBeUndefined();
    expect(session.getSnapshot().phase).toBe('unavailable');
    expect(api.set).not.toHaveBeenCalled();
  });
});
