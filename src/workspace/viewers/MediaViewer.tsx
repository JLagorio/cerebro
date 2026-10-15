import { useEffect, useState } from 'react';
import { fileUrl } from '@/lib/rootsIpc';
import { VAULT_ROOT, type FileProbe } from '@/engine/fileBytes';
import { useVaultStore } from '@/stores/vaultStore';
const ERRORS: Record<number, string> = {
  1: 'Playback was stopped.',
  2: 'This media could not be read.',
  3: 'This media could not be decoded.',
  4: 'This media format cannot be played here.',
};
export function MediaViewer({
  rootId,
  path,
  probe,
}: {
  rootId: string;
  path: string;
  probe: FileProbe;
}) {
  const vault = useVaultStore((s) => (rootId === VAULT_ROOT ? s.vaultPath : null));
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSource(null);
    setError(null);
    void fileUrl(rootId, path)
      .then((result) => {
        if (live) {
          if (typeof result === 'string') setSource(result);
          else setError(result.message);
        }
      })
      .catch(() => {
        if (live) setError('This media could not be read.');
      });
    return () => {
      live = false;
    };
  }, [rootId, path, vault]);
  const Tag = probe.kind === 'video' ? 'video' : 'audio';
  return (
    <div className="media-viewer" data-testid="media-viewer">
      {error !== null ? (
        <p role="status">{error}</p>
      ) : source !== null ? (
        <Tag
          key={source}
          controls
          preload="metadata"
          src={source}
          aria-label={path.split('/').at(-1)}
          onError={(event) => setError(ERRORS[event.currentTarget.error?.code ?? 4] ?? ERRORS[4])}
        />
      ) : (
        <span>Loading media…</span>
      )}
    </div>
  );
}
