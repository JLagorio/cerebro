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
  const [loaded, setLoaded] = useState<{ path: string; body: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [lossy, setLossy] = useState(false);
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
    emitSaveState('idle');
    if (vaultPath === null) return;
    let cancelled = false;
    readNote(vaultPath, path)
      .then((text) => {
        // Rust read_note returns the body verbatim including the blank line
        // after the frontmatter fence; the mock strips leading newlines —
        // normalize so both backends match (M1 note 10 discipline).
        if (!cancelled) setLoaded({ path, body: text.replace(/^\n+/, '') });
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
  }, [path, vaultPath, toast, emitSaveState]);

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
      try {
        await rescan();
      } catch {
        toast("Couldn't refresh vault");
      }
    })();
  };

  if (failed) {
    return (
      <p className="m-0 px-1 py-2 text-[13px] text-[var(--n-500)]">This page couldn't be loaded.</p>
    );
  }
  if (loaded === null || loaded.path !== path) {
    return <div data-testid="note-body-loading" />;
  }

  const locked = lossy && !unlocked;

  return (
    <div className={`flex min-h-0 flex-1 flex-col${compact ? ' cerebro-editor-compact' : ''}`}>
      {lossy && (
        <div
          role="alert"
          data-testid="lossy-import-banner"
          className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--warn-500)] bg-[var(--warn-50)] px-3 py-2 text-[12.5px] text-[var(--warn-700)]"
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
              className="flex-none rounded-md border border-[var(--warn-500)] bg-transparent px-2 py-0.5 text-[12px] font-medium text-[var(--warn-700)] hover:bg-[var(--warn-500)] hover:text-[var(--n-0)]"
            >
              Edit anyway (raw HTML will be removed)
            </button>
          )}
        </div>
      )}
      <LazyMarkdownEditor
        key={loaded.path}
        markdown={loaded.body}
        readOnly={locked}
        onChange={saveFor(loaded.path)}
        onDirty={() => emitSaveState('dirty')}
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
