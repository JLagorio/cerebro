import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { renderMermaid } from '../render';
import { nodes, parseFlowchart, serialize, type Shape } from './model';
import { addEdge, addNode, deleteNode, renameNode, setNodeShape } from './ops';
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

/**
 * The structural editor (M29.17): mermaid renders, we bind its SVG, and every
 * interaction becomes a surgical text edit flowing out through onChangeCode —
 * the same channel typing uses, so BlockNote history gives undo/redo for free.
 * The diagram re-lays-out after each edit; that is mermaid's auto-layout
 * nature, honestly embraced, not fought with hand positions.
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

  // Render, inject, and bind in one pass. The svg is written imperatively —
  // hostRef.current.innerHTML = r.svg — rather than through React's
  // dangerouslySetInnerHTML, and deliberately so: bindFlowchartSvg attaches
  // raw onclick/ondblclick handlers straight onto mermaid's DOM nodes below,
  // and this component's own state changes (select, rename, toolbar
  // position) re-render it constantly. A React-managed subtree gets
  // re-diffed on every one of those renders; an imperatively-written one
  // does not — React never looks at this subtree again after the initial
  // empty <div>, so a click can't clobber the very handlers it just used.
  // This effect only re-runs on [code, model], i.e. on an actual diagram
  // change, never on selection/rename/toolbar state.
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
      }
    });
    return () => {
      stale = true;
    };
  }, [code, model]);

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
        ref={hostRef}
        data-testid="structural-host"
        className="[&_svg]:h-auto [&_svg]:max-w-full"
      />

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
    </div>
  );
}
