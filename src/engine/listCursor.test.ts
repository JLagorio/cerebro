import { describe, expect, it } from 'vitest';
import {
  edge,
  emptyCursor,
  escape,
  extend,
  focusCursor,
  rangeToggle,
  reconcile,
  step,
  toggle,
  toggleAll,
} from './listCursor';
const keys = ['a', 'b', 'c', 'd'];
const selected = (state: ReturnType<typeof emptyCursor>) => [...state.selected];
describe('keyed list cursor', () => {
  it('enters at either end, clamps, jumps and ends a Shift run', () => {
    expect(step(emptyCursor(), keys, 1).focus).toBe('a');
    expect(step(emptyCursor(), keys, -1).focus).toBe('d');
    expect(step(focusCursor(emptyCursor(), 'd'), keys, 1).focus).toBe('d');
    expect(edge(emptyCursor(), keys, 'first').focus).toBe('a');
    expect(edge(emptyCursor(), keys, 'last').focus).toBe('d');
    expect(step(extend(focusCursor(emptyCursor(), 'a'), keys, 1), keys, 1).base).toBeNull();
    expect(step(emptyCursor(), [], 1).focus).toBeNull();
  });
  it('extends and shrinks a range while preserving its baseline selection', () => {
    let state = focusCursor(toggle(emptyCursor(), 'd'), 'a');
    state = extend(state, keys, 1);
    expect(selected(state)).toEqual(['d', 'a', 'b']);
    state = extend(state, keys, 1);
    expect(selected(state)).toEqual(['d', 'a', 'b', 'c']);
    state = extend(state, keys, -1);
    expect(selected(state)).toEqual(['d', 'a', 'b']);
    expect(selected(extend(emptyCursor(), keys, -1))).toEqual(['d']);
  });
  it('replays TableView shift-click add and remove ranges', () => {
    let state = toggle(emptyCursor(), 'a');
    state = rangeToggle(state, keys, 'c');
    expect(selected(state)).toEqual(['a', 'b', 'c']);
    state = rangeToggle(state, keys, 'b');
    expect(selected(state)).toEqual(['a']);
    expect(state.anchor).toBe('b');
    state = rangeToggle(emptyCursor(), keys, 'c');
    expect(selected(state)).toEqual(['c']);
  });
  it('maps repeated occurrences to a single selected page', () => {
    const occurrences = ['a:1', 'b:1', 'a:2'];
    const selKey = (key: string) => key.split(':')[0];
    let state = toggleAll(emptyCursor(), occurrences, selKey);
    expect(selected(state)).toEqual(['a', 'b']);
    state = toggle(state, 'a:2', selKey);
    expect(selected(state)).toEqual(['b']);
    state = toggleAll(state, occurrences, selKey);
    expect(selected(state)).toEqual(['b', 'a']);
    expect(selected(toggleAll(state, occurrences, selKey))).toEqual([]);
  });
  it('Escape clears selection, then focus, then passes', () => {
    let result = escape(toggle(emptyCursor(), 'b'));
    expect(result.consumed).toBe('selection');
    expect(result.state.focus).toBe('b');
    result = escape(result.state);
    expect(result.consumed).toBe('focus');
    expect(escape(result.state).consumed).toBeNull();
  });
  it('reconciles gone selections and moves focus into its former position', () => {
    const state = toggle(toggle(emptyCursor(), 'a'), 'c');
    const next = reconcile(state, keys, ['a', 'b', 'd']);
    expect(next.focus).toBe('d');
    expect(selected(next)).toEqual(['a']);
    expect(next.anchor).toBeNull();
    expect(reconcile(state, keys, ['a']).focus).toBe('a');
    expect(reconcile(state, keys, []).focus).toBeNull();
    expect(reconcile(emptyCursor(), keys, ['a']).focus).toBeNull();
    expect(reconcile(extend(state, keys, -1), keys, ['b', 'c']).base).toEqual(new Set(['c']));
  });
});
