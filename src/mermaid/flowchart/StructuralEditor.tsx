import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { renderMermaid } from '../render';
import { nodes, parseFlowchart, serialize, type EdgeEntry, type Shape } from './model';
import {
  addEdge,
  addNode,
  deleteEdge,
  deleteNode,
  renameNode,
  setDirection,
  setEdgeLabel,
  setLayoutEngine,
  setNodeShape,
} from './ops';
import { bindFlowchartSvg, type FlowchartSvgBinding } from './svgBinding';

const SHAPE_CHOICES: { shape: Shape; label: string; icon: string }[] = [
  { shape: 'rect', label: 'Rectangle', icon: 'square' },
  { shape: 'rounded', label: 'Rounded', icon: 'square-round-corner' },
  { shape: 'stadium', label: 'Stadium', icon: 'rectangle-horizontal' },
  { shape: 'diamond', label: 'Decision', icon: 'diamond' },
  { shape: 'circle', label: 'Circle', icon: 'circle' },
  { shape: 'cylinder', label: 'Database', icon: 'database' },
  { shape: 'hexagon', label: 'Hexagon', icon: 'hexagon' },
  { shape: 'subroutine', label: 'Subroutine', icon: 'square-stack' },
];

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
}: {
  code: string;
  onChangeCode: (code: string) => void;
}) {
  const model = useMemo(() => parseFlowchart(code), [code]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<FlowchartSvgBinding | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [edgeEditor, setEdgeEditor] = useState<{ edge: EdgeEntry; value: string } | null>(null);
  const [ghost, setGhost] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );
  const dragFrom = useRef<string | null>(null);

  // A selection can outlive the node it points at — an external edit (undo,
  // another surface, a code-mode change) can delete the node between one
  // render and the next. `selected` itself is left alone (no setState here,
  // this is a plain render-time guard); every read that matters — the
  // toolbar's visibility and every op below — goes through this instead of
  // the raw state so a stale id can never resurrect a node that's gone.
  const validSelected =
    selected !== null && model !== null && nodes(model).has(selected) ? selected : null;

  const apply = (next: ReturnType<typeof parseFlowchart>) => {
    if (next !== null) onChangeCode(serialize(next));
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
      if (model === null) return;
      const binding = bindFlowchartSvg(hostRef.current, model);
      bindingRef.current = binding;
      for (const [id, el] of binding.nodeEls) {
        el.style.cursor = 'pointer';
        el.onclick = (e) => {
          e.stopPropagation();
          setSelected(id);
          const host = hostRef.current;
          if (host !== null) {
            const hostBox = host.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            setToolbarPos({ x: box.left - hostBox.left, y: box.top - hostBox.top - 34 });
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
          dragFrom.current = id;
          setGhost({
            x1: e.clientX - hostBox.left,
            y1: e.clientY - hostBox.top,
            x2: e.clientX - hostBox.left,
            y2: e.clientY - hostBox.top,
          });
        });
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
  }, [code, model]);

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
      setGhost((g) =>
        g === null ? null : { ...g, x2: e.clientX - hostBox.left, y2: e.clientY - hostBox.top },
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
      const hitGroup =
        (target?.closest('g.node[id^="flowchart-"]') as SVGGElement | null) ?? null;

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
    for (const [id, el] of binding.nodeEls) {
      for (const shapeEl of el.querySelectorAll<SVGElement>('rect, circle, polygon, path')) {
        if (id === validSelected) {
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
            style={{ left: toolbarPos.x, top: Math.max(0, toolbarPos.y) }}
            onClick={(e) => e.stopPropagation()}
          >
            {SHAPE_CHOICES.map((c) => (
              <button
                key={c.shape}
                type="button"
                title={c.label}
                aria-label={`Shape: ${c.label}`}
                onClick={() => {
                  if (validSelected === null) return;
                  apply(setNodeShape(model, validSelected, c.shape));
                }}
                className="rounded border-0 bg-transparent p-1 hover:bg-n-50"
              >
                <Icon name={c.icon} size={13} color="var(--n-600)" />
              </button>
            ))}
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

        {edgeEditor !== null && (
          <div
            className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              aria-label="Edge label"
              value={edgeEditor.value}
              placeholder="label"
              onChange={(e) => setEdgeEditor({ ...edgeEditor, value: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  // No-op on an unchanged label: skip the apply so hitting
                  // Enter without editing anything doesn't churn history.
                  if (edgeEditor.value !== (edgeEditor.edge.label ?? '')) {
                    apply(
                      setEdgeLabel(
                        model,
                        edgeEditor.edge,
                        edgeEditor.value.trim() === '' ? null : edgeEditor.value,
                      ),
                    );
                  }
                  setEdgeEditor(null);
                }
                if (e.key === 'Escape') setEdgeEditor(null);
              }}
              className="w-32 rounded border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-800 outline-none"
            />
            <button
              type="button"
              aria-label="Delete edge"
              onClick={() => {
                apply(deleteEdge(model, edgeEditor.edge));
                setEdgeEditor(null);
              }}
              className="rounded border-0 bg-transparent p-1 hover:bg-danger-50"
            >
              <Icon name="trash-2" size={13} color="var(--danger-600)" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
