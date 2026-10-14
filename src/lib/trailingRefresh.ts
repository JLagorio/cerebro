/**
 * One refresh at a time, plus one trailing, and a fence that keeps a refresh
 * from landing over a write it read before (M58.2).
 *
 * Pure: no imports, no store. `vaultStore` builds its rescan from these two,
 * and so does any later caller that needs one ordered, coalesced reread.
 *
 * Never gated on visibility or focus. Triggers ride on rescans, so a hidden
 * window that stopped refreshing would stop running its automations too; a
 * tripwire in the test keeps those reads out of this file and its callers.
 */

/** What one pass of a refresh did. `'again'` asks for one more pass in the
 *  same cycle: what it read is stale, and nothing landed. */
export type PassOutcome = 'done' | 'again' | 'failed';

/**
 * Coalesce calls to `pass` into cycles: one pass running, at most one more
 * trailing behind it, however many calls arrive.
 *
 * - A call with no cycle running starts one on a microtask, so calls in the
 *   same tick, and a pass that calls the refresh while it runs, join it.
 * - A call while a pass runs asks for ONE trailing pass, which starts after
 *   that pass ends. Every such call shares it.
 * - `'again'` runs one more pass in the same cycle.
 *
 * Every caller of a cycle shares its promise, which resolves when the cycle
 * ends: never before a pass that started after the call. It never rejects; a
 * pass that throws counts as `'failed'`. `onFailed` runs once per cycle, and
 * only when the cycle's LAST pass failed: a trailing pass that succeeds has
 * already put things right.
 */
export function coalescedRefresh(
  pass: () => Promise<PassOutcome>,
  onFailed: () => void,
): () => Promise<void> {
  let requested = false;
  let cycle: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    // One microtask, so every call made in this tick joins the first pass.
    await Promise.resolve();
    let last: PassOutcome = 'done';
    while (requested) {
      requested = false;
      try {
        last = await pass();
      } catch {
        last = 'failed';
      }
      if (last === 'again') requested = true;
    }
    // Synchronous with the loop's last check: a call from here on finds no
    // cycle and starts its own, so none is left unanswered.
    cycle = null;
    if (last === 'failed') {
      try {
        onFailed();
      } catch {
        // The hook is a toast; a refresh still never rejects.
      }
    }
  };

  return () => {
    requested = true;
    if (cycle === null) cycle = run();
    return cycle;
  };
}

/** Where the fence stood when a reader started: compare it with `moved`. */
export interface FenceMark {
  readonly generation: number;
  readonly pending: number;
}

/**
 * Optimistic writes in flight. A reader marks the fence before it reads; if
 * a write began or ended while it read, what it read may predate the write,
 * and it must not land.
 */
export interface WriteFence {
  /** A write starts: returns its `end`, which is idempotent. */
  begin(): () => void;
  mark(): FenceMark;
  /** True when a write began or ended since `mark` was taken. */
  moved(mark: FenceMark): boolean;
  /**
   * Resolves at once when no write is pending, with no timer. Otherwise on
   * the last `end`, or after `budgetMs`, whichever is first: a write that
   * never answers must not hold every reader behind it.
   */
  settled(budgetMs: number): Promise<void>;
  /** A reader landed over a pending write: the last `end` calls `onOwed`. */
  owe(): void;
}

/** A fence whose last `end` calls `onOwed` when a reader landed past it. */
export function writeFence(onOwed: () => void): WriteFence {
  let pending = 0;
  let generation = 0;
  let owed = false;
  let waiters: Array<() => void> = [];

  return {
    begin() {
      pending += 1;
      generation += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        pending -= 1;
        generation += 1;
        if (pending > 0) return;
        const woken = waiters;
        waiters = [];
        for (const wake of woken) wake();
        if (owed) {
          owed = false;
          onOwed();
        }
      };
    },
    mark: () => ({ generation, pending }),
    moved: (mark) => mark.generation !== generation,
    settled(budgetMs) {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== wake);
          resolve();
        };
        const timer = setTimeout(wake, budgetMs);
        waiters.push(wake);
      });
    },
    owe() {
      owed = true;
    },
  };
}
