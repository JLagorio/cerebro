import type { SceneEditor } from '@/engine/scene/editor';
/** A file flush settles its in-place text before measuring dirty scene state.
 * A UI draft otherwise lives outside history until the edit ends. */
const pending = new WeakMap<SceneEditor, () => void>();
export function registerBoardText(editor: SceneEditor, commit: () => void): () => void {
  pending.set(editor, commit);
  return () => {
    if (pending.get(editor) === commit) pending.delete(editor);
  };
}
export function settleBoardText(editor: SceneEditor): void {
  pending.get(editor)?.();
}
