import { Icon } from '@/components/ui/Icon';
import { describeViewProblem, type ViewProblem } from '@/engine/viewCheck';

/** How many problems the strip names before it counts the rest. */
export const MAX_SHOWN_PROBLEMS = 5;

/**
 * What a view names that it can't apply (M60.2b), above its canvas.
 *
 * A filter on a field nobody declares, an option the type retired or an
 * operator the field's kind can't take draws an empty canvas, which reads as
 * "nothing matches" when the truth is "this view can't be applied". So the
 * strip says which, one line per problem, in words. It renders nothing for a
 * clean view.
 */
export function ViewProblems({
  problems,
  source,
}: {
  problems: readonly ViewProblem[];
  /** The view's type, or null when it is typeless. */
  source: string | null;
}) {
  if (problems.length === 0) return null;
  const shown = problems.slice(0, MAX_SHOWN_PROBLEMS);
  const more = problems.length - shown.length;
  return (
    <div
      data-testid="view-problems"
      role="status"
      className="flex flex-none items-start gap-2 border-b border-n-200 px-5 py-1.5 text-xs text-warn-600"
    >
      <span className="mt-px inline-flex flex-none text-warn-500">
        <Icon name="triangle-alert" size={13} />
      </span>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
        {shown.map((p, i) => (
          <li key={i} data-testid="view-problem" data-problem={p.code}>
            {describeViewProblem(p, source)}
          </li>
        ))}
        {more > 0 && <li className="text-n-500">and {more} more</li>}
      </ul>
    </div>
  );
}
