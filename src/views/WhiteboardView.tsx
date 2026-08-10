import { useEffect, useMemo, useRef, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Popover } from '@/components/ui/Popover';
import type { Entry, Presentation, Schema } from '@/engine/types';
import { writeTextFile } from '@/lib/ipc';
import { quickOpenScore } from '@/lib/quickOpenScore';
import { slugify } from '@/lib/slug';
import { FullScreenDiagramEditor } from '@/mermaid/FullScreenDiagramEditor';
import { SAVE_LABEL, useDiagramFile } from '@/mermaid/useDiagramFile';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { RecordChipOverlay } from '@/views/RecordChipOverlay';
import { insertRecordNode, recordBindings } from '@/views/whiteboardBindings';

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
   * The view's own records — already filtered, sorted and limited by the page
   * that built them — and exactly what "Add record" offers (M29.47, spec D8).
   *
   * It is NOT the link popover's corpus, and it is not what the chips resolve
   * against: both of those are vault-wide by design (M29.38). Narrowing the
   * link search would make most of the vault unlinkable from a whiteboard, and
   * narrowing the chips would make a node's card vanish the moment its record
   * stopped matching the tab's filter.
   */
  entries: Entry[];
  presentation: Presentation;
  /** Resolves each bound record's status field for its chip (M29.47). */
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
 * A whiteboard tab (M29.45–M29.47, spec D8): a `.mmd` canvas owned by the
 * view, created on first open, rendered through the shared full-screen editor,
 * with the view's own records placeable on it as bound, badged, clickable
 * cards.
 *
 * `EmptyState` takes a fixed prop list and spreads nothing, so each face is
 * wrapped in the div that carries its test id.
 */
export function WhiteboardView({
  entries,
  presentation,
  schema,
  host,
  onPresentationChange,
}: WhiteboardViewProps) {
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

  // Held in a ref so the effect can read the persist channel WITHOUT keying
  // on it: `presentation` is a new object on every unrelated view setting and
  // `onPresentationChange` a new closure on every host render, so either in
  // the dep array re-arms creation constantly.
  const latest = useRef({ presentation, onPresentationChange });
  latest.current = { presentation, onPresentationChange };

  /**
   * The creation targets with a write IN FLIGHT right now.
   *
   * Keyed on the TARGET, not on the mount, because `ViewCanvas` renders this
   * view UNKEYED: one instance serves every tab on the page. A plain
   * `creating` boolean — set on the way in, cleared only on failure — starved
   * every whiteboard tab after the first, so the second one a user ever
   * opened sat on "Preparing canvas…" forever (M29.46 review).
   *
   * A SET, because two tabs can be mid-creation at once. Cleared when the
   * attempt SETTLES, not held for the life of the mount: a durable "already
   * attempted" record is the same latch one level up, and it would kill the
   * tombstone's "Start a new canvas" for any canvas this mount had created.
   * Nothing needs it to be durable — once the pointer is persisted, `file`
   * is non-null and the effect returns on its own.
   *
   * A ref rather than nothing at all, because StrictMode's dev double-invoke
   * (main.tsx) re-fires this effect synchronously with identical deps, inside
   * the window, and must still make exactly one file.
   */
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (file !== null || folder === null || viewName === null) return;
    if (vaultPath === null || !canPersist) return;
    const target = `${folder}\0${viewName}`;
    if (inFlight.current.has(target)) return;
    inFlight.current.add(target);
    // PINNED at fire time, not read at resolve time. `ListPage`'s
    // changePresentation writes to whichever tab is active when it is CALLED,
    // so a tab switch during the write handed this canvas to the wrong view:
    // tab B adopted tab A's file and A was left pointerless (M29.46 review).
    // The cost of pinning is the mirror case — an unrelated setting changed
    // on THIS tab inside the window is overwritten by the pinned copy — which
    // is a last-write-wins on one tab instead of corruption across two, and
    // is the same shape every other presentation writer here already has.
    const pinned = latest.current;
    void (async () => {
      let written = false;
      try {
        // <host folder>/whiteboards/<view-name-slug>.mmd. `folder` is '' for a
        // root-level List — no collection folder — so the canvas lands in a
        // top-level whiteboards/.
        const stem = slugify(viewName) || 'whiteboard';
        const rel = `${folder === '' ? '' : `${folder}/`}whiteboards/${stem}.mmd`;
        const actual = await writeTextFile(vaultPath, rel, WHITEBOARD_SEED);
        written = true;
        // The mock backend has no watcher and Tauri's arrives late; the tree
        // and the entry list should know about the canvas before the tab does.
        await rescan();
        // The pointer is presentation state, so it persists through the same
        // channel every view setting does — one write to the List's YAML.
        pinned.onPresentationChange?.({
          ...pinned.presentation,
          whiteboard: { file: actual },
        });
        inFlight.current.delete(target);
      } catch (err) {
        // Store-layer discipline (AGENTS.md): caught, named, and left
        // recoverable. The target is released ONLY if the write never landed.
        // A failure AFTER it — rescan, or the persist channel, both store
        // actions bound by the never-throw invariant — keeps the target held,
        // because retrying would write a second file through the stem dedupe
        // and orphan the first: the very litter `canPersist` exists to
        // prevent, one step later.
        if (!written) inFlight.current.delete(target);
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
        entries={entries}
        schema={schema}
        presentation={presentation}
        onPresentationChange={onPresentationChange}
        viewName={host.viewName}
      />
    </div>
  );
}

/** How many records the picker shows at once — quick open's own ceiling. */
const MAX_OFFERED = 25;

function WhiteboardCanvas({
  file,
  entries,
  schema,
  presentation,
  onPresentationChange,
  viewName,
}: {
  file: string;
  entries: Entry[];
  schema: Schema;
  presentation: Presentation;
  onPresentationChange?: (next: Presentation) => void;
  viewName: string;
}) {
  const { code, loadFailed, saveState, handleChange } = useDiagramFile(file);
  // The link popover's record search and what a link badge opens (M29.38) —
  // the same wiring DiagramPage gives the shared editor, so a whiteboard can
  // bind a node to a record instead of being URL-only. `in-place`, not
  // `navigate`: this tab IS the backdrop the user is standing on (M9.3).
  const vaultEntries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath('in-place');
  const toast = useUiStore((s) => s.toast);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  /**
   * What is left to offer. Resolved against the VIEW's rows, not the vault,
   * because only those can be offered in the first place — and the narrower
   * corpus is also the cheaper one.
   *
   * Absence is read as "not on the canvas", which is right for every binding
   * this editor can read and wrong for exactly one it cannot: a node linked
   * only by a click form we do not own has no entry in `recordBindings` at
   * all, so its record is offered again and the user can end up with two
   * nodes for it. That is the smaller wrong — the alternative is refusing to
   * offer records on the strength of a line we are unable to read.
   */
  const offered = useMemo(() => {
    if (code === null) return entries;
    const placed = new Set([...recordBindings(code, entries).values()].map((b) => b.entry.path));
    return entries.filter((e) => !placed.has(e.path));
  }, [code, entries]);

  /**
   * Spec D10: node + label + binding is ONE `onChangeCode`, therefore one undo
   * step. A refusal is a true no-op — no commit, nothing to undo — and says so
   * rather than throwing (the store-layer ethos, AGENTS.md).
   *
   * KNOWN LIMITATION, deliberate (M29.48): the new node gets no stored manual
   * position. The seed asks for manual layout, but `applyManualLayout` only
   * moves nodes the source already places, so this one lands wherever dagre
   * put it and the user drags it once — after which the drag stores a position
   * like any other. Placing it properly means the toolbar's `NodePlacer`,
   * which lives on `FullScreenDiagramEditor`'s internal `placerRef` and is
   * armed only while the structural editor is mounted in manual mode. Reaching
   * it from out here is a second additive prop to a Stage D file plus a
   * "not placeable right now" branch for the demoted (code-mode) canvas, and
   * "where should a record added from a BAR land" is a product question the
   * toolbar's viewport-centre answer does not obviously settle. Left to a
   * stage that can decide it; the current behaviour is safe and self-correcting.
   */
  const addRecord = (entry: Entry) => {
    setAdding(false);
    if (code === null) return;
    const next = insertRecordNode(code, entry);
    if (next === null) {
      toast("This canvas isn't a flowchart, so records can't be placed on it");
      return;
    }
    handleChange(next);
  };

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
    <>
      {/* The whiteboard's own bar — NOT part of FullScreenDiagramEditor.
          "Add record" lists the VIEW's entries (spec D8), and the shared
          editor must not learn what a record is. */}
      <div className="relative flex h-9 flex-none items-center gap-1.5 border-b border-n-200 px-3">
        <button
          ref={addRef}
          type="button"
          data-testid="whiteboard-add-record"
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
          className="rounded-md border border-n-200 bg-transparent px-2 py-0.5 text-xs text-n-700 hover:bg-n-50"
        >
          Add record
        </button>
        {SAVE_LABEL[saveState] !== null && (
          <span
            data-testid="whiteboard-save-state"
            title={saveState === 'failed' ? undefined : 'Saves automatically'}
            className={
              saveState === 'failed'
                ? 'ml-auto text-xs font-medium text-danger-600'
                : 'ml-auto text-xs text-[var(--text-meta)]'
            }
          >
            {SAVE_LABEL[saveState]}
          </span>
        )}
        {adding && (
          <AddRecordPopover
            anchorRef={addRef}
            entries={offered}
            // "Nothing to offer" has two causes and they are not the same
            // news: a view with no rows at all is not a canvas that already
            // holds them.
            emptyLabel={
              entries.length === 0
                ? 'This view has no records yet'
                : 'Every record is already on the canvas'
            }
            onPick={addRecord}
            onClose={() => setAdding(false)}
          />
        )}
      </div>
      <FullScreenDiagramEditor
        code={code}
        onChangeCode={handleChange}
        title={viewName}
        embedded
        entries={vaultEntries}
        onOpenPath={openPath}
        overlay={<RecordChipOverlay code={code} entries={vaultEntries} schema={schema} />}
      />
    </>
  );
}

/**
 * The picker behind "Add record" (M29.47).
 *
 * `quickOpenScore` is the app's one fuzzy matcher, so a record is found here
 * by the same typing that finds it in ⌘K. Built on the `Popover` primitive
 * rather than a hand-rolled scrim: dismissal, the Escape layer stack and the
 * portal all come with it, and this surface sits on a bar that other layers
 * open over.
 */
function AddRecordPopover({
  anchorRef,
  entries,
  emptyLabel,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  /** What is still offerable — the view's rows minus everything already placed. */
  entries: Entry[];
  /** Why there is nothing to offer, when there is nothing to offer. */
  emptyLabel: string;
  onPick: (entry: Entry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const results = useMemo(() => {
    if (q === '') return entries.slice(0, MAX_OFFERED);
    return entries
      .map((e) => ({ e, score: quickOpenScore(q, e.title) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_OFFERED)
      .map((r) => r.e);
  }, [entries, q]);

  return (
    <Popover
      onClose={onClose}
      anchorRef={anchorRef}
      role="dialog"
      ariaLabel="Add record"
      trapFocus
      className="w-[280px] rounded-lg border border-n-200 bg-n-0 p-2 shadow-[var(--shadow-lg)]"
    >
      <div
        data-testid="whiteboard-record-picker"
        // Portals bubble through the REACT tree, so without this every key
        // typed in here also reaches whatever the host page listens for
        // (M29.33's lesson, one surface further out). The window-capture
        // Escape layer is unaffected — it never travels through this node.
        onKeyDown={(e) => e.stopPropagation()}
        className="flex max-h-80 flex-col gap-1.5"
      >
        <Input
          autoFocus
          size="sm"
          ariaLabel="Find a record"
          placeholder="Find a record…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          width="100%"
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {results.map((e) => (
            <button
              key={e.path}
              type="button"
              data-testid="whiteboard-add-option"
              title={e.path}
              onClick={() => onPick(e)}
              className="flex w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-sm text-n-700 hover:bg-n-50"
            >
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <span className="flex-none text-2xs text-n-400">{e.folder}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-n-400">
              {entries.length === 0 ? emptyLabel : 'No matches'}
            </div>
          )}
        </div>
      </div>
    </Popover>
  );
}
