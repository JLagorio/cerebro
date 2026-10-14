import { useState } from 'react';
import { MessageText } from '@/agent/MessageMarkdown';
import { Button } from '@/components/ui/Button';
import { useOpenPath } from '@/app/useOpenPath';
import { listAgents } from '@/engine/agents';
import { OWNER, type CommentStamp, type PageComment } from '@/engine/comments';
import type { Entry } from '@/engine/types';
import { instantText, relativeWhen } from '@/engine/whenText';
import { resolveTarget } from '@/engine/wikilink';
import { useVaultStore } from '@/stores/vaultStore';
import { CommentComposer } from './CommentComposer';
import { noteText, type DetachedNote, type SectionThread } from './commentSections';
import type { PageCommentsController } from './usePageComments';

/** The panel's own turns (mcp.rs `DEFAULT_ACTOR`). */
const PANEL_ACTOR = 'claude-code';

/**
 * Who wrote a comment, as a reader says it: "You" for the owner, an agent by
 * its title (or `@handle` when no agent answers to it any more), "Assistant"
 * for the panel's own turns. Anything else is shown as written.
 */
export function authorLabel(author: string, entries: Entry[]): string {
  if (author === OWNER) return 'You';
  if (author === PANEL_ACTOR) return 'Assistant';
  const agents = listAgents(entries);
  if (author.startsWith('process:')) {
    const handle = author.slice('process:'.length);
    return agents.find((a) => a.handle === handle)?.title ?? `@${handle}`;
  }
  if (author.startsWith('agent:')) {
    const id = author.slice('agent:'.length);
    return agents.find((a) => a.id === id)?.title ?? `@${id}`;
  }
  return author;
}

export const commentCountText = (n: number): string => `${n} comment${n === 1 ? '' : 's'}`;

function When({ at, now }: { at: string; now: Date }) {
  return (
    <span className="text-2xs text-[var(--text-meta)]" title={instantText(at)}>
      {relativeWhen(at, now)}
    </span>
  );
}

function CommentRow({
  comment,
  who,
  now,
  onOpen,
  onDelete,
}: {
  comment: PageComment;
  who: string;
  now: Date;
  onOpen: (target: string) => void;
  onDelete: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  if (comment.deleted !== undefined) {
    return (
      <p data-testid="comment-tombstone" className="m-0 text-sm italic text-n-400">
        Comment deleted.
      </p>
    );
  }
  return (
    <div
      data-testid="comment"
      data-comment-id={comment.id}
      data-state={comment.state}
      className="flex flex-col gap-0.5"
    >
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-medium text-n-800">{who}</span>
        <When at={comment.created} now={now} />
        <span className="flex-1" />
        {!confirming && (
          <button
            type="button"
            data-testid="comment-delete"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
            className="rounded border-0 bg-transparent px-1 text-2xs text-n-400 hover:bg-n-50 hover:text-danger-600"
          >
            Delete
          </button>
        )}
      </div>
      {comment.state === 'pending' ? (
        <p data-testid="comment-pending" className="m-0 text-sm italic text-n-500">
          {who} is answering…
        </p>
      ) : (
        <div
          className={[
            'whitespace-pre-wrap break-words text-sm leading-[19px]',
            comment.state === 'failed' ? 'text-n-400' : 'text-n-800',
          ].join(' ')}
        >
          <MessageText text={comment.body} onOpen={onOpen} />
        </div>
      )}
      {confirming && (
        <div className="flex items-center gap-1.5 text-xs text-n-600">
          <span>Delete this comment?</span>
          <Button
            size="sm"
            variant="danger"
            testId="comment-delete-confirm"
            onClick={() => {
              setConfirming(false);
              void onDelete();
            }}
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function ResolvedBy({ stamp, entries, now }: { stamp: CommentStamp; entries: Entry[]; now: Date }) {
  return (
    <p data-testid="comment-resolved-by" className="m-0 text-2xs text-[var(--text-meta)]">
      Resolved by {authorLabel(stamp.by, entries)}{' '}
      <span title={instantText(stamp.at)}>{relativeWhen(stamp.at, now)}</span>
    </p>
  );
}

/**
 * One thread on the Comments tab (M70.2b): its quote, its comments, a reply
 * box and its actions. Clicking the card focuses it.
 */
export function CommentThread({
  item,
  note = null,
  controller,
  now,
}: {
  item: SectionThread;
  /** Why a quoted thread sits in Discussion. */
  note?: DetachedNote | null;
  controller: PageCommentsController;
  now: Date;
}) {
  const { id, thread } = item;
  const entries = useVaultStore((s) => s.entries);
  const openPath = useOpenPath();
  const [confirmingThread, setConfirmingThread] = useState(false);
  const focused = controller.focused === id;
  const live = thread.comments.filter((c) => c.deleted === undefined).length;
  const resolved = thread.resolved !== undefined;

  const open = (target: string) => {
    const entry = resolveTarget(target, entries);
    if (entry !== null) openPath(entry.path);
  };

  return (
    <article
      data-testid="comment-thread"
      data-thread-id={id}
      data-focused={focused || undefined}
      data-anchor={thread.anchor?.quote}
      onClick={() => {
        if (!focused) controller.focus(id);
      }}
      className={[
        'flex flex-col gap-2 rounded-lg border px-2.5 py-2',
        focused ? 'border-cortex-500 bg-n-0' : 'border-n-200 bg-n-0 hover:border-n-300',
      ].join(' ')}
    >
      {thread.anchor !== undefined && (
        <blockquote
          data-testid="comment-quote"
          className="m-0 border-0 border-l-2 border-solid border-n-300 pl-2 text-xs text-n-600"
        >
          {thread.anchor.quote}
        </blockquote>
      )}
      {note !== null && (
        <p data-testid="comment-note" className="m-0 text-2xs text-[var(--text-meta)]">
          {noteText(note)}
        </p>
      )}
      {thread.comments.map((c) => (
        <CommentRow
          key={c.id}
          comment={c}
          who={authorLabel(c.author, entries)}
          now={now}
          onOpen={open}
          onDelete={() => controller.deleteComment(id, c.id)}
        />
      ))}
      {thread.resolved !== undefined && (
        <ResolvedBy stamp={thread.resolved} entries={entries} now={now} />
      )}
      <CommentComposer
        placeholder="Reply…"
        submitLabel="Reply"
        testId="comment-reply-submit"
        onSubmit={(body) => controller.reply(id, body)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {resolved ? (
          <Button
            size="sm"
            variant="ghost"
            icon="rotate-ccw"
            testId="comment-reopen"
            onClick={() => void controller.setResolved(id, false)}
          >
            Reopen
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon="check"
            testId="comment-resolve"
            onClick={() => void controller.setResolved(id, true)}
          >
            Resolve
          </Button>
        )}
        <span className="flex-1" />
        {!confirmingThread && (
          <Button
            size="sm"
            variant="ghost"
            testId="comment-thread-delete"
            onClick={() => setConfirmingThread(true)}
          >
            Delete thread
          </Button>
        )}
      </div>
      {confirmingThread && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-n-600">
          <span>Delete this thread and its {commentCountText(live)}?</span>
          <Button
            size="sm"
            variant="danger"
            testId="comment-thread-delete-confirm"
            onClick={() => {
              setConfirmingThread(false);
              void controller.deleteThread(id);
            }}
          >
            Delete thread
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmingThread(false)}>
            Cancel
          </Button>
        </div>
      )}
    </article>
  );
}
