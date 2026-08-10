import type { FlowchartModel } from './model';
import { canCreateSubgraph, createSubgraph, SUBGRAPH_REFUSAL_TEXT } from './ops';

/** The title a group takes when the box is left empty. */
const DEFAULT_TITLE = 'Group';

/** The one element the refusal text is announced through — one bar at a time. */
const REFUSAL_ID = 'mermaid-group-refusal';

/**
 * The bar a MULTI-SELECTION raises (M29.38): name the block, group into it.
 *
 * `createSubgraph` refuses a selection mermaid cannot express — a node already
 * inside another block, a line the wrap would have to move out of one, a
 * document whose markers do not pair up. Without a signal those are a button
 * that swallows the click and moves nothing, which reads as broken rather than
 * as refused, so the predicate is asked up front and its answer is both the
 * disabled state and the sentence next to it.
 */
export function GroupBar({
  model,
  ids,
  title,
  onChangeTitle,
  apply,
  onGrouped,
}: {
  model: FlowchartModel;
  /** The multi-selected node ids, in click order. */
  ids: string[];
  title: string;
  onChangeTitle: (title: string) => void;
  /** StructuralEditor's serialize-and-emit channel, with its unchanged-bytes guard. */
  apply: (next: FlowchartModel | null) => void;
  onGrouped: () => void;
}) {
  // The title the OP will actually see, so the predicate answers the question
  // the button asks. Anything else and an empty box would read as a blank-title
  // refusal for a group that would have landed fine.
  const effective = title.trim() === '' ? DEFAULT_TITLE : title.trim();
  const refusal = canCreateSubgraph(model, ids, effective);

  const group = (): void => {
    if (refusal !== null) return;
    const created = createSubgraph(model, ids, effective);
    if (created.id === null) return; // unreachable: the predicate just agreed
    apply(created.model);
    onGrouped();
  };

  return (
    <div
      data-testid="mermaid-group-bar"
      className="absolute left-1/2 top-2 z-10 flex max-w-[22rem] -translate-x-1/2 flex-col gap-1 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 shadow-sm"
      onClick={(e) => e.stopPropagation()}
      // Backspace on any control in here would otherwise reach the editor's own
      // onKeyDown and delete the selected node (the M29.33 leak).
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1">
        <span className="text-xs text-n-500">{ids.length} selected</span>
        <input
          aria-label="New subgraph title"
          aria-describedby={refusal !== null ? REFUSAL_ID : undefined}
          value={title}
          placeholder={DEFAULT_TITLE}
          onChange={(e) => onChangeTitle(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') group();
          }}
          className="w-28 rounded border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-800 outline-none"
        />
        <button
          type="button"
          aria-label="Group into subgraph"
          disabled={refusal !== null}
          title={refusal !== null ? SUBGRAPH_REFUSAL_TEXT[refusal] : 'Group into subgraph'}
          onClick={group}
          className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-xs text-n-700 hover:bg-n-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Group into subgraph
        </button>
      </div>
      {refusal !== null && (
        <div id={REFUSAL_ID} className="text-2xs leading-snug text-danger-700">
          {SUBGRAPH_REFUSAL_TEXT[refusal]}
        </div>
      )}
    </div>
  );
}
