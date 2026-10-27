import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './types';
import type { RunActionAccessView, SetRunActionAccessResult } from '@/lib/generated/actions';
const api = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  listen: vi.fn(),
  event: null as ((event: AgentEvent) => void) | null,
}));
vi.mock('./agentIpc', () => ({
  readManagedActionAccess: api.read,
  setManagedActionAccess: api.set,
  onAgentEvent: api.listen,
}));
const view: RunActionAccessView = {
  runId: 'durable-original',
  accessRevision: 'a',
  accessRequestId: 'request',
  accounts: [],
  definitions: [],
  grants: [],
};
beforeEach(() => {
  vi.resetModules();
  api.read.mockReset().mockResolvedValue(view);
  api.set.mockReset();
  api.listen.mockReset().mockImplementation((event) => {
    api.event = event;
    return vi.fn();
  });
  api.event = null;
});
describe('managed access app-session integration', () => {
  it('does not read or subscribe on import; the first explicit open installs one event observer', async () => {
    const { openRunActionAccess } = await import('./managedActionAccessRuntime');
    expect(api.listen).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
    const first = openRunActionAccess(41, 'request');
    expect(first).not.toBeNull();
    expect(openRunActionAccess(41, 'request')).toBe(first);
    expect(api.listen).toHaveBeenCalledTimes(1);
    expect(api.read).not.toHaveBeenCalled();
    await first!.refresh();
    expect(api.read).toHaveBeenCalledExactlyOnceWith(41);
  });
  it('reopening a pending save returns the original session and never submits again', async () => {
    const { openRunActionAccess } = await import('./managedActionAccessRuntime');
    const first = openRunActionAccess(41, 'request');
    expect(first).not.toBeNull();
    await first!.refresh();
    let finish!: (result: SetRunActionAccessResult) => void;
    api.set.mockReturnValue(
      new Promise<SetRunActionAccessResult>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = first!.save();
    const reopened = openRunActionAccess(41, 'request');
    expect(reopened).toBe(first);
    await reopened!.save();
    expect(api.set).toHaveBeenCalledTimes(1);
    finish({ state: 'changed', view, sourceCurrent: false, requestClosed: false });
    await saving;
    expect(first!.getSnapshot()).toMatchObject({
      phase: 'saved',
      sourceCurrent: false,
      requestClosed: false,
    });
  });
  it('retires only the exact original card, while Done retires every view of that run', async () => {
    const { openRunActionAccess } = await import('./managedActionAccessRuntime');
    const card = openRunActionAccess(41, 'request');
    const run = openRunActionAccess(41, null);
    const other = openRunActionAccess(42, 'request');
    expect(card).not.toBeNull();
    expect(run).not.toBeNull();
    expect(other).not.toBeNull();
    api.event?.({ kind: 'InteractionClosed', interaction_id: 'request', run: 41, seq: 1 });
    expect(card!.getSnapshot().retired).toBe(true);
    expect(run!.getSnapshot().retired).toBe(false);
    expect(other!.getSnapshot().retired).toBe(false);
    api.event?.({ kind: 'Done', run: 41, seq: 2 });
    expect(run!.getSnapshot().retired).toBe(true);
    expect(other!.getSnapshot().retired).toBe(false);
  });
});
