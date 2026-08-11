import { useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/editor/NoteBodyEditor';
import { readNote, saveNote } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** How long a pause in editing waits before the source flushes to disk. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * How many source versions the undo stack keeps, and how close together two
 * changes have to be to count as one (M29.52).
 *
 * 250ms separates the two kinds of edit this surface produces without needing
 * to be told which is which: typing in the code overlay arrives every 50–150ms
 * and collapses into one step, while two structural ops need two deliberate
 * clicks and stay two. The wave's ops were all built to be "one op, one
 * onChangeCode, one undo step" — this is the stack that claim was about, and
 * until now it did not exist.
 */
const HISTORY_LIMIT = 200;
const COALESCE_MS = 250;

/**
 * The trust signal beside a diagram's title; `idle` stays quiet on purpose.
 *
 * It lives with the hook that produces `saveState` rather than with either
 * host, because both the diagram page and the whiteboard tab show it and a
 * second copy of the table is a second place for the wording to drift.
 */
export const SAVE_LABEL: Record<SaveState, string | null> = {
  idle: null,
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  failed: "Couldn't save",
};

export interface DiagramFile {
  /** null while loading; hosts only mount editors on real content. */
  code: string | null;
  /** The read failed — renamed, trashed, or unreadable. The tombstone signal. */
  loadFailed: boolean;
  saveState: SaveState;
  /** The one write channel: every edit — typed or structural — goes through here. */
  handleChange: (next: string) => void;
  /** Step back / forward through this session's edits (M29.52). No-ops at the ends. */
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * A `.mmd` file's whole editing lifecycle (M29.46): read-once, debounce-save,
 * survive-unmount. Extracted verbatim from DiagramPage (M29.21) so the
 * whiteboard view (M29.46) edits its canvas with the identical discipline.
 *
 * THE KEYED-MOUNT CONTRACT (M29.23) TRAVELS WITH THIS HOOK: the component
 * calling it MUST be mounted `key={path}` by its host, so a path change is a
 * true unmount. The pending-debounce flush runs as an unmount cleanup, and
 * only a true unmount guarantees that cleanup still belongs to the file it
 * was editing — an unkeyed path change re-points `handleChange`'s refs at
 * the new file FIRST and then runs the old cleanup, which writes the old
 * file's bytes into the new one and drops the pending edit. App.tsx keys
 * DiagramPage; WhiteboardView keys its canvas subtree. Do not call this from
 * a component whose host does not key it.
 *
 * Content is RAW end-to-end: readNote/saveNote pass `.mmd` bytes through
 * verbatim, so mermaid's own `---` config header survives every save. No
 * external live-reload (DocPage's M17.4 reconcile problem, consciously
 * deferred): the file is read once per mount, and an outside edit wins or
 * loses on last-write like any plain editor.
 */
export function useDiagramFile(path: string): DiagramFile {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);

  const [code, setCode] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // Only a FAILED READ sets this: the file is the truth in a files-first app,
  // so a path the scanner has not adopted yet still opens (a just-created
  // .mmd edits fine pre-rescan), and only "nothing readable here" is gone.
  const [loadFailed, setLoadFailed] = useState(false);

  // The save pipeline lives in refs so the debounce and the unmount flush
  // always see the newest source without re-arming effects per keystroke.
  const latest = useRef('');
  const timer = useRef<number | null>(null);
  const saving = useRef(false);
  const queued = useRef(false);

  const flushRef = useRef<() => Promise<void>>(async () => {});
  flushRef.current = async () => {
    if (vaultPath === null) return;
    if (saving.current) {
      // A save is already on the wire; run again with the newer bytes when
      // it lands rather than racing two writes to the same file.
      queued.current = true;
      return;
    }
    saving.current = true;
    setSaveState('saving');
    try {
      await saveNote(vaultPath, path, latest.current);
      saving.current = false;
      if (queued.current) {
        queued.current = false;
        await flushRef.current();
      } else {
        setSaveState('saved');
      }
    } catch {
      saving.current = false;
      queued.current = false;
      setSaveState('failed');
      toast("Couldn't save diagram");
    }
  };

  // The undo stack (M29.52). Strings, not diffs: a `.mmd` is small, the whole
  // wave's ops are already whole-source rewrites, and holding versions means
  // undo cannot drift from what is on screen the way a replayed inverse can.
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastPush = useRef(0);
  // The stack lives in refs so a keystroke does not re-arm effects; this is the
  // one bit of it a RENDER depends on, for the toolbar's disabled states.
  const [ends, setEnds] = useState({ canUndo: false, canRedo: false });
  const syncEnds = () =>
    setEnds({ canUndo: past.current.length > 0, canRedo: future.current.length > 0 });

  /**
   * Every write to `code`, in one place. `remember` is false for the two moves
   * that are themselves history navigation — otherwise undoing would push the
   * state it just left onto the past and the stack could never advance.
   */
  const applyCode = (next: string, remember: boolean) => {
    if (remember) {
      const now = Date.now();
      if (past.current.length === 0 || now - lastPush.current > COALESCE_MS) {
        past.current.push(latest.current);
        if (past.current.length > HISTORY_LIMIT) past.current.shift();
      }
      lastPush.current = now;
      // A fresh edit forks the timeline: whatever was redoable is unreachable.
      future.current = [];
    }
    latest.current = next;
    setCode(next);
    setSaveState('dirty');
    syncEnds();
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  };

  const handleChange = (next: string) => applyCode(next, true);

  const undo = () => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(latest.current);
    applyCode(prev, false);
  };

  const redo = () => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(latest.current);
    applyCode(next, false);
  };

  // Read through refs by the window listener below, which registers once.
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;

  /**
   * Cmd/Ctrl+Z anywhere on this surface, because the thing a user has just
   * clicked is a `<g>` in an svg and there is nowhere else for the key to go
   * (measured: a real Cmd+Z after `+ Node` left the node in the file). A
   * control with its OWN undo keeps it — the code overlay's textarea is a real
   * text field and the browser's history there is better than ours.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
      ) {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) redoRef.current();
      else undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Load once per mount (the host's key makes a path change a fresh mount).
  useEffect(() => {
    let cancelled = false;
    setCode(null);
    setSaveState('idle');
    setLoadFailed(false);
    // A fresh file is a fresh timeline. The host keys this hook on the path, so
    // in practice this is a fresh mount too — but the effect also re-runs on a
    // vault change, and undoing into another file's bytes would be a data bug,
    // not a UI one.
    past.current = [];
    future.current = [];
    setEnds({ canUndo: false, canRedo: false });
    if (vaultPath === null) return;
    void readNote(vaultPath, path)
      .then((raw) => {
        if (cancelled) return;
        latest.current = raw;
        setCode(raw);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, path]);

  // A pending debounce must not die with the host: flush it on unmount. This
  // is only safe BECAUSE the host keys the caller on the path — a path change
  // is a real unmount, so the flushRef this cleanup reads was last assigned
  // by the dying instance and still closes over ITS path and bytes. (Without
  // the key, the new path's render reassigned flushRef before this ran.)
  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void flushRef.current();
      }
    };
  }, []);

  return { code, loadFailed, saveState, handleChange, undo, redo, ...ends };
}
