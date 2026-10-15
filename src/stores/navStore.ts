import { create } from 'zustand';
import type { Selection } from '@/engine/types';
import { deepEqual } from '@/lib/deepEqual';
import { recordPersonOpen, useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

export interface NavigateOptions {
  /**
   * Keep the record panel open across this navigation.
   *
   * The ONE caller that needs it is the detail panel's own container
   * breadcrumb: it navigates to the record's Collection precisely so you can
   * read the record against its container, so closing the panel would undo the
   * thing the button exists to do. Everything else is a surface change, and a
   * record panel from another surface is not part of it.
   */
  keepDetail?: boolean;
  /**
   * Write over the current history slot instead of adding one (M55.12).
   *
   * For a selection that only forwards: `{kind:'agents', actor}` and a library
   * agent path both render nothing and send you to the agent's page. Pushed,
   * the forwarder would be the step Back lands on, and landing there forwards
   * you straight back — Back would never leave the page.
   */
  replace?: boolean;
  /**
   * An agent moved the app, not the person (M59.3): the open log records
   * nothing. A replace inherits its slot's flag, so the page an agent's
   * forwarder lands on is the agent's open too.
   */
  byAgent?: boolean;
}

interface NavState {
  selection: Selection;
  history: Selection[];
  historyIndex: number;
  navigate(sel: Selection, options?: NavigateOptions): void;
  back(): void;
  forward(): void;
  replacePath(from: string, to: string): void;
}

/**
 * Rewrite one path inside a selection, including anything beneath it.
 *
 * A folder rename moves every descendant, so an exact-match-only rewrite would
 * leave `docs/old/page.md` in the history after `docs/old` became `docs/new`.
 */
function remapSelection(sel: Selection, from: string, to: string): Selection {
  const swap = (p: string): string | null => {
    if (p === from) return to;
    if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
    return null;
  };
  if (sel.kind === 'doc' || sel.kind === 'diagram') {
    const next = swap(sel.path);
    return next === null ? sel : { ...sel, path: next };
  }
  if (sel.kind === 'knowledge' && sel.path !== undefined) {
    const next = swap(sel.path);
    return next === null ? sel : { ...sel, path: next };
  }
  if (sel.kind === 'collection') {
    const next = swap(sel.folder);
    return next === null ? sel : { ...sel, folder: next };
  }
  return sel;
}

/**
 * The history slots an agent put there (M59.3), by identity: `navigate`
 * stores a fresh object per step, and a slot no one marked is the person's.
 */
const agentSlots = new WeakSet<Selection>();

/**
 * The page a selection shows, for the open log (M59.3): a doc or diagram, or
 * a library item. Paths, not whole selections — a tab or comment thread on
 * the same page is the same page.
 */
function pagePathOf(sel: Selection | undefined): string | null {
  if (sel === undefined) return null;
  if (sel.kind === 'doc' || sel.kind === 'diagram') return sel.path;
  if (sel.kind === 'library') return sel.path ?? null;
  return null;
}

/**
 * Surface-scoped UI state, dropped whenever the surface changes (M9.7/M15).
 *
 * An open diff belongs to the note you were reading; an open record panel
 * belongs to the table you opened it from. Carrying either across a navigation
 * shows one surface's state against another's — the record panel was following
 * users onto Docs, Inbox, Knowledge, Settings and Pulse, where it read as the
 * page content rather than as a leftover.
 *
 * Safe for opening records because `useOpenPath` navigates FIRST and calls
 * `openDetail` after, so the panel it opens is never the one closed here.
 */
function leaveSurface(keepDetail: boolean): void {
  const ui = useUiStore.getState();
  ui.closeDiff();
  if (!keepDetail) ui.closeDetail();
}

/**
 * Structural equality. A Selection is a flat bag of primitives except for
 * `knowledge.nav`, which is one level deeper — hence `deepEqual` rather than
 * a stringify compare, which would also make the answer depend on key order.
 */
function sameSelection(a: Selection | undefined, b: Selection): boolean {
  return a !== undefined && deepEqual(a, b);
}

export const useNavStore = create<NavState>((set, get) => ({
  selection: { kind: 'home' },
  history: [{ kind: 'home' }],
  historyIndex: 0,

  navigate(sel, options) {
    const { history, historyIndex } = get();
    leaveSurface(options?.keepDetail === true);
    // Strip explicitly-undefined keys at the door (M45.3): the deepEqual
    // hoist counts an undefined-valued key as a key, so a spread-built
    // `{kind:'doc', path, tab: undefined}` would compare UNEQUAL to the
    // literal without it and mint a phantom history step. Absent and
    // explicitly undefined spell the same place; normalizing what we STORE
    // also keeps the poison out of every later compare.
    const target = Object.fromEntries(
      Object.entries(sel).filter(([, v]) => v !== undefined),
    ) as Selection;
    // Navigating to where you already are is not a history step. Without this,
    // a rename that repairs history and then re-opens the moved page leaves two
    // identical adjacent entries, and the first Back press appears to do
    // nothing. Surface state is still dropped above — that part did happen.
    if (sameSelection(history[historyIndex], target)) {
      set({ selection: target });
      return;
    }
    const replace = options?.replace === true;
    const byAgent = options?.byAgent === true || (replace && agentSlots.has(history[historyIndex]));
    // A person's open of a page records once (M59.3), pushed or replaced: a
    // replace finishes a forwarder's open (M55.12's `{kind:'agents', actor}`
    // lands on the agent's page). Moving within one page records nothing.
    const page = pagePathOf(target);
    if (!byAgent && page !== null && page !== pagePathOf(history[historyIndex])) {
      recordPersonOpen(page);
    }
    if (byAgent) agentSlots.add(target);
    if (replace) {
      set({
        selection: target,
        history: history.map((sel, i) => (i === historyIndex ? target : sel)),
      });
      return;
    }
    const next = [...history.slice(0, historyIndex + 1), target];
    set({ selection: target, history: next, historyIndex: next.length - 1 });
  },

  back() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const index = historyIndex - 1;
    leaveSurface(false);
    set({ selection: history[index], historyIndex: index });
  },

  forward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const index = historyIndex + 1;
    leaveSurface(false);
    set({ selection: history[index], historyIndex: index });
  },

  /**
   * Follow a file that moved (M15).
   *
   * Renaming leaves the old path in `history`, and Back then lands on a path
   * that no longer exists — the "This page no longer exists" empty state, from
   * a file the user never deleted. "Add page" hit this every time: growing a
   * single file into a doc folder renames it, so the entry you were reading
   * one step ago was already dead by the time you pressed Back.
   *
   * The history entry is rewritten in place rather than dropped: the user did
   * navigate there, and the note is still that note at a new address.
   *
   * The open log follows the same move in the current vault (M59.3), so a
   * renamed page keeps its opens and a folder carries its descendants'.
   */
  replacePath(from, to) {
    if (from === to) return;
    set((s) => ({
      selection: remapSelection(s.selection, from, to),
      history: s.history.map((sel) => remapSelection(sel, from, to)),
    }));
    const vault = useVaultStore.getState().vaultPath;
    if (vault !== null) useOpenLogStore.getState().remap(vault, from, to);
  },
}));
