import { documentAdmission, waitForDocumentAdmission } from '@/editor/documentAdmission';
import {
  holdEditor,
  registerSaveParticipant,
  retainDocumentOwner,
  retainedDocumentOwner,
  releaseDocumentOwner,
} from '@/editor/openPages';
import type { DocumentOwner } from '@/editor/documentOwner';
import { usePaneId } from '@/stores/navStore';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRecoveryCapture, type RecoveryCapture } from '@/editor/recoveryBuffers';
import type { SaveState } from '@/editor/NoteBodyEditor';
import { readNote, saveNote } from '@/lib/ipc';
import { useCommands } from '@/lib/keys/useKeys';
import { useUiStore } from '@/stores/uiStore';
import { useEntry, useVaultStore } from '@/stores/vaultStore';

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
  retry: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  recoveryCapture: RecoveryCapture;
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
 * external live-reload: markdown pages merge an outside write in place
 * (M55.6), but a `.mmd` file is still read once per mount, and an outside
 * edit wins or loses on last-write like any plain editor.
 */
export function useDiagramFile(path: string): DiagramFile {
  const pane = usePaneId();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  useEffect(() => holdEditor(path, pane, vaultPath), [path, pane, vaultPath]);
  const entry = useEntry(path);
  const [readGeneration, setReadGeneration] = useState(0);
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
  const owner = useRef<DocumentOwner | null>(null);
  const previousRecoveryCapture = useRef<RecoveryCapture | null>(null);
  const recoveryCapture = useMemo(
    () =>
      createRecoveryCapture({
        vaultId: vaultPath,
        path,
        ownerId: pane,
        generation: readGeneration,
      }),
    [vaultPath, path, pane, readGeneration],
  );
  // Keep the memo calculation pure under StrictMode's ignored second call.
  if (previousRecoveryCapture.current !== recoveryCapture) {
    previousRecoveryCapture.current?.detach();
    previousRecoveryCapture.current = recoveryCapture;
  }

  const flushRef = useRef<() => Promise<void>>(async () => {});
  flushRef.current = async () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const result = await owner.current?.flush();
    if (result?.kind === 'failed') toast("Couldn't save diagram");
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
    const target = recoveryCapture.owner();
    if (target === null) return;
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
    target.edit(next);
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
    if (recoveryCapture.owner() === null) return;
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(latest.current);
    applyCode(prev, false);
  };

  const redo = () => {
    if (recoveryCapture.owner() === null) return;
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(latest.current);
    applyCode(next, false);
  };

  /**
   * ⌘Z and ⇧⌘Z anywhere on this surface (M65.1: `diagram.undo/redo`, bound
   * in the page or peek around the host), because the thing a user has just
   * clicked is a `<g>` in an svg and there is nowhere else for the key to go
   * (measured: a real Cmd+Z after `+ Node` left the node in the file). A
   * control with its OWN undo keeps it — the code overlay's textarea is a real
   * text field, its `editor` claim holds the keys back, and the browser's
   * history there is better than ours. The binding shadows the app's own
   * undo, so a diagram's undo stays the diagram's and never reverts a
   * database change behind it.
   */
  useCommands([
    { id: 'diagram.undo', run: undo },
    { id: 'diagram.redo', run: redo },
  ]);

  // The retained owner survives a failed save and a reopened presentation.
  // Its writer always closes over the original vault/path, never current UI.
  useEffect(() => {
    let cancelled = false;
    let own: DocumentOwner | null = null;
    let stop = () => {};
    let stopParticipant = () => {};
    setCode(null);
    setSaveState('idle');
    setLoadFailed(false);
    past.current = [];
    future.current = [];
    setEnds({ canUndo: false, canRedo: false });
    if (vaultPath === null) return;
    const key = { vaultId: vaultPath, path, ownerId: pane };
    const attach = (initial: string) => {
      if (cancelled) return;
      const target = retainDocumentOwner(
        key,
        initial,
        async (body, _format, _bypass, expectHash, destination = key) => {
          const hash = await (expectHash === undefined
            ? saveNote(destination.vaultId, destination.path, body)
            : saveNote(destination.vaultId, destination.path, body, expectHash));
          if (hash === null) throw new Error('unconfirmed_diagram_save');
          return { kind: 'file', contentHash: hash };
        },
      );
      own = target;
      owner.current = target;
      recoveryCapture.bind(target);
      latest.current = target.snapshot().latestDraft;
      setCode(latest.current);
      const publish = () => {
        if (cancelled) return;
        if (target.recoveryRetired()) {
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = null;
          recoveryCapture.detach();
          setCode(null);
          setLoadFailed(true);
          setSaveState('idle');
          return;
        }
        const state = target.snapshot();
        latest.current = state.latestDraft;
        setCode(state.latestDraft);
        setSaveState(
          state.inFlightGeneration !== null
            ? 'saving'
            : state.failure !== null
              ? 'failed'
              : state.generation > state.acknowledgedGeneration
                ? 'dirty'
                : state.generation > 0
                  ? 'saved'
                  : 'idle',
        );
      };
      stop = target.subscribe(publish);
      publish();
      stopParticipant = registerSaveParticipant({
        identity: target,
        key,
        snapshot: () => target.snapshot(),
        prepare: () => {
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = null;
        },
        flush: async () => {
          const result = await target.flush();
          if (result.kind === 'failed') toast("Couldn't save diagram");
          return result;
        },
      });
    };
    void (async () => {
      for (;;) {
        if (
          !(await waitForDocumentAdmission(
            key,
            () => !cancelled && useVaultStore.getState().vaultPath === vaultPath,
          ))
        )
          return;
        const retained = retainedDocumentOwner(key);
        if (retained !== undefined) {
          attach(retained.snapshot().latestDraft);
          return;
        }
        const text = await readNote(vaultPath, path);
        if (cancelled) return;
        if (documentAdmission(key).kind === 'deferred') continue;
        attach(text);
        return;
      }
    })().catch(() => {
      if (!cancelled) setLoadFailed(true);
    });
    return () => {
      cancelled = true;
      const pending = timer.current !== null;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      stop();
      stopParticipant();
      if (own !== null) {
        if (pending) void own.flush();
        releaseDocumentOwner(own, path);
      }
      if (owner.current === own) owner.current = null;
    };
  }, [vaultPath, path, pane, toast, recoveryCapture]);
  useEffect(() => {
    if (loadFailed && entry && owner.current?.recoveryRetired())
      setReadGeneration((generation) => generation + 1);
  }, [loadFailed, entry]);

  return {
    code,
    loadFailed,
    saveState,
    handleChange,
    undo,
    redo,
    retry: () => flushRef.current(),
    recoveryCapture,
    ...ends,
  };
}
