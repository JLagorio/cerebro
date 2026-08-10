import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { Selection } from '@/engine/types';
import { humanize } from '@/lib/mockParse';
import { detectDiagramType } from '@/mermaid/detect';
import { FullScreenDiagramEditor } from '@/mermaid/FullScreenDiagramEditor';
import { SAVE_LABEL, useDiagramFile } from '@/mermaid/useDiagramFile';
import { useOpenPath } from '@/app/useOpenPath';
import { useNavStore } from '@/stores/navStore';
import { useEntry, useVaultStore } from '@/stores/vaultStore';

export type DiagramSelection = Extract<Selection, { kind: 'diagram' }>;

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
 * The file itself — read-once, debounce-save, flush-on-unmount, and the raw
 * `.mmd` byte contract that keeps mermaid's `---` config header intact — is
 * `useDiagramFile` since M29.46, shared verbatim with the whiteboard view.
 * The no-live-reload choice travels with it (DocPage's M17.4 reconcile
 * problem, consciously deferred): the watcher's rescan still updates the
 * entry (title, tree), only the open buffer stays put.
 *
 * App.tsx mounts this KEYED on the path, and that is still load-bearing: the
 * hook's pending-debounce flush runs as an unmount cleanup, and only a true
 * unmount guarantees that cleanup still belongs to the file it was editing.
 * An unkeyed diagram→diagram navigation re-rendered first — re-pointing the
 * flush at the new path — and THEN ran the old effect's cleanup, which wrote
 * the old file's bytes into the new one and dropped the pending edit.
 */
export function DiagramPage({ selection }: { selection: DiagramSelection }) {
  const entry = useEntry(selection.path);
  const navigate = useNavStore((s) => s.navigate);
  // M29.38 — the link popover's record search and what a link badge opens.
  // `in-place`, not `navigate`: this page IS the canvas the user is standing
  // on, and M9.3's backdrop jump is for surfaces that have none. The detail
  // panel mounts app-globally (App.tsx), so openDetail works from here.
  const entries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath('in-place');

  // The whole file lifecycle. The entry mode is latched by
  // FullScreenDiagramEditor, from the source it mounts with — which is this
  // load's result, so the M29.21 rule is unchanged.
  const { code, loadFailed, saveState, handleChange } = useDiagramFile(selection.path);

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
