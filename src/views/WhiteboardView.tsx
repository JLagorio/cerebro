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
import type { NodePlacer } from '@/mermaid/flowchart/StructuralEditor';
import { parseFlowchart, serialize } from '@/mermaid/flowchart/model';
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
  const { code, loadFailed, saveState, handleChange, undo, redo, canUndo, canRedo } =
    useDiagramFile(file);
  // Shared with the editor inside FullScreenDiagramEditor, so "Add record"
  // places a node exactly as `+ Node` does (M29.52).
  const placerRef = useRef<NodePlacer | null>(null);
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
   * CLOSED (M29.52), and the limitation this comment used to record is worth
   * keeping because it is why the surface looked broken: the new node got no
   * stored position, so on a manual-layout canvas it landed wherever dagre put
   * it — a row that widened with every record until, measured live at three,
   * the third was already clipped by the viewport and a fourth was invisible.
   * The answer turned out to be the one the note doubted: the toolbar's
   * viewport-centre placement, which is what `+ Node` has always done here, so
   * both insert paths now agree instead of disagreeing. `placerRef` is shared
   * rather than internal, and a canvas with no armed placer (code mode, an
   * unmeasurable host) falls through to the unplaced insertion exactly as
   * before — a refusal to place is never a refusal to insert.
   */
  const addRecord = (entry: Entry) => {
    setAdding(false);
    if (code === null) return;
    const result = insertRecordNode(code, entry);
    if (!result.ok) {
      // Two refusals, two pieces of news. "Not a flowchart" is about the
      // canvas and true of every record; "unbindable" is about THIS record
      // and true of no other, so one message for both would send the user to
      // fix the wrong thing.
      toast(
        result.reason === 'opaque'
          ? "This canvas isn't a flowchart, so records can't be placed on it"
          : `Couldn't place ${entry.title} — its file path can't be written as a link`,
      );
      return;
    }
    // The record lands where the user is looking, exactly as `+ Node` does
    // (M29.52). This used to be the KNOWN LIMITATION above: with no stored
    // position the node went wherever dagre put it, which on a manual-layout
    // canvas meant a widening row marching off the right-hand edge — measured
    // live at three records, the third already clipped by the viewport. The
    // placer is the editor's own, shared through `placerRef`, so the answer is
    // the toolbar's answer rather than a second one; and it cascades off
    // anything already there, so two records in a row do not stack.
    const model = parseFlowchart(result.code);
    const placed = model === null ? null : (placerRef.current?.(model, result.id) ?? null);
    handleChange(placed === null ? result.code : serialize(placed));
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
      {/* No `relative`: the picker anchors through `anchorRef` and portals to
          the body, so a positioned bar would only be an unused containing
          block for nothing. */}
      <div className="flex h-9 flex-none items-center gap-1.5 border-b border-n-200 px-3">
        <button
          ref={addRef}
          type="button"
          data-testid="whiteboard-add-record"
          aria-haspopup="dialog"
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
        // The one surface that gets the dot grid (M29.52): a whiteboard is a
        // place you arrange things on, and every tool that offers one — Miro,
        // Lucidchart, ClickUp — says so with dots. A `.mmd` file does not get
        // them; that surface is a document that happens to pan.
        dots
        history={{ undo, redo, canUndo, canRedo }}
        placerRef={placerRef}
        entries={vaultEntries}
        onOpenPath={openPath}
        overlay={<RecordChipOverlay code={code} entries={vaultEntries} schema={schema} />}
      />
    </>
  );
}

/** The record's key (`FLD-7`), or ''. The alias QuickOpen scores against. */
function recordKey(entry: Entry): string {
  return typeof entry.properties.key === 'string' ? entry.properties.key : '';
}

/**
 * The picker behind "Add record" (M29.47).
 *
 * `quickOpenScore` over TITLE AND KEY, `Math.max` of the two — the same pair
 * ⌘K scores (QuickOpen.tsx:84,203), so the typing that finds a record there
 * finds it here. Title alone was a false claim in this very docstring: every
 * work item in the demo vault carries a key, so `lnc-3` found the record in
 * ⌘K and nothing at all on the whiteboard.
 *
 * Built on the `Popover` primitive rather than a hand-rolled scrim: dismissal,
 * the Escape layer stack and the portal all come with it, and this surface
 * sits on a bar that other layers open over.
 */
/** The listbox and its rows, named so the input can point at the marked one. */
const LIST_ID = 'whiteboard-add-listbox';
const optionId = (i: number): string => `whiteboard-add-option-${i}`;

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
  /**
   * Which row Enter will take, or null for "the top one, once you have typed".
   *
   * Null rather than 0 at rest, deliberately: an empty box offers 25 records in
   * whatever order they came, and marking one of them would be the picker
   * claiming a choice nobody has made — the same rule the Enter branch below
   * has always held, now visible.
   */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const q = query.trim();
  const results = useMemo(() => {
    if (q === '') return entries.slice(0, MAX_OFFERED);
    return entries
      .map((e) => ({
        e,
        score: Math.max(quickOpenScore(q, e.title), quickOpenScore(q, recordKey(e))),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_OFFERED)
      .map((r) => r.e);
  }, [entries, q]);
  // A mark that outlived the list it pointed into would move Enter's target
  // silently as the user typed.
  const active = activeIndex === null || activeIndex >= results.length ? null : activeIndex;

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
          // The row Enter will take, said out loud (M29.53). MEASURED before
          // this: 25 options with an empty query, ArrowDown moved nothing,
          // every row's background was rgba(0,0,0,0) and there was no
          // aria-activedescendant — so Enter DID place a record and nothing on
          // screen had said which one it would be. ⌘K, whose scorer this
          // reuses, has always highlighted its rows; this is that pattern.
          ariaActivedescendant={active === null ? undefined : optionId(active)}
          ariaControls={LIST_ID}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActiveIndex((i) => {
                const next = (i ?? -1) + step;
                if (next < 0) return results.length - 1;
                if (next >= results.length) return 0;
                return next;
              });
              return;
            }
            // Enter takes the marked offer, or the top one — but only once
            // something has been typed OR something has been picked out with
            // the arrows. With the box empty and nothing marked every record
            // is "first", and placing whichever one that is would be an edit
            // nobody asked for (LinkPopover's rule, same reason).
            if (e.key !== 'Enter') return;
            if (q === '' && active === null) return;
            const chosen = results[active ?? 0];
            if (chosen !== undefined) onPick(chosen);
          }}
          width="100%"
        />
        <div className="min-h-0 flex-1 overflow-y-auto" id={LIST_ID} role="listbox">
          {results.map((e, i) => (
            <button
              key={e.path}
              type="button"
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              data-testid="whiteboard-add-option"
              title={e.path}
              onClick={() => onPick(e)}
              onMouseEnter={() => setActiveIndex(i)}
              style={{ background: i === active ? 'var(--n-50)' : 'transparent' }}
              className="flex w-full items-center gap-2 rounded-md border-0 px-2 py-1.5 text-left text-sm text-n-700 hover:bg-n-50"
            >
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              {/* The key when the record has one, since that is what a key
                  search matched on and it identifies the record outright;
                  the folder otherwise, to tell two same-titled rows apart. */}
              <span className="flex-none text-2xs text-n-400">{recordKey(e) || e.folder}</span>
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
