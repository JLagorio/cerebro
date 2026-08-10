import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { Entry } from '@/engine/types';
import { useCanvasTransformRef } from '../CanvasViewport';
import { renderMermaid } from '../render';
import { neutralizeDiagramLinks } from '../svgLinks';
import { EdgeEditor } from './EdgeEditor';
import { GroupBar } from './GroupBar';
import { IconPicker } from './IconPicker';
import { LinkBadges, type LinkBadge } from './LinkBadges';
import { LinkPopover } from './LinkPopover';
import { applyManualLayout, beginManualLayout, type ManualLayoutSession } from './manualLayout';
import {
  isManualLayout,
  linkWriterLines,
  nodeLinks,
  nodeMeta,
  nodeStyle,
  nodes,
  parseFlowchart,
  serialize,
  storedPositions,
  subgraphs,
  type EdgeEntry,
} from './model';
import { NodeStyleMenu } from './NodeStyleMenu';
import {
  addEdge,
  addNode,
  deleteNode,
  renameNode,
  setDirection,
  setLayoutEngine,
  setNodeIcon,
  setNodeLink,
  setNodeShape,
  setNodeStyle,
} from './ops';
import { ShapePalette } from './ShapePalette';
import { SubgraphToolbar } from './SubgraphToolbar';
import { BRACKET_SHAPE_TO_REGISTRY, SHORT_NAME_FOR } from './shapes';
import { bindFlowchartSvg, NODE_GROUP_SELECTOR, type FlowchartSvgBinding } from './svgBinding';

const DIRECTIONS = ['TD', 'LR', 'BT', 'RL'] as const;

/** True when the source's YAML frontmatter pins mermaid's ELK layout engine. */
function isElk(code: string): boolean {
  return code.match(/^\s*layout:\s*elk\s*$/m) !== null;
}

/**
 * The structural editor (M29.17–.18): mermaid renders, we bind its SVG, and
 * every interaction becomes a surgical text edit flowing out through
 * onChangeCode — the same channel typing uses, so BlockNote history gives
 * undo/redo for free. The diagram re-lays-out after each edit; that is
 * mermaid's auto-layout nature, honestly embraced, not fought with hand
 * positions.
 */
export function StructuralEditor({
  code,
  onChangeCode,
  toolbar = true,
  entries,
  onOpenPath,
}: {
  code: string;
  onChangeCode: (code: string) => void;
  /**
   * The built-in control row. The full-screen editor passes false — its
   * DiagramToolbar owns those controls, and rendering both would be two
   * direction rows (M29.26).
   */
  toolbar?: boolean;
  /**
   * Vault entries for the link popover's record search (M29.38). This surface
   * has no store access by design — it is code in, code out — so the vault
   * arrives as a prop or not at all. Without it the popover is URL-only:
   * degradation, never a crash, because hosts without a vault exist.
   */
  entries?: Entry[];
  /** What a record badge click does — hosts pass useOpenPath('in-place'). */
  onOpenPath?: (path: string) => void;
}) {
  const model = useMemo(() => parseFlowchart(code), [code]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<FlowchartSvgBinding | null>(null);
  /** The live manual-layout measurement, null in auto mode (M29.42). */
  const manualRef = useRef<ManualLayoutSession | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [edgeEditor, setEdgeEditor] = useState<{ edge: EdgeEntry; value: string } | null>(null);
  const [shapeOpen, setShapeOpen] = useState(false);
  // The INSERT palette (M29.39), on the structural toolbar rather than the node
  // mini-toolbar — it mints a node instead of editing one, so it is deliberately
  // not part of that toolbar's mutual-close set. It does not need to be: it
  // anchors to its own trigger, so a press on any node-toolbar button is an
  // outside press by Popover's own reckoning and dismisses it (and vice versa).
  const [insertOpen, setInsertOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  // Cluster selection (M29.38) is held as a POSITION in subgraphs(model) — the
  // handle every subgraph op takes — not as an id: a generated `subGraph<k>`
  // id is a close-order ordinal that an edit elsewhere in the document can
  // silently re-key.
  const [selectedSub, setSelectedSub] = useState<number | null>(null);
  const [subToolbarPos, setSubToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [subTitle, setSubTitle] = useState('');
  const [multi, setMulti] = useState<string[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [badges, setBadges] = useState<LinkBadge[]>([]);
  const [ghost, setGhost] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );
  const dragFrom = useRef<string | null>(null);

  // Inside a CanvasViewport the host is scaled, and getBoundingClientRect
  // deltas are SCREEN px — dividing by the plane scale converts them to the
  // plane coordinates CSS absolute positioning uses in here. Outside any
  // viewport the context is the identity and this is a no-op (M29.26).
  //
  // The REF context, never useCanvasTransform(): the value context publishes a
  // fresh object per pan frame and per wheel tick, so consuming it re-rendered
  // this component once per frame for a value nothing here reads at render
  // time — and every one of those renders re-ran the deliberately
  // dep-array-less selection-sync effect below (a querySelectorAll plus two
  // style writes per bound node, per frame). Measured over 20 pan frames: 20
  // renders as a value consumer, 0 as a ref consumer. The handlers read the
  // scale when a gesture actually happens, which is the only time it matters.
  //
  // React.memo is NOT the alternative fix here. The scale's freshness was
  // parasitic on that per-frame re-render, so memoizing would freeze it at
  // mount and mis-place every overlay after a zoom — and jsdom rects are all
  // 0×0, so no unit test could ever catch that.
  const transformRef = useCanvasTransformRef();

  // A selection can outlive the node it points at — an external edit (undo,
  // another surface, a code-mode change) can delete the node between one
  // render and the next. `selected` itself is left alone (no setState here,
  // this is a plain render-time guard); every read that matters — the
  // toolbar's visibility and every op below — goes through this instead of
  // the raw state so a stale id can never resurrect a node that's gone.
  const validSelected =
    selected !== null && model !== null && nodes(model).has(selected) ? selected : null;

  // The block list every cluster control resolves against. Memoized on the
  // model because subgraphs() walks every line and three surfaces read it.
  const subs = useMemo(() => (model === null ? [] : subgraphs(model)), [model]);
  // Same staleness guard as validSelected, one level out: an external edit can
  // dissolve the block a toolbar is pointing at between two renders, and an
  // index past the end must not reach an op.
  const validSelectedSub = selectedSub !== null && selectedSub < subs.length ? selectedSub : null;
  const validMulti = useMemo(() => {
    if (model === null) return [];
    const known = nodes(model);
    return multi.filter((id) => known.has(id));
  }, [multi, model]);

  const apply = (next: ReturnType<typeof parseFlowchart>) => {
    if (next === null) return;
    const out = serialize(next);
    // An op that refused (an unknown shape, a shape the node already has)
    // returns the model unchanged, and pushing identical bytes back through
    // onChangeCode would still cost the user an undo step for a click that
    // moved nothing. Same reasoning as the edge-label editor's unchanged-value
    // check below — history churn is a real cost, not a cosmetic one.
    if (out === code) return;
    onChangeCode(out);
  };

  // Every popover keys off line/segment indices captured from a PAST render
  // of `code`. A code change — whether from an edit made here or from
  // outside (undo, code-mode, another surface) — can shift or delete those
  // indices, so any open popover closes the instant the source it was
  // reasoning about is no longer current. Normal open-after-click still
  // works: a click always happens after the render for the code it's
  // clicking on, never before. `validSelected` above already guards reads of
  // `selected` defensively; this clears the state outright too — belt and
  // suspenders.
  useEffect(() => {
    setEdgeEditor(null);
    setSelected(null);
    setToolbarPos(null);
    setShapeOpen(false);
    setInsertOpen(false);
    setStyleOpen(false);
    setIconOpen(false);
    setLinkOpen(false);
    setSelectedSub(null);
    setSubToolbarPos(null);
    setSubTitle('');
    setMulti([]);
    setGroupTitle('');
    // Badges are read off the OLD model and pinned to the OLD picture. Holding
    // them until the async re-render lands leaves a badge that can fire
    // onOpenPath with the target of a node this edit deleted — so they go with
    // the rest of the selection state and come back when the bind effect has
    // fresh geometry to place them by.
    setBadges([]);
  }, [code]);

  // Render, inject, and bind in one pass. The svg is written imperatively —
  // hostRef.current.innerHTML = r.svg — rather than through React's
  // dangerouslySetInnerHTML, and deliberately so: bindFlowchartSvg attaches
  // raw onclick/ondblclick/onpointerdown handlers straight onto mermaid's DOM
  // nodes below, and this component's own state changes (select, rename,
  // toolbar position, edge editor, drag ghost) re-render it constantly. A
  // React-managed subtree gets re-diffed on every one of those renders; an
  // imperatively-written one does not — React never looks at this subtree
  // again after the initial empty <div>, so a click can't clobber the very
  // handlers it just used. This effect only re-runs on [code, model], i.e. on
  // an actual diagram change, never on selection/rename/toolbar/edge state.
  useEffect(() => {
    let stale = false;
    void renderMermaid(code).then((r) => {
      if (stale || hostRef.current === null) return;
      if (!r.ok) return; // the block view surfaces errors; here we hold the last svg
      // Safe: mermaid runs at securityLevel 'strict' and sanitizes its output.
      hostRef.current.innerHTML = r.svg;
      // Before the model check, not after: `bindFlowchartSvg` strips mermaid's
      // own anchors, but the unparseable-header branch below returns without
      // ever binding — and that svg carries exactly the same live `href` a
      // click follows straight out of the SPA. Unreachable through today's two
      // hosts, which both gate on parseFlowchart(code) !== null, but it is a
      // hole the moment one mounts this editor ungated. Idempotent: the second
      // pass inside the binding finds nothing left to remove.
      neutralizeDiagramLinks(hostRef.current);
      if (model === null) return;
      const binding = bindFlowchartSvg(hostRef.current, model);
      bindingRef.current = binding;
      for (const [id, el] of binding.nodeEls) {
        el.style.cursor = 'pointer';
        el.onclick = (e) => {
          e.stopPropagation();
          // Shift-click builds a MULTI-selection (M29.38) and must not open the
          // single-node toolbar: the group bar is the surface for two or more
          // nodes, and two overlays claiming the same click is the state that
          // made M29.33's keystroke leak reachable.
          if (e.shiftKey) {
            setSelected(null);
            setToolbarPos(null);
            setEdgeEditor(null);
            setSelectedSub(null);
            setSubToolbarPos(null);
            setMulti((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
            return;
          }
          // A plain click is a fresh, single selection: it drops any pending
          // multi-selection and any cluster the toolbar was pointing at.
          setMulti([]);
          setSelectedSub(null);
          setSubToolbarPos(null);
          setSelected(id);
          // The mirror of the edge handler below, which has always cleared the
          // selection. Without it the two surfaces sat open at once — and the
          // edge editor's controls then had a live node selection to delete
          // when a keystroke leaked out of them (M29.33 review).
          setEdgeEditor(null);
          const host = hostRef.current;
          if (host !== null) {
            const hostBox = host.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            // Prefer floating above the node; when a top-row node leaves no
            // headroom, drop BELOW it instead. The old Math.max(0, y) clamp
            // parked the toolbar directly ON such a node — covering its
            // center, so the second click of a double-click rename landed on
            // toolbar buttons instead of the node (observed live, M29.19).
            const s = transformRef.current.scale;
            const above = (box.top - hostBox.top) / s - 34;
            const y = above >= 0 ? above : (box.bottom - hostBox.top) / s + 6;
            setToolbarPos({ x: (box.left - hostBox.left) / s, y });
          }
        };
        el.ondblclick = (e) => {
          e.stopPropagation();
          const label = nodes(model).get(id)?.label ?? id;
          setRenaming({ id, value: label });
        };
        // addEventListener, not `.onpointerdown =` — jsdom (no PointerEvent
        // support) never wires the onpointerdown IDL property up to actual
        // "pointerdown" dispatches, so an assignment there silently never
        // fires under test even though it works in a real browser.
        el.addEventListener('pointerdown', (e: PointerEvent) => {
          const host = hostRef.current;
          if (host === null) return;
          const hostBox = host.getBoundingClientRect();
          const s = transformRef.current.scale;
          dragFrom.current = id;
          setGhost({
            x1: (e.clientX - hostBox.left) / s,
            y1: (e.clientY - hostBox.top) / s,
            x2: (e.clientX - hostBox.left) / s,
            y2: (e.clientY - hostBox.top) / s,
          });
        });
      }

      // Clusters (M29.38). A click on a node inside a block cannot reach this
      // handler, for two independent reasons, and neither needs a target check:
      // MEASURED on the bundled 11.16.0 (subgraphs.mermaid.test.ts) node groups
      // are NOT descendants of their cluster — they sit in a sibling `g.nodes`
      // layer — and even where a layout engine did nest them, the node handler
      // above calls stopPropagation() before an ancestor ever hears the event.
      // A `closest('g.node')` guard stood here and could not fail; it is gone
      // rather than left as code that reads like it is protecting something.
      const blocks = subgraphs(model);
      for (const [sgId, el] of binding.clusterEls) {
        el.style.cursor = 'pointer';
        el.onclick = (e) => {
          e.stopPropagation();
          const idx = blocks.findIndex((s) => s.id === sgId);
          if (idx === -1) return;
          setSelected(null);
          setToolbarPos(null);
          setEdgeEditor(null);
          setMulti([]);
          setSelectedSub(idx);
          setSubTitle(blocks[idx].title);
          const host = hostRef.current;
          if (host !== null) {
            const hostBox = host.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            // Same scale conversion and same above/below flip as the node
            // toolbar: screen deltas become plane coordinates, and a block with
            // no headroom gets its controls underneath rather than on top of
            // its own title.
            const s = transformRef.current.scale;
            const above = (box.top - hostBox.top) / s - 34;
            const y = above >= 0 ? above : (box.bottom - hostBox.top) / s + 6;
            setSubToolbarPos({ x: (box.left - hostBox.left) / s, y });
          }
        };
      }

      // Manual layout (M29.42): after render + bind, take over geometry. This
      // is imperative work inside the React-free svg subtree, under exactly the
      // same rules as the handler wiring above. It runs BEFORE the badge block
      // below and not after it, because the badges are measured ONCE here off
      // getBoundingClientRect — placing them first would pin every badge to the
      // position mermaid's auto layout chose and leave them stranded there. The
      // session is kept so a drag can move a node without re-measuring.
      manualRef.current = null;
      const manualHost = hostRef.current;
      if (manualHost !== null && isManualLayout(model)) {
        const session = beginManualLayout(manualHost, binding);
        if (session !== null) {
          applyManualLayout(session, binding, storedPositions(model));
          manualRef.current = session;
        }
      }

      // Link badges (M29.38): one per node with an OWNED click line that the
      // binding could resolve. Computed HERE because this is the only place
      // with fresh geometry, in the same plane coordinates every other overlay
      // uses — so they scale with a CanvasViewport zoom instead of drifting off
      // their nodes. The badge, not the node, is the navigation hit target:
      // clicking a node selects it, which is why bindFlowchartSvg strips
      // mermaid's own `<a href>` off the picture.
      const badgeHost = hostRef.current;
      if (badgeHost !== null) {
        const hostBox = badgeHost.getBoundingClientRect();
        const s = transformRef.current.scale;
        const next: LinkBadge[] = [];
        for (const [nid, link] of nodeLinks(model)) {
          const nodeEl = binding.nodeEls.get(nid);
          if (nodeEl === undefined) continue;
          const box = nodeEl.getBoundingClientRect();
          next.push({
            id: nid,
            target: link.target,
            contested: link.contested,
            x: (box.right - hostBox.left) / s - 7,
            y: (box.top - hostBox.top) / s - 7,
          });
        }
        setBadges(next);
      }

      // Bound edge entries carry their own line/seg/from/to/label directly
      // (see svgBinding's docstring) — reused here as-is, never re-looked-up
      // through edges(model).find(...), which would reintroduce the very
      // duplicate-pair ambiguity the binding already resolved.
      for (const bound of binding.edgeEls) {
        bound.el.style.cursor = 'pointer';
        bound.el.onclick = (e) => {
          e.stopPropagation();
          setSelected(null);
          setToolbarPos(null);
          setEdgeEditor({ edge: bound, value: bound.label ?? '' });
        };
      }
    });
    return () => {
      stale = true;
    };
    // transformRef comes from context, so exhaustive-deps cannot see it is a
    // ref and asks for it by name. Harmless to give it: the provider's object
    // identity never changes (that is the entire point of the ref context), so
    // this effect still re-binds only on an actual diagram change — and if a
    // host ever DID swap providers, re-binding would be the correct answer.
  }, [code, model, transformRef]);

  // Window-level drag-to-connect: pointerdown on a node (above) starts it,
  // these two finish it. Registered once per model (i.e. per actual diagram
  // change), not per render, so ghost/selection churn during a drag can't
  // tear the listeners down mid-gesture.
  useEffect(() => {
    if (model === null) return;

    const onPointerMove = (e: PointerEvent) => {
      if (dragFrom.current === null) return;
      const host = hostRef.current;
      if (host === null) return;
      const hostBox = host.getBoundingClientRect();
      const s = transformRef.current.scale;
      setGhost((g) =>
        g === null
          ? null
          : { ...g, x2: (e.clientX - hostBox.left) / s, y2: (e.clientY - hostBox.top) / s },
      );
    };

    const onPointerUp = (e: PointerEvent) => {
      const from = dragFrom.current;
      dragFrom.current = null;
      setGhost(null);
      if (from === null) return;

      // elementFromPoint is unimplemented in plain jsdom (returns undefined,
      // not null) — every plain click also fires a pointerdown/pointerup
      // pair, so this must degrade to a no-op rather than throw when the
      // method isn't there at all.
      const target = document.elementFromPoint?.(e.clientX, e.clientY) ?? null;
      // The binding's own selector, shared rather than re-spelled: `id*=` and
      // not `id^=` because in a real browser mermaid namespaces the group id
      // with the render id (`cerebro-mermaid-3-flowchart-…` — see
      // svgBinding.ts), so a prefix match finds nothing live; and all three
      // classes because an ICON node is not a `g.node` (measured, M29.39).
      // A second spelling here is how dropping an edge ONTO an icon node
      // would silently mint a stray "New step" instead of connecting to it.
      // The id is only a coarse filter — the binding resolves the element by
      // identity below.
      const hitGroup = (target?.closest(NODE_GROUP_SELECTOR) as SVGGElement | null) ?? null;

      if (hitGroup !== null) {
        // Landed inside a node group — resolve it back to a model id and
        // connect, but never to itself: dropping back on the SAME node ends
        // the gesture as a no-op, not a self-edge, and never falls through
        // to the "empty canvas" branch below.
        const binding = bindingRef.current;
        if (binding === null) return;
        let hitId: string | null = null;
        for (const [mid, el] of binding.nodeEls) {
          if (el === hitGroup) {
            hitId = mid;
            break;
          }
        }
        if (hitId === null || hitId === from) return;
        apply(addEdge(model, from, hitId));
        return;
      }

      const host = hostRef.current;
      if (host !== null && target !== null && host.contains(target)) {
        // Dropped on empty canvas: spin up a fresh node and wire it in one
        // motion, same as the toolbar's "Add connected node".
        const added = addNode(model, 'New step');
        apply(addEdge(added.model, from, added.id));
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply closes over model/onChangeCode; re-registering per render would tear the listeners down mid-gesture.
  }, [model]);

  // Selection outline via inline stroke on the bound group's shapes. This
  // effect intentionally has no dependency array: it must resync the DOM
  // stroke every render (selection state, and the node elements themselves
  // after a re-bind above, can both change), and it neither subscribes to
  // nor unsubscribes from anything — it's plain DOM sync, not a real effect.
  useEffect(() => {
    const binding = bindingRef.current;
    if (binding === null) return;
    // A multi-selected node wears the same outline as a singly-selected one:
    // the group bar says how many are picked, but only the canvas can say WHICH.
    const outlined = new Set(validMulti);
    if (validSelected !== null) outlined.add(validSelected);
    for (const [id, el] of binding.nodeEls) {
      for (const shapeEl of el.querySelectorAll<SVGElement>('rect, circle, polygon, path')) {
        if (outlined.has(id)) {
          shapeEl.style.stroke = 'var(--cortex-500)';
          shapeEl.style.strokeWidth = '2.5px';
        } else {
          shapeEl.style.stroke = '';
          shapeEl.style.strokeWidth = '';
        }
      }
    }
  });

  if (model === null) {
    // Header unparseable: render-only + honest hint. Rendering never degrades.
    return (
      <div className="px-3 py-2">
        <div ref={hostRef} data-testid="structural-host" />
        <div className="mt-1 text-xs text-n-400">
          This diagram uses syntax the visual editor does not own — edit it as code.
        </div>
      </div>
    );
  }

  // Read only while the popover is open — nodeLinks walks every line, and this
  // renders on every selection and drag frame. `contested` has two readings
  // (see nodeLinks): an owned line someone else also writes over, or — when
  // there is no owned line at all — a node linked ONLY by a click form we do
  // not own, where "absent from the map" must not be shown as "unlinked".
  const openLink =
    linkOpen && validSelected !== null ? nodeLinks(model).get(validSelected) : undefined;
  const linkContested =
    linkOpen && validSelected !== null
      ? (openLink?.contested ?? linkWriterLines(model, validSelected).length > 0)
      : false;

  const commitRename = () => {
    if (renaming === null) return;
    apply(renameNode(model, renaming.id, renaming.value));
    setRenaming(null);
  };

  return (
    <div
      className="relative px-3 py-2"
      onClick={() => {
        setSelected(null);
        setToolbarPos(null);
        setMulti([]);
        setSelectedSub(null);
        setSubToolbarPos(null);
      }}
      onKeyDown={(e) => {
        if (
          (e.key === 'Delete' || e.key === 'Backspace') &&
          validSelected !== null &&
          renaming === null
        ) {
          apply(deleteNode(model, validSelected));
          setSelected(null);
          setToolbarPos(null);
        }
      }}
      tabIndex={-1}
    >
      {toolbar && (
        <div
          data-testid="structural-toolbar"
          className="mb-1.5 flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => apply(addNode(model, 'New step').model)}
            className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
          >
            + Node
          </button>
          {/*
            Its own wrapper, and that is what anchors the palette: Popover with
            no anchorRef measures the nearest positioned ancestor of where it
            was written, i.e. this span's parent — so writing the palette
            straight into the toolbar row would open it at the row's left edge,
            under `+ Node`, instead of under the button that opened it.
          */}
          <span className="relative">
            <button
              type="button"
              title="Insert a node with a shape"
              aria-haspopup="dialog"
              aria-expanded={insertOpen}
              // A toggle, unlike the node toolbar's four triggers: those close
              // each other and share one anchor, so re-pressing one is a
              // deliberate no-op. This one is alone, and Popover's click-away
              // counts a press on the anchor as inside — so without the toggle
              // the button could open the palette but never close it.
              onClick={() => setInsertOpen((open) => !open)}
              className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
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
                  // step (spec D10): the intermediate rectangle from `addNode`
                  // is never emitted, so Cmd+Z takes the whole insertion back
                  // instead of leaving a stray node of the wrong shape behind.
                  const added = addNode(model, 'New step');
                  apply(setNodeShape(added.model, added.id, name));
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
              className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
            >
              {d}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-n-100" />
          <button
            type="button"
            aria-label={isElk(code) ? 'Layout: ELK' : 'Layout: Dagre'}
            onClick={() => apply(setLayoutEngine(model, isElk(code) ? 'dagre' : 'elk'))}
            className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
          >
            {isElk(code) ? 'Layout: ELK' : 'Layout: Dagre'}
          </button>
        </div>
      )}

      {/*
        Own positioning context for the host: toolbarPos/ghost are measured
        against hostRef.getBoundingClientRect() (see the bind effect and the
        pointer handlers above), so every absolutely-positioned overlay that
        reads those coordinates must share hostRef's origin exactly. The
        outer container above adds a toolbar row and its own px-3/py-2
        padding — anchoring overlays there instead put them ~12px left and
        ~36px up from where the coordinates actually meant (M29.18 defect 3).
        This wrapper holds nothing but the host, so its box and the host's
        box coincide.
      */}
      <div className="relative">
        <div
          ref={hostRef}
          data-testid="structural-host"
          className="[&_svg]:h-auto [&_svg]:max-w-full"
        />

        {ghost !== null && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            <line
              // Real pointer events always carry clientX/Y; jsdom's fallback
              // (no PointerEvent constructor) does not, so this guards
              // against NaN reaching the DOM under test rather than trusting
              // the input.
              x1={Number.isFinite(ghost.x1) ? ghost.x1 : 0}
              y1={Number.isFinite(ghost.y1) ? ghost.y1 : 0}
              x2={Number.isFinite(ghost.x2) ? ghost.x2 : 0}
              y2={Number.isFinite(ghost.y2) ? ghost.y2 : 0}
              stroke="var(--cortex-500)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
          </svg>
        )}

        {validSelected !== null && toolbarPos !== null && renaming === null && (
          <div
            data-testid="mermaid-node-toolbar"
            className="absolute z-10 flex items-center gap-0.5 rounded-md border border-n-200 bg-n-0 px-1 py-0.5 shadow-sm"
            style={{ left: toolbarPos.x, top: toolbarPos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Change shape"
              title="Change shape"
              aria-haspopup="dialog"
              aria-expanded={shapeOpen}
              // Closing the sibling is this trigger's job, not the popover's:
              // Popover dismisses on an outside press, but its anchor is the
              // whole mini-toolbar, so a press on the button next door counts
              // as inside and both surfaces stayed open on top of each other.
              onClick={() => {
                setStyleOpen(false);
                setIconOpen(false);
                setLinkOpen(false);
                setShapeOpen(true);
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="shapes" size={13} color="var(--n-600)" />
            </button>
            {shapeOpen && (
              <ShapePalette
                current={(() => {
                  // What the node ACTUALLY renders as: a meta shape wins over
                  // the brackets, which is the same precedence setNodeShape
                  // writes by. A meta shape spelled as an alias resolves to its
                  // short name so the right button lights up; one we do not
                  // know marks NOTHING rather than falling back to the
                  // brackets, which would point at a shape that isn't drawn.
                  const resolved = nodes(model).get(validSelected);
                  if (resolved === undefined) return null;
                  if (resolved.metaShape !== undefined) {
                    return SHORT_NAME_FOR[resolved.metaShape] ?? null;
                  }
                  return BRACKET_SHAPE_TO_REGISTRY[resolved.shape];
                })()}
                // Render precedence is img > icon > shape (MEASURED,
                // icons.mermaid.test.ts), so a node carrying an icon draws the
                // icon and its shape never appears. The pick is LATENT, not
                // dead — it applies the moment the icon goes — so nothing is
                // refused here; the palette just stops pretending the shape it
                // lights up is the one on screen.
                supersededByIcon={nodeMeta(model).get(validSelected)?.icon ?? null}
                onPick={(name) => {
                  setShapeOpen(false);
                  apply(setNodeShape(model, validSelected, name));
                }}
                onClose={() => setShapeOpen(false)}
              />
            )}
            <button
              type="button"
              aria-label="Node colors"
              title="Node colors"
              aria-haspopup="dialog"
              aria-expanded={styleOpen}
              onClick={() => {
                setShapeOpen(false);
                setIconOpen(false);
                setLinkOpen(false);
                setStyleOpen(true);
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="palette" size={13} color="var(--n-600)" />
            </button>
            {styleOpen && (
              <NodeStyleMenu
                // The FOLDED reading of every style line for this node, which
                // is what mermaid renders — and what setNodeStyle writes back
                // onto. A node coloured through classDef reads as {} here (a
                // known gap: classDef stays opaque this wave, spec D5), so it
                // shows as unstyled rather than as some colour it is not.
                current={validSelected !== null ? nodeStyle(model, validSelected) : {}}
                onPatch={(patch) => {
                  setStyleOpen(false);
                  if (validSelected !== null) apply(setNodeStyle(model, validSelected, patch));
                }}
                onClose={() => setStyleOpen(false)}
              />
            )}
            <button
              type="button"
              aria-label="Node icon"
              title="Node icon"
              aria-haspopup="dialog"
              aria-expanded={iconOpen}
              onClick={() => {
                setShapeOpen(false);
                setStyleOpen(false);
                setLinkOpen(false);
                setIconOpen(true);
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="sparkles" size={13} color="var(--n-600)" />
            </button>
            {iconOpen && (
              <IconPicker
                // The FOLDED reading of every meta line for this node, which is
                // what mermaid renders: several `A@{ … }` lines settle per key
                // with the last value winning (measured, icons.mermaid.test.ts),
                // so reading the first would mark an icon the diagram does not
                // show — and setNodeIcon writes to the same line this reads.
                current={nodeMeta(model).get(validSelected)?.icon ?? null}
                onPick={(icon) => {
                  setIconOpen(false);
                  apply(setNodeIcon(model, validSelected, icon));
                }}
                onClose={() => setIconOpen(false)}
              />
            )}
            <button
              type="button"
              aria-label="Node link"
              title="Node link"
              aria-haspopup="dialog"
              aria-expanded={linkOpen}
              onClick={() => {
                setShapeOpen(false);
                setStyleOpen(false);
                setIconOpen(false);
                setLinkOpen(true);
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="link" size={13} color="var(--n-600)" />
            </button>
            {linkOpen && (
              <LinkPopover
                entries={entries}
                current={openLink?.target ?? null}
                contested={linkContested}
                onPick={(target) => {
                  setLinkOpen(false);
                  apply(setNodeLink(model, validSelected, target));
                }}
                onClose={() => setLinkOpen(false)}
              />
            )}
            <span className="mx-0.5 h-4 w-px bg-n-100" />
            <button
              type="button"
              aria-label="Add connected node"
              onClick={() => {
                if (validSelected === null) return;
                const added = addNode(model, 'New step');
                apply(addEdge(added.model, validSelected, added.id));
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
            >
              <Icon name="plus" size={13} color="var(--n-600)" />
            </button>
            <button
              type="button"
              aria-label="Delete node"
              onClick={() => {
                if (validSelected === null) return;
                apply(deleteNode(model, validSelected));
                setSelected(null);
                setToolbarPos(null);
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-danger-50"
            >
              <Icon name="trash-2" size={13} color="var(--danger-600)" />
            </button>
          </div>
        )}

        {renaming !== null && (
          <input
            autoFocus
            aria-label="Node label"
            value={renaming.value}
            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(null);
            }}
            className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border border-cortex-500 bg-n-0 px-2 py-1 text-sm text-n-800 shadow-sm outline-none"
          />
        )}

        <LinkBadges badges={badges} onOpenPath={onOpenPath} />

        {validSelectedSub !== null && subToolbarPos !== null && (
          <SubgraphToolbar
            model={model}
            index={validSelectedSub}
            pos={subToolbarPos}
            title={subTitle}
            onChangeTitle={setSubTitle}
            apply={apply}
            onClose={() => {
              setSelectedSub(null);
              setSubToolbarPos(null);
            }}
          />
        )}

        {validMulti.length >= 2 && (
          <GroupBar
            model={model}
            ids={validMulti}
            title={groupTitle}
            onChangeTitle={setGroupTitle}
            apply={apply}
            onGrouped={() => {
              setMulti([]);
              setGroupTitle('');
            }}
          />
        )}

        {edgeEditor !== null && (
          <EdgeEditor
            edgeEditor={edgeEditor}
            model={model}
            apply={apply}
            onChangeValue={(value) => setEdgeEditor({ ...edgeEditor, value })}
            onClose={() => setEdgeEditor(null)}
          />
        )}
      </div>
    </div>
  );
}
