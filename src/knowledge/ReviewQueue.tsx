import { useMemo } from 'react';
import { create } from 'zustand';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { resolveAuthor } from '@/engine/authors';
import {
  AGENT_ONLY_LABEL,
  recheckLine,
  REVIEW_LABELS,
  reviewQueue,
  type Concept,
  type QueuedConcept,
  type QueueReason,
} from '@/engine/okf';
import type { Entry, Selection } from '@/engine/types';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { useConcepts } from '@/knowledge/useConcepts';
import { useNavStore } from '@/stores/navStore';

/**
 * The review queue as a to-do list (M51.2): every row says WHY it is here,
 * and the order is the order to work it in (`reviewQueue`). The words live
 * here — the reason's sentence and its word — along with the two ways to
 * walk the queue (a way in, and Next); the rows are `ConceptTable`'s (M52.5).
 *
 * It replaced a list of thirteen rows that each wore the same "Unreviewed"
 * pill — a tag on every row is a tag on none — and a deprecated concept that
 * read "Reviewed · by a person" inside Needs review with nothing to say why.
 */

/**
 * Each reason's word and tone (M52.5) — `reasonText` is the sentence, this is
 * the word a status column wears for it, beside a dot in its tone: `accent`
 * for what nobody has read, `warn` for what moved or fell due, `muted` for
 * what was retired.
 *
 * A reason that IS a review state says it in the review chip's word
 * (`REVIEW_LABELS`), so the row and the page it opens name it once: the row
 * said "Differs from its history" over a page that led with "Review
 * disputed". A concept only a process confirmed is "Needs a person", here and
 * on its own page (`ReviewChip`): the table said "Reviewed by an agent" in
 * the loud tone while the page said "Reviewed" in green, so the same concept
 * read as waiting in one place and settled in the other. It is waiting — an
 * agent's confirmation does not take it out of the queue.
 */
export const REASON: Record<QueueReason, { tone: 'accent' | 'warn' | 'muted'; label: string }> = {
  disputed: { tone: 'warn', label: REVIEW_LABELS.disputed },
  changed: { tone: 'warn', label: REVIEW_LABELS.predates_current },
  stale: { tone: 'warn', label: 'Due a recheck' },
  deprecated: { tone: 'muted', label: 'Deprecated' },
  new: { tone: 'accent', label: REVIEW_LABELS.unreviewed },
  'agent-only': { tone: 'accent', label: AGENT_ONLY_LABEL },
};

/** The row's one sentence — what happened, and who or when where it is known. */
export function reasonText(item: QueuedConcept, entries: Entry[], today: string): string {
  const { concept } = item;
  switch (item.reason) {
    case 'disputed':
      return 'The file differs from its recorded history';
    case 'changed':
      return 'Changed since it was reviewed';
    case 'stale':
      return recheckLine(concept, today);
    case 'deprecated':
      return 'Marked deprecated — no person has confirmed it';
    case 'new': {
      // What else it owes, after who wrote it (M52.5): a never-reviewed
      // concept leads with that, so a recheck or a retirement it is also
      // due is said here rather than as its status.
      const owed = [
        concept.stale ? recheckLine(concept, today) : null,
        concept.lifecycle === 'deprecated' ? 'Marked deprecated' : null,
      ].filter((part) => part !== null);
      const also = owed.length === 0 ? '' : ` — ${owed.join(' · ')}`;
      // Absent is never zero: an unstamped concept says nobody recorded who
      // wrote it, not that nobody did.
      if (concept.generated === null) return `New — who wrote it is not recorded${also}`;
      const author = resolveAuthor(concept.generated.by, entries);
      const who =
        author.kind === 'agent'
          ? author.title
          : author.kind === 'assistant'
            ? // The Written by column's word for it, without an article.
              'Assistant'
            : author.label;
      const when = relativeDay(concept.generated.at, today);
      return `New from ${who}${when === null ? '' : ` · ${when}`}${also}`;
    }
    case 'agent-only':
      return 'An agent confirmed it — no person has yet';
  }
}

/**
 * A walk through the queue (M52.5): the concepts it covers, what to call
 * them, and where "back" is. Started from a folder's view, the pager counted
 * the whole bundle — "Review 2 of 3" from a folder with one waiting, and Next
 * walked out of the folder into another one. The walk is the scope the Start
 * review button was pressed under, carried to the page.
 *
 * The membership is every concept in scope, not the ones waiting when it
 * started: the pager re-reads the live queue against it, so a concept just
 * verified drops out of the count as it does from the Review tab.
 *
 * The whole queue is a walk too — `paths` and `label` null, back to Review —
 * so it has an ending: verifying its last concept left the page with no
 * pager at all, where a folder's walk said "Nothing left to review in
 * Systems · Done".
 */
export type ReviewWalk =
  | {
      paths: readonly string[];
      /** "Systems", or the page whose strip started it. */
      label: string;
      /** Where the walk ends up: the folder, or the page. */
      back: Selection;
    }
  | { paths: null; label: null; back: Selection };

const REVIEW_TAB: Selection = { kind: 'knowledge', nav: { tab: 'review' } };
const WHOLE_QUEUE: ReviewWalk = { paths: null, label: null, back: REVIEW_TAB };

const useWalkStore = create<{ walk: ReviewWalk | null }>(() => ({ walk: null }));

/** Forget the walk. The Knowledge page does this on arrival, so a concept
 * opened from anywhere but the queue is no walk's. */
export function clearReviewWalk(): void {
  if (useWalkStore.getState().walk !== null) useWalkStore.setState({ walk: null });
}

/** Walk the whole queue from here: a Review-tab row, the unscoped Start
 * review, and a Next pressed outside any walk. */
export function startWholeQueueWalk(): void {
  useWalkStore.setState({ walk: WHOLE_QUEUE });
}

const covers = (walk: ReviewWalk | null, path: string): boolean =>
  walk !== null && (walk.paths === null || walk.paths.includes(path));

/**
 * The way into the queue (M52.5): the concepts waiting on a person, in the
 * order the queue works them — all of them, or only those among `within` —
 * and the act that opens the first as its page, where the review bar and its
 * pager take over. One implementation for every door into the walk: a page's
 * Knowledge strip opens the first of ITS concepts, a folder's view the first
 * of its own, the Knowledge header the first of all — and each opens the row
 * the Review tab would. A scoped door hands the pager its scope (`scope`),
 * so Next stays inside it; an unscoped one walks the whole queue.
 */
export function useReviewStart(
  concepts: readonly Concept[],
  within?: readonly Concept[],
  scope?: { label: string; back: Selection },
): { waiting: Concept[]; start: () => void } {
  const navigate = useNavStore((s) => s.navigate);
  const waiting = useMemo(() => {
    const queue = reviewQueue(concepts).map((q) => q.concept);
    if (within === undefined) return queue;
    const here = new Set(within.map((c) => c.entry.path));
    return queue.filter((c) => here.has(c.entry.path));
  }, [concepts, within]);
  const start = () => {
    if (waiting.length === 0) return;
    useWalkStore.setState({
      walk:
        within === undefined || scope === undefined
          ? WHOLE_QUEUE
          : { paths: within.map((c) => c.entry.path), label: scope.label, back: scope.back },
    });
    navigate({ kind: 'doc', path: waiting[0].entry.path });
  };
  return { waiting, start };
}

/**
 * "3 of 13 · Next" on a concept page (M51.2): the queue, walkable from inside
 * it. Derived rather than remembered — the position is wherever this concept
 * sits in the queue right now, so it is right however the page was reached,
 * and a concept just verified (and so out of the queue) offers the next one.
 *
 * Inside a walk (a folder's Start review, a page's strip) it counts the walk
 * — "Review 1 of 1 in Systems" — and a concept outside the walk is counted
 * against everything. Either way the walk ENDS (M52.5): at its last concept
 * Next becomes Done, and **Done returns to where the walk started** — a
 * folder's walk to that folder, a page's to that page, and the whole queue
 * to Review. So does the count's own link, "Back to …", at any step, and so
 * does the Done a walk shows once nothing in it waits — the whole queue's
 * included, which is why reaching a page by walking the whole queue is
 * remembered (`startWholeQueueWalk`). The whole queue used to wrap from "9 of
 * 9" to 1 while a folder's stopped, so one pager had two endings and the
 * longer walk had none.
 */
export function ReviewPager({ path }: { path: string }) {
  const navigate = useNavStore((s) => s.navigate);
  const walk = useWalkStore((s) => s.walk);
  const concepts = useConcepts();
  const everything = useMemo(() => reviewQueue(concepts), [concepts]);
  // The walk this page is in, if any.
  const current = covers(walk, path) ? walk : null;
  const queue = useMemo(() => {
    if (current?.paths == null) return everything;
    const scope = new Set(current.paths);
    return everything.filter((q) => scope.has(q.concept.entry.path));
  }, [everything, current]);

  if (queue.length === 0) {
    if (current === null) return null;
    // The walk is done: nothing in it waits any more.
    return (
      <span data-testid="review-pager" className="inline-flex items-center gap-1">
        <span className="px-1 text-xs text-n-500">
          Nothing left to review{current.label === null ? '' : ` in ${current.label}`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          testId="review-done"
          onClick={() => navigate(current.back)}
        >
          Done
          <Icon name="check" size={13} />
        </Button>
      </span>
    );
  }
  const at = queue.findIndex((q) => q.concept.entry.path === path);
  const next = at === -1 ? queue[0] : queue[Math.min(at + 1, queue.length - 1)];
  const open = () => {
    // Next outside any walk walks the whole queue, so it ends where it
    // should once the last concept is verified.
    if (walk === null) startWholeQueueWalk();
    navigate({ kind: 'doc', path: next.concept.entry.path });
  };
  if (at === -1) {
    return (
      <Button variant="ghost" size="sm" testId="review-next" onClick={open}>
        Next to review
        <Icon name="arrow-right" size={13} />
      </Button>
    );
  }
  const back: Selection = current?.back ?? REVIEW_TAB;
  const scoped = current?.label ?? null;
  const backLabel = scoped === null ? 'Back to Review' : `Back to ${scoped}`;
  const last = at === queue.length - 1;
  return (
    <span data-testid="review-pager" className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => navigate(back)}
        className="border-0 bg-transparent px-1 text-xs text-n-500 hover:text-n-800"
        title={backLabel}
      >
        Review {at + 1} of {queue.length}
        {scoped !== null && ` in ${scoped}`}
      </button>
      {last ? (
        <Button variant="ghost" size="sm" testId="review-done" onClick={() => navigate(back)}>
          Done
          <Icon name="check" size={13} />
        </Button>
      ) : (
        <Button variant="ghost" size="sm" testId="review-next" onClick={open}>
          Next
          <Icon name="arrow-right" size={13} />
        </Button>
      )}
    </span>
  );
}
