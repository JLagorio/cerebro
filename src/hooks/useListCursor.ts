import { withOpenBesideIntent } from '@/app/openIntent';
import { usePaneId } from '@/stores/navStore';
import { useId, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { hasLayers } from '@/components/ui/layers';
import { useCommands } from '@/lib/keys/useKeys';
import { isEditableTarget } from '@/lib/keys/claims';
import { useUiStore } from '@/stores/uiStore';
import * as cursor from '@/engine/listCursor';

export interface ListItemActions {
  open?: () => void;
  done?: () => void;
}
interface Options {
  keys: readonly string[] | (() => readonly string[]);
  selKey?: cursor.SelectionKey;
  onOpen?: (key: string) => void;
  focus?: string | null;
  onFocusChange?: (key: string | null) => void;
  selectable?: boolean;
  peek?: boolean;
}
const identity = (key: string) => key;
const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

/** One roving list cursor. Letter commands use the page key scope; arrows and
 * Escape remain local to the actual list, and child controls keep their Enter. */
export function useListCursor(options: Options) {
  const id = useId();
  const pane = usePaneId();
  const [stored, setStored] = useState(() =>
    cursor.focusCursor(cursor.emptyCursor(), options.focus ?? null),
  );
  const state =
    options.focus === undefined || options.focus === stored.focus
      ? stored
      : cursor.focusCursor(stored, options.focus);
  const stateRef = useRef(state);
  stateRef.current = state;
  const latest = useRef(options);
  latest.current = options;
  const container = useRef<HTMLElement | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const actions = useRef(new Map<string, ListItemActions>());
  const previousKeys = useRef<readonly string[]>([]);
  const published = useRef<string[] | null>(null);
  const keys = () => {
    const source = latest.current.keys;
    return typeof source === 'function' ? source() : source;
  };
  const selKey = (key: string) => (latest.current.selKey ?? identity)(key);
  const commit = (next: cursor.ListCursorState, focusDom = false) => {
    const before = stateRef.current;
    stateRef.current = next;
    setStored(next);
    if (next.focus !== before.focus) latest.current.onFocusChange?.(next.focus);
    if (focusDom && next.focus !== null) {
      const row = elements.current.get(next.focus);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: 'nearest' });
    }
  };
  const open = (key: string) => {
    const action = actions.current.get(key)?.open;
    if (action) action();
    else latest.current.onOpen?.(key);
  };
  const move = (next: cursor.ListCursorState) => {
    const { detailPath, detailPane } = useUiStore.getState();
    const followPeek =
      latest.current.peek &&
      (detailPane === null || detailPane === pane) &&
      detailPath !== null &&
      keys().includes(detailPath);
    commit(next, true);
    if (followPeek && next.focus !== null) open(next.focus);
  };
  const step = (delta: number, extend = false) =>
    move(
      extend
        ? cursor.extend(stateRef.current, keys(), delta, selKey)
        : cursor.step(stateRef.current, keys(), delta),
    );
  const edge = (end: 'first' | 'last') => move(cursor.edge(stateRef.current, keys(), end));
  const canOpen = () => {
    const focus = stateRef.current.focus;
    const active = document.activeElement;
    return (
      focus !== null &&
      keys().includes(focus) &&
      (active === document.body ||
        active === container.current ||
        active === elements.current.get(focus))
    );
  };
  const canSelect = () => latest.current.selectable === true && keys().length > 0;
  useCommands([
    { id: 'list.down', run: () => step(1), when: () => keys().length > 0 },
    { id: 'list.up', run: () => step(-1), when: () => keys().length > 0 },
    { id: 'list.extendDown', run: () => step(1, true), when: canSelect },
    { id: 'list.extendUp', run: () => step(-1, true), when: canSelect },
    { id: 'list.first', run: () => edge('first'), when: () => keys().length > 0 },
    { id: 'list.last', run: () => edge('last'), when: () => keys().length > 0 },
    {
      id: 'list.toggle',
      run: () => {
        const focus = stateRef.current.focus;
        if (focus !== null) commit(cursor.toggle(stateRef.current, focus, selKey));
      },
      when: () => canSelect() && stateRef.current.focus !== null,
    },
    {
      id: 'list.toggleAll',
      run: () => commit(cursor.toggleAll(stateRef.current, keys(), selKey)),
      when: canSelect,
    },
    {
      id: 'list.open',
      run: () => {
        const focus = stateRef.current.focus;
        if (focus !== null) open(focus);
      },
      when: canOpen,
    },
    {
      id: 'list.openBeside',
      run: () => {
        const focus = stateRef.current.focus;
        if (focus !== null) withOpenBesideIntent(true, () => open(focus));
      },
      when: canOpen,
    },
  ]);

  const syncKeys = () => {
    const next = [...keys()];
    if (!sameKeys(previousKeys.current, next)) {
      const before = stateRef.current;
      const reconciled = cursor.reconcile(before, previousKeys.current, next, selKey);
      previousKeys.current = next;
      commit(
        reconciled,
        before.focus !== null &&
          before.focus !== reconciled.focus &&
          document.activeElement === document.body,
      );
      for (const key of actions.current.keys())
        if (!next.includes(key)) actions.current.delete(key);
    }
    if (latest.current.peek) {
      const paths = [...new Set(next.map(selKey))];
      if (!published.current || !sameKeys(published.current, paths)) {
        useUiStore.getState().setDetailSiblings(paths, pane);
        published.current = useUiStore.getState().siblingsByPane[pane] ?? null;
      }
    }
  };
  const syncRef = useRef(syncKeys);
  syncRef.current = syncKeys;
  useLayoutEffect(syncKeys);
  // Lanes can reveal or remove rows in a child commit without re-rendering
  // the cursor's owner. Observe child order, never focus/selection attributes.
  useLayoutEffect(() => {
    if (typeof latest.current.keys !== 'function' || !container.current) return;
    const observer = new MutationObserver(() => syncRef.current());
    observer.observe(container.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!options.peek) return;
    const stop = useUiStore.subscribe((next, previous) => {
      if (
        (next.detailPane === null || next.detailPane === pane) &&
        next.detailPath !== previous.detailPath &&
        next.detailPath !== null &&
        keys().includes(next.detailPath)
      )
        commit(cursor.focusCursor(stateRef.current, next.detailPath));
      if (
        (previous.detailPane === null || previous.detailPane === pane) &&
        next.detailPath === null &&
        previous.detailPath !== null &&
        keys().includes(previous.detailPath) &&
        (document.activeElement === document.body ||
          document.activeElement?.closest('[data-testid="detail-panel"]'))
      ) {
        // Returning from the peek restores its originating row, so the next
        // Escape belongs to the list and letters keep walking it.
        commit(stateRef.current, true);
      }
    });
    return () => {
      stop();
      if (
        published.current !== null &&
        useUiStore.getState().siblingsByPane[pane] === published.current
      )
        useUiStore.getState().setDetailSiblings([], pane);
    };
  }, [options.peek, pane]);

  const containerProps: HTMLAttributes<HTMLElement> & {
    ref: (element: HTMLElement | null) => void;
  } = {
    ref: (element) => {
      container.current = element;
    },
    tabIndex: state.focus === null ? 0 : -1,
    'aria-multiselectable': options.selectable || undefined,
    onKeyDown: (event) => {
      if (hasLayers() || isEditableTarget(event.target)) return;
      const ownRow = [...elements.current.values()].includes(event.target as HTMLElement);
      if (event.target !== event.currentTarget && !ownRow) return;
      if (event.key === 'Escape') {
        const escaped = cursor.escape(stateRef.current);
        if (escaped.consumed === null) return;
        event.preventDefault();
        event.stopPropagation();
        commit(escaped.state);
        if (escaped.consumed === 'focus') container.current?.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Home' || event.key === 'End')
        edge(event.key === 'Home' ? 'first' : 'last');
      else step(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey && !!options.selectable);
    },
  };
  const itemProps = (key: string, handlers: ListItemActions = {}) => {
    actions.current.set(key, handlers);
    return {
      id: `${id}-${encodeURIComponent(key)}`,
      'data-cursor-key': key,
      'data-focused': state.focus === key ? ('true' as const) : undefined,
      'aria-selected':
        options.selectable && state.selected.size > 0
          ? state.selected.has(selKey(key))
          : state.focus === key,
      tabIndex: state.focus === key ? 0 : -1,
      ref: (element: HTMLElement | null) => {
        if (element) elements.current.set(key, element);
        else elements.current.delete(key);
      },
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        if (event.target === event.currentTarget && stateRef.current.focus !== key)
          commit(cursor.focusCursor(stateRef.current, key));
      },
      onPointerDown: () => {
        if (stateRef.current.focus !== key) commit(cursor.focusCursor(stateRef.current, key));
      },
      onClick: () => {
        commit(cursor.focusCursor(stateRef.current, key));
        open(key);
      },
    };
  };
  return {
    state,
    containerProps,
    itemProps,
    focus: (key: string | null, focusDom = false) =>
      commit(cursor.focusCursor(stateRef.current, key), focusDom),
    clear: () => commit({ ...stateRef.current, selected: new Set(), base: null }),
    action: (key: string) => actions.current.get(key),
    keys,
  };
}

export type ListCursor = ReturnType<typeof useListCursor>;
