import { useMemo } from 'react';
import { listConcepts, type Concept } from '@/engine/okf';
import { todayIso } from '@/lib/templates';
import { useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The bundle as every surface should read it (M50.1): the vault's entries,
 * judged against today and against the ledger's own review record — so a
 * concept reads the same wherever it is opened.
 */
export function useConcepts(): Concept[] {
  const entries = useVaultStore((s) => s.entries);
  const quarantine = useQuarantine();
  const ledgerReview = useLedgerReview();
  const today = todayIso();
  return useMemo(
    () => listConcepts(entries, today, quarantine, ledgerReview),
    [entries, today, quarantine, ledgerReview],
  );
}

/** One concept by path, or null when the path is not a concept. */
export function useConcept(path: string | null): Concept | null {
  const all = useConcepts();
  return useMemo(
    () => (path === null ? null : (all.find((c) => c.entry.path === path) ?? null)),
    [all, path],
  );
}
