import type { ChoiceView } from './MarkdownEditor';

/** Previews stop here: a row says which part, not all of it. */
const PREVIEW_CHARS = 200;

const cut = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === '') return '(removed)';
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}…` : trimmed;
};

/** Bring the block a choice is about into view. */
function show(blockId: string | null): void {
  if (blockId === null) return;
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(blockId) : blockId;
  document
    .querySelector(`.bn-block[data-id="${escaped}"]`)
    ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
}

/**
 * The places an outside write and unsaved typing disagree (M55.6), above the
 * page. Everything else of the write has already landed in place; here mine
 * stays until the person picks, and nothing saves until every row is settled.
 */
export function MergeChoices({
  choices,
  onPick,
}: {
  choices: readonly ChoiceView[];
  onPick: (id: string, pick: 'mine' | 'theirs') => void;
}) {
  if (choices.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Choose a version"
      data-testid="merge-choices"
      className="mx-1 mb-2 flex flex-col gap-2 rounded-lg border border-warn-500 bg-warn-50 px-3 py-2 text-sm text-warn-700"
    >
      <p className="m-0">
        This page changed while you were editing. Where you both changed the same part, choose which
        to keep. Nothing saves until you do.
      </p>
      {choices.map((choice) => (
        <div
          key={choice.id}
          data-testid="merge-choice"
          className="flex flex-col gap-1 rounded-md border border-warn-300 bg-n-0 px-2 py-1.5"
        >
          <div className="grid gap-1 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-xs font-medium">Yours</div>
              <div className="whitespace-pre-wrap break-words text-n-700">{cut(choice.mine)}</div>
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium">New</div>
              <div className="whitespace-pre-wrap break-words text-n-700">{cut(choice.theirs)}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="merge-keep-mine"
              onClick={() => onPick(choice.id, 'mine')}
              className="flex-none rounded-md border border-warn-500 bg-transparent px-2 py-0.5 text-xs font-medium text-warn-700 hover:bg-warn-500 hover:text-n-0"
            >
              Keep yours
            </button>
            <button
              type="button"
              data-testid="merge-take-theirs"
              onClick={() => onPick(choice.id, 'theirs')}
              className="flex-none rounded-md border border-warn-500 bg-transparent px-2 py-0.5 text-xs font-medium text-warn-700 hover:bg-warn-500 hover:text-n-0"
            >
              Use new
            </button>
            {choice.firstBlockId !== null && (
              <button
                type="button"
                data-testid="merge-show"
                onClick={() => show(choice.firstBlockId)}
                className="flex-none rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-warn-700 underline"
              >
                Show
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
