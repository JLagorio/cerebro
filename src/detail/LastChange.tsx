import { useEffect, useState } from 'react';
import { attributionLine, type PageAttribution } from '@/engine/attribution';
import type { Entry } from '@/engine/types';
import { pageAttribution } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

type Read =
  { kind: 'loading' } | { kind: 'read'; attribution: PageAttribution } | { kind: 'unavailable' };

/**
 * Who last changed this page (M58.1b): one line at the top of the Info tab,
 * read from the operational write log through Rust's read-only
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
  return (
    <div data-testid="last-change" className="px-1.5 pb-1 pt-2 text-xs text-n-600">
      {read.kind === 'loading' && <span className="text-n-400">Reading who changed it…</span>}
      {read.kind === 'read' && (
        <span
          data-testid="last-change-line"
          data-state={read.attribution.state}
          title={
            read.attribution.state === 'recorded' || read.attribution.state === 'unattributed'
              ? (read.attribution.actor ?? undefined)
              : undefined
          }
        >
          {attributionLine(read.attribution, entries, new Date())}
        </span>
      )}
      {read.kind === 'unavailable' && (
        <span data-testid="section-unavailable" className="text-n-500">
          Who last changed this page could not be read.
        </span>
      )}
    </div>
  );
}
