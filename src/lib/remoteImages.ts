import { imageSource } from '@/engine/imageSource';

/** Session memory only. The exact trimmed URL is the authority a click grants;
 * a different URL on the same host still waits for its own click. */
const allowed = new Set<string>();
const listeners = new Set<() => void>();
export const remoteImageAllowed = (url: string) => allowed.has(url.trim());
export function allowRemoteImage(url: string): void {
  const value = url.trim();
  if (imageSource(value) !== 'remote' || allowed.has(value)) return;
  allowed.add(value);
  for (const notify of listeners) notify();
}
export function subscribeRemoteImages(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}
export function clearRemoteImages(): void {
  allowed.clear();
  for (const notify of listeners) notify();
}
export function imageHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'this address';
  }
}
