import { useMemo, useState } from 'react';
import { Queue, QueueItem, QueueItemAction, QueueList, QueueSection } from '@/components/ai/Queue';
import { Icon } from '@/components/ui/Icon';
import { Arrival, useDrawn } from '@/components/ui/motion';
import {
  MAX_QUEUED_NOTES,
  notesPrompt,
  orderNotes,
  sendable,
  type ReviewNote,
} from '@/engine/reviewNotes';
import { statusWords } from '@/git/DiffNotes';
import { statusOf, useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUiStore } from '@/stores/uiStore';
import { useUpNextStore } from '@/stores/upNextStore';
import type { UpNextInput } from './useUpNext';
import './review-notes.css';

/** What a full Up next says to a Send (M58.5). */
export const NOTES_FULL = 'Up next is full. Send these notes when a place opens.';
/** What a thread that cannot continue says in place of Send (M56.3). */
export const NOTES_BLOCKED = "This conversation can't continue, so these notes can't be sent here.";

const linesLabel = (note: ReviewNote) =>
  note.start === note.end && note.startSide === undefined
    ? `line ${note.start}`
    : `lines ${note.start}–${note.end}`;

/**
 * The review notes this conversation holds for the agent (M58.5), between Up
 * next and the composer, and only while some are queued: a Queue (M91.14)
 * whose one line counts them, opening onto the notes, with Send beside it.
 * Send turns them into one numbered prompt, in path and line order, and
 * submits it as the person's own message: sent now when the conversation is
 * idle, else one Up next entry. Each note is an item naming the file and
 * lines it is on, its status said in the diff's own words; it can be opened
 * on its diff, edited or removed (an ×, as Up next's) until it goes.
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
  // Drawn with its conversation (AiPanel keys it by the thread): notes that
  // come to be queued after that bring the dock in (chat.css).
  const drawn = useDrawn();

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
    <Arrival when={drawn}>
      <Queue
        className="cb-review-notes"
        render={<section data-testid="review-notes-dock" aria-label="Review notes" />}
      >
        <QueueSection
          label={`review note${count === 1 ? '' : 's'} ready`}
          count={count}
          icon="message-square-quote"
          labelProps={{ 'data-testid': 'review-notes-count' }}
          triggerTestId="review-notes-toggle"
          open={open}
          onOpenChange={setOpen}
          actions={
            !blocked && (
              <QueueItemAction
                data-testid="review-notes-send"
                disabled={ready.length === 0}
                onClick={send}
              >
                Send to the agent
              </QueueItemAction>
            )
          }
        >
          <QueueList>
            {queued.map((note) => {
              const where = `${note.path}, ${linesLabel(note)}`;
              return (
                <QueueItem
                  key={note.id}
                  data-testid="review-note"
                  icon="message-square-text"
                  statusText={statusWords(note)}
                  // The path gives way in a narrow dock, whole on hover; the
                  // lines it is on never do.
                  title={note.path}
                  titleProps={{ title: note.path }}
                  description={`· ${linesLabel(note)}`}
                  actions={
                    <>
                      <QueueItemAction
                        data-testid="review-note-open"
                        aria-label={`View diff of ${where}`}
                        onClick={() => onOpenNote(note)}
                      >
                        View diff
                      </QueueItemAction>
                      <QueueItemAction
                        data-testid="review-note-remove"
                        aria-label={`Remove the note on ${where}`}
                        onClick={() => remove(note.id)}
                      >
                        <Icon name="x" size={10} />
                      </QueueItemAction>
                    </>
                  }
                >
                  <textarea
                    data-testid="review-note-edit"
                    aria-label={`Note on ${where}`}
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
                </QueueItem>
              );
            })}
          </QueueList>
        </QueueSection>
        {blocked && (
          <p data-testid="review-notes-blocked" className="m-0 text-2xs leading-[15px] text-n-600">
            {NOTES_BLOCKED}
          </p>
        )}
        {unsent >= MAX_QUEUED_NOTES && (
          <p data-testid="review-notes-cap" className="m-0 text-2xs leading-[15px] text-n-500">
            Up to {MAX_QUEUED_NOTES} notes per conversation.
          </p>
        )}
      </Queue>
    </Arrival>
  );
}
