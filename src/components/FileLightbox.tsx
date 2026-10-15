import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { FileImage } from './FileImage';
import { FileActions } from '@/workspace/viewers/FileActions';
import { probeFile } from '@/lib/rootsIpc';
import { isFileRefusal, type FileProbe } from '@/engine/fileBytes';
import { useVaultStore } from '@/stores/vaultStore';

export function FileLightbox({
  paths,
  initialIndex = 0,
  onClose,
}: {
  paths: readonly string[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const current = Math.min(Math.max(index, 0), Math.max(0, paths.length - 1));
  const path = paths[current];
  const vault = useVaultStore((s) => s.vaultPath);
  const key = JSON.stringify([vault, path]);
  const [read, setRead] = useState<{ key: string; probe?: FileProbe; error?: string }>({ key: '' });
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (path === undefined) return;
    let live = true;
    void probeFile('0', path)
      .then((probe) => {
        if (live) setRead(isFileRefusal(probe) ? { key, error: probe.message } : { key, probe });
      })
      .catch(() => {
        if (live) setRead({ key, error: "Couldn't read this image" });
      });
    return () => {
      live = false;
    };
  }, [key, path]);
  useEffect(() => {
    const dialog = content.current?.closest('[role="dialog"]');
    const keys = (event: Event) => {
      const e = event as KeyboardEvent;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        setIndex((i) =>
          Math.max(0, Math.min(paths.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1))),
        );
      }
    };
    dialog?.addEventListener('keydown', keys);
    return () => dialog?.removeEventListener('keydown', keys);
  }, [paths.length]);
  if (path === undefined) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={path.split('/').at(-1) ?? path}
      width={960}
      footerNote={
        read.key === key && read.probe ? (
          <FileActions rootId="0" path={path} probe={read.probe} />
        ) : undefined
      }
    >
      <div ref={content} data-testid="file-lightbox" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" disabled={current === 0} onClick={() => setIndex(current - 1)}>
            Previous image
          </Button>
          <span aria-live="polite">
            {current + 1} of {paths.length}
          </span>
          <Button
            size="sm"
            disabled={current === paths.length - 1}
            onClick={() => setIndex(current + 1)}
          >
            Next image
          </Button>
        </div>
        {read.key === key && read.error ? (
          <p role="status">{read.error}</p>
        ) : (
          <div className="relative h-[min(60vh,560px)] min-w-0">
            <FileImage
              rootId="0"
              path={path}
              className="absolute inset-0 m-auto max-h-full max-w-full"
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}
