import { useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { CommentComposer } from './CommentComposer';
import { CommentThread } from './CommentThread';
import type { PageCommentsController } from './usePageComments';

export const UNPLACED_NOTE = "Open the page's text to see where each comment sits.";

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="m-0 px-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
      {children}
    </h3>
  );
}

/**
 * A page's Comments tab (M70.2b). Unavailable says why and offers nothing to
 * write with (CV-05: a sidecar that can't be read is never "no comments", and
 * no composer can write over it); loading draws nothing; ready draws the
 * draft, On the page, the unplaced threads, Discussion with its composer, and
 * a folded Resolved that opens when the thread in focus is resolved.
 */
export function CommentsTab({
  controller,
  now = new Date(),
}: {
  controller: PageCommentsController;
  /** The clock relative times read; a test pins it. */
  now?: Date;
}) {
  const { slot, sections, draft } = controller;
  const focusedResolved =
    sections !== null && sections.resolved.some((t) => t.id === controller.focused);
  // Open when asked, and whenever the thread in focus is in it.
  const [resolvedOpen, setResolvedOpen] = useState(false);

  if (slot === null || slot.kind === 'loading') return null;
  if (slot.kind === 'unavailable') {
    return (
      <p data-testid="section-unavailable" className="m-0 px-1.5 py-3 text-sm text-n-600">
        {slot.reason}
      </p>
    );
  }
  if (sections === null) return null;

  const thread = (item: (typeof sections.onPage)[number]) => (
    <CommentThread key={item.id} item={item} controller={controller} now={now} />
  );
  const nothing =
    draft === null &&
    sections.onPage.length === 0 &&
    sections.unplaced.length === 0 &&
    sections.discussion.length === 0 &&
    sections.resolved.length === 0;

  return (
    <div data-testid="comments-tab" className="flex flex-col gap-3 pb-3 pt-1.5">
      {draft !== null && (
        <section
          data-testid="comment-draft"
          className="flex flex-col gap-2 rounded-lg border border-cortex-500 px-2.5 py-2"
        >
          <blockquote className="m-0 border-0 border-l-2 border-solid border-n-300 pl-2 text-xs text-n-600">
            {draft.quote}
          </blockquote>
          <CommentComposer
            // A new selection is a new draft.
            key={`${draft.quote}\n${draft.occurrence}\n${draft.before}`}
            placeholder="Add a comment…"
            submitLabel="Comment"
            testId="comment-draft-submit"
            autoFocus
            onSubmit={(body) => controller.submitDraft(body)}
            onCancel={controller.cancelDraft}
          />
        </section>
      )}
      {sections.onPage.length > 0 && (
        <section data-testid="comments-on-page" className="flex flex-col gap-2">
          <Heading>On the page</Heading>
          {sections.onPage.map(thread)}
        </section>
      )}
      {sections.unplaced.length > 0 && (
        <section data-testid="comments-unplaced" className="flex flex-col gap-2">
          <p className="m-0 px-1 text-2xs text-[var(--text-meta)]">{UNPLACED_NOTE}</p>
          {sections.unplaced.map(thread)}
        </section>
      )}
      <section data-testid="comments-discussion" className="flex flex-col gap-2">
        <Heading>Discussion</Heading>
        {nothing && (
          <EmptyState
            compact
            icon="message-square"
            title="No comments yet"
            description="Select text and press Comment, or start a discussion below."
          />
        )}
        {sections.discussion.map((item) => (
          <CommentThread
            key={item.id}
            item={item}
            note={item.note}
            controller={controller}
            now={now}
          />
        ))}
        <CommentComposer
          placeholder="Start a discussion…"
          submitLabel="Post"
          testId="discussion-submit"
          onSubmit={(body) => controller.startDiscussion(body)}
        />
      </section>
      {sections.resolved.length > 0 && (
        <details
          data-testid="comments-resolved"
          open={resolvedOpen || focusedResolved}
          onToggle={(e) => setResolvedOpen(e.currentTarget.open)}
          className="flex flex-col gap-2"
        >
          <summary className="cursor-pointer px-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            Resolved ({sections.resolved.length})
          </summary>
          <div className="mt-2 flex flex-col gap-2">{sections.resolved.map(thread)}</div>
        </details>
      )}
    </div>
  );
}
