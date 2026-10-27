import type { PendingInteraction } from './types';

/** Closed managed card kinds share original-call lifecycle, never CLI resume. */
export function isManagedInteraction(card: PendingInteraction | null | undefined): boolean {
  return card?.kind === 'managed_action' || card?.kind === 'managed_access';
}

/** A native view's original selector only; commands authenticate it again. */
export function managedRunSelector(card: PendingInteraction): number | null {
  const run = card.run;
  return isManagedInteraction(card) && typeof run === 'number' && Number.isSafeInteger(run) && run >= 0
    ? run
    : null;
}
