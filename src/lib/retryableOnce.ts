/**
 * A lazily started engine every caller shares, that forgets a failed start
 * (M93.12, audit BL-195). A plain `cache ??= start()` keeps a rejected promise,
 * so one dead worker or failed import refuses every later use until relaunch.
 * Here a rejection, or `expire()` once a started engine dies, clears the
 * cache, and the next caller starts afresh. Callers in flight share one start.
 */
export function retryableOnce<T>(start: (expire: () => void) => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => {
    if (current !== null) return current;
    const attempt: { promise: Promise<T> | null } = { promise: null };
    const expire = () => {
      if (current !== null && current === attempt.promise) current = null;
    };
    attempt.promise = start(expire);
    current = attempt.promise;
    attempt.promise.catch(expire);
    return attempt.promise;
  };
}
