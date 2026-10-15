import { useEffect, useMemo, useRef } from 'react';
import { deleteItems, duplicateItems, reorderItems } from '@/engine/scene/commands';
import { itemKey } from '@/engine/scene/board';
import type { SceneEditor } from '@/engine/scene/editor';
import { useDragGesture } from '@/hooks/useDragGesture';
import { useCommands } from '@/lib/keys/useKeys';
import { DOT_GAP } from '@/mermaid/CanvasViewport';
import { useUiStore } from '@/stores/uiStore';
import type { BoardStore } from './boardState';
import { createNudge } from './gestures/nudge';
import { textEditing } from './gestures/text';
import type { BoardTool } from './tools';
export function useBoardKeys(editor: SceneEditor, state: BoardStore) {
  const panHeld = useRef(false);
  const nudge = useMemo(() => createNudge(editor), [editor]);
  const gesture = useDragGesture();
  const toast = useUiStore((s) => s.toast);
  const press = (event: KeyboardEvent | undefined, dx: number, dy: number) => {
    const wasActive = nudge.active;
    const release = wasActive ? null : state.claimGesture(gesture.end);
    const step = (state.getState().snap.grid ? DOT_GAP : 1) * (event?.shiftKey ? 10 : 1);
    if (nudge.press(event?.key ?? '', dx * step, dy * step)) {
      if (!wasActive)
        gesture.begin(() => {
          nudge.cancel();
          release?.();
        });
    } else release?.();
  };
  useCommands([
    {
      id: 'whiteboard.duplicate',
      when: () => editor.selection.size > 0,
      run: () => {
        state.claimGesture(gesture.end)();
        const result = editor.execute(duplicateItems, { keys: [...editor.selection] });
        if (!result.ok) toast(result.refusal.message);
      },
    },
    ...(
      [
        ['whiteboard.order.front', 'front'],
        ['whiteboard.order.back', 'back'],
        ['whiteboard.order.forward', 'forward'],
        ['whiteboard.order.backward', 'backward'],
      ] as const
    ).map(([id, to]) => ({
      id,
      when: () => editor.selection.size > 0,
      run: () => {
        state.claimGesture(gesture.end)();
        const result = editor.execute(reorderItems, { keys: [...editor.selection], to });
        if (!result.ok) toast(result.refusal.message);
      },
    })),
    ...(
      [
        ['whiteboard.tool.select', 'select'],
        ['whiteboard.tool.hand', 'hand'],
        ['whiteboard.tool.text', 'text'],
        ['whiteboard.tool.rectangle', 'rectangle'],
        ['whiteboard.tool.ellipse', 'ellipse'],
        ['whiteboard.tool.connector', 'connector'],
        ['whiteboard.tool.line', 'line'],
        ['whiteboard.tool.pencil', 'pencil'],
        ['whiteboard.tool.eraser', 'eraser'],
      ] as const
    ).map(([id, tool]) => ({ id, run: () => state.getState().setTool(tool as BoardTool) })),
    {
      id: 'whiteboard.editText',
      run: () => {
        const key = [...editor.selection][0];
        const editing = key ? textEditing(editor.board, key.slice(2), key.startsWith('e:')) : null;
        if (editing) {
          state.getState().setTool('select');
          state.setState({ editing });
        }
      },
      when: () => editor.selection.size === 1,
    },
    {
      id: 'whiteboard.selectAll',
      run: () =>
        state
          .getState()
          .select(
            new Set([
              ...[...editor.board.nodes.keys()].map((id) => itemKey('n', id)),
              ...[...editor.board.edges.keys()].map((id) => itemKey('e', id)),
              ...[...editor.board.ink.keys()].map((id) => itemKey('i', id)),
            ]),
          ),
    },
    {
      id: 'whiteboard.delete',
      run: () => {
        const result = editor.execute(deleteItems, { keys: [...editor.selection] });
        if (!result.ok) toast(result.refusal.message);
      },
      when: () => editor.selection.size > 0,
    },
    ...(
      [
        { id: 'whiteboard.nudge.up', x: 0, y: -1 },
        { id: 'whiteboard.nudge.right', x: 1, y: 0 },
        { id: 'whiteboard.nudge.down', x: 0, y: 1 },
        { id: 'whiteboard.nudge.left', x: -1, y: 0 },
      ] as const
    ).map((dir) => ({
      id: dir.id,
      run: (event?: KeyboardEvent) => press(event, dir.x, dir.y),
      when: () => editor.selection.size > 0,
    })),
    {
      id: 'whiteboard.pan',
      run: () => {
        panHeld.current = true;
      },
    },
    {
      id: 'whiteboard.undo',
      run: () => {
        nudge.cancel();
        gesture.end();
        editor.undo();
      },
    },
    {
      id: 'whiteboard.redo',
      run: () => {
        nudge.cancel();
        gesture.end();
        editor.redo();
      },
    },
  ]);
  useEffect(() => {
    const released = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ') panHeld.current = false;
      const result = nudge.release(event.key);
      if (!nudge.active) gesture.end();
      if (result && !result.ok) toast(result.refusal.message);
    };
    const blurred = () => {
      panHeld.current = false;
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') blurred();
    };
    const stop = editor.subscribe(({ cause }) => {
      if (cause === 'external' || cause === 'cancel' || cause === 'undo' || cause === 'redo') {
        nudge.cancel();
        gesture.end();
      }
    });
    window.addEventListener('keyup', released);
    window.addEventListener('blur', blurred);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      stop();
      window.removeEventListener('keyup', released);
      window.removeEventListener('blur', blurred);
      document.removeEventListener('visibilitychange', hidden);
      nudge.cancel();
    };
  }, [editor, nudge, gesture, toast]);
  return panHeld;
}
