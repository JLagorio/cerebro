/** Keyed focus and selection. Rendered occurrences may share one selected page. */
export interface ListCursorState {
  focus: string | null;
  anchor: string | null;
  selected: ReadonlySet<string>;
  /** The selection before the current Shift run; null means no run. */
  base: ReadonlySet<string> | null;
}
export type SelectionKey = (key: string) => string;
const identity: SelectionKey = (key) => key;
export const emptyCursor = (): ListCursorState => ({
  focus: null,
  anchor: null,
  selected: new Set(),
  base: null,
});
export function focusCursor(state: ListCursorState, focus: string | null): ListCursorState {
  return { ...state, focus, anchor: focus, base: null };
}
function destination(focus: string | null, keys: readonly string[], delta: number): string | null {
  if (keys.length === 0) return null;
  const at = focus === null ? -1 : keys.indexOf(focus);
  if (at < 0) return delta < 0 ? keys[keys.length - 1] : keys[0];
  return keys[Math.max(0, Math.min(keys.length - 1, at + delta))];
}
export function step(
  state: ListCursorState,
  keys: readonly string[],
  delta: number,
): ListCursorState {
  return focusCursor(state, destination(state.focus, keys, delta));
}
export function edge(
  state: ListCursorState,
  keys: readonly string[],
  end: 'first' | 'last',
): ListCursorState {
  return focusCursor(state, keys.length ? keys[end === 'first' ? 0 : keys.length - 1] : null);
}
function range(keys: readonly string[], anchor: string, focus: string): readonly string[] {
  const a = keys.indexOf(anchor),
    b = keys.indexOf(focus);
  if (a < 0 || b < 0) return [focus];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}
export function extend(
  state: ListCursorState,
  keys: readonly string[],
  delta: number,
  selKey: SelectionKey = identity,
): ListCursorState {
  const focus = destination(state.focus, keys, delta);
  if (focus === null) return focusCursor(state, null);
  const anchor = state.base === null ? (state.focus ?? focus) : (state.anchor ?? focus);
  const base = state.base ?? new Set(state.selected);
  return {
    ...state,
    focus,
    anchor,
    base,
    selected: new Set([...base, ...range(keys, anchor, focus).map(selKey)]),
  };
}
export function toggle(
  state: ListCursorState,
  key: string,
  selKey: SelectionKey = identity,
): ListCursorState {
  const selected = new Set(state.selected);
  const target = selKey(key);
  if (selected.has(target)) selected.delete(target);
  else selected.add(target);
  return { ...focusCursor(state, key), selected };
}
/** Shift-click applies the clicked box's new state across its range and moves
 * the anchor to that box, preserving TableView's established behavior. */
export function rangeToggle(
  state: ListCursorState,
  keys: readonly string[],
  key: string,
  selKey: SelectionKey = identity,
): ListCursorState {
  const selected = new Set(state.selected);
  const add = !selected.has(selKey(key));
  for (const row of range(keys, state.anchor ?? key, key)) {
    if (add) selected.add(selKey(row));
    else selected.delete(selKey(row));
  }
  return { ...focusCursor(state, key), selected };
}
export function toggleAll(
  state: ListCursorState,
  keys: readonly string[],
  selKey: SelectionKey = identity,
): ListCursorState {
  const visible = new Set(keys.map(selKey));
  const all = visible.size > 0 && [...visible].every((key) => state.selected.has(key));
  const selected = new Set(state.selected);
  for (const key of visible) {
    if (all) selected.delete(key);
    else selected.add(key);
  }
  return { ...state, selected, base: null };
}
export function escape(state: ListCursorState): {
  state: ListCursorState;
  consumed: 'selection' | 'focus' | null;
} {
  if (state.selected.size)
    return { state: { ...state, selected: new Set(), base: null }, consumed: 'selection' };
  if (state.focus !== null) return { state: focusCursor(state, null), consumed: 'focus' };
  return { state, consumed: null };
}
export function reconcile(
  state: ListCursorState,
  before: readonly string[],
  keys: readonly string[],
  selKey: SelectionKey = identity,
): ListCursorState {
  const visible = new Set(keys.map(selKey));
  const selected = new Set([...state.selected].filter((key) => visible.has(key)));
  const base =
    state.base === null ? null : new Set([...state.base].filter((key) => visible.has(key)));
  const oldIndex = state.focus === null ? -1 : before.indexOf(state.focus);
  const focus =
    state.focus !== null && !keys.includes(state.focus)
      ? oldIndex < 0 || keys.length === 0
        ? null
        : keys[Math.min(oldIndex, keys.length - 1)]
      : state.focus;
  const anchor = state.anchor !== null && keys.includes(state.anchor) ? state.anchor : null;
  return { focus, anchor, selected, base };
}
