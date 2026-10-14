/**
 * The browser backend's one fault seam (M64.1).
 *
 * The state lab, vitest and the e2e specs all need a section to meet a read
 * that FAILS, because "we could not tell you" is a state every section renders
 * (CV-05) and the mock otherwise always answers. `failNext(command)` arms one
 * failure for a Tauri command name; the browser branch of that command in an
 * adapter runs through `faulted(command, run)`, which rejects while armed.
 *
 * **One failure is one burst, not one call.** The first rejection disarms on
 * `setTimeout(0)`, so every call of that command in the same task fails too.
 * StrictMode mounts each effect twice and a section may read in parallel; if
 * only the first call failed, the second would land and paper over it, and
 * the failure would be invisible. The next read after that task recovers, so
 * a remount reads again. Arming twice fails two separate bursts.
 *
 * Only browser branches pass through here. The Tauri branches never do, so a
 * packaged build cannot be told to fail, and a part wraps exactly the commands
 * its presets fail (the source scan in `mockFaults.test.ts` holds every
 * `faulted('x'` beside an invoke of `'x'`).
 */

/** Armed failures still waiting for a burst, by command. */
const armed = new Map<string, number>();
/** Commands whose burst is in progress this task. */
const failing = new Set<string>();

function message(command: string): string {
  return `state lab: ${command} was told to fail once`;
}

/** Arm one failure: the next read of `command` (and every read in its task) fails. */
export function failNext(command: string): void {
  armed.set(command, (armed.get(command) ?? 0) + 1);
}

/** Every command with an armed failure, and how many bursts are left. */
export function armedFaults(): Record<string, number> {
  return Object.fromEntries([...armed.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Disarm everything, including a burst in progress. */
export function resetFaults(): void {
  armed.clear();
  failing.clear();
}

/**
 * Run a browser-branch read, unless `command` was told to fail.
 *
 * The check is synchronous, at call time, so a call made in the burst's task
 * fails whether or not an earlier one has settled yet.
 */
export function faulted<T>(command: string, run: () => Promise<T>): Promise<T> {
  if (failing.has(command)) return Promise.reject(new Error(message(command)));
  const left = armed.get(command) ?? 0;
  if (left === 0) return run();
  if (left === 1) armed.delete(command);
  else armed.set(command, left - 1);
  failing.add(command);
  setTimeout(() => failing.delete(command), 0);
  return Promise.reject(new Error(message(command)));
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cerebroFailNext: typeof failNext }).__cerebroFailNext = failNext;
}
