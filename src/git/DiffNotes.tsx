import { keysText } from '@/components/ui/Keycaps';
import { useState } from 'react';
import { useLayer } from '@/components/ui/layers';
import { MAX_QUEUED_NOTES, type ReviewNote } from '@/engine/reviewNotes';
import { localStamp, relativeWhen } from '@/engine/whenText';
import { statusOf, useReviewNotesStore } from '@/stores/reviewNotesStore';

/** What a diff's notes are on (M58.5): the turn's commit and file, and the
 * conversation and run they go back to. */
export interface DiffNotesTarget {
  vault: string;
  conversationId: string;
  runId: string | null;
  commit: string;
  path: string;
}

const BUTTON =
  'rounded-md border border-n-200 bg-n-0 px-2 py-0.5 text-2xs text-n-700 hover:border-n-400 hover:text-n-900 disabled:cursor-default disabled:opacity-50';

/**
 * The note being written under a range's last line. ⌘Enter (or Ctrl+Enter)
 * adds it; Escape cancels it and nothing else, since the composer is a layer
 * and the lens behind it stands down while one is open.
 */
export function NoteComposer({
  full,
  onAdd,
  onCancel,
}: {
  /** The conversation already holds the most unsent notes it can. */
  full: boolean;
  onAdd: (text: string) => void;
  onCancel: () => void;
}) {
  useLayer();
  const [text, setText] = useState('');
  const empty = text.trim() === '';
  const add = () => {
    if (!empty && !full) onAdd(text);
  };
  return (
    <div
      data-testid="diff-note-composer"
      className="sticky left-0 my-1 ml-2 flex w-[min(520px,calc(100vw-48px))] flex-col gap-1.5 whitespace-normal rounded-md border border-n-200 bg-n-0 p-2 [font-family:var(--font-ui)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          add();
        }
      }}
    >
      <textarea
        data-testid="diff-note-text"
        aria-label="Note for the agent"
        autoFocus
        rows={3}
        maxLength={2000}
        placeholder="What should change here?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full resize-y rounded-md border border-n-300 bg-n-0 px-2 py-1 text-xs leading-[17px] text-n-800 outline-none focus:border-cortex-500"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          data-testid="diff-note-add"
          disabled={empty || full}
          title={keysText('mod+enter')}
          onClick={add}
          className={BUTTON}
        >
          Add note
        </button>
        <button type="button" data-testid="diff-note-cancel" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
      </div>
      <p className="m-0 text-2xs leading-[15px] text-n-500">
        {full
          ? `Up to ${MAX_QUEUED_NOTES} notes per conversation.`
          : 'Notes go to the agent in this conversation, not into the page.'}
      </p>
    </div>
  );
}

/** A note's status, in words. */
export function statusWords(note: ReviewNote, now = new Date()): string {
  switch (statusOf(note)) {
    case 'sent':
      return `Sent to the agent ${relativeWhen(new Date(note.sentAt ?? 0).toISOString(), now)}`;
    case 'waiting':
      return 'Waiting in Up next';
    case 'queued':
      return 'Queued for the agent';
  }
}

/** The notes that end on one line, with what became of each; a queued one
 * can be removed. */
export function NoteList({ notes }: { notes: readonly ReviewNote[] }) {
  const remove = useReviewNotesStore((s) => s.remove);
  if (notes.length === 0) return null;
  return (
    <ul className="sticky left-0 m-0 ml-2 flex w-[min(520px,calc(100vw-48px))] list-none flex-col gap-1 whitespace-normal p-0 py-1 [font-family:var(--font-ui)]">
      {notes.map((note) => {
        const status = statusOf(note);
        return (
          <li
            key={note.id}
            data-testid="diff-note"
            data-status={status}
            className="flex flex-col gap-0.5 rounded-md border border-n-200 bg-n-0 px-2 py-1.5"
          >
            <span className="whitespace-pre-wrap break-words text-xs leading-[17px] text-n-800">
              {note.text}
            </span>
            <span className="flex items-center gap-2 text-2xs text-n-500">
              <span
                data-testid="diff-note-status"
                title={note.sentAt === undefined ? undefined : localStamp(new Date(note.sentAt))}
              >
                {statusWords(note)}
              </span>
              {status === 'queued' && (
                <button
                  type="button"
                  data-testid="diff-note-remove"
                  onClick={() => remove(note.id)}
                  className="border-0 bg-transparent p-0 text-2xs text-n-500 underline hover:text-n-800"
                >
                  Remove
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
