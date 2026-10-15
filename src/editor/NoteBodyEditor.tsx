import { useCallback, useEffect, useRef, useState } from 'react';
import { readNote, saveNote } from '@/lib/ipc';
import { refusalText } from '@/lib/refusal';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';
import type { ChoiceView, EditorReadyInfo } from './MarkdownEditor';
import type { LossyCause } from './markdown';
import { MergeChoices } from './MergeChoices';
import { NotePathContext } from './notePath';
import { onExternalWrite, registerFlush, registerHold } from './openPages';

/** Where the body currently stands relative to disk. */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

/** A save autosave did not write, while the page waits on a write, a
 * reconcile or the person's choice (M53.6, M55.6). */
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

/** The choice offered when a write the editor cannot show meets unsaved typing. */
const PAGE_CHOICE = 'page';

/**
 * Loads a note's body, shows the rich editor, and persists debounced edits.
 * Every save rescans, so editing the H1 syncs the entry title everywhere
 * (scanner derives titles from the first H1 — that IS the title sync).
 *
 * Reconciliation with the disk (M55.6). The editor is uncontrolled, so an
 * outside write (almost always the agent's) has to be brought into it, or
 * the next keystroke's save would put the old text back over it. The agent's
 * MCP writes announce their paths (`openPages.ts`); any other change shows as
 * a new content hash on the entry. Either way the page reads the body again
 * and, when it differs from `base` (what it last read or saved), applies it
 * in place: a clean page takes it block by block, and a page with unsaved
 * typing merges three ways, so only blocks both sides changed are left for
 * the person, as choices above the page. The caret, the scroll, the undo
 * history and every untouched block stay. While a write is pending, a
 * reconcile runs or a choice is open, autosave HOLDS what is typed, and
 * `release` writes the page as it stands once nothing holds. Leaving the page
 * meanwhile writes it too: yours wins.
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
   * The body exactly as the disk returned it — on load, after each own save
   * (M50.1), and after an outside write the page took whole (M55.6). A
   * concept page pins Verify to it (M49.3): what a person attests is the text
   * they had on screen, and an edit of their own is part of that text once it
   * has landed.
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
  // `gen` counts the remounts outside writes still need: a locked page, and
  // a write the editor cannot show on a clean one. It travels WITH the body,
  // so a remount never shows the stale body while the re-read is in flight.
  const [loaded, setLoaded] = useState<{ path: string; body: string; gen: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [lossy, setLossy] = useState<LossyCause | null>(null);
  const [generation, setGeneration] = useState(0);
  const [choices, setChoices] = useState<ChoiceView[]>([]);
  // The open choices, readable synchronously: a save deciding whether to
  // hold cannot wait for a render to learn one is open.
  const choicesRef = useRef<ChoiceView[]>([]);
  const showChoices = useCallback((next: ChoiceView[]) => {
    choicesRef.current = next;
    setChoices(next);
  }, []);
  /** What the page last read or saved: the body as read, and its canonical
   *  text, which the editor's serialization is compared against. */
  const base = useRef<{ raw: string; canon: string } | null>(null);
  /** The entry's content hash this page last heard: undefined until the
   *  load, null when the load found none. */
  const seenHash = useRef<string | null | undefined>(undefined);
  // Announced writes to this path still catching up.
  const externalPending = useRef(0);
  const held = useRef<Held | null>(null);
  /** The page has something to write once nothing holds: a held save, a
   *  merge with unsaved typing, or a choice. */
  const owed = useRef(false);
  /** The editor showing this path, once it is ready. */
  const ready = useRef<{ path: string; info: EditorReadyInfo } | null>(null);
  /** The reconcile running now; another is queued behind it at most. */
  const reconciling = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  /** A trigger heard before the editor was ready. */
  const missed = useRef(false);
  const mounted = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;
  const vaultRef = useRef(vaultPath);
  vaultRef.current = vaultPath;
  const entryHash = useVaultStore((s) => s.entries.find((e) => e.path === path)?.hash ?? null);
  // A lossy import mounts READ-ONLY. The old behaviour warned about the loss
  // and then let the very next keystroke autosave it away half a second
  // later — the warning was the entire mitigation. Editing is now an
  // explicit, undoable-by-choice act.
  const [unlocked, setUnlocked] = useState(false);
  // The same facts, for a reconcile that runs between renders.
  const lossyRef = useRef<LossyCause | null>(null);
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const isLocked = () => readOnlyRef.current || (lossyRef.current !== null && !unlockedRef.current);
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
    lossyRef.current = null;
    setUnlocked(false);
    showChoices([]);
    base.current = null;
    ready.current = null;
    seenHash.current = undefined;
    owed.current = false;
    emitSaveState('idle');
    if (vaultPath === null) return;
    let cancelled = false;
    readNote(vaultPath, path)
      .then((text) => {
        // Rust read_note returns the body verbatim including the blank line
        // after the frontmatter fence; the mock strips leading newlines —
        // normalize so both backends match (M1 note 10 discipline).
        if (cancelled) return;
        // The hash this body answers to, read from the store rather than
        // captured when this effect ran: a write that landed during the read
        // is already IN the body.
        seenHash.current =
          useVaultStore.getState().entries.find((e) => e.path === path)?.hash ?? null;
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
    // `generation` re-runs this effect to re-read from disk: the remounts
    // above, which take the file whole.
  }, [path, vaultPath, toast, emitSaveState, generation, showChoices]);

  /** Write it, or hold it while the page waits on a write, a reconcile or a
   *  choice. */
  const land = (parked: Held): Promise<void> => {
    if (
      mounted.current &&
      parked.path === pathRef.current &&
      (externalPending.current > 0 || reconciling.current !== null || choicesRef.current.length > 0)
    ) {
      held.current = parked;
      owed.current = true;
      emitSaveState('dirty');
      return Promise.resolve();
    }
    return write(parked.vault, parked.path, parked.markdown);
  };

  /**
   * Write `markdown` to `forPath` now. Resolves once the save has landed, or
   * failed and said so; the rescan and pin that follow a landed save run on
   * behind it.
   */
  const write = (vault: string, forPath: string, markdown: string): Promise<void> => {
    emitSaveState('saving');
    // Separate catches: after a successful save the disk already holds the
    // edit, so a refresh failure must not claim the save failed.
    return saveNote(vault, forPath, markdown).then(
      () => {
        emitSaveState('saved');
        // What the page saved is what it stands on now; the hash change the
        // rescan brings reads it back and finds nothing new.
        if (ready.current?.path === forPath) base.current = { raw: markdown, canon: markdown };
        void (async () => {
          try {
            await rescan();
          } catch {
            toast("Couldn't refresh vault");
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

  /**
   * Once nothing holds: drop the held save and write the page as it stands,
   * when that differs from the base. A merge, a held save and a choice all
   * end here.
   */
  const release = () => {
    if (
      !owed.current ||
      externalPending.current > 0 ||
      reconciling.current !== null ||
      choicesRef.current.length > 0
    ) {
      return;
    }
    owed.current = false;
    held.current = null;
    const at = ready.current;
    const was = base.current;
    const vault = vaultRef.current;
    if (at === null || was === null || vault === null || at.path !== pathRef.current) return;
    if (isLocked()) return;
    const md = at.info.serialize();
    at.info.markSaved(md);
    if (md !== was.canon) void write(vault, at.path, md);
    else emitSaveState('saved');
  };

  /** Take the file whole: a locked page, or a write the editor cannot show. */
  const remount = () => {
    cancelRef.current?.();
    held.current = null;
    owed.current = false;
    showChoices([]);
    setGeneration((g) => g + 1);
  };

  /** Read the file and bring what changed into the page. */
  const reconcileOnce = async (): Promise<void> => {
    const at = ready.current;
    const vault = vaultRef.current;
    if (at === null || vault === null) return;
    let text: string;
    try {
      text = await readNote(vault, at.path);
    } catch {
      if (mounted.current && ready.current === at) toast("Couldn't reload page");
      return;
    }
    if (!mounted.current || ready.current !== at) return;
    const raw = text.replace(/^\n+/, '');
    const was = base.current;
    // An own save, or a change to the frontmatter alone.
    if (was === null || raw === was.raw) return;
    if (isLocked()) {
      remount();
      return;
    }
    const result = at.info.applyExternal(raw, was.canon, {
      allowLoss: lossyRef.current !== null && unlockedRef.current,
    });
    switch (result.kind) {
      case 'same':
        base.current = { raw, canon: was.canon };
        return;
      case 'applied':
        if (result.after !== result.next && !result.dirty) {
          // A clean page that did not come out as the write: never save it
          // over the file, take the file whole.
          remount();
          return;
        }
        base.current = { raw, canon: result.next };
        showChoices([]);
        if (result.after === result.next) onBodyLoadedRef.current?.(at.path, text);
        else owed.current = true;
        return;
      case 'choices':
        base.current = { raw, canon: result.next };
        owed.current = true;
        showChoices(result.choices);
        return;
      case 'unrepresentable':
        if (!result.dirty) {
          remount();
          return;
        }
        // Nothing of the write can land without losing text, and the page
        // holds typing: the whole page is the choice.
        base.current = { raw, canon: was.canon };
        owed.current = true;
        showChoices([
          ...choicesRef.current.filter((choice) => choice.id !== PAGE_CHOICE),
          { id: PAGE_CHOICE, mine: at.info.serialize(), theirs: raw, firstBlockId: null },
        ]);
        return;
    }
  };

  // Through refs: the reconcile loop outlives the render that started it.
  const reconcileRef = useRef(reconcileOnce);
  reconcileRef.current = reconcileOnce;
  const releaseRef = useRef(release);
  releaseRef.current = release;

  /** Reconcile now, or after the one running; once ready, if not yet. */
  const requestReconcile = useCallback(() => {
    if (ready.current === null || ready.current.path !== pathRef.current) {
      missed.current = true;
      return;
    }
    if (reconciling.current !== null) {
      queued.current = true;
      return;
    }
    const run: Promise<void> = (async () => {
      do {
        queued.current = false;
        await reconcileRef.current();
      } while (queued.current && mounted.current);
    })().finally(() => {
      if (reconciling.current === run) reconciling.current = null;
      releaseRef.current();
    });
    reconciling.current = run;
  }, []);

  // A change of the file's content, from anyone. The agent's announced
  // writes are settled by their announcement (below), which knows when the
  // vault has caught up.
  useEffect(() => {
    // A null hash is a write in flight (setTitle clears it before it writes):
    // keep the last one seen, so the hash after it reads as a change. Before
    // the load, the load reads the hash itself.
    if (entryHash === null || seenHash.current === undefined) return;
    if (entryHash === seenHash.current) return;
    seenHash.current = entryHash;
    if (externalPending.current === 0) requestReconcile();
  }, [entryHash, path, requestReconcile]);

  // An agent wrote THIS file (M53.6). Saves hold from the announcement; once
  // the vault has caught up with the last of a burst, the page reconciles.
  useEffect(() => {
    let live = true;
    const stop = onExternalWrite(path, {
      pending: () => {
        if (live) externalPending.current += 1;
      },
      settled: () => {
        if (!live) return;
        externalPending.current = Math.max(0, externalPending.current - 1);
        if (externalPending.current > 0) return;
        requestReconcile();
        // Nothing to read if the editor is not up yet; a save held meanwhile
        // still lands.
        releaseRef.current();
      },
    });
    return () => {
      live = false;
      externalPending.current = 0;
      stop();
    };
  }, [path, requestReconcile]);

  // A panel turn lands every open page's pending save before its child
  // starts (useAgentChat), so the agent reads what is on screen.
  useEffect(() => registerFlush(() => flushRef.current?.() ?? Promise.resolve()), []);
  // What a flush cannot land: a save that waits on a write, a reconcile or a
  // choice. A page move refuses while this names the file (M55.13), since
  // the save would release onto the old path.
  useEffect(
    () =>
      registerHold(() =>
        held.current !== null ||
        owed.current ||
        choicesRef.current.length > 0 ||
        externalPending.current > 0 ||
        reconciling.current !== null
          ? pathRef.current
          : null,
      ),
    [],
  );

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

  // Saves target the path the body was LOADED for, never the current prop —
  // a debounce flush racing a navigation must land in its own file.
  const saveFor = (forPath: string) => (markdown: string) => {
    if (vaultPath === null) return Promise.resolve();
    return land({ vault: vaultPath, path: forPath, markdown });
  };

  // Leaving the page (another path, or unmounting) while it holds a save or
  // a choice writes the page as it stands: yours wins (M53 Q5). Through a
  // ref, because the cleanup belongs to the render that created it.
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(
    () => () => {
      const at = ready.current;
      const owing = held.current !== null || choicesRef.current.length > 0;
      const vault = held.current?.vault ?? vaultRef.current;
      held.current = null;
      if (!owing || at === null || at.path !== path || vault === null) return;
      at.info.cancelPendingSave();
      void writeRef.current(vault, path, at.info.serialize());
    },
    [path],
  );

  /** Settle a row of the choice bar. */
  const pick = (id: string, which: 'mine' | 'theirs') => {
    const at = ready.current;
    if (at === null) return;
    if (id === PAGE_CHOICE) {
      // The new version, whole: what was typed is discarded, so the pending
      // debounce and the held save go before the remount.
      if (which === 'theirs') {
        remount();
        return;
      }
      showChoices(choicesRef.current.filter((choice) => choice.id !== PAGE_CHOICE));
    } else {
      const page = choicesRef.current.filter((choice) => choice.id === PAGE_CHOICE);
      showChoices([...at.info.choose(id, which), ...page]);
    }
    release();
  };

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
      <MergeChoices choices={choices} onPick={pick} />
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
          // A remount (`gen`) takes the file whole; every other outside write
          // lands in place through `applyExternal`.
          key={`${loaded.path}#${loaded.gen}`}
          markdown={loaded.body}
          readOnly={locked}
          onChange={saveFor(loaded.path)}
          onDirty={() => emitSaveState('dirty')}
          onReady={(info: EditorReadyInfo) => {
            flushRef.current = info.flushPendingSave;
            cancelRef.current = info.cancelPendingSave;
            lossyRef.current = info.lossyCause;
            setLossy(info.lossyCause);
            ready.current = { path: loaded.path, info };
            base.current = { raw: loaded.body, canon: info.loadedAs };
            onReady?.(info);
            if (missed.current) {
              missed.current = false;
              requestReconcile();
            }
          }}
          autoFocus={autoFocus}
          debounceMs={debounceMs}
        />
      </NotePathContext.Provider>
    </div>
  );
}
