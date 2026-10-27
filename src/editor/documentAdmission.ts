import type { DocumentKey } from './documentOwner';

export type DocumentAdmission = { kind: 'ready' } | { kind: 'deferred'; settled: Promise<void> };
const READY: DocumentAdmission = { kind: 'ready' };
interface Reservation {
  vault: string;
  destinations: readonly string[];
  identities: ReadonlySet<object>;
  admission: DocumentAdmission;
  settle: () => void;
}
const reservations = new Set<Reservation>();
const listeners = new Set<() => void>();
const readers = new Set<DocumentKey>();
export const containsPath = (parent: string, path: string): boolean =>
  path === parent || path.startsWith(`${parent}/`);
export function documentAdmission(key: DocumentKey, identity?: object): DocumentAdmission {
  for (const reservation of reservations)
    if (
      key.vaultId === reservation.vault &&
      reservation.destinations.some((path) => containsPath(path, key.path)) &&
      (identity === undefined || !reservation.identities.has(identity))
    )
      return reservation.admission;
  return READY;
}
export function subscribeDocumentAdmission(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const notify = () => {
  for (const listener of listeners) listener();
};
/** Reservation carries no writer or payload. Readers wait before constructing
 * an editable owner, then read the authoritative destination after settlement. */
export function reserveDocumentDestinations(
  vault: string,
  destinations: readonly string[],
  identities: ReadonlySet<object>,
): () => void {
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  const reservation: Reservation = {
    vault,
    destinations,
    identities,
    admission: { kind: 'deferred', settled },
    settle: () => resolve(),
  };
  reservations.add(reservation);
  notify();
  return () => {
    if (!reservations.delete(reservation)) return;
    resolve();
    notify();
  };
}
export function documentReaderKeys(): DocumentKey[] {
  return [...readers].map((key) => ({ ...key }));
}
export function holdDocumentReader(key: DocumentKey): () => void {
  const captured = { ...key };
  readers.add(captured);
  return () => {
    readers.delete(captured);
  };
}
export async function waitForDocumentAdmission(
  key: DocumentKey,
  current: () => boolean,
  identity?: object,
): Promise<boolean> {
  while (current()) {
    const admission = documentAdmission(key, identity);
    if (admission.kind === 'ready') return true;
    await admission.settled;
  }
  return false;
}
export function resetDocumentAdmission(): void {
  readers.clear();
  // Claim owners settle their own promises; reset is explicit owner teardown.
  for (const reservation of [...reservations]) {
    reservations.delete(reservation);
    reservation.settle();
  }
  notify();
}
