import { useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/editor/NoteBodyEditor';
import { holdEditor, onExternalWrite, registerFlush, registerHold } from '@/editor/openPages';
import { problemsOf, type Problem } from '@/engine/scene/board';
import { createSceneEditor, type SceneEditor } from '@/engine/scene/editor';
import { readCanvas, writeCanvas } from '@/engine/scene/jsonCanvas';
import { mergeBoards } from '@/engine/scene/merge';
import type { Board } from '@/engine/scene/model';
import { isKnowledgePath } from '@/engine/okf';
import { readCanvasFile, saveCanvasFile } from '@/lib/ipc';
import { settleBoardText } from './pendingText';
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

interface Controller {
  reload: () => Promise<void>;
  changedHash: (hash: string | null | undefined) => void;
}

/** A keyed board page owns this lifecycle. All async work closes over its
 * original vault and path, including a final flush after the page leaves. */
export function useCanvasFile(path: string): CanvasFile {
  const vault = useVaultStore((s) => s.vaultPath);
  const pane = usePaneId();
  const hash = useEntry(path)?.hash;
  const [state, setState] = useState<CanvasFile>({ state: 'loading' });
  const controller = useRef<Controller | null>(null);
  useEffect(() => holdEditor(path, pane), [path, pane]);

  useEffect(() => {
    setState({ state: 'loading' });
    if (vault === null) return;
    const readOnly = isKnowledgePath(path);
    let alive = true;
    let editor: SceneEditor | null = null;
    let saved: Board | null = null;
    let held: CanvasHeld = null;
    let saveState: SaveState = 'idle';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saving: Promise<void> | null = null;
    let loading: Promise<void> | null = null;
    let readAgain = false;
    let blocked = false;
    let applying = false;
    let failed = false;
    let unlisten = () => {};
    let knownHash: string | null = null;
    let lastEntryHash = useVaultStore.getState().entries.find((entry) => entry.path === path)?.hash;
    const dirty = () => editor !== null && editor.board !== saved;
    const toast = (words: string) => {
      if (useVaultStore.getState().vaultPath === vault) useUiStore.getState().toast(words);
    };
    const publish = () => {
      if (alive && editor !== null)
        setState({
          state: 'ready',
          editor,
          problems: problemsOf(editor.board),
          saveState,
          held,
          readOnly,
          reload,
        });
    };
    const cancelTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      cancelTimer();
      if (!readOnly && !blocked && held === null && dirty())
        timer = setTimeout(() => {
          timer = undefined;
          void flush();
        }, 500);
    };
    const flush = (settleText = false): Promise<void> => {
      if (settleText && editor !== null) settleBoardText(editor);
      cancelTimer();
      if (saving !== null) return saving;
      if (editor === null || !dirty() || readOnly || blocked || held !== null)
        return Promise.resolve();
      saving = (async () => {
        while (editor !== null && dirty() && !readOnly && !blocked && held === null) {
          const writing = editor.board;
          saveState = 'saving';
          publish();
          try {
            const result = await saveCanvasFile(vault, path, writeCanvas(writing));
            if (!result.ok) {
              if (result.refusal.code === 'missing') held = 'missing';
              if (
                result.refusal.code === 'unreadable_on_disk' ||
                result.refusal.code === 'too_large' ||
                result.refusal.code === 'not_text'
              )
                held = 'unreadable';
              throw new Error(result.refusal.message);
            }
            knownHash = result.hash;
            saved = writing;
            failed = false;
            saveState = dirty() ? 'dirty' : 'saved';
            publish();
          } catch {
            saveState = 'failed';
            if (!failed) toast("Couldn't save whiteboard");
            failed = true;
            publish();
            break;
          }
        }
      })().finally(() => {
        saving = null;
      });
      return saving;
    };
    const unreadable = (reason: string, preview: string, missing = false) => {
      held = missing ? 'missing' : 'unreadable';
      if (editor !== null && dirty()) {
        publish();
      } else if (alive) {
        setState(
          missing
            ? { state: 'missing' }
            : { state: 'unavailable', reason, preview: preview.slice(0, 20_000) },
        );
      }
    };
    const read = async () => {
      if (saving !== null) await saving;
      if (!alive && editor === null) return;
      try {
        const result = await readCanvasFile(vault, path);
        if (!alive && editor === null) return;
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
          publish();
          return;
        }
        held = null;
        if (editor === null) {
          editor = createSceneEditor(parsed.board, { createId: newBoardId });
          saved = editor.board;
          unlisten = editor.subscribe(({ cause }) => {
            if (
              applying ||
              cause === 'begin' ||
              cause === 'preview' ||
              cause === 'cancel' ||
              cause === 'select'
            )
              return;
            saveState = dirty() ? 'dirty' : 'idle';
            publish();
            schedule();
          });
        } else if (!dirty()) {
          saved = parsed.board;
          applying = true;
          editor.applyExternal(parsed.board, 'Outside edit');
          applying = false;
          saved = editor.board;
          saveState = 'idle';
        } else {
          const merged = mergeBoards(saved!, editor.board, parsed.board);
          applying = true;
          editor.applyExternal(merged.board, 'Outside edit');
          applying = false;
          // A merge that is already exactly on disk needs no write. A local
          // edit retained by the merge still flushes through the human door.
          saved =
            writeCanvas(editor.board) === writeCanvas(parsed.board) ? editor.board : parsed.board;
          saveState = dirty() ? 'dirty' : 'idle';
          if (merged.conflicts)
            toast(`Kept your version of ${merged.conflicts} items that also changed on disk`);
          if (merged.removedEdges)
            toast(`Removed ${merged.removedEdges} connections whose cards were deleted on disk`);
        }
        publish();
      } catch (error) {
        if (alive || editor !== null)
          unreadable(
            error instanceof Error ? error.message : "The whiteboard couldn't be read.",
            '',
          );
      }
    };
    const reload = (): Promise<void> => {
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
        } while (readAgain && (alive || dirty()));
      })().finally(() => {
        loading = null;
        blocked = false;
        if (alive) schedule();
      });
      return loading;
    };
    const own: Controller = {
      reload,
      changedHash(next) {
        if (next === lastEntryHash) return;
        lastEntryHash = next;
        if (next == null || next !== knownHash) {
          if (loading !== null) readAgain = true;
          else void reload();
        }
      },
    };
    controller.current = own;
    const stopExternal = onExternalWrite(path, {
      pending() {
        blocked = true;
        cancelTimer();
      },
      settled() {
        if (alive) void reload();
      },
    });
    const stopFlush = registerFlush(() => flush(true));
    const stopHold = registerHold(() =>
      dirty() && (blocked || held !== null || saveState === 'failed' || saving !== null)
        ? path
        : null,
    );
    void reload();
    return () => {
      alive = false;
      if (controller.current === own) controller.current = null;
      cancelTimer();
      stopExternal();
      stopFlush();
      stopHold();
      unlisten();
      // A read already in flight may contain the outside half of a dirty
      // merge. Retiring the view stops publication, not that reconciliation.
      // Flush only after it settles; otherwise blocked would drop the edit.
      const reconciled = loading ?? (blocked ? reload() : Promise.resolve());
      void reconciled.then(() => flush(true)).finally(() => editor?.dispose());
    };
  }, [vault, path]);
  useEffect(() => {
    controller.current?.changedHash(hash);
  }, [hash, vault, path]);
  return state;
}
