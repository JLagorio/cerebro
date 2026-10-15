import { useMemo, useSyncExternalStore } from 'react';
import type { SceneEditor } from '@/engine/scene/editor';
import type { Board, BoardEdge, BoardNode, InkStroke } from '@/engine/scene/model';

export type SceneSource = Board | SceneEditor;
export const isSceneEditor = (source: SceneSource): source is SceneEditor => 'subscribe' in source;

/** A gesture paints overrides without making a commit or changing durable
 * board identity. Unchanged item references survive every preview frame. */
function visible(editor: SceneEditor): Board {
  if (editor.gesture === null || editor.gesture.overrides.size === 0) return editor.board;
  const nodes = new Map(editor.board.nodes);
  const edges = new Map(editor.board.edges);
  const ink = new Map(editor.board.ink);
  for (const [key, item] of editor.gesture.overrides) {
    const id = key.slice(2);
    if (key.startsWith('n:')) {
      if (item === null) nodes.delete(id);
      else nodes.set(id, item as BoardNode);
    }
    if (key.startsWith('e:')) {
      if (item === null) edges.delete(id);
      else edges.set(id, item as BoardEdge);
    }
    if (key.startsWith('i:')) {
      if (item === null) ink.delete(id);
      else ink.set(id, item as InkStroke);
    }
  }
  return { ...editor.board, nodes, edges, ink };
}
/** useSyncExternalStore needs a referentially stable snapshot between
 * notifications, including its post-subscribe consistency check. */
function sceneStore(source: SceneSource) {
  let board: Board | undefined;
  let gesture: SceneEditor['gesture'] | undefined;
  let snapshot: Board;
  return {
    get: () => {
      if (!isSceneEditor(source)) return source;
      if (board !== source.board || gesture !== source.gesture) {
        board = source.board;
        gesture = source.gesture;
        snapshot = visible(source);
      }
      return snapshot;
    },
    subscribe: (notify: () => void) => {
      if (!isSceneEditor(source)) return () => {};
      return source.subscribe(({ cause }) => {
        if (cause !== 'select') notify();
      });
    },
  };
}
export function useScene(source: SceneSource): Board {
  const store = useMemo(() => sceneStore(source), [source]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
