import { useEffect, useState } from 'react';
import { attributionLine, attributionValue, type PageAttribution } from '@/engine/attribution';
import type { Entry } from '@/engine/types';
import { pageAttribution } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

type Read =
  { kind: 'loading' } | { kind: 'read'; attribution: PageAttribution } | { kind: 'unavailable' };

/**
 * Who last changed this page (M58.1b): the value of the "Changed by" row in
 * the inspector's Info section — who and when, with the whole sentence in
 * its tooltip — read from the operational write log through Rust's read-only
 * `page_attribution`.
 *
 * It reads again whenever the page's bytes change (`entry.hash`), so a save,
 * an agent's write or an outside edit is reflected once the scan has seen it.
 * A read that fails says so (`section-unavailable`), never "not recorded":
 * "nobody recorded a writer" and "we could not look" are opposite sentences
 * (CV-05). With no vault open there is nothing to ask, and nothing renders.
 */
export function LastChange({ entry }: { entry: Entry }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const { path, hash } = entry;

  useEffect(() => {
    if (vaultPath === null) return;
    let live = true;
    setRead({ kind: 'loading' });
    pageAttribution(vaultPath, path).then(
      (attribution) => live && setRead({ kind: 'read', attribution }),
      () => live && setRead({ kind: 'unavailable' }),
    );
    return () => {
      live = false;
    };
    // `hash` is the page's content identity: a new one is a new answer.
  }, [vaultPath, path, hash]);

  if (vaultPath === null) return null;
  const now = new Date();
  return (
    <span data-testid="last-change" className="min-w-0 truncate">
      {read.kind === 'loading' && <span className="text-n-400">Reading…</span>}
      {read.kind === 'read' && (
        <span
          data-testid="last-change-line"
          data-state={read.attribution.state}
          data-actor={
            read.attribution.state === 'recorded' || read.attribution.state === 'unattributed'
              ? (read.attribution.actor ?? undefined)
              : undefined
          }
          title={attributionLine(read.attribution, entries, now)}
          className={read.attribution.state === 'recorded' ? undefined : 'text-n-400'}
        >
          {attributionValue(read.attribution, entries, now)}
        </span>
      )}
      {read.kind === 'unavailable' && (
        <span
          data-testid="section-unavailable"
          title="Who last changed this page could not be read."
          className="text-n-400"
        >
          Couldn&rsquo;t read
        </span>
      )}
    </span>
  );
}
