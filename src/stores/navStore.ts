import { createContext, useContext, useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { Selection } from '@/engine/types';
import * as panes from '@/engine/panes';
import type { EntryStateKey, NavSlot, Pane, PaneId, PaneLayout, NavOutcome } from '@/engine/panes';
import { recordPersonOpen } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import type { StoredLayout } from '@/engine/paneLayout';
export type { EntryStateKey, NavSlot, PaneId, NavOutcome } from '@/engine/panes';

export interface NavigateOptions {
  /** The peek's container breadcrumb retains that pane's record context. */
  keepDetail?: boolean;
  /** Replace a forwarder so Back cannot land on it and forward again. */
  replace?: boolean;
  /** Agent navigation never enters the person's open log or raises reuse notices. */
  byAgent?: boolean;
  /** Restoring local convenience is not a person opening a page. */
  restore?: boolean;
}
export interface OpenPaneOptions extends NavigateOptions {
  from?: PaneId;
}
export interface NavState {
  selection: Selection;
  history: NavSlot[];
  historyIndex: number;
  navSeq: number;
  /** Focused history stays inline for existing subscribers and test seeds. */
  active: PaneId;
  paneIds: PaneId[];
  stashed: Partial<Record<PaneId, Pane>>;
  focusOrder: PaneId[];
  seq: number;
  paneCapacity: number;
  navigate(sel: Selection, options?: NavigateOptions): NavOutcome;
  navigateIn(pane: PaneId, sel: Selection, options?: NavigateOptions): NavOutcome;
  back(pane?: PaneId): void;
  forward(pane?: PaneId): void;
  openPane(sel: Selection, options?: OpenPaneOptions): NavOutcome;
  closePane(pane?: PaneId): void;
  focusPane(pane: PaneId): void;
  setPaneCapacity(capacity: number): void;
  openPeek(path: string, options?: OpenPaneOptions): NavOutcome;
  stepPeek(delta: number, pane?: PaneId): void;
  replacePath(from: string, to: string): void;
  renameType(from: string, to: string): void;
  restoreLayout(layout: StoredLayout): void;
  reset(): void;
  setEntryState(key: EntryStateKey, value: unknown, pane?: PaneId): void;
  readEntryState<T = unknown>(key: EntryStateKey, pane?: PaneId): T | undefined;
  registerEntryCaptor(key: EntryStateKey, read: () => unknown, pane?: PaneId): () => void;
  setLiveCheck(check: ((selection: Selection) => boolean) | null): void;
}
export const PaneContext = createContext<PaneId | null>(null);
const captors = new Map<PaneId, Map<EntryStateKey, { read: () => unknown }>>();
let liveCheck: ((selection: Selection) => boolean) | null = null;
export function layoutOf(state: NavState): PaneLayout {
  const focused: Pane = {
    id: state.active,
    selection: state.selection,
    history: state.history,
    historyIndex: state.historyIndex,
    navSeq: state.navSeq,
  };
  return {
    panes: state.paneIds
      .map((id) => (id === state.active ? focused : state.stashed[id]!))
      .filter(Boolean),
    active: state.active,
    focusOrder: state.focusOrder,
    seq: state.seq,
  };
}
function inlineLayout(
  layout: PaneLayout,
): Pick<
  NavState,
  | 'selection'
  | 'history'
  | 'historyIndex'
  | 'navSeq'
  | 'active'
  | 'paneIds'
  | 'stashed'
  | 'focusOrder'
  | 'seq'
> {
  const focused = panes.paneById(layout, layout.active)!;
  return {
    selection: focused.selection,
    history: focused.history,
    historyIndex: focused.historyIndex,
    navSeq: focused.navSeq,
    active: layout.active,
    paneIds: layout.panes.map((pane) => pane.id),
    stashed: Object.fromEntries(
      layout.panes.filter((pane) => pane.id !== layout.active).map((pane) => [pane.id, pane]),
    ),
    focusOrder: layout.focusOrder,
    seq: layout.seq,
  };
}
function withState(slot: NavSlot, key: EntryStateKey, value: unknown): NavSlot {
  const state = { ...slot.state };
  if (value === undefined) delete state[key];
  else state[key] = value;
  return { ...slot, state: Object.keys(state).length ? state : undefined };
}
function capture(layout: PaneLayout, id: PaneId): PaneLayout {
  const own = captors.get(id);
  if (!own?.size) return layout;
  return {
    ...layout,
    panes: layout.panes.map((pane) => {
      if (pane.id !== id) return pane;
      let slot = pane.history[pane.historyIndex];
      for (const [key, captor] of own) slot = withState(slot, key, captor.read());
      return {
        ...pane,
        history: pane.history.map((old, at) => (at === pane.historyIndex ? slot : old)),
      };
    }),
  };
}
function pagePathOf(selection: Selection): string | null {
  if (selection.kind === 'doc' || selection.kind === 'diagram' || selection.kind === 'file')
    return selection.path;
  if (selection.kind === 'library') return selection.path ?? null;
  return null;
}
/** A peek belongs to its originating pane. A diff survives only while another
 * pane still shows its page. Neither overlay belongs to history or relaunch. */
function leaveSurface(from: PaneId, next: PaneLayout, keepDetail = false): void {
  const ui = useUiStore.getState();
  if (
    ui.diffView &&
    !next.panes.some(
      (pane) => pane.id !== from && panes.claimOf(pane.selection) === ui.diffView!.path,
    )
  )
    ui.closeDiff();
  if (
    ui.detailPath !== null &&
    (next.panes.some((pane) => panes.claimOf(pane.selection) === ui.detailPath) ||
      (!keepDetail && (ui.detailPane === null || ui.detailPane === from)))
  )
    ui.closeDetail();
}
function notice(outcome: NavOutcome, options?: NavigateOptions): void {
  if (options?.byAgent || options?.restore) return;
  if (outcome.kind === 'reused') useUiStore.getState().toast('Already open in another pane.');
  if (outcome.kind === 'full')
    useUiStore.getState().toast('No room for another pane — opened here.');
}
const store = createStore<NavState>((set, get) => ({
  ...inlineLayout(panes.emptyPanes()),
  paneCapacity: 1,
  navigate(selection, options) {
    return get().navigateIn(get().active, selection, options);
  },
  navigateIn(id, selection, options) {
    let layout = layoutOf(get());
    const source = panes.paneById(layout, id);
    if (!source) return { kind: 'unchanged', pane: layout.active };
    const inherited =
      options?.byAgent === true ||
      (options?.replace === true && source.history[source.historyIndex]?.byAgent === true);
    const effective = { ...options, byAgent: inherited };
    layout = capture(layout, id);
    const held = panes.holderOf(layout, selection, id);
    if (held) layout = capture(layout, held.id);
    const result = panes.navigatePane(layout, id, selection, effective);
    leaveSurface(id, result.layout, options?.keepDetail);
    const page = pagePathOf(selection);
    if (
      !inherited &&
      !options?.restore &&
      page !== null &&
      (result.outcome.kind === 'reused' || page !== pagePathOf(source.selection))
    )
      recordPersonOpen(page);
    set(inlineLayout(result.layout));
    notice(result.outcome, effective);
    return result.outcome;
  },
  back(id) {
    step(-1, id ?? get().active);
  },
  forward(id) {
    step(1, id ?? get().active);
  },
  openPane(selection, options) {
    const from = options?.from ?? get().active;
    let layout = capture(layoutOf(get()), from);
    const held = panes.holderOf(layout, selection);
    if (held) layout = capture(layout, held.id);
    const result = panes.openPane(layout, from, selection, get().paneCapacity, options);
    // Opening beside doesn't make the source leave, but a newly claimed file
    // can never remain in the peek too.
    if (result.outcome.kind === 'full') leaveSurface(from, result.layout, options?.keepDetail);
    else if (
      useUiStore.getState().detailPath !== null &&
      result.layout.panes.some(
        (pane) => panes.claimOf(pane.selection) === useUiStore.getState().detailPath,
      )
    )
      useUiStore.getState().closeDetail();
    const page = pagePathOf(selection);
    const sourcePage = pagePathOf(panes.paneById(layout, from)?.selection ?? { kind: 'home' });
    if (
      !options?.byAgent &&
      !options?.restore &&
      page !== null &&
      (result.outcome.pane !== from || page !== sourcePage)
    )
      recordPersonOpen(page);
    set(inlineLayout(result.layout));
    if (result.outcome.kind !== 'reused' || result.outcome.pane !== from)
      notice(result.outcome, options);
    return result.outcome;
  },
  closePane(id = get().active) {
    const layout = layoutOf(get());
    const next = panes.closePane(layout, id);
    if (next === layout) return;
    leaveSurface(id, next);
    captors.delete(id);
    set(inlineLayout(next));
  },
  focusPane(id) {
    const layout = layoutOf(get());
    const next = panes.focusPane(layout, id);
    if (next !== layout) set(inlineLayout(next));
  },
  setPaneCapacity(capacity) {
    const next = Number.isFinite(capacity)
      ? Math.max(1, Math.min(panes.MAX_PANES, Math.floor(capacity)))
      : 1;
    if (next !== get().paneCapacity) set({ paneCapacity: next });
  },
  openPeek(path, options) {
    const from = options?.from ?? get().active;
    const held = panes.holderOf(layoutOf(get()), { kind: 'doc', path });
    if (held) {
      get().focusPane(held.id);
      useUiStore.getState().closeDetail();
      const outcome: NavOutcome = {
        kind: held.id === from ? 'unchanged' : 'reused',
        pane: held.id,
      };
      if (held.id !== from && !options?.byAgent && !options?.restore) recordPersonOpen(path);
      notice(outcome, options);
      return outcome;
    }
    get().focusPane(from);
    useUiStore.getState().openDetail(path, from);
    return { kind: 'navigated', pane: from };
  },
  stepPeek(delta, owner) {
    const layout = layoutOf(get());
    const ui = useUiStore.getState();
    if (owner !== undefined && ui.detailPane !== null && owner !== ui.detailPane) return;
    ui.stepDetail(delta, (path) => panes.holderOf(layout, { kind: 'doc', path }) !== undefined);
  },
  reset() {
    const next = panes.emptyPanes(get().seq);
    next.panes[0].navSeq = get().navSeq + 1;
    useUiStore.getState().closeDetail();
    useUiStore.getState().closeDiff();
    captors.clear();
    set(inlineLayout(next));
  },
  setEntryState(key, value, id = get().active) {
    const layout = layoutOf(get());
    set(
      inlineLayout({
        ...layout,
        panes: layout.panes.map((pane) =>
          pane.id === id
            ? {
                ...pane,
                history: pane.history.map((slot, at) =>
                  at === pane.historyIndex ? withState(slot, key, value) : slot,
                ),
              }
            : pane,
        ),
      }),
    );
  },
  readEntryState<T>(key: EntryStateKey, id = get().active) {
    const pane = panes.paneById(layoutOf(get()), id);
    return pane?.history[pane.historyIndex]?.state?.[key] as T | undefined;
  },
  registerEntryCaptor(key, read, id = get().active) {
    let own = captors.get(id);
    if (!own) {
      own = new Map();
      captors.set(id, own);
    }
    const captor = { read };
    own.set(key, captor);
    return () => {
      if (own.get(key) === captor) own.delete(key);
    };
  },
  setLiveCheck(check) {
    liveCheck = check;
  },
  /** Only the shared rename hook moves pane pointers. */
  replacePath(from, to) {
    if (from === to) return;
    set(inlineLayout(panes.remapPaths(layoutOf(get()), from, to)));
  },
  renameType(from, to) {
    if (from === to) return;
    const rename = (selection: Selection): Selection =>
      selection.kind === 'type' && selection.name === from ? { ...selection, name: to } : selection;
    const layout = layoutOf(get());
    set(
      inlineLayout({
        ...layout,
        panes: layout.panes.map((pane) => ({
          ...pane,
          selection: rename(pane.selection),
          history: pane.history.map((slot) => ({ ...slot, selection: rename(slot.selection) })),
        })),
      }),
    );
  },
  restoreLayout(saved) {
    if (saved.panes.length === 0) return;
    let seq = get().seq;
    const restored: Pane[] = saved.panes.map((pane) => ({
      id: `p${++seq}`,
      selection: pane.entries[pane.index],
      history: pane.entries.map((selection) => ({ selection, byAgent: false })),
      historyIndex: pane.index,
      navSeq: get().navSeq + 1,
    }));
    const active = restored[saved.active]?.id ?? restored[0].id;
    captors.clear();
    useUiStore.getState().closeDetail();
    useUiStore.getState().closeDiff();
    set(
      inlineLayout({
        panes: restored,
        active,
        focusOrder: [
          active,
          ...restored.filter((pane) => pane.id !== active).map((pane) => pane.id),
        ],
        seq,
      }),
    );
  },
}));
function step(direction: -1 | 1, id: PaneId): void {
  const layout = capture(layoutOf(store.getState()), id);
  const result = panes.stepPane(
    layout,
    id,
    direction,
    (selection) => liveCheck?.(selection) ?? true,
  );
  if (result.outcome.kind !== 'unchanged') leaveSurface(id, result.layout);
  store.setState(inlineLayout(result.layout));
}
/** Each pane has stable bound actions. Selecting one never points its buttons
 * at a different pane merely because keyboard focus moved elsewhere. */
const bound = new Map<PaneId, Partial<NavState>>();
function actionsFor(id: PaneId): Partial<NavState> {
  let actions = bound.get(id);
  if (!actions) {
    actions = {
      navigate: (selection, options) => store.getState().navigateIn(id, selection, options),
      back: () => store.getState().back(id),
      forward: () => store.getState().forward(id),
      openPane: (selection, options) =>
        store.getState().openPane(selection, { ...options, from: id }),
      closePane: () => store.getState().closePane(id),
      openPeek: (path, options) => store.getState().openPeek(path, { ...options, from: id }),
      stepPeek: (delta) => store.getState().stepPeek(delta, id),
      setEntryState: (key, value) => store.getState().setEntryState(key, value, id),
      readEntryState: <T>(key: EntryStateKey) => store.getState().readEntryState<T>(key, id),
      registerEntryCaptor: (key, read) => store.getState().registerEntryCaptor(key, read, id),
    };
    bound.set(id, actions);
  }
  return actions;
}
const projections = new WeakMap<NavState, Map<PaneId, NavState>>();
function projected(state: NavState, id: PaneId): NavState {
  let views = projections.get(state);
  if (!views) {
    views = new Map();
    projections.set(state, views);
  }
  let view = views.get(id);
  if (!view) {
    const pane = id === state.active ? null : state.stashed[id];
    view = { ...state, ...pane, ...actionsFor(id) };
    views.set(id, view);
  }
  return view;
}
const identity = (state: NavState) => state;
function useNav<T = NavState>(
  selector: (state: NavState) => T = identity as (state: NavState) => T,
): T {
  const pane = useContext(PaneContext);
  const select = useMemo(
    () => (state: NavState) => selector(pane === null ? state : projected(state, pane)),
    [pane, selector],
  );
  return useStore(store, select);
}
export const useNavStore = Object.assign(useNav, store, {
  getPaneState: (id: PaneId): NavState => projected(store.getState(), id),
});
export function usePaneId(): PaneId {
  const context = useContext(PaneContext);
  return useStore(store, (state) => context ?? state.active);
}
