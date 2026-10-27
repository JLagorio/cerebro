import type { RunActionAccessApi } from './managedActionAccessSession';
import { createRunActionAccessSession } from './managedActionAccessSession';
export type AccessSession = ReturnType<typeof createRunActionAccessSession>;
/** Bounded app-session views; selectors never confer native access. */
export function createRunActionAccessBook(capacity = 32) {
  const entries = new Map<
    string,
    { run: number; requestId: string | null; session: AccessSession; off: () => void }
  >();
  const prune = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    const state = entry.session.getSnapshot();
    const pending = state.phase === 'loading' || state.phase === 'saving';
    if (!pending && (state.retired || state.phase === 'saved' || state.phase === 'closed')) {
      entries.delete(key);
      entry.off();
    }
  };
  return {
    acquire: (
      run: number,
      requestId: string | null,
      api: RunActionAccessApi,
    ): AccessSession | null => {
      if (
        !Number.isSafeInteger(run) ||
        run < 0 ||
        (requestId !== null &&
          (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128))
      )
        return null;
      const key = JSON.stringify([run, requestId]);
      const existing = entries.get(key);
      if (existing !== undefined)
        return existing.session.getSnapshot().retired ? null : existing.session;
      if (entries.size >= capacity) return null;
      const session = createRunActionAccessSession(run, requestId, api);
      const off = session.subscribe(() => {
        prune(key);
      });
      entries.set(key, { run, requestId, session, off });
      return session;
    },
    retire: (run: number, requestId?: string): void => {
      for (const entry of entries.values()) {
        if (entry.run === run && (requestId === undefined || entry.requestId === requestId))
          entry.session.retire();
      }
    },
  };
}
export const runActionAccessBook = createRunActionAccessBook();
