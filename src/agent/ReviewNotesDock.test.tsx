import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NOTES_BLOCKED, NOTES_FULL, ReviewNotesDock } from './ReviewNotesDock';
import type { UpNextEntry } from './upNextQueue';
import { notesPrompt, type ReviewNote } from '@/engine/reviewNotes';
import { statusWords } from '@/git/DiffNotes';
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
  narrowing: {},
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

/** What a screen reader reads of an element: its text, less what is hidden. */
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// M91.14 — the dock is a Queue: one line counting the notes, which opens
// onto them, with Send beside it; each note an item saying where it stands
// in the diff's own words, its actions beside its line.
describe('ReviewNotesDock as a Queue (M91.14)', () => {
  beforeEach(() => {
    localStorage.clear();
    useReviewNotesStore.setState({ notes: [] });
    useUpNextStore.setState({ queues: {} });
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it('is the region Review notes, one line counting its notes that opens onto them', () => {
    added();
    added({ path: 'records/a.md', start: 1, end: 1 });
    dock();
    const region = screen.getByRole('region', { name: 'Review notes' });
    expect(region).toBe(screen.getByTestId('review-notes-dock'));
    expect(region.tagName).toBe('SECTION');
    expect(region.dataset.slot).toBe('queue');
    const toggle = screen.getByTestId('review-notes-toggle');
    expect(toggle).toBe(screen.getByRole('button', { name: '2 review notes ready' }));
    expect(toggle.contains(screen.getByTestId('review-notes-count'))).toBe(true);
    // Closed until asked, its notes kept in the document.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByTestId('review-note')[0].closest('[hidden]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByTestId('review-note')[0].closest('[hidden]')).toBeNull();
    // Send is the section's action, beside its line and never inside it.
    const send = screen.getByTestId('review-notes-send');
    expect(toggle.contains(send)).toBe(false);
    expect(send.closest('[data-slot="queue-section-actions"]')).not.toBeNull();
  });

  it('lists its notes in path and line order, each an item of the list', () => {
    added({ path: 'records/b.md', start: 9, end: 9 });
    added({ path: 'records/a.md', start: 3, end: 3 });
    added({ path: 'records/b.md', start: 2, end: 4 });
    dock();
    const notes = screen.getAllByTestId('review-note');
    expect(notes.map((li) => li.tagName)).toEqual(['LI', 'LI', 'LI']);
    expect(notes.every((li) => li.dataset.slot === 'queue-item')).toBe(true);
    const part = (li: HTMLElement, slot: string) =>
      li.querySelector(`[data-slot="${slot}"]`)?.textContent ?? '';
    expect(notes.map((li) => [part(li, 'trace-title'), part(li, 'trace-description')])).toEqual([
      ['records/a.md', '· line 3'],
      ['records/b.md', '· lines 2–4'],
      ['records/b.md', '· line 9'],
    ]);
  });

  it('says each note’s status in the diff’s own words, before the place it is on', () => {
    const note = added();
    dock();
    const [item] = screen.getAllByTestId('review-note');
    const line = item.querySelector('[data-slot="trace-line"]') as HTMLElement;
    expect(statusWords(note)).toBe('Queued for the agent');
    expect(line.querySelector('.sr-only')?.textContent).toBe('Queued for the agent: ');
    expect(spoken(line)).toMatch(/^Queued for the agent: records\/b\.md\s*· line 2$/);
    // The path gives way in a narrow dock, whole on hover; its lines never do.
    const title = line.querySelector('[data-slot="trace-title"]') as HTMLElement;
    expect(title.getAttribute('title')).toBe('records/b.md');
    expect(title.nextElementSibling?.getAttribute('data-slot')).toBe('trace-description');
  });

  it('names each action by the note it acts on, and puts it beside the line', () => {
    const note = added({ start: 2, end: 4 });
    const { onOpenNote } = dock();
    const [item] = screen.getAllByTestId('review-note');
    const view = within(item).getByRole('button', {
      name: 'View diff of records/b.md, lines 2–4',
      hidden: true,
    });
    expect(view).toBe(within(item).getByTestId('review-note-open'));
    expect(view.textContent).toBe('View diff');
    const remove = within(item).getByRole('button', {
      name: 'Remove the note on records/b.md, lines 2–4',
      hidden: true,
    });
    expect(remove).toBe(within(item).getByTestId('review-note-remove'));
    // An ×, as Up next's Remove is.
    expect(remove.querySelector('[data-icon="x"]')).not.toBeNull();
    for (const action of [view, remove]) {
      expect(action.closest('[data-slot="trace-line"]')).toBeNull();
      expect(action.closest('[data-slot="queue-item-actions"]')?.parentElement).toBe(item);
    }
    // Its words are edited under its line.
    const edit = within(item).getByTestId('review-note-edit');
    expect(edit.getAttribute('aria-label')).toBe('Note on records/b.md, lines 2–4');
    expect(edit.closest('[data-slot="queue-item-detail"]')).not.toBeNull();
    fireEvent.click(view);
    expect(onOpenNote).toHaveBeenCalledWith(expect.objectContaining({ id: note.id }));
  });

  it('says why it cannot send under the line, the line and its notes kept', () => {
    added();
    dock({ blocked: true });
    const blocked = screen.getByTestId('review-notes-blocked');
    expect(blocked.closest('[data-slot="queue-section"]')).toBeNull();
    expect(blocked.parentElement).toBe(screen.getByTestId('review-notes-dock'));
    expect(screen.getByTestId('review-notes-toggle')).toBeTruthy();
  });
});
