import { snapThumbSize, type Thumbnail } from '@/engine/thumbs';
import { fileThumbnail } from './rootsIpc';
import { useVaultStore } from '@/stores/vaultStore';

let visit = 0;
const listeners = new Set<() => void>();
useVaultStore.subscribe((next, previous) => {
  if (next.vaultPath !== previous.vaultPath) {
    visit += 1;
    for (const notify of listeners) notify();
  }
});
export const thumbVisit = () => visit;
export const subscribeThumbVisit = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};

type Read = (root: string, path: string, size: number) => Promise<Thumbnail>;
/** Four IPC reads at a time, FIFO, sharing only in-flight work. The native
 * cache owns freshness; retaining resolved URLs here would hide a changed file. */
export function makeThumbQueue(read: Read, concurrency = 4) {
  let running = 0;
  const pending: (() => void)[] = [];
  const active = new Map<string, { promise: Promise<Thumbnail>; readers: (() => boolean)[] }>();
  const pump = () => {
    while (running < concurrency && pending.length > 0) pending.shift()!();
  };
  return (
    root: string,
    path: string,
    size: number,
    visit: string,
    current: () => boolean = () => true,
  ): Promise<Thumbnail> => {
    const snapped = snapThumbSize(size);
    const key = JSON.stringify([visit, root, path, snapped]);
    const existing = active.get(key);
    if (existing) {
      existing.readers.push(current);
      return existing.promise;
    }
    const readers = [current];
    const result = new Promise<Thumbnail>((resolve, reject) => {
      pending.push(() => {
        running += 1;
        void Promise.resolve()
          .then(() =>
            readers.some((reader) => reader())
              ? read(root, path, snapped)
              : { state: 'none' as const, reason: 'notFound' as const },
          )
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            active.delete(key);
            pump();
          });
      });
    });
    active.set(key, { promise: result, readers });
    pump();
    return result;
  };
}
export const requestThumb = makeThumbQueue((root, path, size) => fileThumbnail(root, path, size));
