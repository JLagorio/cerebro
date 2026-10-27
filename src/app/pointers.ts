import { followDocumentRename } from '@/editor/openPages';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useVaultStore } from '@/stores/vaultStore';
import { remapLastPlace, renameLastPlaceType } from './lastPlace';

const safely = (move: () => void): void => {
  try {
    move();
  } catch {
    /* Local pointers never turn a successful disk rename into a failed action. */
  }
};
/** applyBatch announces/rescans before returning. Hold pruning until every
 * successful step has moved its pointers, including an Undo/Redo sequence. */
export function beginPointerRename(vault: string): () => void {
  useUiStore.setState((state) => ({
    pendingRenames: { ...state.pendingRenames, [vault]: (state.pendingRenames[vault] ?? 0) + 1 },
  }));
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    useUiStore.setState((state) => {
      const pendingRenames = { ...state.pendingRenames };
      const next = (pendingRenames[vault] ?? 1) - 1;
      if (next > 0) pendingRenames[vault] = next;
      else delete pendingRenames[vault];
      return { pendingRenames };
    });
  };
}
/** Follow only a landed move. Other vaults' stored pointers may move, but a
 * vault switch must never re-point the new vault's live panes. */
export function followRename(vault: string, from: string, to: string): void {
  if (from === to) return;
  followDocumentRename(vault, from, to);
  if (useVaultStore.getState().vaultPath === vault)
    safely(() => useNavStore.getState().replacePath(from, to));
  safely(() => remapLastPlace(vault, from, to));
  safely(() => useUiStore.getState().remapFavorites(vault, from, to));
  safely(() => useOpenLogStore.getState().remap(vault, from, to));
}
export function followTypeRename(vault: string, from: string, to: string): void {
  if (from === to) return;
  if (useVaultStore.getState().vaultPath === vault)
    safely(() => useNavStore.getState().renameType(from, to));
  safely(() => renameLastPlaceType(vault, from, to));
}
