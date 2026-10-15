import { useEffect, useState } from 'react';
import { fileUrl } from '@/lib/rootsIpc';
import { VAULT_ROOT } from '@/engine/fileBytes';
import { useVaultStore } from '@/stores/vaultStore';

/** The one root-file image. Neither dragging nor saving exposes its transient URL. */
export function FileImage({
  rootId,
  path,
  alt,
  className,
  fit = 'contain',
  onError,
  testId = 'file-image',
}: {
  rootId: string;
  path: string;
  alt?: string;
  className?: string;
  fit?: 'contain' | 'cover';
  onError?: () => void;
  testId?: string;
}) {
  const vault = useVaultStore((s) => (rootId === VAULT_ROOT ? s.vaultPath : null));
  const [image, setImage] = useState<{ key: string; url: string | null; error: boolean }>({
    key: '',
    url: null,
    error: false,
  });
  const key = JSON.stringify([rootId, path, vault]);
  useEffect(() => {
    let live = true;
    setImage({ key, url: null, error: false });
    void fileUrl(rootId, path)
      .then((result) => {
        if (live)
          setImage({
            key,
            url: typeof result === 'string' ? result : null,
            error: typeof result !== 'string',
          });
      })
      .catch(() => {
        if (live) setImage({ key, url: null, error: true });
      });
    return () => {
      live = false;
    };
  }, [key, rootId, path]);
  const current = image.key === key ? image : null;
  useEffect(() => {
    if (image.key === key && image.error) onError?.();
  }, [image.key, image.error, key, onError]);
  if (current?.error)
    return (
      <span role="status" data-testid="file-image-unavailable">
        Image unavailable: {path}
      </span>
    );
  if (current?.url == null)
    return <span data-testid="file-image-loading" aria-label="Loading image" />;
  return (
    <img
      data-testid={testId}
      data-path={path}
      className={className}
      src={current.url}
      alt={alt ?? path.split('/').at(-1) ?? path}
      draggable={false}
      loading="lazy"
      decoding="async"
      style={{ objectFit: fit }}
      onError={() => {
        setImage({ key, url: null, error: true });
      }}
    />
  );
}
