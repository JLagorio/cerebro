import { Fragment, useMemo, useState } from 'react';
import { diffStats, parseDiff, type DiffLine } from '@/engine/git';
import { MAX_QUEUED_NOTES, anchorFrom, type NoteSide, type ReviewNote } from '@/engine/reviewNotes';
import { NoteComposer, NoteList, type DiffNotesTarget } from '@/git/DiffNotes';
import { useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUpNextStore } from '@/stores/upNextStore';

/** The side a line's note button stands on: a removed line's old number,
 * an added or context line's new one. */
function buttonSide(line: DiffLine): NoteSide | null {
  if (line.kind === 'del') return line.oldLine === null ? null : 'old';
  if (line.kind === 'add' || line.kind === 'context') return line.newLine === null ? null : 'new';
  return null;
}

const numberOn = (line: DiffLine, side: NoteSide) => (side === 'old' ? line.oldLine : line.newLine);

const GUTTER =
  'w-10 flex-none select-none border-0 bg-transparent px-1 py-0 text-right text-n-400 [font-family:var(--font-mono)] text-xs leading-[17px]';

/** The index of the line a note ends on, or -1 when this diff has none. */
function endIndex(lines: DiffLine[], note: ReviewNote): number {
  return lines.findIndex(
    (line) =>
      line.kind !== 'meta' && line.kind !== 'hunk' && numberOn(line, note.side) === note.end,
  );
}

/**
 * A unified diff, rendered (M9.4).
 *
 * Syntax-neutral on purpose: the vault holds markdown, YAML, and whatever
 * else the user put there, and a wrong highlighter is worse than none. The
 * +/− gutter says what changed; the old and new line-number gutters say
 * where (M58.5).
 *
 * With `notes`, the diff is a turn's and takes review notes: each numbered
 * line's number is a button, a click picks the line and a shift-click
 * extends the range, and the composer opens under the range's last line.
 * Each note shows under the line it ends on, with what became of it.
 */
export function DiffView({
  diff,
  emptyLabel = 'No changes.',
  notes,
}: {
  diff: string;
  emptyLabel?: string;
  notes?: DiffNotesTarget;
}) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const stats = useMemo(() => diffStats(diff), [diff]);
  const [range, setRange] = useState<{ anchor: number; focus: number } | null>(null);
  const allNotes = useReviewNotesStore((s) => s.notes);
  const add = useReviewNotesStore((s) => s.add);
  // Read so a note re-renders as waiting or queued when Up next changes.
  useUpNextStore((s) => s.queues);

  const mine = useMemo(
    () =>
      notes === undefined
        ? []
        : allNotes.filter(
            (n) =>
              n.vault === notes.vault &&
              n.conversationId === notes.conversationId &&
              n.commit === notes.commit &&
              n.path === notes.path,
          ),
    [allNotes, notes],
  );
  const byEnd = useMemo(() => {
    const map = new Map<number, ReviewNote[]>();
    for (const note of mine) {
      const at = endIndex(lines, note);
      const key = at === -1 ? lines.length - 1 : at;
      map.set(key, [...(map.get(key) ?? []), note]);
    }
    return map;
  }, [lines, mine]);
  const full =
    notes !== undefined &&
    allNotes.filter(
      (n) =>
        n.vault === notes.vault &&
        n.conversationId === notes.conversationId &&
        n.sentAt === undefined,
    ).length >= MAX_QUEUED_NOTES;

  if (diff.trim() === '') {
    return <p className="m-0 px-1 py-3 text-sm text-n-400">{emptyLabel}</p>;
  }

  const lo = range === null ? -1 : Math.min(range.anchor, range.focus);
  const hi = range === null ? -1 : Math.max(range.anchor, range.focus);
  const anchor = range === null ? null : anchorFrom(lines, range.anchor, range.focus);

  const pick = (i: number, extend: boolean) =>
    setRange((prev) =>
      extend && prev !== null ? { anchor: prev.anchor, focus: i } : { anchor: i, focus: i },
    );

  const gutter = (line: DiffLine, side: NoteSide, i: number) => {
    const n = numberOn(line, side);
    if (notes !== undefined && n !== null && buttonSide(line) === side) {
      return (
        <button
          type="button"
          data-testid="diff-note-line"
          aria-label={`Note on line ${n} ${side === 'new' ? 'after' : 'before'} the change`}
          onClick={(e) => pick(i, e.shiftKey)}
          className={`${GUTTER} cursor-pointer hover:bg-n-100 hover:text-cortex-600`}
        >
          {n}
        </button>
      );
    }
    return (
      <span aria-hidden className={GUTTER}>
        {n ?? ''}
      </span>
    );
  };

  return (
    <div data-testid="diff-view" className="flex min-h-0 flex-col">
      <div className="flex flex-none items-center gap-3 pb-1.5 text-2xs">
        <span className="[font-family:var(--font-mono)] text-success-600">+{stats.added}</span>
        <span className="[font-family:var(--font-mono)] text-danger-500">−{stats.removed}</span>
      </div>
      {/* Diffs are wide; they scroll inside their own box rather than making
          the panel scroll sideways. */}
      <div className="min-h-0 overflow-auto rounded-md border border-n-200 bg-n-25">
        <div className="m-0 w-max min-w-full p-0 [font-family:var(--font-mono)] text-xs leading-[17px]">
          {lines.map((line, i) => (
            <Fragment key={i}>
              <div
                data-kind={line.kind}
                data-selected={i >= lo && i <= hi ? 'true' : undefined}
                className={[
                  'flex',
                  line.kind === 'add'
                    ? 'bg-success-50 text-success-700'
                    : line.kind === 'del'
                      ? 'bg-danger-50 text-danger-700'
                      : line.kind === 'hunk'
                        ? 'bg-n-100 text-n-500'
                        : line.kind === 'meta'
                          ? 'text-n-400'
                          : 'text-n-700',
                  i >= lo && i <= hi ? 'shadow-[inset_2px_0_0_var(--cortex-500)]' : '',
                ].join(' ')}
              >
                {gutter(line, 'old', i)}
                {gutter(line, 'new', i)}
                <span data-testid="diff-line-text" className="whitespace-pre px-2">
                  {line.text === '' ? ' ' : line.text}
                </span>
              </div>
              {notes !== undefined && anchor !== null && i === hi && (
                <NoteComposer
                  full={full}
                  onCancel={() => setRange(null)}
                  onAdd={(text) => {
                    if (add({ ...notes, ...anchor, text }) !== null) setRange(null);
                  }}
                />
              )}
              {notes !== undefined && <NoteList notes={byEnd.get(i) ?? []} />}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
