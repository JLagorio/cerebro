import { EMPTY_BOARD, writeCanvas } from '@/engine/scene/jsonCanvas';
import { createCanvasFile } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

/** A creation primitive: its human UI callers catch and name a refusal. */
export async function newBoardFile(
  vault: string,
  rel: string,
  content = writeCanvas(EMPTY_BOARD),
): Promise<string> {
  let current = useVaultStore.getState().vaultPath === vault;
  const unsubscribe = useVaultStore.subscribe((next, previous) => {
    if (next.vaultPath !== previous.vaultPath) current = false;
  });
  try {
    const result = await createCanvasFile(vault, rel, content, 'commit');
    if (!result.ok) throw new Error(result.refusal.message);
    if (current) await useVaultStore.getState().rescan();
    return result.path;
  } finally {
    unsubscribe();
  }
}
