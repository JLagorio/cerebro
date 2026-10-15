import { useEffect, useRef, useState } from 'react';
import { searchVault, type VaultSearch } from '@/lib/ipc';

/** How long typing must pause before page text is searched (M59.4). */
export const CONTENT_DEBOUNCE_MS = 250;
/** The fewest characters (code points of the trimmed query) worth a search. */
export const CONTENT_MIN_CHARS = 3;
/** The most hits one search asks for: "All N matches" expands to these. */
export const CONTENT_LIMIT = 50;

/**
 * Where ⌘K's page-text search stands for the query on screen: nothing
 * asked (`idle`), asked and not yet answered (`pending`), answered
 * (`ready`), or failed (`unavailable`, which is never an empty answer:
 * CV-05).
 */
export type ContentSearch =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ready'; result: VaultSearch }
  | { status: 'unavailable' };

/** What an answer was for: an answer lands only on the query it answers. */
const keyOf = (vault: string | null, trimmed: string, enabled: boolean): string =>
  JSON.stringify([vault, trimmed, enabled]);

/** The query is long enough, there is a vault, and searching is on. */
function asks(vault: string | null, trimmed: string, enabled: boolean): vault is string {
  return enabled && vault !== null && Array.from(trimmed).length >= CONTENT_MIN_CHARS;
}

/**
 * ⌘K's page-text search (M59.4): `searchVault` once typing pauses for
 * `CONTENT_DEBOUNCE_MS`, on a trimmed query of `CONTENT_MIN_CHARS` or more,
 * while `enabled` and a vault is open. Only the latest call's answer lands:
 * every change of query, vault or `enabled` bumps a sequence, and an answer
 * or a failure from an older call is dropped. The state is read against the
 * query on screen, so a stale answer never shows under a new query.
 */
export function useContentSearch(
  vault: string | null,
  query: string,
  enabled: boolean,
): ContentSearch {
  const trimmed = query.trim();
  const key = keyOf(vault, trimmed, enabled);
  const [landed, setLanded] = useState<{ key: string; state: ContentSearch } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (!asks(vault, trimmed, enabled)) return;
    const timer = setTimeout(() => {
      searchVault(vault, trimmed, CONTENT_LIMIT).then(
        (result) => {
          if (seq.current === mine) setLanded({ key, state: { status: 'ready', result } });
        },
        () => {
          // No toast, on purpose (CV-03's written reason): this runs on a
          // pause in typing, so a toast per failure would flood the screen.
          // The palette says the page text couldn't be searched instead.
          if (seq.current === mine) setLanded({ key, state: { status: 'unavailable' } });
        },
      );
    }, CONTENT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, vault, trimmed, enabled]);

  if (!asks(vault, trimmed, enabled)) return { status: 'idle' };
  if (landed?.key === key) return landed.state;
  return { status: 'pending' };
}
