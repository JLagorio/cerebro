import { checkSet, getItem, parseItemKey } from './board';
import { HISTORY_LIMIT, MIN_SIZE } from './limits';
import type {
  Board,
  BoardEdge,
  BoardNode,
  Command,
  CommandResult,
  InkStroke,
  Item,
  ItemKey,
  Refusal,
} from './model';
import { applyStep, stepBetween, type Step } from './history';

/**
 * The scene editor (M68.1): one board, its undo history and the selection.
 * A command run through `execute` is one step. A gesture (a drag, a resize,
 * a stroke) previews as overrides that never touch the board, and its commit
 * is one step, so one drag is one undo. The selection is view state: it is
 * never in history or the file, and it drops keys that no longer exist after
 * every change. There is no camera here; that is the renderer's view state.
 */

export interface Gesture {
  readonly kind: string;
  /** Per item: what to draw in its place, or null to draw it removed. */
  readonly overrides: ReadonlyMap<ItemKey, Item | null>;
}

export type EditorCause =
  'commit' | 'undo' | 'redo' | 'external' | 'cancel' | 'begin' | 'preview' | 'select';

export interface EditorEvent {
  readonly cause: EditorCause;
  readonly board: Board;
  readonly selection: ReadonlySet<ItemKey>;
}

export interface Undone {
  readonly label: string;
  readonly skipped: readonly ItemKey[];
}

export interface SceneEditor {
  readonly board: Board;
  readonly selection: ReadonlySet<ItemKey>;
  readonly gesture: Gesture | null;
  select(keys: Iterable<ItemKey>): void;
  subscribe(listener: (event: EditorEvent) => void): () => void;
  /** Runs a command as one step; it ends any gesture first. */
  execute<P>(command: Command<P>, payload: P): CommandResult;
  begin(kind: string): void;
  preview(overrides: ReadonlyMap<ItemKey, Item | null>): void;
  /** Rounds, checks and records the gesture as one step. */
  commit(): CommandResult;
  /** Drops the gesture; records nothing. */
  cancel(): void;
  undo(): Undone | null;
  redo(): Undone | null;
  /** Takes a board changed elsewhere as one undoable step; it ends any gesture first. */
  applyExternal(next: Board, label: string): void;
  canUndo(): boolean;
  canRedo(): boolean;
  dispose(): void;
}

const round = (n: number) => (Number.isFinite(n) ? Math.round(n) : n);
const roundSize = (n: number) => (Number.isFinite(n) ? Math.max(MIN_SIZE, Math.round(n)) : n);

/** The item with its box, and a stroke's points, as whole numbers. */
function rounded(item: Item): Item {
  if (!('width' in item)) return item;
  const box = {
    x: round(item.x),
    y: round(item.y),
    width: roundSize(item.width),
    height: roundSize(item.height),
  };
  if ('points' in item) return { ...item, ...box, points: item.points.map(round) };
  return { ...item, ...box };
}

function sameItem(a: Item, b: Item): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  return ka.every((k) => {
    const va = ra[k];
    const vb = rb[k];
    if (Array.isArray(va) && Array.isArray(vb)) {
      return va.length === vb.length && va.every((v, i) => v === vb[i]);
    }
    return va === vb;
  });
}

const refusal = (message: string): CommandResult => ({
  ok: false,
  refusal: { code: 'missing', message } satisfies Refusal,
});

export function createSceneEditor(
  initial: Board,
  options: { createId: () => string },
): SceneEditor {
  let board = initial;
  let selection: ReadonlySet<ItemKey> = new Set();
  let gesture: Gesture | null = null;
  const undoStack: Step[] = [];
  const redoStack: Step[] = [];
  const listeners = new Set<(event: EditorEvent) => void>();
  const ctx = { createId: options.createId };

  const emit = (cause: EditorCause) => {
    const event = { cause, board, selection };
    for (const listener of [...listeners]) listener(event);
  };

  const reconcile = (keys: Iterable<ItemKey>) => {
    selection = new Set([...keys].filter((key) => getItem(board, key) !== undefined));
  };

  const record = (step: Step) => {
    undoStack.push(step);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  };

  const endGesture = () => {
    if (gesture === null) return;
    gesture = null;
    emit('cancel');
  };

  /** Moves `board` to `next` as one recorded step, when anything changed. */
  const change = (next: Board, label: string, keys: Iterable<ItemKey>, cause: EditorCause) => {
    const step = stepBetween(board, next, label);
    if (step !== null) {
      record(step);
      board = next;
    }
    reconcile(keys);
    emit(cause);
  };

  const travel = (from: Step[], to: Step[], direction: 'undo' | 'redo'): Undone | null => {
    endGesture();
    const step = from.pop();
    if (step === undefined) return null;
    const applied = applyStep(board, step, direction);
    to.push(step);
    board = applied.board;
    reconcile(selection);
    emit(direction);
    return { label: step.label, skipped: applied.skipped };
  };

  return {
    get board() {
      return board;
    },
    get selection() {
      return selection;
    },
    get gesture() {
      return gesture;
    },
    select(keys) {
      reconcile(keys);
      emit('select');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    execute(command, payload) {
      endGesture();
      const result = command(board, payload, ctx);
      if (result.ok) change(result.board, result.label, result.selection ?? selection, 'commit');
      return result;
    },
    begin(kind) {
      endGesture();
      gesture = { kind, overrides: new Map() };
      emit('begin');
    },
    preview(overrides) {
      if (gesture === null) return;
      gesture = { kind: gesture.kind, overrides: new Map(overrides) };
      emit('preview');
    },
    commit() {
      if (gesture === null) return refusal('There is no gesture to commit.');
      const { kind, overrides } = gesture;
      const before = board;
      const nodes = new Map(before.nodes);
      const edges = new Map(before.edges);
      const ink = new Map(before.ink);
      for (const [key, value] of overrides) {
        const parsed = parseItemKey(key);
        if (parsed === null) continue;
        const map = (parsed.kind === 'n' ? nodes : parsed.kind === 'e' ? edges : ink) as Map<
          string,
          Item
        >;
        if (value === null) {
          map.delete(parsed.id);
          continue;
        }
        if (value.id !== parsed.id) {
          endGesture();
          return refusal(`The gesture put item ${value.id} where ${parsed.id} was.`);
        }
        const next = rounded(value);
        const current = map.get(parsed.id);
        map.set(parsed.id, current !== undefined && sameItem(current, next) ? current : next);
      }
      // A removed card takes its connections with it, in this one step.
      for (const [id, edge] of edges) {
        const lost = [edge.fromNode, edge.toNode].some(
          (end) => before.nodes.has(end) && !nodes.has(end),
        );
        if (lost) edges.delete(id);
      }
      const after: Board = {
        ...before,
        nodes: nodes as Map<string, BoardNode>,
        edges: edges as Map<string, BoardEdge>,
        ink: ink as Map<string, InkStroke>,
      };
      const problem = checkSet(before, after);
      gesture = null;
      if (problem) {
        emit('cancel');
        return { ok: false, refusal: problem };
      }
      change(after, kind, selection, 'commit');
      return { ok: true, board, label: kind };
    },
    cancel() {
      endGesture();
    },
    undo() {
      return travel(undoStack, redoStack, 'undo');
    },
    redo() {
      return travel(redoStack, undoStack, 'redo');
    },
    applyExternal(next, label) {
      endGesture();
      change(next, label, selection, 'external');
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    dispose() {
      listeners.clear();
      gesture = null;
    },
  };
}
