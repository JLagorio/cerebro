import { useCallback, useEffect, useRef, useState } from 'react';
import { readNote, saveNote } from '@/lib/ipc';
import { refusalText } from '@/lib/refusal';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';
import type { EditorReadyInfo } from './MarkdownEditor';
import type { LossyCause } from './markdown';
import { NotePathContext } from './notePath';
import { onExternalWrite, registerFlush } from './openPages';

/** Where the body currently stands relative to disk. */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

/** A save autosave did not write, while the page waits on the person (M53.6). */
interface Held {
  vault: string;
  path: string;
  markdown: string;
}

/**
 * The read-only banner's words for each reason a save would change the file
 * (`lossyImportCause`, M55.15). It once blamed raw HTML whatever the cause.
 */
const LOSSY_COPY: Record<LossyCause, { locked: string; unlocked: string; button: string }> = {
  html: {
    locked:
      "Parts of this file (raw HTML) can't be shown in the rich editor. It is open read-only so editing can't strip them.",
    unlocked: 'Editing enabled — saving this page will remove the raw HTML it contains.',
    button: 'Edit anyway (raw HTML will be removed)',
  },
  dropped: {
    locked:
      "Parts of this file can't be shown in the rich editor. It is open read-only so editing can't strip them.",
    unlocked: "Editing enabled — saving this page will remove the parts the editor can't show.",
    button: 'Edit anyway (those parts will be removed)',
  },
  added: {
    locked:
      "Saving this file from the rich editor would add text it doesn't have. It is open read-only.",
    unlocked: 'Editing enabled — saving this page will add that text.',
    button: 'Edit anyway (text will be added)',
  },
  rewritten: {
    locked: 'Saving this file from the rich editor would reorder its text. It is open read-only.',
    unlocked: 'Editing enabled — saving this page will reorder its text.',
    button: 'Edit anyway (text will be reordered)',
  },
};

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
  onBodyLoaded,
  readOnly = false,
  sections = false,
}: {
  path: string;
  autoFocus?: boolean;
  /** Narrow contexts (detail panel): smaller gutter and heading scale. */
  compact?: boolean;
  debounceMs?: number;
  onReady?: (info: EditorReadyInfo) => void;
  /** Save lifecycle, for a visible saved/unsaved indicator in the host. */
  onSaveState?: (state: SaveState) => void;
  /**
   * The body exactly as the disk returned it — on load, and again after each
   * own save (M50.1). A concept page pins Verify to it (M49.3): what a person
   * attests is the text they had on screen, and an edit of their own is part
   * of that text once it has landed.
   */
  onBodyLoaded?: (path: string, raw: string) => void;
  /** A file the person reads but does not write here — the knowledge log and
   *  cached sources are the system's. */
  readOnly?: boolean;
  /** `#` headings are sections, not the page title: a concept keeps its title
   *  in frontmatter (OKF), so its body's H1s render at section size. */
  sections?: boolean;
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
  const [lossy, setLossy] = useState<LossyCause | null>(null);
  /**
   * Reconciliation with the disk (M17.4, M53.6).
   *
   * The editor is uncontrolled, so nothing reloads it when the file changes
   * underneath, and the next keystroke's debounce would save the stale buffer
   * back over whoever wrote it. Almost always the agent. Its MCP writes go
   * through the app's own `write_file`, which registers every write as the
   * app's, so the watcher drops their echo; the tools announce what they
   * wrote instead (`openPages.ts`). A write announced for this path is handled
   * by that announcement alone. Anything else (a write that names no path, an
   * outside editor) is noticed through `baseline`, the modifiedAt this buffer
   * corresponds to, which Rust stamps to the second and so cannot see a
   * second write within one.
   *
   * Either way: reload silently when the buffer is clean, and ask when it is
   * not, because discarding what someone typed is not a decision this
   * component gets to make. While an announced write is catching up, or the
   * question is open, autosave HOLDS what is typed instead of writing it over
   * the new version (`held`). Keep writes it; Load drops it. Leaving the page
   * writes it too: theirs wins, as it did before there was a hold.
   */
  const baseline = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [conflict, setConflict] = useState(false);
  // The banner's state, readable synchronously — a save deciding whether to
  // hold cannot wait for a render to learn the question is open.
  const conflictRef = useRef(false);
  const showConflict = useCallback((on: boolean) => {
    conflictRef.current = on;
    setConflict(on);
  }, []);
  const dirty = useRef(false);
  // Every edit, counted, so a save that lands clears `dirty` only if nothing
  // was typed while it was in flight.
  const edits = useRef(0);
  // Announced writes to this path still catching up.
  const externalPending = useRef(0);
  const held = useRef<Held | null>(null);
  // A body the person chose to discard (Load): saves from its editor are
  // dropped, however late they arrive.
  const discarded = useRef<{ path: string; gen: number } | null>(null);
  const mounted = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;
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
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;
  const onBodyLoadedRef = useRef(onBodyLoaded);
  onBodyLoadedRef.current = onBodyLoaded;
  const emitSaveState = useCallback((state: SaveState) => {
    onSaveStateRef.current?.(state);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setFailed(false);
    setLossy(null);
    setUnlocked(false);
    conflictRef.current = false;
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
        onBodyLoadedRef.current?.(path, text);
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

  // Someone else wrote this file (M17.4), and nobody announced it for this
  // path: a write that named no path, or an editor outside the app.
  useEffect(() => {
    if (loaded === null || loaded.path !== path) return;
    if (ownSaveInFlight.current) return;
    // An announced write is settled by its announcement (below), which knows
    // when its rescan has landed; this would only act on half of it.
    if (externalPending.current > 0) return;
    if (entryModifiedAt === null || entryModifiedAt === baseline.current) return;
    if (dirty.current) {
      showConflict(true);
      return;
    }
    // Clean buffer: nothing of the user's to lose, so take the new version
    // without asking. Asking here would be a dialog for every agent write.
    setGeneration((g) => g + 1);
  }, [entryModifiedAt, loaded, path, showConflict]);

  // An agent wrote THIS file (M53.6). Saves hold from the announcement until
  // the vault has caught up; then a clean page reloads and a dirty one asks.
  useEffect(() => {
    let live = true;
    const stop = onExternalWrite(path, {
      pending: () => {
        if (live) externalPending.current += 1;
      },
      settled: () => {
        if (!live) return;
        externalPending.current = Math.max(0, externalPending.current - 1);
        // A burst is answered once, after its last catch-up.
        if (externalPending.current > 0) return;
        if (dirty.current) showConflict(true);
        else setGeneration((g) => g + 1);
      },
    });
    return () => {
      live = false;
      externalPending.current = 0;
      stop();
    };
  }, [path, showConflict]);

  // A panel turn lands every open page's pending save before its child
  // starts (useAgentChat), so the agent reads what is on screen.
  useEffect(() => registerFlush(() => flushRef.current?.() ?? Promise.resolve()), []);

  // ⌘S / Ctrl+S force-flushes the debounce. The instinctive shortcut was a
  // no-op before, which read as "my work is not being saved".
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      void flushRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * Write `markdown` to `forPath` now. Resolves once the save has landed, or
   * failed and said so; the rescan, re-baseline and pin that follow a landed
   * save run on behind it.
   */
  const write = (vault: string, forPath: string, markdown: string): Promise<void> => {
    const upTo = edits.current;
    emitSaveState('saving');
    // Separate catches: after a successful save the disk already holds the
    // edit, so a refresh failure must not claim the save failed.
    return saveNote(vault, forPath, markdown).then(
      () => {
        emitSaveState('saved');
        if (edits.current === upTo) dirty.current = false;
        void (async () => {
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
          // What the disk holds now — a capture may have canonicalized it.
          if (onBodyLoadedRef.current !== undefined) {
            try {
              onBodyLoadedRef.current(forPath, await readNote(vault, forPath));
            } catch {
              // The pin stays on the last body read; a Verify against it refuses
              // as stale rather than attesting unseen text.
            }
          }
        })();
      },
      (err: unknown) => {
        emitSaveState('failed');
        // The refusal says why — a knowledge file that differs from its
        // recorded history, recording paused for the vault (M49.6, K13).
        toast(`Couldn't save page: ${refusalText(err)}`);
      },
    );
  };

  /** Write it, or hold it while the page on screen waits on an announced
   *  write or on the person's answer. */
  const land = (parked: Held): Promise<void> => {
    if (
      mounted.current &&
      parked.path === pathRef.current &&
      (externalPending.current > 0 || conflictRef.current)
    ) {
      held.current = parked;
      emitSaveState('dirty');
      return Promise.resolve();
    }
    return write(parked.vault, parked.path, parked.markdown);
  };

  // Saves target the path the body was LOADED for, never the current prop —
  // a debounce flush racing a navigation must land in its own file.
  const saveFor = (forPath: string, gen: number) => (markdown: string) => {
    if (vaultPath === null) return Promise.resolve();
    const dropped = discarded.current;
    if (dropped !== null && dropped.path === forPath && gen <= dropped.gen) {
      return Promise.resolve();
    }
    return land({ vault: vaultPath, path: forPath, markdown });
  };

  // Leaving the page (another path, or unmounting) writes what was held for
  // it: theirs wins, as before the hold. Through a ref, because the cleanup
  // belongs to the render that created it.
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(
    () => () => {
      const parked = held.current;
      if (parked === null || parked.path !== path) return;
      held.current = null;
      void writeRef.current(parked.vault, parked.path, parked.markdown);
    },
    [path],
  );

  if (failed) {
    return <p className="m-0 px-1 py-2 text-sm text-n-500">This page couldn't be loaded.</p>;
  }
  if (loaded === null || loaded.path !== path) {
    return <div data-testid="note-body-loading" />;
  }

  const locked = readOnly || (lossy !== null && !unlocked);

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col${compact ? ' cerebro-editor-compact' : ''}${
        sections ? ' cerebro-editor-sections' : ''
      }`}
    >
      {conflict && (
        <div
          role="alert"
          data-testid="external-change-banner"
          className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn-500 bg-warn-50 px-3 py-2 text-sm text-warn-700"
        >
          <span className="min-w-0 flex-1">
            This page changed on disk while you were editing it — usually the assistant. Your edits
            are held, not saved, until you choose.
          </span>
          <button
            type="button"
            data-testid="external-change-reload"
            onClick={() => {
              // Discarded means discarded: the pending debounce is cancelled
              // and the held save dropped BEFORE the remount, whose unmount
              // flush would otherwise write this buffer back over the version
              // being loaded.
              cancelRef.current?.();
              held.current = null;
              discarded.current = { path: loaded.path, gen: loaded.gen };
              dirty.current = false;
              showConflict(false);
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
              showConflict(false);
              // And write what was held. Through `land`, so a write announced
              // while they decided is asked about rather than overwritten.
              const parked = held.current;
              held.current = null;
              if (parked !== null) void land(parked);
            }}
            className="flex-none rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-warn-700 underline"
          >
            Keep mine
          </button>
        </div>
      )}
      {lossy !== null && !readOnly && (
        <div
          role="alert"
          data-testid="lossy-import-banner"
          className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn-500 bg-warn-50 px-3 py-2 text-sm text-warn-700"
        >
          <span className="min-w-0 flex-1">
            {locked ? LOSSY_COPY[lossy].locked : LOSSY_COPY[lossy].unlocked}
          </span>
          {locked && (
            <button
              type="button"
              onClick={() => setUnlocked(true)}
              className="flex-none rounded-md border border-warn-500 bg-transparent px-2 py-0.5 text-xs font-medium text-warn-700 hover:bg-warn-500 hover:text-n-0"
            >
              {LOSSY_COPY[lossy].button}
            </button>
          )}
        </div>
      )}
      {/* The path the body was LOADED for, the one its saves target too: what
          a chip reads about its own note — a citation's number comes from the
          note's frontmatter `sources` (M51.5) — is about the file on screen. */}
      <NotePathContext.Provider value={loaded.path}>
        <LazyMarkdownEditor
          // The generation is part of the key: the editor takes `markdown` as an
          // initial value only, so a reload has to be a remount.
          key={`${loaded.path}#${loaded.gen}`}
          markdown={loaded.body}
          readOnly={locked}
          onChange={saveFor(loaded.path, loaded.gen)}
          onDirty={() => {
            dirty.current = true;
            edits.current += 1;
            emitSaveState('dirty');
          }}
          onReady={(info: EditorReadyInfo) => {
            flushRef.current = info.flushPendingSave;
            cancelRef.current = info.cancelPendingSave;
            setLossy(info.lossyCause);
            onReady?.(info);
          }}
          autoFocus={autoFocus}
          debounceMs={debounceMs}
        />
      </NotePathContext.Provider>
    </div>
  );
}
