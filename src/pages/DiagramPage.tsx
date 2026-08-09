import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { SaveState } from '@/editor/NoteBodyEditor';
import type { Selection } from '@/engine/types';
import { readNote, saveNote } from '@/lib/ipc';
import { humanize } from '@/lib/mockParse';
import { detectDiagramType } from '@/mermaid/detect';
import { parseFlowchart } from '@/mermaid/flowchart/model';
import { StructuralEditor } from '@/mermaid/flowchart/StructuralEditor';
import { HighlightedTextarea } from '@/mermaid/HighlightedTextarea';
import { LivePreview } from '@/mermaid/MermaidBlockView';
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
 * The page IS an editor — no separate view mode. Same latched-mode state
 * machine as MermaidBlockView: a source that parses as a flowchart opens in
 * the structural editor with a "Show code" toggle; everything else opens as
 * side-by-side code + live preview. The mode is chosen when the file loads
 * and only the toggle button promotes code → visual — mid-keystroke source
 * becoming flowchart-shaped must never yank the textarea away. The one
 * automatic flip is the demotion safety net, same as the block's.
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

  // null while loading; the editors only mount on real content.
  const [code, setCode] = useState<string | null>(null);
  const [mode, setMode] = useState<'visual' | 'code'>('code');
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

  // Load once per mount (the App.tsx key makes a path change a fresh mount);
  // the entry mode is LATCHED here (visual for flowcharts, code for
  // everything else) and never auto-promoted after.
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
        setMode(parseFlowchart(raw) !== null ? 'visual' : 'code');
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

  const flowchartCapable = code !== null && parseFlowchart(code) !== null;

  // Demotion safety net only (parity with MermaidBlockView): source that
  // stops parsing as a flowchart falls back to code rather than leaving the
  // structural editor holding a model it cannot build. Never the other
  // direction — that is the toggle button's job.
  useEffect(() => {
    if (mode === 'visual' && code !== null && !flowchartCapable) setMode('code');
  }, [mode, code, flowchartCapable]);

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
        {flowchartCapable && (
          <button
            type="button"
            onClick={() => setMode(mode === 'visual' ? 'code' : 'visual')}
            className="rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            {mode === 'visual' ? 'Show code' : 'Show diagram'}
          </button>
        )}
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

      {code !== null && mode === 'visual' && flowchartCapable && (
        <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="diagram-visual-pane">
          {/* Every structural op commits through handleChange — the same
              channel typing uses — so visual edits autosave identically. */}
          <StructuralEditor code={code} onChangeCode={handleChange} />
        </div>
      )}

      {code !== null && (mode === 'code' || !flowchartCapable) && (
        <div
          className="flex min-h-0 flex-1 flex-wrap content-start overflow-auto"
          data-testid="diagram-code-pane"
        >
          {/* No draft/commit dance here (unlike the block's code mode): the
              page autosaves, so the textarea edits `code` directly and the
              debounce is the commit. Escape has nothing to cancel. */}
          <HighlightedTextarea
            ariaLabel="Mermaid source"
            value={code}
            placeholder={'graph TD\n  A[Idea] --> B[Shipped]'}
            onChange={handleChange}
            rows={Math.max(16, code.split('\n').length + 1)}
          />
          <LivePreview code={code} />
        </div>
      )}
    </div>
  );
}
