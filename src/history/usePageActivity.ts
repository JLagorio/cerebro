import { useEffect, useState } from 'react';
import type { PageAttribution } from '@/engine/attribution';
import type { FileCommit } from '@/engine/git';
import { useFileHistory, type GitRead } from '@/git/useGit';
import { pageActivity, pageAttribution, type HistoryPageActivity } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

/** One read, as a page's History renders it: nothing yet, what it found, or
 * that it failed. Failed is never empty (CV-05). */
export type PageRead<T> =
  { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: T };

export interface PageActivityReads {
  /** `page_activity`: the page's rows, runs and Knowledge events. */
  activity: PageRead<HistoryPageActivity>;
  /** M58.4's versions of the page. */
  history: GitRead<FileCommit[]>;
  /** M58.1b's last change, which says whether the page changed outside
   * Cerebro. */
  attribution: PageRead<PageAttribution>;
}

const LOADING = { kind: 'loading' } as const;
const UNAVAILABLE = { kind: 'unavailable' } as const;

/**
 * Run `read` for `key` and keep its answer beside the key it answers. A
 * render whose key has moved on shows `loading` until its own answer lands,
 * and a late answer to an old key is dropped: newer requests win.
 */
function useKeyedRead<T>(key: string | null, read: () => Promise<T>): PageRead<T> {
  const [answer, setAnswer] = useState<{ key: string; read: PageRead<T> } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    new Promise<T>((resolve) => resolve(read())).then(
      (data) => live && setAnswer({ key, read: { kind: 'ready', data } }),
      () => live && setAnswer({ key, read: UNAVAILABLE }),
    );
    return () => {
      live = false;
    };
    // `key` names everything `read` reads; a new closure alone is no new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the request's identity
  }, [key]);
  if (key === null) return UNAVAILABLE;
  return answer !== null && answer.key === key ? answer.read : LOADING;
}

/**
 * Everything one page's History tab reads (M64.2b): `page_activity`, its
 * versions (`useFileHistory`) and its last change (`page_attribution`). Each
 * read fails alone, so a failed one is said on its own line while the others
 * still render. The activity and the attribution read again when the page's
 * bytes change (`entry.hash`): a save, an agent's write or an outside edit
 * the scan has seen is a new answer.
 */
export function usePageActivity(path: string): PageActivityReads {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const hash = useVaultStore((s) => s.entries.find((e) => e.path === path)?.hash ?? null);
  const key = vaultPath === null ? null : JSON.stringify([vaultPath, path, hash]);
  const activity = useKeyedRead(key, () => pageActivity(vaultPath!, path));
  const attribution = useKeyedRead(key, () => pageAttribution(vaultPath!, path));
  const history = useFileHistory(path);
  return { activity, history, attribution };
}
