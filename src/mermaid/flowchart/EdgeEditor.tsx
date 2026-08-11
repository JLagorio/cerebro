import { Icon } from '@/components/ui/Icon';
import { edgeAnimated, type EdgeEntry, type EdgeHead, type FlowchartModel } from './model';
import { canAnimateEdge, deleteEdge, setEdgeAnimate, setEdgeArrow, setEdgeLabel } from './ops';

/**
 * The head cycle (M29.33). `invisible` is a STROKE, not a head, and neither
 * control offers it: entering it from the canvas is a ONE-WAY DOOR. Measured on
 * the bundled 11.16.0 — a `~~~` link does render a path, but its classes are
 * `edge-thickness-invisible edge-pattern-solid` with no `flowchart-link`, which
 * is exactly the selector `svgBinding` matches on, so the edge stops being
 * clickable and nothing on screen could bring it back. Code mode still writes
 * it, and the model still reads it.
 */
const HEAD_CYCLE: EdgeHead[] = ['arrow', 'open', 'circle', 'cross', 'double'];
const HEAD_LABEL: Record<EdgeHead, string> = {
  arrow: 'Arrow',
  open: 'None',
  circle: 'Circle',
  cross: 'Cross',
  double: 'Both ways',
};
const STROKES = ['normal', 'thick', 'dotted'] as const;
const STROKE_LABEL: Record<(typeof STROKES)[number], string> = {
  normal: 'Solid',
  thick: 'Thick',
  dotted: 'Dotted',
};

/**
 * The edge editor overlay (M29.37): the surface an edge click opens — label,
 * arrow head, stroke, animate, delete. Lifted out of StructuralEditor verbatim
 * so that file stays readable as more overlays land on it; the state still
 * lives up there, and this renders it. Absolutely positioned against the host
 * wrapper, so it must stay inside that positioning context.
 */
export function EdgeEditor({
  edgeEditor,
  model,
  apply,
  onChangeValue,
  onClose,
}: {
  /** The open editor's state — the bound edge entry and the in-flight label. */
  edgeEditor: { edge: EdgeEntry; value: string };
  model: FlowchartModel;
  /** StructuralEditor's serialize-and-emit channel, with its unchanged-bytes guard. */
  apply: (next: FlowchartModel | null) => void;
  onChangeValue: (value: string) => void;
  onClose: () => void;
}) {
  // Read ONCE per render, not once per use: edgeAnimated rebuilds the whole
  // edgeMeta map (O(lines)) on every call, and the controls row below needs
  // the answer twice — for the pressed state and for the toggle's target.
  const edgeIsAnimated = edgeAnimated(model, edgeEditor.edge);
  // Whether this expansion could carry an id at all — the same predicate
  // setEdgeAnimate refuses by, read here so the control can say so up front.
  const edgeCanAnimate = canAnimateEdge(model, edgeEditor.edge);

  return (
    <div
      data-testid="mermaid-edge-editor"
      // On a CanvasViewport this bar renders as a child of the viewport, not
      // of the transformed plane (M29.51) — so `left-1/2` centres it on the
      // SCREEN, and a press on its own padding must not start a pan.
      data-no-pan
      className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 flex-col gap-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 shadow-sm"
      onClick={(e) => e.stopPropagation()}
      // Same guard the two node popovers carry, and the one this editor
      // never had: its label input stopped its OWN keys, but Backspace on
      // any of the buttons travelled up to this component's onKeyDown and
      // deleted the selected node. `Delete edge` leaked that way long
      // before these controls joined it.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        <input
          autoFocus
          aria-label="Edge label"
          value={edgeEditor.value}
          placeholder="label"
          onChange={(e) => onChangeValue(e.target.value)}
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
              onClose();
            }
            if (e.key === 'Escape') onClose();
          }}
          className="w-32 rounded border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-800 outline-none"
        />
        <button
          type="button"
          aria-label="Delete edge"
          onClick={() => {
            apply(deleteEdge(model, edgeEditor.edge));
            onClose();
          }}
          className="rounded border-0 bg-transparent p-1 hover:bg-danger-50"
        >
          <Icon name="trash-2" size={13} color="var(--danger-600)" />
        </button>
      </div>
      <div className="flex items-center gap-1">
        {/* One button, five heads: a cycle rather than five controls,
            because the arrow head is one property with one current
            value — and the label names that value, so the button reads
            as the state it is in, not as a guess about the next one. */}
        <button
          type="button"
          aria-label={`Arrow head: ${HEAD_LABEL[edgeEditor.edge.arrow.head]}`}
          title="Cycle arrow head"
          onClick={() => {
            const cur = edgeEditor.edge.arrow.head;
            const next = HEAD_CYCLE[(HEAD_CYCLE.indexOf(cur) + 1) % HEAD_CYCLE.length];
            apply(setEdgeArrow(model, edgeEditor.edge, { head: next }));
            onClose();
          }}
          className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-600 hover:bg-n-50"
        >
          {HEAD_LABEL[edgeEditor.edge.arrow.head]}
        </button>
        {/* A stroke or head belongs to the SEGMENT, so on `A & Z --> B`
            or a chain both expansions change together — that is what the
            mermaid text can express, no more, and the same scope
            setEdgeLabel has always had. Only `animate` is per-edge, which
            is why it is the one control that can go dead below. */}
        {STROKES.map((s) => (
          <button
            key={s}
            type="button"
            aria-label={`Stroke ${STROKE_LABEL[s].toLowerCase()}`}
            aria-pressed={edgeEditor.edge.arrow.stroke === s}
            onClick={() => {
              // Re-picking the stroke the edge already has changes
              // nothing on screen, and setEdgeArrow would still
              // normalize the token — silently shortening an author's
              // `---->` and costing an undo step for a click that moved
              // nothing. (apply's byte guard only catches this when the
              // line was already canonical.)
              if (edgeEditor.edge.arrow.stroke !== s) {
                apply(setEdgeArrow(model, edgeEditor.edge, { stroke: s }));
              }
              onClose();
            }}
            className={`rounded-md border border-n-200 px-1.5 py-0.5 text-xs hover:bg-n-50 ${
              edgeEditor.edge.arrow.stroke === s ? 'bg-n-50 text-n-800' : 'bg-n-0 text-n-600'
            }`}
          >
            {STROKE_LABEL[s]}
          </button>
        ))}
        <button
          type="button"
          aria-label="Animate edge"
          aria-pressed={edgeIsAnimated}
          // Animation rides an edge id, and a segment spells exactly one
          // — so on an & group every expansion but last-from × first-to
          // has nowhere to hang it and setEdgeAnimate refuses. Saying so
          // beats swallowing the click: an enabled button that closes the
          // popover and changes nothing reads as broken, not as refused.
          disabled={!edgeCanAnimate}
          title={
            edgeCanAnimate
              ? 'Animate edge'
              : 'Only one edge of an & group can be animated — split the line to animate this one'
          }
          onClick={() => {
            apply(setEdgeAnimate(model, edgeEditor.edge, !edgeIsAnimated));
            onClose();
          }}
          className="rounded border-0 bg-transparent p-1 hover:bg-n-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="play" size={13} color="var(--n-600)" />
        </button>
      </div>
    </div>
  );
}
