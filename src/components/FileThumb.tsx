import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from './ui/Icon';
import { fileLook } from '@/engine/fileKinds';
import { thumbReason, thumbSource, type Thumbnail, type ThumbReason } from '@/engine/thumbs';
import { requestThumb, subscribeThumbVisit, thumbVisit } from '@/lib/thumbQueue';

/** Derived image only: the source path never becomes an img src. */
export function FileThumb({
  rootId,
  path,
  size = 256,
  eager = false,
  alt,
  className,
  fit = 'contain',
  compact = false,
  caption = false,
  fallback,
}: {
  rootId: string;
  path: string;
  size?: number;
  eager?: boolean;
  alt?: string;
  className?: string;
  fit?: 'cover' | 'contain';
  compact?: boolean;
  caption?: boolean;
  fallback?: (reason: ThumbReason) => ReactNode;
}) {
  const epoch = useSyncExternalStore(subscribeThumbVisit, thumbVisit, thumbVisit);
  const key = JSON.stringify([epoch, rootId, path, size]);
  const host = useRef<HTMLSpanElement>(null);
  const [read, setRead] = useState<{ key: string; result: Thumbnail } | null>(null);
  useEffect(() => {
    let live = true;
    let started = false;
    const current = () => live && thumbVisit() === epoch;
    const load = () => {
      if (started || !current()) return;
      started = true;
      void requestThumb(rootId, path, size, String(epoch), current)
        .then((result) => {
          if (current()) setRead({ key, result });
        })
        .catch(() => {
          if (current()) setRead({ key, result: { state: 'none', reason: 'corrupt' } });
        });
    };
    let observer: IntersectionObserver | undefined;
    if (eager || typeof IntersectionObserver === 'undefined') load();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            load();
          }
        },
        { rootMargin: '200px' },
      );
      if (host.current) observer.observe(host.current);
    }
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [key, epoch, rootId, path, size, eager]);
  const result = read?.key === key ? read.result : null;
  const label = alt ?? path.split('/').at(-1) ?? path;
  let body;
  if (result?.state === 'ready') {
    const source = thumbSource(result.source);
    body = (
      <>
        <img
          data-testid="file-thumb-image"
          src={result.dataUrl}
          alt={label}
          draggable={false}
          loading="lazy"
          decoding="async"
          className="h-full w-full"
          style={{ objectFit: fit }}
          onError={() => setRead({ key, result: { state: 'none', reason: 'corrupt' } })}
        />
        {caption && source && <span className="text-xs text-n-500">{source}</span>}
      </>
    );
  } else if (result?.state === 'none') {
    body = fallback ? (
      fallback(result.reason)
    ) : (
      <span
        title={thumbReason(result.reason)}
        role="img"
        aria-label={`${label}: ${thumbReason(result.reason)}`}
        className="inline-flex max-w-full flex-col items-center justify-center gap-1 text-n-500"
      >
        <Icon name={fileLook(path).icon} size={compact ? 16 : 24} />
        {!compact && <span className="text-xs">{thumbReason(result.reason)}</span>}
      </span>
    );
  } else
    body = (
      <span aria-label={`Loading preview of ${label}`}>
        <Icon name={fileLook(path).icon} size={compact ? 16 : 24} color="var(--n-400)" />
      </span>
    );
  return (
    <span ref={host} className={className} data-testid="file-thumb" data-path={path}>
      {body}
    </span>
  );
}
