import { useCallback, useLayoutEffect, useRef } from 'react';
import { useVaultStore } from '@/stores/vaultStore';

/** Capture the owner of an asynchronous UI action before its first await.
 * Check the returned guard before every later mutation. A vault round trip
 * also invalidates it, even when React batches both switches into one render. */
export function useVaultActionGuard(owner: string) {
  const life = useRef({ generation: 0, mounted: false });
  useLayoutEffect(() => {
    const current = life.current;
    current.mounted = true;
    current.generation += 1;
    const unsubscribe = useVaultStore.subscribe((next, previous) => {
      if (next.vaultPath !== previous.vaultPath) current.generation += 1;
    });
    return () => {
      current.mounted = false;
      current.generation += 1;
      unsubscribe();
    };
  }, [owner]);
  return useCallback(() => {
    const current = life.current;
    const generation = current.generation;
    const vault = useVaultStore.getState().vaultPath;
    return () =>
      current.mounted &&
      current.generation === generation &&
      useVaultStore.getState().vaultPath === vault;
  }, []);
}
