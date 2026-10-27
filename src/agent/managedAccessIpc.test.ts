import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetRunActionAccess, RunActionAccessView } from '@/lib/generated/actions';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { readManagedActionAccess, setManagedActionAccess } from './agentIpc';
const native = () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
};
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});
const view: RunActionAccessView = {
  runId: 'original',
  accessRevision: 'revision-a',
  accessRequestId: 'request-a',
  accounts: [],
  definitions: [],
  grants: [],
};
const request: SetRunActionAccess = {
  expectedAccessRevision: 'revision-a',
  completeRequestId: 'request-a',
  selections: [
    {
      kind: 'new',
      selection: {
        connectionId: 'github',
        accountId: 'selected',
        accountRevision: 1,
        revocationGeneration: 0,
        actionId: 'github.issue.read',
        definitionDigest: 'd'.repeat(64),
        inputScope: { kind: 'exact_canonical_input', input: '{"n":9007199254740993.00000000001}' },
      },
    },
  ],
};
describe('original managed access IPC', () => {
  it('reads only the fixed original run selector through the authenticated native command', async () => {
    native();
    invoke.mockResolvedValueOnce(view);
    await expect(readManagedActionAccess(41)).resolves.toEqual(view);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('read_managed_action_access', { run: 41 });
  });
  it('sends exact input text and returns a known commit independently from current-source status', async () => {
    native();
    const result = { state: 'changed', view, sourceCurrent: false, requestClosed: false };
    invoke.mockResolvedValueOnce(result);
    await expect(setManagedActionAccess(41, request)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('set_managed_action_access', {
      run: 41,
      request,
    });
    expect(invoke.mock.calls[0][1].request.selections[0].selection.inputScope.input).toBe(
      '{"n":9007199254740993.00000000001}',
    );
  });
  it('never fabricates browser account access or a successful browser grant mutation', async () => {
    await expect(readManagedActionAccess(41)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(setManagedActionAccess(41, request)).resolves.toMatchObject({
      state: 'refused',
      error: { code: 'unavailable' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'does not send an unsafe run selector %s',
    async (run) => {
      native();
      await expect(readManagedActionAccess(run)).rejects.toMatchObject({ code: 'unavailable' });
      await expect(setManagedActionAccess(run, request)).resolves.toMatchObject({
        state: 'refused',
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});

it('reads the actual first native run zero without replacing its selector', async () => {
  native(); invoke.mockResolvedValueOnce(view);
  await expect(readManagedActionAccess(0)).resolves.toEqual(view);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('read_managed_action_access', { run: 0 });
});
it('saves explicit access for actual first native run zero with unchanged original request', async () => {
  native(); const result = { state: 'changed', view, sourceCurrent: true, requestClosed: true };
  invoke.mockResolvedValueOnce(result);
  await expect(setManagedActionAccess(0, request)).resolves.toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('set_managed_action_access', { run: 0, request });
});
