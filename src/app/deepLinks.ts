import { listenDeepLinks, takeDeepLink } from '@/lib/ipc';

export type LinkVault = {
  id: string;
  lookup: { kind: 'found'; path: string } | { kind: 'unknown' | 'unreadable' };
};
export type DeepLink =
  | { kind: 'open'; path: string; vault: LinkVault | null }
  | {
      kind: 'go';
      to: string;
      database: string | null;
      view: string | null;
      vault: LinkVault | null;
    }
  | { kind: 'refused'; reason: string };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** Validate the IPC shape, never parse a URL: Rust owns that grammar. */
export function readDeepLink(value: unknown): DeepLink | null {
  if (!record(value)) return null;
  if (value.kind === 'refused')
    return typeof value.reason === 'string' ? { kind: 'refused', reason: value.reason } : null;
  const vault = value.vault;
  if (vault !== null) {
    if (!record(vault) || typeof vault.id !== 'string' || !record(vault.lookup)) return null;
    const lookup = vault.lookup;
    if (!(
      (lookup.kind === 'found' && typeof lookup.path === 'string') ||
      lookup.kind === 'unknown' ||
      lookup.kind === 'unreadable'
    ))
      return null;
  }
  if (value.kind === 'open' && typeof value.path === 'string')
    return { kind: 'open', path: value.path, vault: vault as LinkVault | null };
  if (
    value.kind === 'go' &&
    typeof value.to === 'string' &&
    nullableText(value.database) &&
    nullableText(value.view)
  )
    return {
      kind: 'go',
      to: value.to,
      database: value.database,
      view: value.view,
      vault: vault as LinkVault | null,
    };
  return null;
}

let queue: DeepLink[] = [];
let primed: Promise<void> | null = null;
let taking = false;
let unlisten: (() => void) | null = null;
let revision = 0;
const listeners = new Set<() => void>();
const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
export const subscribeDeepLinks = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const deepLinkRevision = (): number => revision;

/** Bind first, then take once, even under StrictMode. Events arriving during
 * the take follow the older inbox value when the reply reaches the webview. */
export function primeDeepLinks(): Promise<void> {
  if (primed !== null) return primed;
  taking = true;
  primed = (async () => {
    try {
      unlisten = await listenDeepLinks((payload) => {
        const link = readDeepLink(payload);
        if (link !== null) queue.push(link);
        if (!taking) changed();
      });
      const held = readDeepLink(await takeDeepLink());
      if (held !== null) queue.unshift(held);
    } catch {
      queue.push({ kind: 'refused', reason: "Cerebro couldn't read its incoming links" });
    } finally {
      taking = false;
      changed();
    }
  })();
  return primed;
}
export function shiftDeepLink(): DeepLink | null {
  if (taking) return null;
  return queue.shift() ?? null;
}
export function deepLinksPriming(): boolean {
  return taking;
}
export function hasPendingDeepLink(vault: string): boolean {
  // Any queued link owns startup, including a refused link or a vault-switch
  // confirmation: restoring behind either would add an unrelated back entry.
  return vault.length > 0 && (taking || queue.length > 0);
}
/** A confirmed switch keeps its link ahead of last-place restoration while
 * the new vault's first scan is pending. */
export function returnDeepLink(link: DeepLink): void {
  queue.unshift(link);
  changed();
}
/** Test isolation only; production primes once for the life of the webview. */
export function __resetDeepLinks(): void {
  unlisten?.();
  unlisten = null;
  queue = [];
  primed = null;
  taking = false;
  revision++;
}
