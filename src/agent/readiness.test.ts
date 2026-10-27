import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliReadinessOwner } from './readiness';
import type { CliReadinessProbe } from './cliReadinessTypes';

const found: CliReadinessProbe = {
  state: 'available',
  path: '/tools/claude',
  version: '2.0',
  backend: 'native',
};
function deferred() {
  let resolve!: (value: CliReadinessProbe) => void;
  const promise = new Promise<CliReadinessProbe>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe('shared CLI readiness observation', () => {
  it('two subscribers join one initial probe and receive an observed result', async () => {
    const pending = deferred();
    const probe = vi.fn(() => pending.promise);
    const owner = createCliReadinessOwner(probe, () => 1000);
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = owner.subscribe(a);
    owner.subscribe(b);
    const first = owner.ensure();
    const second = owner.ensure();
    expect(first).toBe(second);
    expect(probe).toHaveBeenCalledTimes(1);
    pending.resolve(found);
    expect(await first).toEqual({
      ...found,
      generation: 1,
      observedAt: new Date(1000).toISOString(),
    });
    expect(owner.getSnapshot()).toEqual(await second);
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    unsubscribeA();
    a.mockClear();
    await owner.refresh();
    expect(a).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a failed transport is unavailable and never installation advice', async () => {
    const owner = createCliReadinessOwner(vi.fn().mockRejectedValue(new Error('secret path')));
    expect(await owner.ensure()).toMatchObject({ state: 'unavailable', code: 'ipc' });
    expect(JSON.stringify(owner.getSnapshot())).not.toContain('secret path');
  });

  it.each(['timeout', 'permission', 'probe_failed', 'output_limit'] as const)(
    'retains the native %s refusal without calling it missing',
    async (code) => {
      const owner = createCliReadinessOwner(async () => ({ state: 'unavailable', code }));
      expect(await owner.ensure()).toMatchObject({ state: 'unavailable', code });
    },
  );

  it('an explicit refresh supersedes an initial probe and concurrent refreshes join', async () => {
    const old = deferred();
    const fresh = deferred();
    const probe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const owner = createCliReadinessOwner(probe);
    const initial = owner.ensure();
    const refresh = owner.refresh();
    expect(owner.refresh()).toBe(refresh);
    expect(owner.ensure()).toBe(refresh);
    fresh.resolve(found);
    await refresh;
    old.resolve({ state: 'missing' });
    await initial;
    expect(owner.getSnapshot()).toMatchObject({ ...found, generation: 2 });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('retry after a missing observation can find the newly installed binary', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ state: 'missing' }).mockResolvedValueOnce(found);
    const owner = createCliReadinessOwner(probe);
    expect(await owner.ensure()).toMatchObject({ state: 'missing' });
    expect(await owner.ensure()).toMatchObject({ state: 'missing' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await owner.refresh()).toMatchObject({ ...found, generation: 2 });
  });

  it('an IPC watchdog releases a stuck check for explicit retry without claiming native cleanup', async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(found);
    const owner = createCliReadinessOwner(probe);
    const pending = owner.ensure();
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toMatchObject({ state: 'unavailable', code: 'timeout' });
    expect(await owner.refresh()).toMatchObject(found);
  });

  it('only the explicit browser mock may report available without an executable path', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ...found, path: null })
      .mockResolvedValueOnce({
        state: 'available',
        path: null,
        version: 'mock (browser)',
        backend: 'browser_mock',
      });
    const owner = createCliReadinessOwner(probe);
    expect(await owner.ensure()).toMatchObject({ state: 'unavailable', code: 'probe_failed' });
    expect(await owner.refresh()).toMatchObject({
      state: 'available',
      backend: 'browser_mock',
      path: null,
    });
  });

  it('malformed bridge values cannot leave a probe spinning or leak arbitrary response fields', async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...found,
        arbitrarySecret: 'must not be retained',
      });
    const owner = createCliReadinessOwner(probe);
    const first = owner.ensure();
    await vi.advanceTimersByTimeAsync(6000);
    expect(await first).toMatchObject({ state: 'unavailable', code: 'probe_failed' });
    await owner.refresh();
    expect(owner.getSnapshot()).not.toHaveProperty('arbitrarySecret');
  });
});
