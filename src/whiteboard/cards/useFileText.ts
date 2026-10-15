import { useEffect, useState } from 'react';
import { readCanvasFile, readNote } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

export type FileTextState =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'unavailable'; reason: string }
  | { state: 'ready'; text: string };
const cache = new Map<string, Promise<FileTextState>>();
export function resetFileTextCache() {
  cache.clear();
}
function read(vault: string, path: string, hash: string | null | undefined) {
  const key = JSON.stringify([vault, path, hash]);
  const prior = cache.get(key);
  if (prior) {
    cache.delete(key);
    cache.set(key, prior);
    return prior;
  }
  const pending: Promise<FileTextState> = (async () => {
    try {
      if (/\.canvas$/i.test(path)) {
        const result = await readCanvasFile(vault, path);
        return result.ok
          ? { state: 'ready', text: result.content }
          : result.refusal.code === 'missing'
            ? { state: 'missing' }
            : { state: 'unavailable', reason: result.refusal.message };
      }
      return { state: 'ready', text: await readNote(vault, path) };
    } catch {
      return {
        state: 'unavailable',
        reason: /\.canvas$/i.test(path)
          ? 'This whiteboard could not be read. Try opening it again.'
          : 'This diagram could not be read. Try opening it again.',
      };
    }
  })();
  cache.set(key, pending);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  void pending.then((result) => {
    if (result.state !== 'ready' && cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}
/** Vault identity is part of every cache and render key. Failed reads never cache.
 * Concurrent cards share the in-flight promise; a changed hash reads new bytes. */
export function useFileText(
  path: string,
  hash: string | null | undefined,
  enabled = true,
): FileTextState {
  const vault = useVaultStore((s) => s.vaultPath);
  const key = JSON.stringify([vault, path, hash, enabled]);
  const [result, setResult] = useState<{ key: string; value: FileTextState } | null>(null);
  useEffect(() => {
    let live = true;
    if (!enabled) return;
    if (!vault) {
      setResult({
        key,
        value: { state: 'unavailable', reason: 'Open a vault to read this file.' },
      });
      return;
    }
    void read(vault, path, hash).then((value) => {
      if (live) setResult({ key, value });
    });
    return () => {
      live = false;
    };
  }, [key, vault, path, hash, enabled]);
  return result?.key === key ? result.value : { state: 'loading' };
}
