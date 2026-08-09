import { useCallback, useEffect, useRef, useState } from 'react';
import { readNote, saveNote } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';
import type { EditorReadyInfo } from './MarkdownEditor';

/** Where the body currently stands relative to disk. */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

/**
 * Loads a note's body, shows the rich editor, and persists debounced edits.
 * Every save rescans, so editing the H1 syncs the entry title everywhere
 * (scanner derives titles from the first H1 — that IS the title sync).
 */
export function NoteBodyEditor({
  path,
  autoFocus = false,
  compact = false,
  debounceMs,
  onReady,
  onSaveState,
}: {
  path: string;
  autoFocus?: boolean;
  /** Narrow contexts (detail panel): smaller gutter and heading scale. */
  compact?: boolean;
  debounceMs?: number;
  onReady?: (info: EditorReadyInfo) => void;
  /** Save lifecycle, for a visible saved/unsaved indicator in the host. */
  onSaveState?: (state: SaveState) => void;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  // The body is stored WITH the path it was read from. The editor renders
  // only when they agree with the current prop — otherwise a path change
  // would mount the keyed editor with the PREVIOUS doc's body for one
  // render, and its unmount flush could write that body into the new file
  // (cross-doc corruption seen live in M2.x doc-polish testing).
  // `gen` travels WITH the body, never ahead of it: the editor is uncontrolled
  // and remounts on its key, so bumping the key while the re-read is still in
  // flight remounts with the stale body and then ignores the new one when it
  // lands (M17.4).
  const [loaded, setLoaded] = useState<{ path: string; body: string; gen: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [lossy, setLossy] = useState(false);
  /**
   * Reconciliation with the disk (M17.4).
   *
   * The editor is uncontrolled and its load effect ran on `[path, vaultPath]`
   * alone, so NOTHING reloaded it when the file changed underneath. The agent
   * writes straight to disk through its MCP tools; the watcher suppresses
   * own-writes for four seconds; and the next keystroke's debounce saved the
   * stale buffer back over the agent's work. That is not a race with a narrow
   * window — it is the guaranteed outcome of asking the assistant to revise a
   * note you have open.
   *
   * `baseline` is the modifiedAt this buffer corresponds to. A different one
   * on the entry means someone else wrote the file: reload silently when the
   * buffer is clean, and ask when it is not, because discarding what someone
   * typed is not a decision this component gets to make.
   */
  const baseline = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [conflict, setConflict] = useState(false);
  const dirty = useRef(false);
  // An own save's rescan publishes the new mtime to the store BEFORE the
  // `await rescan()` continuation below re-baselines — and React can flush
  // the reconciler effect in that gap (observed in the M29.13 e2e: every
  // save silently reloaded the editor ~100ms later, which remounted the
  // mermaid block and threw away its open edit session). While this flag is
  // up, the mtime change is ours, not somebody else's.
  const ownSaveInFlight = useRef(false);
  const entryModifiedAt = useVaultStore(
    (s) => s.entries.find((e) => e.path === path)?.modifiedAt ?? null,
  );
  // A lossy import mounts READ-ONLY. The old behaviour warned about the loss
  // and then let the very next keystroke autosave it away half a second
  // later — the warning was the entire mitigation. Editing is now an
  // explicit, undoable-by-choice act.
  const [unlocked, setUnlocked] = useState(false);
  const flushRef = useRef<(() => void) | null>(null);

  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;
  const emitSaveState = useCallback((state: SaveState) => {
    onSaveStateRef.current?.(state);
  }, []);

  useEffect(() => {
    setFailed(false);
    setLossy(false);
    setUnlocked(false);
    setConflict(false);
    dirty.current = false;
    emitSaveState('idle');
    if (vaultPath === null) return;
    let cancelled = false;
    readNote(vaultPath, path)
      .then((text) => {
        // Rust read_note returns the body verbatim including the blank line
        // after the frontmatter fence; the mock strips leading newlines —
        // normalize so both backends match (M1 note 10 discipline).
        if (cancelled) return;
        // Re-baselined from the store rather than from the value captured
        // when this effect ran: the read is async, and a write that landed
        // during it is already IN the body we just read.
        baseline.current =
          useVaultStore.getState().entries.find((e) => e.path === path)?.modifiedAt ?? null;
        setLoaded({ path, body: text.replace(/^\n+/, ''), gen: generation });
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          toast("Couldn't load page");
        }
      });
    return () => {
      cancelled = true;
    };
    // `generation` re-runs this effect to re-read from disk — that is what
    // makes a reload a reload rather than a remount of the same stale body.
  }, [path, vaultPath, toast, emitSaveState, generation]);

  // Someone else wrote this file (M17.4). Almost always the agent, which is
  // why this is Phase 0 of a milestone about putting AI into the editor.
  useEffect(() => {
    if (loaded === null || loaded.path !== path) return;
    if (ownSaveInFlight.current) return;
    if (entryModifiedAt === null || entryModifiedAt === baseline.current) return;
    if (dirty.current) {
      setConflict(true);
      return;
    }
    // Clean buffer: nothing of the user's to lose, so take the new version
    // without asking. Asking here would be a dialog for every agent write.
    setGeneration((g) => g + 1);
  }, [entryModifiedAt, loaded, path]);

  // ⌘S / Ctrl+S force-flushes the debounce. The instinctive shortcut was a
  // no-op before, which read as "my work is not being saved".
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      flushRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Saves target the path the body was LOADED for, never the current prop —
  // a debounce flush racing a navigation must land in its own file.
  const saveFor = (forPath: string) => (markdown: string) => {
    if (vaultPath === null) return;
    emitSaveState('saving');
    void (async () => {
      // Separate catches: after a successful save the disk already holds the
      // edit, so a refresh failure must not claim the save failed.
      try {
        await saveNote(vaultPath, forPath, markdown);
      } catch {
        emitSaveState('failed');
        toast("Couldn't save page");
        return;
      }
      emitSaveState('saved');
      dirty.current = false;
      ownSaveInFlight.current = true;
      try {
        await rescan();
        // Our own write moved the file's mtime. Re-baselining here is what
        // stops the reconciler treating every save as somebody else's edit
        // and reloading the buffer out from under the person typing.
        baseline.current =
          useVaultStore.getState().entries.find((e) => e.path === forPath)?.modifiedAt ??
          baseline.current;
      } catch {
        toast("Couldn't refresh vault");
      } finally {
        ownSaveInFlight.current = false;
      }
    })();
  };

  if (failed) {
    return <p className="m-0 px-1 py-2 text-sm text-n-500">This page couldn't be loaded.</p>;
  }
  if (loaded === null || loaded.path !== path) {
    return <div data-testid="note-body-loading" />;
  }

  const locked = lossy && !unlocked;

  return (
    <div className={`flex min-h-0 flex-1 flex-col${compact ? ' cerebro-editor-compact' : ''}`}>
      {conflict && (
        <div
          role="alert"
          data-testid="external-change-banner"
          className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn-500 bg-warn-50 px-3 py-2 text-sm text-warn-700"
        >
          <span className="min-w-0 flex-1">
            This page changed on disk while you were editing it — usually the assistant. Keeping
            yours will overwrite that version when you next save.
          </span>
          <button
            type="button"
            data-testid="external-change-reload"
            onClick={() => {
              dirty.current = false;
              setConflict(false);
              setGeneration((g) => g + 1);
            }}
            className="flex-none rounded-md border border-warn-500 bg-transparent px-2 py-0.5 text-xs font-medium text-warn-700 hover:bg-warn-500 hover:text-n-0"
          >
            Load the new version
          </button>
          <button
            type="button"
            data-testid="external-change-keep"
            onClick={() => {
              // Take the disk's mtime as ours so the banner does not come
              // back on the next rescan; the user has answered this question.
              baseline.current = entryModifiedAt;
              setConflict(false);
            }}
            className="flex-none rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-warn-700 underline"
          >
            Keep mine
          </button>
        </div>
      )}
      {lossy && (
        <div
          role="alert"
          data-testid="lossy-import-banner"
          className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn-500 bg-warn-50 px-3 py-2 text-sm text-warn-700"
        >
          <span className="min-w-0 flex-1">
            {locked
              ? "Parts of this file (raw HTML) can't be shown in the rich editor. It is open read-only so editing can't strip them."
              : 'Editing enabled — saving this page will remove the raw HTML it contains.'}
          </span>
          {locked && (
            <button
              type="button"
              onClick={() => setUnlocked(true)}
              className="flex-none rounded-md border border-warn-500 bg-transparent px-2 py-0.5 text-xs font-medium text-warn-700 hover:bg-warn-500 hover:text-n-0"
            >
              Edit anyway (raw HTML will be removed)
            </button>
          )}
        </div>
      )}
      <LazyMarkdownEditor
        // The generation is part of the key: the editor takes `markdown` as an
        // initial value only, so a reload has to be a remount.
        key={`${loaded.path}#${loaded.gen}`}
        markdown={loaded.body}
        readOnly={locked}
        onChange={saveFor(loaded.path)}
        onDirty={() => {
          dirty.current = true;
          emitSaveState('dirty');
        }}
        onReady={(info: EditorReadyInfo) => {
          flushRef.current = info.flushPendingSave;
          setLossy(info.lossyImport);
          onReady?.(info);
        }}
        autoFocus={autoFocus}
        debounceMs={debounceMs}
      />
    </div>
  );
}
