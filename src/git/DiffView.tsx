import { useMemo } from 'react';
import { diffStats, parseDiff } from '@/engine/git';

/**
 * A unified diff, rendered (M9.4).
 *
 * Syntax-neutral on purpose: the vault holds markdown, YAML, and whatever
 * else the user put there, and a wrong highlighter is worse than none. The
 * +/− gutter carries all the meaning that matters here.
 */
export function DiffView({
  diff,
  emptyLabel = 'No changes.',
}: {
  diff: string;
  emptyLabel?: string;
}) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const stats = useMemo(() => diffStats(diff), [diff]);

  if (diff.trim() === '') {
    return <p className="m-0 px-1 py-3 text-[12.5px] text-n-400">{emptyLabel}</p>;
  }

  return (
    <div data-testid="diff-view" className="flex min-h-0 flex-col">
      <div className="flex flex-none items-center gap-3 pb-1.5 text-[11px]">
        <span className="[font-family:var(--font-mono)] text-success-600">+{stats.added}</span>
        <span className="[font-family:var(--font-mono)] text-danger-500">−{stats.removed}</span>
      </div>
      {/* Diffs are wide; they scroll inside their own box rather than making
          the panel scroll sideways. */}
      <div className="min-h-0 overflow-auto rounded-[8px] border border-n-200 bg-n-25">
        <pre className="m-0 min-w-full p-0 [font-family:var(--font-mono)] text-[11.5px] leading-[17px]">
          {lines.map((line, i) => (
            <div
              key={i}
              data-kind={line.kind}
              className={[
                'whitespace-pre px-2',
                line.kind === 'add'
                  ? 'bg-success-50 text-success-700'
                  : line.kind === 'del'
                    ? 'bg-danger-50 text-danger-700'
                    : line.kind === 'hunk'
                      ? 'bg-n-100 text-n-500'
                      : line.kind === 'meta'
                        ? 'text-n-400'
                        : 'text-n-700',
              ].join(' ')}
            >
              {line.text === '' ? ' ' : line.text}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
