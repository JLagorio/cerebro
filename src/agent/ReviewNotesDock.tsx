import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
  MAX_QUEUED_NOTES,
  notesPrompt,
  orderNotes,
  sendable,
  type ReviewNote,
} from '@/engine/reviewNotes';
import { statusOf, useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUiStore } from '@/stores/uiStore';
import { useUpNextStore } from '@/stores/upNextStore';
import type { UpNextInput } from './useUpNext';

/** What a full Up next says to a Send (M58.5). */
export const NOTES_FULL = 'Up next is full. Send these notes when a place opens.';
/** What a thread that cannot continue says in place of Send (M56.3). */
export const NOTES_BLOCKED = "This conversation can't continue, so these notes can't be sent here.";

const BUTTON =
  'flex-none rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-n-600 hover:border-n-400 hover:text-n-900 disabled:cursor-default disabled:opacity-50';

const linesLabel = (note: ReviewNote) =>
  note.start === note.end && note.startSide === undefined
    ? `line ${note.start}`
    : `lines ${note.start}–${note.end}`;

/**
 * The review notes this conversation holds for the agent (M58.5), between Up
 * next and the composer, and only while some are queued. Send turns them into
 * one numbered prompt, in path and line order, and submits it as the person's
 * own message: sent now when the conversation is idle, else one Up next entry.
 * Each note can be reopened on its diff, edited or removed until it goes.
 */
export function ReviewNotesDock({
  vault,
  conversationId,
  blocked,
  submit,
  onOpenNote,
}: {
  vault: string | null;
  conversationId: string | null;
  /** The thread cannot continue (M56.3): another vault's, or one Claude Code
   * no longer has. */
  blocked: boolean;
  submit: (input: UpNextInput) => 'sent' | 'queued' | 'full' | 'refused';
  onOpenNote: (note: ReviewNote) => void;
}) {
  const all = useReviewNotesStore((s) => s.notes);
  const update = useReviewNotesStore((s) => s.update);
  const remove = useReviewNotesStore((s) => s.remove);
  // Read so a note returns here when the Up next entry holding it goes.
  useUpNextStore((s) => s.queues);
  const toast = useUiStore((s) => s.toast);
  const [open, setOpen] = useState(false);

  const mine = useMemo(
    () => all.filter((n) => n.vault === vault && n.conversationId === conversationId),
    [all, vault, conversationId],
  );
  const queued = orderNotes(mine.filter((n) => statusOf(n) === 'queued'));
  if (vault === null || conversationId === null || queued.length === 0) return null;

  const ready = sendable(queued, (id) => useUpNextStore.getState().has(id));
  const unsent = mine.filter((n) => n.sentAt === undefined).length;
  const count = queued.length;

  const send = () => {
    if (ready.length === 0) return;
    const answer = submit({ text: notesPrompt(ready), notes: { ids: ready.map((n) => n.id) } });
    if (answer === 'full') toast(NOTES_FULL);
  };

  return (
    <section
      data-testid="review-notes-dock"
      aria-label="Review notes"
      className="mb-1.5 flex flex-col gap-1 rounded-lg border border-n-200 bg-n-25 px-2 py-1.5"
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="review-notes-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1 border-0 bg-transparent p-0 text-left text-2xs font-medium text-n-600 hover:text-n-900"
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          <span data-testid="review-notes-count">
            {count} review note{count === 1 ? '' : 's'} ready
          </span>
        </button>
        {!blocked && (
          <button
            type="button"
            data-testid="review-notes-send"
            disabled={ready.length === 0}
            onClick={send}
            className={BUTTON}
          >
            Send to the agent
          </button>
        )}
      </div>
      {blocked && (
        <p data-testid="review-notes-blocked" className="m-0 text-2xs leading-[15px] text-n-600">
          {NOTES_BLOCKED}
        </p>
      )}
      {open && (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {queued.map((note) => (
            <li key={note.id} data-testid="review-note" className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="review-note-open"
                  title={note.path}
                  onClick={() => onOpenNote(note)}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left [font-family:var(--font-mono)] text-2xs text-cortex-600 hover:underline"
                >
                  {note.path} · {linesLabel(note)}
                </button>
                <button
                  type="button"
                  data-testid="review-note-remove"
                  onClick={() => remove(note.id)}
                  className={BUTTON}
                >
                  Remove
                </button>
              </div>
              <textarea
                data-testid="review-note-edit"
                aria-label={`Note on ${note.path}, ${linesLabel(note)}`}
                rows={2}
                maxLength={2000}
                value={note.text}
                onChange={(e) => update(note.id, e.target.value)}
                className="w-full resize-y rounded-md border border-n-300 bg-n-0 px-1.5 py-1 text-xs leading-[16px] text-n-800 outline-none focus:border-cortex-500"
              />
              {note.text.trim() === '' && (
                <span data-testid="review-note-empty" className="text-2xs text-n-500">
                  An empty note isn't sent.
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {unsent >= MAX_QUEUED_NOTES && (
        <p data-testid="review-notes-cap" className="m-0 text-2xs leading-[15px] text-n-500">
          Up to {MAX_QUEUED_NOTES} notes per conversation.
        </p>
      )}
    </section>
  );
}
