import { Icon } from '@/components/ui/Icon';
import { type Direction, type FlowchartModel, subgraphs } from './model';
import {
  canDissolveSubgraph,
  canRenameSubgraph,
  canSetSubgraphDirection,
  dissolveSubgraph,
  renameSubgraph,
  setSubgraphDirection,
  SUBGRAPH_REFUSAL_TEXT,
} from './ops';

const DIRECTIONS: Direction[] = ['TD', 'LR', 'BT', 'RL'];

/** The one element the refusal text is announced through — one toolbar at a time. */
const REFUSAL_ID = 'mermaid-subgraph-refusal';

/**
 * The surface a CLUSTER click opens (M29.38): retitle, per-block direction,
 * ungroup. Absolutely positioned against the host wrapper, so it must stay
 * inside that positioning context — the same contract EdgeEditor holds.
 *
 * Every control asks its `can*` predicate FIRST and, when the answer is a
 * refusal, goes disabled WITH the reason attached rather than firing an op
 * that returns the model unchanged. A control that swallows a click and moves
 * nothing reads as broken, not as refused — the dead-button defect class this
 * wave has closed three times, and the reason F3 typed these refusals at all.
 */
export function SubgraphToolbar({
  model,
  index,
  pos,
  title,
  onChangeTitle,
  apply,
  onClose,
}: {
  model: FlowchartModel;
  /** Position in `subgraphs(model)` — the handle every subgraph op takes. */
  index: number;
  /** Host-relative plane coordinates, already divided by the canvas scale. */
  pos: { x: number; y: number };
  /** The in-flight title being typed. */
  title: string;
  onChangeTitle: (title: string) => void;
  /** StructuralEditor's serialize-and-emit channel, with its unchanged-bytes guard. */
  apply: (next: FlowchartModel | null) => void;
  onClose: () => void;
}) {
  const entry = subgraphs(model)[index];
  const renameRefusal = canRenameSubgraph(model, index, title);
  const dissolveRefusal = canDissolveSubgraph(model, index);
  const directionRefusal = canSetSubgraphDirection(model, index);
  // A retitle that would land on the title already there is not a refusal, but
  // it IS a no-op — and `renameSubgraph` re-emits the opener, which reformats a
  // hand-written bare block into the explicit form for a click that moved
  // nothing. apply's byte guard only catches it when the line was already
  // canonical, so the guard belongs here too.
  const renameIsNoop = entry !== undefined && title === entry.title;

  const commitRename = (): void => {
    if (renameRefusal !== null || renameIsNoop) return;
    apply(renameSubgraph(model, index, title));
  };

  const setDirection = (dir: Direction | null): void => {
    if (directionRefusal !== null || entry === undefined) return;
    // Same no-op rule: the direction on screen is already this one, and
    // rewriting the line would cost an undo step for nothing.
    if (entry.direction === dir) return;
    apply(setSubgraphDirection(model, index, dir));
  };

  return (
    <div
      data-testid="mermaid-subgraph-toolbar"
      className="absolute z-10 flex flex-col gap-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 shadow-sm"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      // Backspace on any control in here would otherwise reach the editor's own
      // onKeyDown and delete the SELECTED NODE — the leak M29.33 measured on
      // the edge editor, which this surface would have reintroduced.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        <input
          aria-label="Subgraph title"
          aria-invalid={renameRefusal !== null}
          aria-describedby={renameRefusal !== null ? REFUSAL_ID : undefined}
          value={title}
          onChange={(e) => onChangeTitle(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') onClose();
          }}
          className="w-28 rounded border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-800 outline-none"
        />
        {DIRECTIONS.map((d) => (
          <button
            key={d}
            type="button"
            aria-label={`Subgraph direction ${d}`}
            aria-pressed={entry?.direction === d}
            disabled={directionRefusal !== null}
            title={
              directionRefusal !== null ? SUBGRAPH_REFUSAL_TEXT[directionRefusal] : `Direction ${d}`
            }
            onClick={() => setDirection(d)}
            className={`rounded border-0 px-1 py-0.5 text-xs hover:bg-n-50 disabled:cursor-not-allowed disabled:opacity-40 ${
              entry?.direction === d ? 'bg-cortex-50 text-n-800' : 'bg-transparent text-n-600'
            }`}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          aria-label="Subgraph direction auto"
          aria-pressed={entry !== undefined && entry.direction === null}
          disabled={directionRefusal !== null}
          title={
            directionRefusal !== null
              ? SUBGRAPH_REFUSAL_TEXT[directionRefusal]
              : "Follow the diagram's own direction"
          }
          onClick={() => setDirection(null)}
          className={`rounded border-0 px-1 py-0.5 text-xs hover:bg-n-50 disabled:cursor-not-allowed disabled:opacity-40 ${
            entry !== undefined && entry.direction === null
              ? 'bg-cortex-50 text-n-800'
              : 'bg-transparent text-n-600'
          }`}
        >
          Auto
        </button>
        <span className="mx-0.5 h-4 w-px bg-n-100" />
        <button
          type="button"
          aria-label="Dissolve subgraph"
          disabled={dissolveRefusal !== null}
          title={
            dissolveRefusal !== null
              ? SUBGRAPH_REFUSAL_TEXT[dissolveRefusal]
              : 'Ungroup — the nodes stay, the block goes'
          }
          onClick={() => {
            if (dissolveRefusal !== null) return;
            apply(dissolveSubgraph(model, index));
            onClose();
          }}
          className="rounded border-0 bg-transparent p-1 hover:bg-danger-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="ungroup" size={13} color="var(--danger-600)" />
        </button>
      </div>
      {/* A disabled control that does not say why is only half a fix. The
          dissolve button carries its reason in a tooltip; a REFUSED RENAME has
          no control to hang one on — Enter simply would not commit — so it
          says so in place, and the box points at it through aria-describedby. */}
      {renameRefusal !== null && (
        <div id={REFUSAL_ID} className="max-w-[18rem] text-2xs leading-snug text-danger-700">
          {SUBGRAPH_REFUSAL_TEXT[renameRefusal]}
        </div>
      )}
    </div>
  );
}
