import { useEffect, useState } from 'react';

/** One feed's three states. `loading` is distinct from `unavailable` so a
 * slow read never renders as a refusal. */
export type Feed<T> = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: T };

export function useFeed<T>(
  vaultPath: string | null,
  read: (vault: string) => Promise<T>,
  version = 0,
): Feed<T> {
  const [snapshot, setSnapshot] = useState({
    vaultPath,
    read,
    version,
    feed: { kind: 'loading' } as Feed<T>,
  });
  useEffect(() => {
    const setFeed = (feed: Feed<T>) => setSnapshot({ vaultPath, read, version, feed });
    if (vaultPath === null) {
      setFeed({ kind: 'unavailable' });
      return;
    }
    let live = true;
    setFeed({ kind: 'loading' });
    void (async () => {
      try {
        const data = await read(vaultPath);
        if (live) setFeed({ kind: 'ready', data });
      } catch {
        // A read behind a surface goes quiet rather than toasting (the
        // store-layer rule in AGENTS.md), and the section says what it could
        // not find out. Nothing is retried on a timer: these tabs speak when
        // they are opened and never on their own.
        if (live) setFeed({ kind: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
    // `read` is in the deps rather than suppressed. Every call site passes a
    // module-level IPC function or a memoized callback, so it is stable; an inline lambda would
    // re-fetch on every render, which is a defect this dependency makes loud
    // instead of hiding. `version` is the one deliberate re-read: an action
    // that changed what the feed would say bumps it.
  }, [vaultPath, read, version]);
  // Effects run after paint. Never paint the previous vault's answer, or a
  // previous query's answer, during the render that changes the read.
  return snapshot.vaultPath === vaultPath && snapshot.read === read && snapshot.version === version
    ? snapshot.feed
    : { kind: 'loading' };
}
