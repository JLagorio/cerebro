import { describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, CredentialAcquisitionView } from '@/lib/generated/actions';
import {
  createCredentialImportSession,
  type CredentialImportApi,
  type CredentialSelection,
} from './managedCredentialSession';

const selection: CredentialSelection = {
  connectionId: 'connection-a',
  login: 'alice',
  revision: 3,
  revocationGeneration: 2,
};
const attempt: CredentialAcquisitionView = {
  attemptId: 'attempt-a',
  connectionId: selection.connectionId,
  host: 'github.com',
  login: 'alice',
  expectedRevision: 4,
  revocationGeneration: 2,
  state: 'pending',
  error: null,
  observedAt: '2026-10-26T12:00:00Z',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const api = {
    begin: vi.fn<CredentialImportApi['begin']>().mockResolvedValue(attempt),
    read: vi.fn<CredentialImportApi['read']>().mockResolvedValue(attempt),
    cancel: vi
      .fn<CredentialImportApi['cancel']>()
      .mockResolvedValue({ ...attempt, state: 'cancelled', error: 'cancelled' }),
  };
  return { api, session: createCredentialImportSession(api) };
}

describe('explicit managed credential import', () => {
  it('imports only the exact chosen login once and retains its original selection across consumers', async () => {
    const { api, session } = setup();
    const started = deferred<CredentialAcquisitionView>();
    api.begin.mockReturnValue(started.promise);
    const unsubscribe = session.subscribe(vi.fn());
    const result = session.begin(selection);
    unsubscribe();
    await session.begin({ ...selection, connectionId: 'connection-b', login: 'bob' });
    expect(api.begin).toHaveBeenCalledExactlyOnceWith('connection-a', 'github.com', 'alice', 3);
    expect(session.getSnapshot().phase).toBe('starting');
    started.resolve(attempt);
    await result;
    expect(session.getSnapshot()).toMatchObject({
      selection,
      attempt,
      phase: 'pending',
      busy: false,
    });
  });
  it('retains an unknown start without silently retrying or claiming a credential was installed', async () => {
    const { api, session } = setup();
    api.begin.mockRejectedValue('unavailable');
    await session.begin(selection);
    await session.begin(selection);
    expect(api.begin).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({ phase: 'unknown', attempt: null, busy: false });
    expect(session.getSnapshot().failure).toMatch(/could not confirm/i);
  });
  it('refuses a different account or replacement attempt in a successful transport response', async () => {
    const { api, session } = setup();
    await session.begin(selection);
    api.read.mockResolvedValue({
      ...attempt,
      attemptId: 'different',
      login: 'bob',
      state: 'installed',
    });
    await session.refresh();
    expect(api.read).toHaveBeenCalledExactlyOnceWith('attempt-a');
    expect(session.getSnapshot()).toMatchObject({ attempt, phase: 'pending' });
    expect(session.getSnapshot().failure).not.toBeNull();
  });
  it('keeps the original cancellable attempt after a failed read and never retries import', async () => {
    const { api, session } = setup();
    await session.begin(selection);
    api.read.mockRejectedValue('unavailable');
    await session.refresh();
    expect(session.getSnapshot().attempt).toEqual(attempt);
    await session.cancel();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith('attempt-a');
    expect(session.getSnapshot()).toMatchObject({
      phase: 'terminal',
      attempt: { state: 'cancelled' },
      busy: false,
    });
    expect(api.begin).toHaveBeenCalledTimes(1);
  });
  it('settles only the original pending attempt and makes installed status explicit', async () => {
    const { api, session } = setup();
    await session.begin(selection);
    api.read.mockResolvedValue({ ...attempt, state: 'installed' });
    await session.refresh();
    await session.cancel();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'terminal',
      attempt: { state: 'installed' },
      failure: null,
    });
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it('blocks an unknown start until a later observed disable of that same account', async () => {
    const { api, session } = setup();
    api.begin.mockRejectedValue('unavailable');
    await session.begin(selection);
    const disabled: ConnectionStatus = {
      ...selection,
      revision: 4,
      account: null,
      cleanupPending: false,
      health: 'disabled',
      observedAt: attempt.observedAt,
      remoteRevocation: 'not_attempted',
      secretRevision: 0,
    };
    session.reconcile({ ...disabled, connectionId: 'different' });
    expect(session.getSnapshot().phase).toBe('unknown');
    session.reconcile({ ...disabled, revision: 3 });
    expect(session.getSnapshot().phase).toBe('unknown');
    session.reconcile(disabled);
    expect(session.getSnapshot().phase).toBe('idle');
  });
  it('does not print arbitrary native errors and treats a definite refusal separately', async () => {
    const { api, session } = setup();
    api.begin.mockRejectedValue('stale_revision');
    await session.begin(selection);
    expect(session.getSnapshot().phase).toBe('terminal');
    expect(session.getSnapshot().failure).toMatch(/refresh/i);
    api.begin.mockRejectedValue('SECRET-CANARY');
    await session.begin(selection);
    expect(JSON.stringify(session.getSnapshot())).not.toContain('SECRET-CANARY');
    expect(session.getSnapshot().phase).toBe('unknown');
  });
  it('retains only the selected account fields even when a consumer has a larger object', async () => {
    const { session } = setup();
    const fromConsumer = { ...selection, extra: 'INPUT-CANARY' };
    await session.begin(fromConsumer);
    expect(JSON.stringify(session.getSnapshot())).not.toContain('INPUT-CANARY');
    expect(session.getSnapshot().selection).toEqual(selection);
  });
  it('retains only finite response fields and never stores unexpected native error text', async () => {
    const { api, session } = setup();
    const response = {
      ...attempt,
      state: 'failed',
      error: 'RESPONSE-CANARY',
      extra: 'EXTRA-CANARY',
    };
    api.begin.mockResolvedValue(response as CredentialAcquisitionView);
    await session.begin(selection);
    expect(session.getSnapshot().phase).toBe('terminal');
    expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY');
  });
});
