import { useState, useSyncExternalStore } from 'react';
import { imageSource } from '@/engine/imageSource';
import {
  allowRemoteImage,
  imageHost,
  remoteImageAllowed,
  subscribeRemoteImages,
} from '@/lib/remoteImages';

export function RemoteImage({
  src,
  alt = '',
  className,
  fit = 'contain',
}: {
  src: string;
  alt?: string;
  className?: string;
  fit?: 'cover' | 'contain';
}) {
  const source = src.trim();
  const kind = imageSource(source);
  const allowed = useSyncExternalStore(
    subscribeRemoteImages,
    () => remoteImageAllowed(source),
    () => false,
  );
  const [failed, setFailed] = useState<string | null>(null);
  if (kind === 'insecure')
    return <span className="text-xs text-n-500">HTTP images are not allowed.</span>;
  if (kind !== 'remote' && kind !== 'data')
    return <span className="text-xs text-n-500">This image address is not allowed.</span>;
  if (failed === source)
    return <span className="text-xs text-n-500">This image couldn't be loaded.</span>;
  if (kind === 'remote' && !allowed)
    return (
      <span
        data-testid="remote-image-gate"
        className="inline-flex items-center gap-2 rounded-md border border-n-200 px-3 py-2 text-xs text-n-600"
      >
        <span>{imageHost(source)}</span>
        <button
          type="button"
          className="rounded-sm border border-n-200 px-2 py-1 text-n-800"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            allowRemoteImage(source);
          }}
        >
          Load image
        </button>
      </span>
    );
  return (
    <img
      src={source}
      alt={alt}
      referrerPolicy="no-referrer"
      loading="lazy"
      draggable={false}
      className={className}
      style={{ objectFit: fit }}
      onError={() => setFailed(source)}
    />
  );
}
