/**
 * Quitting saves first (M55.10).
 *
 * ⌘Q, the close button and ⌘W ask the webview before the app exits
 * (`src-tauri/src/shell/quit.rs`). `prepareQuit` answers: it commits the
 * focused field, lands every open page's pending save, waits for the writes,
 * then leaves the shell so every page runs its own leave path, waits again,
 * and tells Rust to exit. Rust owns the deadline and exits without an answer
 * once it passes, so every step here is bounded by a share of the deadline
 * the request names, and no constant here twins Rust's.
 *
 * A save that fails, before or during the leave, keeps the app open with a
 * toast. A second quit within `QUIT_ANYWAY_MS` closes anyway.
 *
 * Dock Quit, logout, restart and shutdown never ask, so none of this runs
 * for them. See quit.rs.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { flushOpenPages, unresolvedOpenPages } from '@/editor/openPages';
import type { FlushReport } from '@/editor/documentOwner';
import {
  cancelQuit,
  finishQuit,
  listenQuitRequested,
  pageWriteFailures,
  settlePageWrites,
  type QuitRequest,
} from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';

/** How long after a quit that stayed open a second quit closes anyway. */
export const QUIT_ANYWAY_MS = 30_000;

/** The toast a quit that stayed open shows. */
export const STAYED_TOAST =
  "A page couldn't save, so Cerebro stayed open. Quit again to close anyway.";

/** Each step's share of the deadline: the rest is headroom for exiting. */
const FLUSH_SHARE = 0.5;
const SETTLE_SHARE = 0.15;
const LEAVE_SHARE = 0.15;

// --- Leaving ------------------------------------------------------------------
//
// To leave, App swaps the shell for QuitScreen. The shell's unmount runs every
// page's own leave path (MarkdownEditor's unmount flush, NoteBodyEditor's held
// save, useDiagramFile's and CodeOverlay's flushes), and QuitScreen's mount
// effect, which React runs after those cleanups, says the leave is done.

let leaving = false;
const leavingListeners = new Set<() => void>();
let onLeft: (() => void) | null = null;

function setLeaving(next: boolean): void {
  if (leaving === next) return;
  leaving = next;
  for (const listener of [...leavingListeners]) listener();
}

/** Hear the leaving flag change; the returned function stops. */
export function subscribe(listener: () => void): () => void {
  leavingListeners.add(listener);
  return () => {
    leavingListeners.delete(listener);
  };
}

/** Whether the shell has been left for the quit screen. */
export function isQuitting(): boolean {
  return leaving;
}

/** `isQuitting` as React state. */
export function useQuitting(): boolean {
  return useSyncExternalStore(subscribe, isQuitting, isQuitting);
}

/**
 * Leave the shell. True confirms QuitScreen mounted (`markLeft`); false
 * means the budget expired before the cleanup phase was confirmed.
 */
export function beginLeaving(budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const done = (completed: boolean) => {
      clearTimeout(timer);
      if (onLeft === left) onLeft = null;
      resolve(completed);
    };
    const left = () => done(true);
    const timer = setTimeout(() => done(false), budgetMs);
    onLeft = left;
    setLeaving(true);
  });
}

/** QuitScreen mounted: every page under the shell has run its leave. */
export function markLeft(): void {
  onLeft?.();
}

// --- The prepare ----------------------------------------------------------------

/** What a prepare reaches for, injectable for tests. */
export interface QuitDeps {
  blurFocused: () => void;
  pageWriteFailures: () => number;
  flushOpenPages: (budgetMs: number) => Promise<FlushReport>;
  hasUnresolved: () => boolean;
  settlePageWrites: (budgetMs: number) => Promise<boolean>;
  beginLeaving: (budgetMs: number) => Promise<boolean>;
  /** Undo `beginLeaving` when a prepare stays open after all. */
  endLeaving: () => void;
  finishQuit: () => Promise<void>;
  cancelQuit: () => Promise<void>;
  toast: (message: string) => void;
  listenQuitRequested: (handler: (request: QuitRequest) => void) => Promise<() => void>;
}

/** Commit the field being typed in: titles and properties save on blur. */
function blurFocused(): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== document.body) focused.blur();
}

export const quitDeps: QuitDeps = {
  blurFocused,
  pageWriteFailures,
  flushOpenPages,
  hasUnresolved: () => unresolvedOpenPages().length > 0,
  settlePageWrites,
  beginLeaving,
  endLeaving: () => setLeaving(false),
  finishQuit,
  cancelQuit,
  toast: (message) => useUiStore.getState().toast(message),
  listenQuitRequested,
};

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A timeout is an unresolved step, never a successful void return. */
async function within<T>(
  step: Promise<T>,
  budgetMs: number,
): Promise<{ completed: true; value: T } | { completed: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<{ completed: false }>((resolve) => {
    timer = setTimeout(() => resolve({ completed: false }), budgetMs);
  });
  try {
    return await Promise.race([
      step.then((value) => ({ completed: true as const, value })),
      budget,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save everything, then exit: blur, flush, settle, leave, settle, finish.
 * Never rejects. Answers `stayed` when a save failed and the app stays open,
 * or `finished` once Rust was told to exit. With `quitAnyway`, a failure does
 * not stop it.
 */
export async function prepareQuit(
  request: QuitRequest,
  deps: QuitDeps = quitDeps,
  quitAnyway = false,
): Promise<'stayed' | 'finished'> {
  const flushMs = request.deadlineMs * FLUSH_SHARE;
  const settleMs = request.deadlineMs * SETTLE_SHARE;
  const leaveMs = request.deadlineMs * LEAVE_SHARE;

  const stay = async (): Promise<'stayed'> => {
    deps.endLeaving();
    await deps.cancelQuit().catch(() => undefined);
    deps.toast(STAYED_TOAST);
    return 'stayed';
  };

  try {
    const before = deps.pageWriteFailures();
    deps.blurFocused();
    // A blur commit starts its write in its own handler: let it.
    await macrotask();
    const flushed = await within(deps.flushOpenPages(flushMs), flushMs);
    if (!quitAnyway && (!flushed.completed || flushed.value.unresolvedOwnerIds.length > 0))
      return await stay();
    const settled = await within(deps.settlePageWrites(settleMs), settleMs);
    if (
      !quitAnyway &&
      (!settled.completed ||
        !settled.value ||
        deps.hasUnresolved() ||
        deps.pageWriteFailures() > before)
    )
      return await stay();
    const left = await within(deps.beginLeaving(leaveMs), leaveMs);
    if (!quitAnyway && (!left.completed || !left.value)) return await stay();
    const afterLeave = await within(deps.settlePageWrites(settleMs), settleMs);
    // Compatibility check for a legacy cleanup writer. Registered owners
    // already prepared and acknowledged while mounted; unresolved retained
    // owners remain recoverable if an unexpected cleanup starts another write.
    if (
      !quitAnyway &&
      (!afterLeave.completed ||
        !afterLeave.value ||
        deps.hasUnresolved() ||
        deps.pageWriteFailures() > before)
    )
      return await stay();
  } catch {
    // An unexpected throw is a save that may not have landed.
    if (!quitAnyway) {
      try {
        return await stay();
      } catch {
        return 'stayed';
      }
    }
  }
  // Rejects only when Rust's deadline already won; the app is exiting anyway.
  await deps.finishQuit().catch(() => undefined);
  return 'finished';
}

// --- The host -------------------------------------------------------------------

let running = false;
let stayedAt: number | null = null;

async function answer(request: QuitRequest, deps: QuitDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    const quitAnyway = stayedAt !== null && Date.now() - stayedAt < QUIT_ANYWAY_MS;
    const outcome = await prepareQuit(request, deps, quitAnyway);
    stayedAt = outcome === 'stayed' ? Date.now() : null;
  } finally {
    running = false;
  }
}

/**
 * Answer the shell's quit requests while mounted. A request while one runs
 * is ignored: Rust's deadline bounds the first. Called once, in App, above
 * every early return, so the vault chooser answers too.
 */
export function useQuitHost(deps: QuitDeps = quitDeps): void {
  useEffect(() => {
    let gone = false;
    let unlisten: (() => void) | null = null;
    deps
      .listenQuitRequested((request) => {
        void answer(request, deps);
      })
      .then((stop) => {
        if (gone) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [deps]);
}

/** Test isolation: forget any quit in progress, its leave and its stay. */
export function __resetQuit(): void {
  running = false;
  stayedAt = null;
  onLeft = null;
  setLeaving(false);
}
