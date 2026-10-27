import type { CliReadiness, CliReadinessProbe } from './cliReadinessTypes';

function checkedProbe(value: unknown): CliReadinessProbe {
  if (value !== null && typeof value === 'object') {
    const result = value as Record<string, unknown>;
    if (result.state === 'missing') return { state: 'missing' };
    if (
      result.state === 'available' &&
      (result.version === null || typeof result.version === 'string')
    ) {
      if (result.backend === 'native' && typeof result.path === 'string' && result.path.length > 0)
        return {
          state: 'available',
          backend: 'native',
          path: result.path,
          version: result.version,
        };
      if (result.backend === 'browser_mock' && result.path === null)
        return { state: 'available', backend: 'browser_mock', path: null, version: result.version };
    }
    if (
      result.state === 'unavailable' &&
      (result.code === 'timeout' ||
        result.code === 'permission' ||
        result.code === 'probe_failed' ||
        result.code === 'output_limit')
    )
      return { state: 'unavailable', code: result.code };
  }
  return { state: 'unavailable', code: 'probe_failed' };
}

export interface CliReadinessOwner {
  getSnapshot(): CliReadiness;
  subscribe(listener: () => void): () => void;
  ensure(): Promise<CliReadiness>;
  refresh(): Promise<CliReadiness>;
}

/** A shared observation owner, separate from conversation state. */
export function createCliReadinessOwner(
  probe: () => Promise<CliReadinessProbe>,
  now: () => number = Date.now,
): CliReadinessOwner {
  let snapshot: CliReadiness = { state: 'checking', generation: 0, observedAt: null };
  let generation = 0;
  let active: { explicit: boolean; promise: Promise<CliReadiness> } | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: CliReadiness) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  function start(explicit: boolean): Promise<CliReadiness> {
    const request = ++generation;
    let finish!: (value: CliReadiness) => void;
    const promise = new Promise<CliReadiness>((resolve) => {
      finish = resolve;
    });
    active = { explicit, promise };
    publish({ state: 'checking', generation: request, observedAt: null });
    let settled = false;
    // This only releases the UI if IPC never answers. Rust separately owns
    // the five-second subprocess deadline, termination and reaping.
    const timer = setTimeout(() => complete({ state: 'unavailable', code: 'timeout' }), 6000);
    function complete(result: CliReadinessProbe | { state: 'unavailable'; code: 'ipc' }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (request === generation) {
        active = null;
        publish({ ...result, generation: request, observedAt: new Date(now()).toISOString() });
      }
      finish(snapshot);
    }
    try {
      void probe().then(
        (result) => complete(checkedProbe(result)),
        () => complete({ state: 'unavailable', code: 'ipc' }),
      );
    } catch {
      complete({ state: 'unavailable', code: 'ipc' });
    }
    return promise;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure: () => active?.promise ?? (generation === 0 ? start(false) : Promise.resolve(snapshot)),
    refresh: () => (active?.explicit ? active.promise : start(true)),
  };
}
