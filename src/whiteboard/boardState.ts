import { createStore, type StoreApi } from 'zustand/vanilla';
import { getItem } from '@/engine/scene/board';
import type { SceneEditor } from '@/engine/scene/editor';
import type { Box, ItemKey } from '@/engine/scene/model';
import type { Guide } from '@/engine/scene/snap';
import type { EdgeRoute, Point } from '@/engine/scene/figure';
import type { PortTarget } from '@/engine/scene/ports';
import type { BoardTool } from './tools';
import type { BoardEditing } from './gestures/text';
export interface SnapPreferences {
  grid: boolean;
  objects: boolean;
}
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'cerebro.whiteboard.snap';
function readSnap(storage?: PreferenceStorage): SnapPreferences {
  try {
    const value: unknown = JSON.parse(
      (storage ?? window.localStorage).getItem(STORAGE_KEY) ?? 'null',
    );
    if (
      typeof value === 'object' &&
      value !== null &&
      'grid' in value &&
      'objects' in value &&
      typeof value.grid === 'boolean' &&
      typeof value.objects === 'boolean'
    )
      return { grid: value.grid, objects: value.objects };
  } catch {
    /* Local view preferences never prevent editing. */
  }
  return { grid: true, objects: true };
}
export interface BoardState {
  selection: ReadonlySet<ItemKey>;
  marquee: Box | null;
  guides: readonly Guide[];
  hover: ItemKey | null;
  snap: SnapPreferences;
  revision: number;
  tool: BoardTool;
  editing: BoardEditing | null;
  trail: readonly Point[];
  fadedIds: ReadonlySet<ItemKey>;
  interactionActive: boolean;
  port: PortTarget | null;
  connection: { route: EdgeRoute; arrow: boolean } | null;
  inspectorOpen: boolean;
  colors: Record<'card' | 'shape' | 'ink' | 'edge', string | null>;
  createdFamilies: ReadonlyMap<string, 'card' | 'shape'>;
  setInspectorOpen(open: boolean): void;
  setTool(tool: BoardTool): void;
  select(keys: Iterable<ItemKey>): void;
  setSnap(next: SnapPreferences): void;
  clearTransient(): void;
}
export interface BoardStore extends StoreApi<BoardState> {
  connect(): () => void;
  /** Pointer-down and held keys share one owner, including the pre-drag threshold. */
  claimGesture(cancel: () => void): () => void;
}
/** One store per open board. Its selection mirrors the scene editor, while
 * guides, marquee, hover and preferences remain entirely outside history. */
export function createBoardState(editor: SceneEditor, storage?: PreferenceStorage): BoardStore {
  let cancelGesture: (() => void) | null = null;
  let inspectorOpen = true;
  try {
    inspectorOpen =
      (storage ?? window.localStorage).getItem('cerebro.whiteboard.inspector') !== 'false';
  } catch {
    /* View preferences never prevent editing. */
  }
  const store = createStore<BoardState>((set) => ({
    selection: editor.selection,
    marquee: null,
    guides: [],
    hover: null,
    snap: readSnap(storage),
    revision: 0,
    tool: 'select',
    editing: null,
    trail: [],
    fadedIds: new Set(),
    interactionActive: false,
    port: null,
    connection: null,
    inspectorOpen,
    colors: { card: null, shape: null, ink: null, edge: null },
    createdFamilies: new Map(),
    setInspectorOpen(open) {
      set({ inspectorOpen: open });
      try {
        (storage ?? window.localStorage).setItem('cerebro.whiteboard.inspector', String(open));
      } catch {
        /* Keep the current view usable without storage. */
      }
    },
    setTool(tool) {
      const cancel = cancelGesture;
      cancelGesture = null;
      cancel?.();
      set({ tool });
    },
    select(keys) {
      editor.select(keys);
      set({ selection: editor.selection });
    },
    setSnap(snap) {
      set({ snap });
      try {
        (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify(snap));
      } catch {
        /* A storage failure leaves the live preference working. */
      }
    },
    clearTransient() {
      set({
        marquee: null,
        guides: [],
        hover: null,
        trail: [],
        fadedIds: new Set(),
        interactionActive: false,
        port: null,
        connection: null,
      });
    },
  }));
  return Object.assign(store, {
    claimGesture(cancel: () => void) {
      const previous = cancelGesture;
      cancelGesture = null;
      previous?.();
      cancelGesture = cancel;
      return () => {
        if (cancelGesture === cancel) cancelGesture = null;
      };
    },
    connect: () =>
      editor.subscribe(({ cause, selection, board }) =>
        store.setState((state) => ({
          selection,
          revision: state.revision + 1,
          hover: state.hover && getItem(board, state.hover) ? state.hover : null,
          ...(cause === 'external' || cause === 'cancel' ? { marquee: null, guides: [] } : {}),
        })),
      ),
  });
}
