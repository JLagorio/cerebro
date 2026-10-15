import { hasLayers } from '@/components/ui/layers';
import { useCommands } from '@/lib/keys/useKeys';
import { useUndoStore } from '@/stores/undoStore';

const canUndo = (): boolean => useUndoStore.getState().past.length > 0;
const canRedo = (): boolean => useUndoStore.getState().future.length > 0;

/**
 * ⌘Z undoes and ⇧⌘Z redoes the person's own changes (M60.7, D11 (b)):
 * renames, kind changes, copies, property deletes, conversions and Trash
 * moves, through `stores/undoStore.ts`.
 *
 * The `undo` and `redo` rows of the keymap (M65.1), bound in the app scope.
 * They act only where nothing else owns the keys: a text field keeps the
 * browser's and the editor's own history (its `editor` claim), an open layer
 * (a dialog, a popover, a menu, the record peek) stands them down, and a
 * diagram's own `diagram.undo` binding shadows them from its page, peek or
 * block. A sheet grid claims editor keys and forwards history to its page.
 * An empty stack says nothing and leaves the key alone.
 */
export function useUndoShortcuts(): void {
  useCommands([
    {
      id: 'undo',
      run: () => void useUndoStore.getState().undo(),
      when: () => !hasLayers() && canUndo(),
    },
    {
      id: 'redo',
      run: () => void useUndoStore.getState().redo(),
      when: () => !hasLayers() && canRedo(),
    },
  ]);
}
