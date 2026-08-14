import { useEffect, useState } from 'react';
import { KNOWLEDGE_DIR } from '@/engine/okf';
import * as ipc from '@/lib/ipc';
import type { BeliefChips } from '@/lib/ipc';

/**
 * The three axes for every projected concept, indexed by the path a surface
 * already has (M27.5c).
 *
 * **`unavailable` and an empty index are different answers.** A vault with no
 * ledger cannot say anything about Support or Coverage; a readable ledger that
 * simply does not hold this file CAN, and what it says is "this is not in the
 * ledger". Collapsing the two would make the first render as the second, so
 * the state is tagged and the caller decides.
 *
 * **The path join happens here, once.** The ledger records a
 * knowledge-relative projection path (`metrics/sync-error-rate.md`) and the
 * vault scanner produces vault-relative ones
 * (`knowledge/metrics/sync-error-rate.md`). One of them has to move; doing it
 * at every call site is how a surface ends up silently matching nothing.
 */
export type ChipsIndex =
  { kind: 'unavailable' } | { kind: 'ready'; byPath: Map<string, BeliefChips> };

export const NO_CHIPS: ChipsIndex = { kind: 'unavailable' };

export function indexChips(rows: BeliefChips[]): ChipsIndex {
  const byPath = new Map<string, BeliefChips>();
  for (const row of rows) {
    if (row.path === null) continue; // a belief no file projects
    byPath.set(`${KNOWLEDGE_DIR}/${row.path}`, row);
  }
  return { kind: 'ready', byPath };
}

/** One row, or null when this surface has no answer for this path. */
export function chipsFor(index: ChipsIndex, path: string): BeliefChips | null {
  return index.kind === 'ready' ? (index.byPath.get(path) ?? null) : null;
}

export function useBeliefChips(vaultPath: string | null): ChipsIndex {
  const [index, setIndex] = useState<ChipsIndex>(NO_CHIPS);

  useEffect(() => {
    if (vaultPath === null) {
      setIndex(NO_CHIPS);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const rows = await ipc.beliefChips(vaultPath);
        if (live) setIndex(indexChips(rows));
      } catch {
        // A vault with no ledger REFUSES rather than answering `[]`, and this
        // is a read behind a surface: it goes quiet rather than toasting.
        // Nothing renders, which is the only honest thing to render when
        // nobody derived an answer.
        if (live) setIndex(NO_CHIPS);
      }
    })();
    return () => {
      live = false;
    };
  }, [vaultPath]);

  return index;
}
