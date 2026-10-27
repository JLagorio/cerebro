import { documentAdmission, waitForDocumentAdmission } from '@/editor/documentAdmission';
import { useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/editor/NoteBodyEditor';
import type { DocumentKey, OwnerSnapshot, SaveOutcome } from '@/editor/documentOwner';
import type { SaveParticipant } from '@/editor/saveParticipants';
import type { RecoveryPayload } from '@/editor/deletedDraftRecovery';
import {
  holdEditor,
  onExternalWrite,
  registerSaveParticipant,
  retainedSaveParticipant,
} from '@/editor/openPages';
import { problemsOf, type Problem } from '@/engine/scene/board';
import { createSceneEditor, type SceneEditor } from '@/engine/scene/editor';
import { readCanvas, writeCanvas } from '@/engine/scene/jsonCanvas';
import { mergeBoards } from '@/engine/scene/merge';
import type { Board } from '@/engine/scene/model';
import { isKnowledgePath } from '@/engine/okf';
import { readCanvasFile, saveCanvasFile } from '@/lib/ipc';
import {
  pendingBoardDrafts,
  settleBoardText,
  subscribeBoardDrafts,
  discardBoardDrafts,
} from './pendingText';
import { usePaneId } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useEntry, useVaultStore } from '@/stores/vaultStore';
import { newBoardId } from './ids';

export type CanvasHeld = 'missing' | 'unreadable' | null;
export type CanvasFile =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'unavailable'; reason: string; preview: string }
  | {
      state: 'ready';
      editor: SceneEditor;
      problems: readonly Problem[];
      saveState: SaveState;
      held: CanvasHeld;
      readOnly: boolean;
      reload: () => Promise<void>;
    };

interface CanvasOwner extends SaveParticipant {
  mount: (publish: (state: CanvasFile) => void, attachedPath: string) => () => void;
  changedHash: (hash: string | null | undefined) => void;
}

/** The file owner survives a failed leave. Reopening reattaches the exact scene
 * and undo history, rather than reparsing older disk bytes into a new editor. */
function createCanvasOwner(key: DocumentKey): CanvasOwner {
  const { vaultId: vault, ownerId } = key;
  let path = key.path;
  let renameHeld = false;
  let renamed = false;
  let awaitingMovedPresentation = false;
  let stopVault = () => {};
  let externalGeneration = 0;
  let fileGeneration = 0;
  const readOnly = isKnowledgePath(path);
  const views = new Set<(state: CanvasFile) => void>();
  const recoveryListeners = new Set<() => void>();
  let recoveryHeld = false;
  let recoveryAdmission: (() => boolean) | null = null;
  let stopDrafts = () => {};
  let state: CanvasFile = { state: 'loading' };
  let editor: SceneEditor | null = null;
  let saved: Board | null = null;
  let held: CanvasHeld = null;
  let saveState: SaveState = 'idle';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<SaveOutcome> | null = null;
  let loading: Promise<void> | null = null;
  let readAgain = false;
  let blocked = false;
  let applying = false;
  let disposed = false;
  let failure: OwnerSnapshot['failure'] = null;
  let generation = 0;
  let acknowledgedGeneration = 0;
  let inFlightGeneration: number | null = null;
  let unlisten = () => {};
  let stopRegistration = () => {};
  let knownHash: string | null = null;
  let lastEntryHash = useVaultStore.getState().entries.find((entry) => entry.path === path)?.hash;
  let releaseEditor = holdEditor(path, ownerId, vault);
  const dirty = () => editor !== null && editor.board !== saved;
  const drafts = () => (editor === null ? [] : pendingBoardDrafts(editor));
  const toast = (words: string) => {
    if (useVaultStore.getState().vaultPath === vault) useUiStore.getState().toast(words);
  };
  const publish = () => {
    if (editor !== null)
      state = {
        state: 'ready',
        editor,
        problems: problemsOf(editor.board),
        saveState,
        held,
        readOnly,
        reload,
      };
    for (const view of views) view(state);
    for (const notify of recoveryListeners) notify();
  };
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const retire = () => {
    if (
      disposed ||
      views.size ||
      dirty() ||
      drafts().length ||
      saving ||
      loading ||
      recoveryHeld ||
      renameHeld ||
      awaitingMovedPresentation
    )
      return;
    disposed = true;
    stopVault();
    cancelTimer();
    stopRegistration();
    stopExternal();
    unlisten();
    stopDrafts();
    releaseEditor();
    editor?.dispose();
  };
  const schedule = () => {
    cancelTimer();
    if (
      !disposed &&
      !recoveryHeld &&
      views.size &&
      !failure &&
      !readOnly &&
      !renameHeld &&
      !blocked &&
      held === null &&
      dirty()
    )
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 500);
  };
  const prepare = () => {
    if (disposed || recoveryHeld) return;
    if (editor !== null) settleBoardText(editor);
  };
  const hold = (includeDrafts = true) => {
    if (renameHeld) return 'reconcile' as const;
    if (recoveryHeld) return 'choice' as const;
    if (includeDrafts && drafts().length) return 'choice' as const;
    if (dirty() && (readOnly || blocked || held !== null)) return 'reconcile' as const;
    return null;
  };
  const flush = (includeDrafts = false): Promise<SaveOutcome> => {
    cancelTimer();
    if (disposed) return Promise.resolve({ kind: 'clean', ownerId, generation });
    if (saving !== null) return saving;
    const reason = hold(includeDrafts);
    if (reason) return Promise.resolve({ kind: 'blocked', ownerId, generation, reason });
    if (editor === null || !dirty()) return Promise.resolve({ kind: 'clean', ownerId, generation });
    saving = (async (): Promise<SaveOutcome> => {
      let outcome: SaveOutcome = { kind: 'clean', ownerId, generation };
      while (editor !== null && dirty()) {
        const reason = hold(includeDrafts);
        if (reason) return { kind: 'blocked', ownerId, generation, reason };
        const writing = editor.board;
        const writingGeneration = generation;
        inFlightGeneration = writingGeneration;
        saveState = 'saving';
        publish();
        let code = 'save_failed';
        try {
          const result = await saveCanvasFile(vault, path, writeCanvas(writing));
          if (!result.ok) {
            code = result.refusal.code;
            if (code === 'missing') held = 'missing';
            if (['unreadable_on_disk', 'too_large', 'not_text'].includes(code)) held = 'unreadable';
            throw new Error(result.refusal.message);
          }
          knownHash = result.hash;
          saved = writing;
          acknowledgedGeneration = writingGeneration;
          failure = null;
          outcome = {
            kind: 'acknowledged',
            ownerId,
            generation: writingGeneration,
            write: { kind: 'file', contentHash: result.hash },
          };
          saveState = dirty() ? 'dirty' : 'saved';
          publish();
        } catch {
          saveState = 'failed';
          if (!failure) toast("Couldn't save whiteboard");
          failure = { kind: 'failed', ownerId, generation: writingGeneration, code };
          publish();
          return failure;
        } finally {
          inFlightGeneration = null;
        }
      }
      return outcome;
    })().finally(() => {
      saving = null;
      publish();
      retire();
    });
    return saving;
  };
  const unreadable = (reason: string, preview: string, missing = false) => {
    held = missing ? 'missing' : 'unreadable';
    if (editor !== null && (dirty() || drafts().length)) publish();
    else {
      state = missing
        ? { state: 'missing' }
        : { state: 'unavailable', reason, preview: preview.slice(0, 20_000) };
      for (const view of views) view(state);
    }
  };
  const read = async () => {
    if (saving !== null) await saving;
    if (disposed || renameHeld) return;
    const readingGeneration = fileGeneration;
    const admittedRead = () =>
      !disposed &&
      !renameHeld &&
      readingGeneration === fileGeneration &&
      (recoveryAdmission === null || recoveryAdmission());
    try {
      const result = await readCanvasFile(vault, path);
      if (!admittedRead()) return;
      const admitted = recoveryAdmission !== null;
      if (!result.ok) {
        unreadable(result.refusal.message, '', result.refusal.code === 'missing');
        return;
      }
      const unchanged = knownHash === result.hash;
      knownHash = result.hash;
      const parsed = readCanvas(result.content);
      if (!parsed.ok) {
        unreadable(parsed.message, result.content);
        return;
      }
      if (unchanged && editor !== null && held === null) {
        if (admitted) {
          recoveryHeld = false;
          recoveryAdmission = null;
        }
        publish();
        return;
      }
      held = null;
      if (editor === null) {
        editor = createSceneEditor(parsed.board, { createId: newBoardId });
        stopDrafts = subscribeBoardDrafts(editor, () => {
          for (const notify of recoveryListeners) notify();
        });
        saved = editor.board;
        unlisten = editor.subscribe(({ cause }) => {
          if (disposed || applying || ['begin', 'preview', 'cancel', 'select'].includes(cause))
            return;
          generation += 1;
          if (!dirty()) {
            acknowledgedGeneration = generation;
            failure = null;
          }
          saveState = dirty() ? 'dirty' : 'idle';
          publish();
          schedule();
        });
      } else if (!dirty()) {
        applying = true;
        editor.applyExternal(parsed.board, 'Outside edit');
        applying = false;
        saved = editor.board;
        acknowledgedGeneration = generation;
        failure = null;
        saveState = 'idle';
      } else {
        const merged = mergeBoards(saved!, editor.board, parsed.board);
        applying = true;
        editor.applyExternal(merged.board, 'Outside edit');
        applying = false;
        generation += 1;
        saved =
          writeCanvas(editor.board) === writeCanvas(parsed.board) ? editor.board : parsed.board;
        if (!dirty()) {
          acknowledgedGeneration = generation;
          failure = null;
        }
        saveState = dirty() ? 'dirty' : 'idle';
        if (merged.conflicts)
          toast(`Kept your version of ${merged.conflicts} items that also changed on disk`);
        if (merged.removedEdges)
          toast(`Removed ${merged.removedEdges} connections whose cards were deleted on disk`);
      }
      if (admitted) {
        recoveryHeld = false;
        recoveryAdmission = null;
      }
      publish();
    } catch (error) {
      if (admittedRead())
        unreadable(error instanceof Error ? error.message : "The whiteboard couldn't be read.", '');
    }
  };
  const reload = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    cancelTimer();
    blocked = true;
    if (loading !== null) {
      readAgain = true;
      return loading;
    }
    loading = (async () => {
      do {
        readAgain = false;
        await read();
      } while (readAgain && !disposed);
    })().finally(() => {
      loading = null;
      blocked = false;
      // Loading has ended, but its chosen missing/unavailable face must stay.
      // Only recovery needs the operation-lock notification here.
      for (const notify of recoveryListeners) notify();
      schedule();
      retire();
    });
    return loading;
  };
  const listenExternal = () => {
    const attached = ++externalGeneration;
    return onExternalWrite(path, {
      pending() {
        if (attached === externalGeneration) {
          blocked = true;
          cancelTimer();
        }
      },
      settled() {
        if (!disposed && !renameHeld && attached === externalGeneration) void reload();
      },
    });
  };
  let stopExternal = listenExternal();
  const owner: CanvasOwner = {
    key,
    retention: {
      held: () => awaitingMovedPresentation,
      release: () => {
        awaitingMovedPresentation = false;
        retire();
      },
    },
    rename: {
      hold: () => {
        renamed = false;
        renameHeld = true;
        cancelTimer();
      },
      landed: (next) => {
        renamed = true;
        awaitingMovedPresentation = true;
        fileGeneration += 1;
        if (loading !== null) readAgain = true;
        lastEntryHash = undefined;
        path = next;
        stopExternal();
        stopExternal = listenExternal();
        releaseEditor();
        releaseEditor = holdEditor(path, ownerId, vault);
        blocked = false;
      },
      release: () => {
        renameHeld = false;
        blocked = false;
        if (
          useVaultStore.getState().vaultPath !== vault &&
          !views.size &&
          !dirty() &&
          !drafts().length &&
          !saving &&
          !loading &&
          !recoveryHeld
        )
          awaitingMovedPresentation = false;
        schedule();
        retire();
      },
    },
    prepare,
    blocked: () => hold(),
    snapshot: () => {
      const source = editor === null ? '' : writeCanvas(editor.board);
      const pending = drafts();
      return {
        latestDraft: pending.length ? JSON.stringify({ source, drafts: pending }) : source,
        generation,
        acknowledgedGeneration,
        inFlightGeneration,
        failure,
        reconcileRequired: renameHeld || recoveryHeld || (dirty() && (blocked || held !== null)),
      };
    },
    flush: () => flush(true),
    recovery: {
      key,
      identity: recoveryListeners,
      snapshot: () => owner.snapshot(),
      subscribe: (notify) => {
        recoveryListeners.add(notify);
        return () => {
          recoveryListeners.delete(notify);
        };
      },
      busy: () => saving !== null || loading !== null,
      requiresRecovery: () => recoveryHeld,
      hold: () => {
        if (disposed || recoveryHeld) return;
        recoveryHeld = true;
        cancelTimer();
        publish();
      },
      resume: async (current) => {
        if (disposed || !current()) return false;
        recoveryAdmission = current;
        try {
          // Keep the actionable hold until this actual reconciliation read
          // succeeds. A prior admission read cannot cover a later refusal.
          await reload();
          return !recoveryHeld;
        } finally {
          if (recoveryAdmission === current) recoveryAdmission = null;
        }
      },
      payload: (): RecoveryPayload => ({
        kind: 'canvas',
        body: { format: 'raw', text: editor === null ? '' : writeCanvas(editor.board) },
        field: null,
        children: drafts().length ? { 'canvas-fields': JSON.stringify(drafts()) } : {},
        metadata: { kind: 'unavailable' },
      }),
      retire: () => {
        if (saving !== null || loading !== null) return false;
        disposed = true;
        stopVault();
        awaitingMovedPresentation = false;
        recoveryHeld = false;
        cancelTimer();
        stopExternal();
        unlisten();
        stopDrafts();
        releaseEditor();
        if (editor !== null) {
          discardBoardDrafts(editor);
          editor.dispose();
        }
        editor = null;
        saved = null;
        failure = null;
        held = null;
        blocked = false;
        generation += 1;
        acknowledgedGeneration = generation;
        state = { state: 'missing' };
        publish();
        stopRegistration();
        return true;
      },
    },
    mount(view, attachedPath) {
      if (renamed && attachedPath === path) awaitingMovedPresentation = false;
      views.add(view);
      stopRegistration = registerSaveParticipant(owner);
      view(state);
      if (editor === null && state.state === 'loading' && loading === null) void reload();
      return () => {
        views.delete(view);
        if (views.size) return;
        prepare();
        cancelTimer();
        stopRegistration();
        // An outside read may hold the missing half of a merge. Finish that
        // reconciliation, but retain failures instead of disposing their scene.
        const reconciled = loading ?? (blocked ? reload() : Promise.resolve());
        void reconciled.then(() => (failure ? undefined : flush())).finally(retire);
      };
    },
    changedHash(next) {
      if (disposed || renameHeld) return;
      if (next === lastEntryHash) return;
      lastEntryHash = next;
      if (next == null || next !== knownHash) {
        if (loading !== null) readAgain = true;
        else void reload();
      }
    },
  };
  stopVault = useVaultStore.subscribe((next) => {
    if (
      next.vaultPath !== vault &&
      awaitingMovedPresentation &&
      !views.size &&
      !dirty() &&
      !drafts().length &&
      !saving &&
      !loading &&
      !recoveryHeld
    ) {
      awaitingMovedPresentation = false;
      retire();
    }
  });
  return owner;
}

export function useCanvasFile(path: string): CanvasFile {
  const vault = useVaultStore((s) => s.vaultPath);
  const pane = usePaneId();
  const hash = useEntry(path)?.hash;
  const [state, setState] = useState<CanvasFile>({ state: 'loading' });
  const controller = useRef<CanvasOwner | null>(null);
  useEffect(() => {
    setState({ state: 'loading' });
    if (vault === null) return;
    const key = { vaultId: vault, path, ownerId: pane };
    let live = true;
    let owner: CanvasOwner | null = null;
    let unmount = () => {};
    const attach = () => {
      if (!live || useVaultStore.getState().vaultPath !== vault) return;
      const retained = retainedSaveParticipant(key) as CanvasOwner | undefined;
      owner = retained ?? createCanvasOwner(key);
      controller.current = owner;
      unmount = owner.mount(setState, path);
      owner.changedHash(
        useVaultStore.getState().entries.find((entry) => entry.path === path)?.hash,
      );
    };
    if (documentAdmission(key, retainedSaveParticipant(key)).kind === 'ready') attach();
    else
      void waitForDocumentAdmission(
        key,
        () => live && useVaultStore.getState().vaultPath === vault,
      ).then((admitted) => {
        if (admitted) attach();
      });
    return () => {
      live = false;
      if (controller.current === owner) controller.current = null;
      unmount();
    };
  }, [vault, path, pane]);
  useEffect(() => {
    controller.current?.changedHash(hash);
  }, [hash, vault, path]);
  return state;
}
