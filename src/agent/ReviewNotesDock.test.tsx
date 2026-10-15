import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NOTES_BLOCKED, NOTES_FULL, ReviewNotesDock } from './ReviewNotesDock';
import type { UpNextEntry } from './upNextQueue';
import { notesPrompt, type ReviewNote } from '@/engine/reviewNotes';
import { useReviewNotesStore, type NewNote } from '@/stores/reviewNotesStore';
import { useUiStore } from '@/stores/uiStore';
import { useUpNextStore } from '@/stores/upNextStore';

const fresh = (over: Partial<NewNote> = {}): NewNote => ({
  vault: '/vault',
  conversationId: 'c-1',
  runId: 'run-1',
  commit: 'c'.repeat(40),
  path: 'records/b.md',
  side: 'new',
  start: 2,
  end: 2,
  excerpt: 'Two',
  text: 'Shorter.',
  ...over,
});

const added = (over: Partial<NewNote> = {}): ReviewNote => {
  const note = useReviewNotesStore.getState().add(fresh(over));
  if (note === null) throw new Error('refused');
  return note;
};

const entry = (id: string): UpNextEntry => ({
  id,
  text: 'notes',
  notes: { ids: [] },
  skill: null,
  allowedTools: null,
  turn: { systemPrompt: () => '', place: null, conversationId: 'c-1' },
  vault: '/vault',
  queuedAt: 0,
});

function dock(over: Partial<Parameters<typeof ReviewNotesDock>[0]> = {}) {
  const submit = vi.fn(() => 'sent' as const);
  const onOpenNote = vi.fn();
  render(
    <ReviewNotesDock
      vault="/vault"
      conversationId="c-1"
      blocked={false}
      submit={submit}
      onOpenNote={onOpenNote}
      {...over}
    />,
  );
  return { submit, onOpenNote };
}

describe('ReviewNotesDock (M58.5)', () => {
  beforeEach(() => {
    localStorage.clear();
    useReviewNotesStore.setState({ notes: [] });
    useUpNextStore.setState({ queues: {} });
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it('is hidden with no queued notes in this conversation', () => {
    added({ conversationId: 'c-2' });
    const sent = added();
    useReviewNotesStore.getState().markSent([sent.id], 1);
    const waiting = added();
    useUpNextStore.getState().enqueue('c-1', entry('up-1'));
    useReviewNotesStore.getState().hold([waiting.id], 'up-1');
    dock();
    expect(screen.queryByTestId('review-notes-dock')).toBeNull();
  });

  it('counts its notes in words', () => {
    added();
    const { unmount } = render(
      <ReviewNotesDock
        vault="/vault"
        conversationId="c-1"
        blocked={false}
        submit={vi.fn(() => 'sent' as const)}
        onOpenNote={vi.fn()}
      />,
    );
    expect(screen.getByTestId('review-notes-count').textContent).toBe('1 review note ready');
    unmount();
    added({ start: 5, end: 5 });
    dock();
    expect(screen.getByTestId('review-notes-count').textContent).toBe('2 review notes ready');
  });

  it('edits and removes a note, and reopens its diff', () => {
    const note = added();
    const { onOpenNote } = dock();
    fireEvent.click(screen.getByTestId('review-notes-toggle'));
    fireEvent.change(screen.getByTestId('review-note-edit'), { target: { value: 'Longer.' } });
    expect(useReviewNotesStore.getState().notes[0].text).toBe('Longer.');
    fireEvent.click(screen.getByTestId('review-note-open'));
    expect(onOpenNote).toHaveBeenCalledWith(expect.objectContaining({ id: note.id }));
    fireEvent.click(screen.getByTestId('review-note-remove'));
    expect(useReviewNotesStore.getState().notes).toEqual([]);
    expect(screen.queryByTestId('review-notes-dock')).toBeNull();
  });

  it('sends one prompt built from its sendable notes, with their ids', () => {
    const b = added({ path: 'records/b.md' });
    const a = added({ path: 'records/a.md', start: 1, end: 1, excerpt: 'One', text: 'Keep.' });
    const empty = added({ path: 'records/c.md' });
    useReviewNotesStore.getState().update(empty.id, '');
    const { submit } = dock();
    fireEvent.click(screen.getByTestId('review-notes-send'));
    const notes = useReviewNotesStore.getState().notes;
    const ready = [a.id, b.id].map((id) => notes.find((n) => n.id === id) as ReviewNote);
    expect(submit).toHaveBeenCalledWith({ text: notesPrompt(ready), notes: { ids: [a.id, b.id] } });
  });

  it('says an empty note is not sent, and sends nothing when all are empty', () => {
    const note = added();
    useReviewNotesStore.getState().update(note.id, '  ');
    const { submit } = dock();
    fireEvent.click(screen.getByTestId('review-notes-toggle'));
    expect(screen.getByTestId('review-note-empty').textContent).toBe("An empty note isn't sent.");
    expect(screen.getByTestId('review-notes-send')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTestId('review-notes-send'));
    expect(submit).not.toHaveBeenCalled();
  });

  it('toasts when Up next is full, and keeps the notes queued', () => {
    added();
    dock({ submit: vi.fn(() => 'full' as const) });
    fireEvent.click(screen.getByTestId('review-notes-send'));
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([NOTES_FULL]);
    expect(screen.getByTestId('review-notes-dock')).toBeTruthy();
    expect(useReviewNotesStore.getState().notes[0].sentAt).toBeUndefined();
  });

  it('hides Send on a thread that cannot continue, and says why', () => {
    added();
    dock({ blocked: true });
    expect(screen.queryByTestId('review-notes-send')).toBeNull();
    expect(screen.getByTestId('review-notes-blocked').textContent).toBe(NOTES_BLOCKED);
  });

  it('states the cap at 30 notes', () => {
    for (let i = 0; i < 30; i += 1) added({ start: i + 1, end: i + 1 });
    dock();
    expect(screen.getByTestId('review-notes-cap').textContent).toBe(
      'Up to 30 notes per conversation.',
    );
  });
});
