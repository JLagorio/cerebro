import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { useUiStore } from '@/stores/uiStore';
import { isManualLayout, parseFlowchart, serialize, type FlowchartModel } from './flowchart/model';
import {
  addNode,
  setDirection,
  setLayoutEngine,
  setManualLayout,
  setNodeShape,
} from './flowchart/ops';
import { ShapePalette } from './flowchart/ShapePalette';
import type { NodePlacer } from './flowchart/StructuralEditor';
import { copyPng, copySvg, savePng } from './export';
import { renderMermaid } from './render';

const DIRECTIONS = ['TD', 'LR', 'BT', 'RL'] as const;

const isElk = (code: string): boolean => code.match(/^\s*layout:\s*elk\s*$/m) !== null;

/**
 * `whitespace-nowrap shrink-0` and a focus ring (M29.53).
 *
 * MEASURED at a 760px window: `+ Node`, `+ Shape`, `Layout: ELK` and
 * `Show code` each rendered 46px tall inside an `h-10` bar — their labels had
 * wrapped to two lines and the buttons spilled 6px below the row's own border
 * into the canvas. And these hand-rolled buttons declared no focus-visible
 * ring while the DS `Button`/`IconButton` beside them do, so Tab through one
 * toolbar strip crossed two different ring vocabularies eight controls in.
 */
const TEXT_BTN =
  'shrink-0 whitespace-nowrap rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50 focus-visible:outline-none focus-visible:ring';

/**
 * The full-screen editor's control strip (M29.26, spec D1/D9-partial).
 *
 * The structural cluster (add node, direction, layout engine) only exists
 * over the structural editor — a read-only canvas has no model to operate on.
 * The zoom cluster is NOT here on purpose: CanvasViewport owns zoom state, so
 * it draws its own controls (spec D2). The layout menu names the two engines
 * the ops speak and, below a separator, whether an engine lays the diagram out
 * at all (M29.43). ELK's placement variants are still unspoken.
 *
 * Export renders through the cached service at click time — the canvas just
 * rendered this exact code, so it is a cache hit, never a second layout.
 */
export function DiagramToolbar({
  code,
  onChangeCode,
  placerRef,
  title,
  mode,
  showCode,
  onToggleShowCode,
  onEditVisually,
  history,
  lastGoodSvg,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  /**
   * The svg the host is still SHOWING when `code` no longer renders — the
   * last-good hold every diagram face in this module keeps. Export falls back
   * to it rather than refusing while a valid picture is on the canvas (M29.53).
   */
  lastGoodSvg?: string | null;
  /**
   * The visual editor's manual-layout placement, when one is mounted beside
   * this toolbar and manual mode is on (M29.42 review). `+ Node` and `+ Shape`
   * here are the ONLY node-creation UI on the full-screen surface — which is
   * the surface manual layout is actually used on — so without this they mint
   * nodes that land wherever auto layout puts them while every other node
   * stays pinned. Absent, or null, means auto mode: nothing to place against.
   */
  placerRef?: MutableRefObject<NodePlacer | null>;
  /**
   * For hosts with no chrome of their own (Stage H's WhiteboardView). The page
   * header and the block dialog already name the diagram, so both omit it.
   */
  title?: string;
  /** What the canvas is hosting right now. */
  mode: 'visual' | 'code';
  showCode: boolean;
  onToggleShowCode: () => void;
  /**
   * Present when the source is flowchart-capable but the canvas is read-only.
   * The latch never auto-promotes (M29.18.1), so promotion is this explicit
   * button — or null when there is nothing to promote to.
   */
  onEditVisually: (() => void) | null;
  /**
   * Undo/redo, when the host owns a file and therefore a history (M29.52) —
   * the diagram page and the whiteboard. Absent inside a document block, where
   * the DOCUMENT's own history already covers the diagram and a second pair of
   * buttons would be a second, disagreeing timeline.
   */
  history?: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
}) {
  const toast = useUiStore((s) => s.toast);
  const model = useMemo(() => parseFlowchart(code), [code]);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const layoutAnchor = useRef<HTMLButtonElement | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);

  // Same rule the inline editor's popovers keep: a surface opened against one
  // reading of the source does not outlive that reading. Routine here rather
  // than exotic — the diagram page streams code-overlay edits into `code` on
  // every debounce tick while Auto-update is on.
  useEffect(() => {
    setInsertOpen(false);
  }, [code]);

  const apply = (next: FlowchartModel | null) => {
    if (next !== null) onChangeCode(serialize(next));
  };

  // savePng resolves null on user cancel — no toast either way (the M29.5
  // contract); the copy actions resolve undefined and always toast.
  const act = (success: string, failure: string, run: (svg: string) => Promise<unknown>) => {
    void renderMermaid(code)
      .then((r) => {
        // A broken source mid-edit does not mean there is nothing to export:
        // the canvas beside this toolbar is still showing its last good render
        // by design, and refusing while a perfectly good diagram is on screen
        // reads as the button being broken (M29.53). Export what the user can
        // see; refuse only when there has never been anything to see.
        if (!r.ok) {
          const fallback = lastGoodSvg ?? null;
          if (fallback === null) throw new Error(r.message);
          return run(fallback);
        }
        return run(r.svg);
      })
      .then((result) => {
        if (result !== null) toast(success);
      })
      .catch(() => toast(failure));
  };

  return (
    <div
      data-testid="diagram-toolbar"
      // `overflow-x-auto` + `shrink-0` children (M29.53). MEASURED at 800x600
      // with a whiteboard's title in the row: 664px of content in a 564px bar,
      // computed overflow-x `visible` and no wrap, so it neither scrolled nor
      // wrapped — "Save PNG…" sat at x=805 against a document 800px wide, past
      // the edge of the page with no scrollbar anywhere to reach it, and the
      // view title measured clientWidth 0 against scrollWidth 73, truncated
      // away without even an ellipsis. A scrolling strip keeps every control
      // reachable at every width; the title keeps its own min-w-0 truncation.
      className="flex h-10 flex-none items-center gap-1 overflow-x-auto border-b border-n-200 bg-n-0 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {title !== undefined && (
        <span className="mr-1 min-w-0 shrink truncate text-sm font-medium text-n-900">{title}</span>
      )}
      {history !== undefined && (
        <>
          {/* First in the row, ahead of the mode-dependent controls, because
              they are the only two buttons here that mean the same thing in
              every mode — and because a user reaches for undo without
              looking. */}
          <IconButton
            icon="undo-2"
            label="Undo"
            size="sm"
            disabled={!history.canUndo}
            onClick={history.undo}
          />
          <IconButton
            icon="redo-2"
            label="Redo"
            size="sm"
            disabled={!history.canRedo}
            onClick={history.redo}
          />
          <span className="mx-0.5 h-4 w-px bg-n-100" />
        </>
      )}
      {mode === 'visual' && model !== null && (
        <>
          <button
            type="button"
            aria-label="Add node"
            onClick={() => {
              const added = addNode(model, 'New step');
              apply(placerRef?.current?.(added.model, added.id) ?? added.model);
            }}
            className={TEXT_BTN}
          >
            + Node
          </button>
          {/*
            Its own wrapper, and that is what anchors the palette: a Popover
            with no anchorRef measures the nearest positioned ancestor of where
            it was written — which without this span is the whole toolbar row,
            so the palette would open at the far left under the title. (The
            layout menu below takes the other route, an explicit anchorRef;
            ShapePalette does not expose one, and wrapping is the primitive's
            other documented contract.)
          */}
          <span className="relative">
            <button
              type="button"
              title="Insert a node with a shape"
              aria-haspopup="dialog"
              aria-expanded={insertOpen}
              // A toggle: Popover's click-away counts a press on the anchor as
              // inside, so without this the button could open the palette but
              // never close it. Closing the LAYOUT menu is not this handler's
              // job — that popover anchors to its own button, so this press is
              // an outside press by its own reckoning and it dismisses itself.
              onClick={() => setInsertOpen((open) => !open)}
              className={TEXT_BTN}
            >
              + Shape
            </button>
            {insertOpen && (
              <ShapePalette
                // Nothing is current: this palette describes a node that does
                // not exist yet, so lighting up Rectangle (what `addNode`
                // happens to mint) would claim a choice nobody has made.
                current={null}
                onPick={(name) => {
                  setInsertOpen(false);
                  // ONE apply, therefore one onChangeCode, therefore one undo
                  // step (spec D10): the intermediate rectangle is never
                  // emitted, so Cmd+Z takes the whole insertion back instead of
                  // leaving a stray node of the wrong shape behind.
                  const added = addNode(model, 'New step');
                  const shaped = setNodeShape(added.model, added.id, name);
                  apply(placerRef?.current?.(shaped, added.id) ?? shaped);
                }}
                onClose={() => setInsertOpen(false)}
              />
            )}
          </span>
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          {DIRECTIONS.map((d) => (
            <button
              key={d}
              type="button"
              aria-label={`Direction ${d}`}
              onClick={() => apply(setDirection(model, d))}
              className={TEXT_BTN}
            >
              {d}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          <button
            type="button"
            ref={layoutAnchor}
            aria-label="Layout engine"
            onClick={() => setLayoutOpen(true)}
            className={TEXT_BTN}
          >
            {isElk(code) ? 'Layout: ELK' : 'Layout: Dagre'}
          </button>
          {layoutOpen && (
            <Popover
              anchorRef={layoutAnchor}
              onClose={() => setLayoutOpen(false)}
              role="menu"
              ariaLabel="Layout engine"
            >
              <MenuSurface width={160}>
                <MenuItem
                  label="Dagre"
                  checked={!isElk(code)}
                  onSelect={() => {
                    apply(setLayoutEngine(model, 'dagre'));
                    setLayoutOpen(false);
                  }}
                />
                <MenuItem
                  label="ELK"
                  checked={isElk(code)}
                  onSelect={() => {
                    apply(setLayoutEngine(model, 'elk'));
                    setLayoutOpen(false);
                  }}
                />
                <MenuSeparator />
                {/*
                  Below the separator because it is a different question: the
                  two above pick WHICH engine lays the diagram out, this one
                  says whether an engine gets to. Checked means auto-layout is
                  on; unchecking it hands geometry to the stored positions and
                  to dragging (M29.43, spec D7/D9). Unchecking never discards
                  them — toggling back on leaves every `%% cerebro:pos` line in
                  the file for the next time.
                */}
                <MenuItem
                  label="Auto-layout"
                  checked={!isManualLayout(model)}
                  onSelect={() => {
                    apply(setManualLayout(model, !isManualLayout(model)));
                    setLayoutOpen(false);
                  }}
                />
              </MenuSurface>
            </Popover>
          )}
        </>
      )}
      {onEditVisually !== null && (
        <button type="button" onClick={onEditVisually} className={TEXT_BTN}>
          Edit visually
        </button>
      )}
      <span className="flex-1" />
      <button type="button" onClick={onToggleShowCode} className={TEXT_BTN}>
        {showCode ? 'Hide code' : 'Show code'}
      </button>
      <span className="mx-0.5 h-4 w-px bg-n-100" />
      <Button
        variant="secondary"
        onClick={() => act('SVG copied', 'Copy SVG failed', (svg) => copySvg(svg))}
      >
        Copy SVG
      </Button>
      <Button
        variant="secondary"
        onClick={() => act('PNG copied', 'Copy PNG failed', (svg) => copyPng(svg))}
      >
        Copy PNG
      </Button>
      <Button
        variant="secondary"
        onClick={() => act('PNG saved', 'Save PNG failed', (svg) => savePng(svg, 'diagram.png'))}
      >
        Save PNG…
      </Button>
    </div>
  );
}
