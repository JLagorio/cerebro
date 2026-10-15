import type { SceneEditor } from '@/engine/scene/editor';
import type { CommandResult } from '@/engine/scene/model';
import { moveKeys, movePreview } from './move';
/** One held key sequence previews against one start board and commits only
 * after its final keyup. An outside apply cancels the sequence. */
export function createNudge(editor: SceneEditor) {
  let active: {
    board: SceneEditor['board'];
    keys: ReturnType<typeof moveKeys>;
    held: Set<string>;
    dx: number;
    dy: number;
  } | null = null;
  return {
    get active() {
      return active !== null;
    },
    press(key: string, dx: number, dy: number): boolean {
      if (active !== null && editor.gesture?.kind !== 'Nudge') active = null;
      if (active === null) {
        if (editor.gesture !== null) return false;
        const keys = moveKeys(editor.board, editor.selection);
        if (keys.length === 0) return false;
        active = { board: editor.board, keys, held: new Set(), dx: 0, dy: 0 };
        editor.begin('Nudge');
      }
      active.held.add(key);
      active.dx += dx;
      active.dy += dy;
      editor.preview(movePreview(active.board, active.keys, active.dx, active.dy));
      return true;
    },
    release(key: string): CommandResult | null {
      if (active === null) return null;
      active.held.delete(key);
      if (active.held.size > 0) return null;
      active = null;
      return editor.gesture?.kind === 'Nudge' ? editor.commit() : null;
    },
    cancel() {
      active = null;
      if (editor.gesture?.kind === 'Nudge') editor.cancel();
    },
  };
}
