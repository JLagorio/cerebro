import { useEffect, useRef } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';
import { writeTextFile } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { FullScreenDiagramEditor } from '@/mermaid/FullScreenDiagramEditor';
import { useDiagramFile } from '@/mermaid/useDiagramFile';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Where a whiteboard tab creates and finds its canvas file (M29.45).
 *
 * `folder` is the folder of the HOST'S OWN file — the `.list.yml`'s folder
 * for a List (which is the collection folder, or '' for a root-level List),
 * the Type doc's folder for a Type screen. The canvas lands in a
 * `whiteboards/` subfolder of it. `viewName` names the file.
 */
export interface WhiteboardHost {
  folder: string;
  viewName: string;
}

export interface WhiteboardViewProps {
  /**
   * The view's own (filtered) records — what "Add record" offers.
   *
   * DECLARED, NOT READ, until M29.47 puts the record chips on the canvas.
   * It is not the link popover's corpus either: that search is vault-wide by
   * design (M29.38), and narrowing it to the tab's filtered rows would make
   * most of the vault unlinkable from a whiteboard. Deliberately left unused
   * rather than given a plausible-looking consumer.
   */
  entries: Entry[];
  presentation: Presentation;
  /** Type icons/colours for the M29.47 chips. Declared, not read, until then. */
  schema: Schema;
  /** null = a surface that cannot host a canvas (a dashboard block). */
  host: WhiteboardHost | null;
  /** Persists the created file's path onto the view. */
  onPresentationChange?: (next: Presentation) => void;
}

/**
 * What a fresh canvas holds. A bare `flowchart TD` is a valid, empty mermaid
 * flowchart — the structural editor opens on it with its add-node affordances
 * and nothing else, which is what "blank whiteboard" means.
 *
 * The manual-layout marker (M29.41) is part of the seed because this is a
 * WHITEBOARD: a node lands where it was dropped, and the toolbar's placer is
 * only armed in manual mode. A diagram file made anywhere else still defaults
 * to auto layout; only this surface asks for free-drag up front.
 */
const WHITEBOARD_SEED = 'flowchart TD\n  %% cerebro:layout manual\n';

/**
 * A whiteboard tab (M29.45/M29.46, spec D8): a `.mmd` canvas owned by the
 * view, created on first open, rendered through the shared full-screen editor.
 * M29.47 adds the record chips.
 *
 * `EmptyState` takes a fixed prop list and spreads nothing, so each face is
 * wrapped in the div that carries its test id.
 */
export function WhiteboardView({ presentation, host, onPresentationChange }: WhiteboardViewProps) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const file = presentation.whiteboard?.file ?? null;
  // Primitives, not the host object: ViewCanvas builds `host` fresh on every
  // render, so an effect keyed on it re-fires constantly.
  const folder = host?.folder ?? null;
  const viewName = host?.viewName ?? null;
  // A canvas nothing points at is litter on disk. A surface that cannot
  // persist the pointer therefore waits rather than creating one per open —
  // defensive only: every host that passes `host` also passes this.
  const canPersist = onPresentationChange !== undefined;

  // Read at FIRE time, not effect-arm time: keying the effect on the
  // presentation object would re-arm it on every unrelated view setting.
  const latest = useRef({ presentation, onPresentationChange });
  latest.current = { presentation, onPresentationChange };

  // One creation per mount, held across the async gap. Without this, the
  // effect re-fires while writeTextFile is on the wire (the rescan re-renders)
  // and the stem dedupe turns one canvas into launch-map.mmd + -2 + -3.
  const creating = useRef(false);

  useEffect(() => {
    if (file !== null || folder === null || viewName === null) return;
    if (vaultPath === null || !canPersist || creating.current) return;
    creating.current = true;
    void (async () => {
      try {
        // <host folder>/whiteboards/<view-name-slug>.mmd. `folder` is '' for a
        // root-level List — no collection folder — so the canvas lands in a
        // top-level whiteboards/.
        const stem = slugify(viewName) || 'whiteboard';
        const rel = `${folder === '' ? '' : `${folder}/`}whiteboards/${stem}.mmd`;
        const actual = await writeTextFile(vaultPath, rel, WHITEBOARD_SEED);
        // The mock backend has no watcher and Tauri's arrives late; the tree
        // and the entry list should know about the canvas before the tab does.
        await rescan();
        // The pointer is presentation state, so it persists through the same
        // channel every view setting does — one write to the List's YAML.
        latest.current.onPresentationChange?.({
          ...latest.current.presentation,
          whiteboard: { file: actual },
        });
      } catch (err) {
        // Store-layer discipline (AGENTS.md): the failure is caught, named,
        // and left recoverable — `creating` re-opens so the next render (or
        // the user's next visit) tries again rather than stranding the tab.
        creating.current = false;
        toast(`Couldn't create whiteboard: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, [file, folder, viewName, vaultPath, canPersist, rescan, toast]);

  if (host === null) {
    // A dashboard block reaches here (M29.48 wires the page hosts and leaves
    // the dashboard out): recursion aside, a whiteboard is an EDITOR, and a
    // 300px read-only tile of one would be a picture pretending to be a
    // canvas. `hasBlocks` guards view-in-view nesting; this face guards
    // canvas-in-block.
    return (
      <div data-testid="whiteboard-unavailable" className="flex min-h-0 flex-1">
        <EmptyState
          icon="presentation"
          title="Whiteboards live on their list"
          description="Open the list to draw on this whiteboard — it can't be embedded in a dashboard."
          className="flex-1"
        />
      </div>
    );
  }
  if (file === null) {
    return (
      <div data-testid="whiteboard-creating" className="flex min-h-0 flex-1">
        <EmptyState icon="presentation" title="Preparing canvas…" className="flex-1" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="whiteboard-view">
      {/* KEYED on the file (M29.23): the canvas's useDiagramFile flushes on
          unmount, and only a true unmount keeps that flush aimed at the file
          it was editing. Re-pointing the tab at a new file must remount. */}
      <WhiteboardCanvas
        key={file}
        file={file}
        presentation={presentation}
        onPresentationChange={onPresentationChange}
        viewName={host.viewName}
      />
    </div>
  );
}

function WhiteboardCanvas({
  file,
  presentation,
  onPresentationChange,
  viewName,
}: {
  file: string;
  presentation: Presentation;
  onPresentationChange?: (next: Presentation) => void;
  viewName: string;
}) {
  const { code, loadFailed, handleChange } = useDiagramFile(file);
  // The link popover's record search and what a link badge opens (M29.38) —
  // the same wiring DiagramPage gives the shared editor, so a whiteboard can
  // bind a node to a record instead of being URL-only. `in-place`, not
  // `navigate`: this tab IS the backdrop the user is standing on (M9.3).
  const vaultEntries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath('in-place');

  if (loadFailed) {
    // The pointer outlived its file: renamed folder, trashed file, hand-edited
    // YAML. Nothing in the app rewrites path references inside files on a
    // folder rename (navStore remaps SELECTIONS only), so this face is the
    // honest recovery: keep the dead pointer visible, offer a fresh canvas.
    // "Start a new canvas" clears the pointer to the in-memory null state,
    // which re-arms create-on-open.
    return (
      <div data-testid="whiteboard-tombstone" className="flex min-h-0 flex-1">
        <EmptyState
          icon="file-x"
          title="This whiteboard's file is gone"
          description={`${file} was renamed, moved, or deleted outside this tab.`}
          className="flex-1"
          action={
            onPresentationChange && (
              <Button
                variant="secondary"
                onClick={() =>
                  onPresentationChange({ ...presentation, whiteboard: { file: null } })
                }
              >
                Start a new canvas
              </Button>
            )
          }
        />
      </div>
    );
  }
  if (code === null) {
    return <div data-testid="whiteboard-loading" className="flex-1" aria-busy="true" />;
  }
  return (
    <FullScreenDiagramEditor
      code={code}
      onChangeCode={handleChange}
      title={viewName}
      embedded
      entries={vaultEntries}
      onOpenPath={openPath}
    />
  );
}
