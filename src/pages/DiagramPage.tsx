import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { SaveState } from '@/editor/NoteBodyEditor';
import type { Selection } from '@/engine/types';
import { readNote, saveNote } from '@/lib/ipc';
import { humanize } from '@/lib/mockParse';
import { detectDiagramType } from '@/mermaid/detect';
import { FullScreenDiagramEditor } from '@/mermaid/FullScreenDiagramEditor';
import { useOpenPath } from '@/app/useOpenPath';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useEntry, useVaultStore } from '@/stores/vaultStore';

export type DiagramSelection = Extract<Selection, { kind: 'diagram' }>;

/** Same trust signal DocPage shows; `idle` stays quiet on purpose. */
const SAVE_LABEL: Record<SaveState, string | null> = {
  idle: null,
  dirty: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  failed: "Couldn't save",
};

/** How long a pause in editing waits before the source flushes to disk. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Full-page editor for a standalone `.mmd` file (M29.21).
 *
 * The page IS an editor — no separate view mode. Since M29.27 the whole body
 * is the shared FullScreenDiagramEditor (spec D1): a pan/zoom canvas hosting
 * the structural editor or a read-only render, with the code panel floating
 * over it. The latch, the "Show code" toggle and the demotion safety net all
 * live there now; this page keeps only the chrome and the file.
 *
 * One honest cost of that body: the save chip now LAGS the keystroke. Typing
 * in the code overlay reaches handleChange 250ms later (CodeOverlay's own
 * debounce), so for that window a just-saved file still reads "Saved" while
 * the buffer is dirty. The BYTES are safe either way — the overlay flushes
 * from a layout cleanup, which React runs before this page's passive unmount
 * save, so a navigation mid-keystroke still lands on the old path (M29.23).
 * Only the label is late, and a dirty-signal prop plumbed up from the overlay
 * would buy a 250ms chip correction at the cost of coupling the shared editor
 * to one host's chrome.
 *
 * Content is RAW end-to-end: readNote/saveNote pass `.mmd` bytes through
 * verbatim, so mermaid's own `---` config header survives every save.
 *
 * v1 deliberately takes no external live-reload: the file is read once per
 * path, and an edit made outside the app while the page is open wins or
 * loses on last-write like any plain editor. The watcher's rescan still
 * updates the entry (title, tree) — only the open buffer stays put. This is
 * DocPage's M17.4 reconcile problem, consciously deferred.
 *
 * App.tsx mounts this KEYED on the path, and the save machinery depends on
 * it: the pending-debounce flush runs as an unmount cleanup, and only a true
 * unmount guarantees that cleanup still belongs to the file it was editing.
 * An unkeyed diagram→diagram navigation re-rendered first — re-pointing
 * `flushRef` at the new path — and THEN ran the old effect's cleanup, which
 * wrote the old file's bytes into the new one and dropped the pending edit.
 */
export function DiagramPage({ selection }: { selection: DiagramSelection }) {
  const entry = useEntry(selection.path);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const navigate = useNavStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);
  // M29.38 — the link popover's record search and what a link badge opens.
  // `in-place`, not `navigate`: this page IS the canvas the user is standing
  // on, and M9.3's backdrop jump is for surfaces that have none. The detail
  // panel mounts app-globally (App.tsx), so openDetail works from here.
  const entries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath('in-place');

  // null while loading; the editors only mount on real content.
  const [code, setCode] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // The read failed — renamed, trashed, or unreadable. The tombstone keys on
  // THIS, not on the entry lookup: the file is the truth in a files-first
  // app, so the page attempts the read regardless of whether the scanner has
  // adopted the path yet (a just-created .mmd opens fine pre-rescan), and
  // only a failed read means there is nothing here to edit.
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
      await saveNote(vaultPath, selection.path, latest.current);
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

  const handleChange = (next: string) => {
    latest.current = next;
    setCode(next);
    setSaveState('dirty');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  };

  // Load once per mount (the App.tsx key makes a path change a fresh mount).
  // The entry mode is latched by FullScreenDiagramEditor, from the source it
  // mounts with — which is this load's result, so the rule is unchanged.
  useEffect(() => {
    let cancelled = false;
    setCode(null);
    setSaveState('idle');
    setLoadFailed(false);
    if (vaultPath === null) return;
    void readNote(vaultPath, selection.path)
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
  }, [vaultPath, selection.path]);

  // A pending debounce must not die with the page: flush it on unmount. This
  // is only safe BECAUSE App.tsx keys the page on the path — a path change
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

  // Only a FAILED READ tombstones the page (see loadFailed above): an entry
  // the scanner has not adopted yet still opens, and an entry that lingers
  // after its file went unreadable does not pretend to be editable.
  if (loadFailed) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="file-x"
          title="This diagram no longer exists"
          description="It may have been renamed, moved to the Trash, or its file couldn't be read."
          action={
            <Button variant="secondary" onClick={() => navigate({ kind: 'home' })}>
              Go home
            </Button>
          }
        />
      </div>
    );
  }

  // The scanner's title when it has one; the filename stem before then —
  // `humanize` is the same sentence-casing the scanner itself applies, so
  // the title doesn't flicker when the rescan lands.
  const title =
    entry?.title ??
    humanize((selection.path.split('/').pop() ?? selection.path).replace(/\.mmd$/, ''));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="diagram-page">
      <div className="flex h-11 flex-none items-center gap-1.5 border-b border-n-200 px-3">
        <Icon name="waypoints" size={14} color="var(--n-500)" />
        <span className="truncate text-sm font-medium text-n-900" data-testid="diagram-title">
          {title}
        </span>
        <span className="flex-none text-xs uppercase tracking-[0.05em] text-n-500">
          {detectDiagramType(code ?? '')}
        </span>
        <span className="flex-1" />
        {SAVE_LABEL[saveState] !== null && (
          <span
            data-testid="diagram-save-state"
            title={saveState === 'failed' ? undefined : 'Saves automatically'}
            className={[
              'flex-none whitespace-nowrap text-xs',
              saveState === 'failed' ? 'font-medium text-danger-600' : 'text-[var(--text-meta)]',
            ].join(' ')}
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
      </div>

      {code !== null && (
        /* Every edit — structural op, overlay keystroke — commits through
           handleChange, the same channel the old panes used, so the keyed
           debounced autosave (M29.23) is untouched. The editor owns no
           persistence; this page is the only writer. */
        <FullScreenDiagramEditor
          code={code}
          onChangeCode={handleChange}
          entries={entries}
          onOpenPath={openPath}
        />
      )}
    </div>
  );
}
