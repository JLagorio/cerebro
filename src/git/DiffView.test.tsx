import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { UpNextEntry } from '@/agent/upNextQueue';
import { resetLayers } from '@/components/ui/layers';
import { DiffView } from './DiffView';
import type { DiffNotesTarget } from './DiffNotes';
import { useReviewNotesStore } from '@/stores/reviewNotesStore';
import { useUpNextStore } from '@/stores/upNextStore';

const DIFF = [
  'diff --git a/notes/plan.md b/notes/plan.md',
  '--- a/notes/plan.md',
  '+++ b/notes/plan.md',
  '@@ -1,3 +1,3 @@',
  ' # Plan',
  '-We ship on Thursdays.',
  '+We ship on Fridays.',
  ' The end.',
  '\\ No newline at end of file',
].join('\n');

const TARGET: DiffNotesTarget = {
  vault: '/vault',
  conversationId: 'c-1',
  runId: 'run-1',
  commit: 'c'.repeat(40),
  path: 'notes/plan.md',
};

const button = (name: string) => screen.getByRole('button', { name });
const store = () => useReviewNotesStore.getState();

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

describe('DiffView line numbers and review notes (M58.5)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayers();
    useReviewNotesStore.setState({ notes: [] });
    useUpNextStore.setState({ queues: {} });
  });
  afterEach(cleanup);

  it('renders the old and new line numbers', () => {
    const { container } = render(<DiffView diff={DIFF} />);
    const row = (kind: string, n: number) =>
      Array.from(container.querySelectorAll(`[data-kind="${kind}"]`))[n] as HTMLElement;
    const numbers = (el: HTMLElement) =>
      Array.from(el.children)
        .slice(0, 2)
        .map((c) => c.textContent);
    expect(numbers(row('context', 0))).toEqual(['1', '1']);
    expect(numbers(row('del', 0))).toEqual(['2', '']);
    expect(numbers(row('add', 0))).toEqual(['', '2']);
    expect(numbers(row('context', 1))).toEqual(['3', '3']);
    // The no-newline marker is meta and never numbered.
    const marker = Array.from(container.querySelectorAll('[data-kind="meta"]')).at(-1);
    expect(marker?.textContent).toContain('No newline');
    expect(numbers(marker as HTMLElement)).toEqual(['', '']);
  });

  it('offers no note buttons without the notes prop', () => {
    render(<DiffView diff={DIFF} />);
    expect(screen.queryAllByTestId('diff-note-line')).toHaveLength(0);
  });

  it('offers one note button per numbered line, none on meta or hunk lines', () => {
    render(<DiffView diff={DIFF} notes={TARGET} />);
    expect(
      screen.getAllByTestId('diff-note-line').map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Note on line 1 after the change',
      'Note on line 2 before the change',
      'Note on line 2 after the change',
      'Note on line 3 after the change',
    ]);
  });

  it('opens the composer on a click, and adds a note with ⌘Enter', () => {
    render(<DiffView diff={DIFF} notes={TARGET} />);
    fireEvent.click(button('Note on line 2 after the change'));
    const text = screen.getByPlaceholderText('What should change here?');
    expect(screen.getByTestId('diff-note-add')).toHaveProperty('disabled', true);
    expect(
      screen.getByText('Notes go to the agent in this conversation, not into the page.'),
    ).toBeTruthy();
    fireEvent.change(text, { target: { value: 'Say Thursday.' } });
    fireEvent.keyDown(text, { key: 'Enter', metaKey: true });
    expect(store().notes).toHaveLength(1);
    expect(store().notes[0]).toMatchObject({
      ...TARGET,
      side: 'new',
      start: 2,
      end: 2,
      excerpt: 'We ship on Fridays.',
      text: 'Say Thursday.',
    });
    expect(screen.queryByTestId('diff-note-composer')).toBeNull();
  });

  it('makes a range across sides with a shift-click', () => {
    render(<DiffView diff={DIFF} notes={TARGET} />);
    fireEvent.click(button('Note on line 2 before the change'));
    fireEvent.click(button('Note on line 2 after the change'), { shiftKey: true });
    fireEvent.change(screen.getByTestId('diff-note-text'), { target: { value: 'Both.' } });
    fireEvent.click(screen.getByTestId('diff-note-add'));
    expect(store().notes[0]).toMatchObject({
      side: 'new',
      startSide: 'old',
      start: 2,
      end: 2,
      excerpt: 'We ship on Thursdays.',
    });
  });

  it('adds no empty note', () => {
    render(<DiffView diff={DIFF} notes={TARGET} />);
    fireEvent.click(button('Note on line 1 after the change'));
    const text = screen.getByTestId('diff-note-text');
    fireEvent.change(text, { target: { value: '   ' } });
    fireEvent.keyDown(text, { key: 'Enter', metaKey: true });
    fireEvent.click(screen.getByTestId('diff-note-add'));
    expect(store().notes).toEqual([]);
    expect(screen.getByTestId('diff-note-composer')).toBeTruthy();
  });

  it('cancels the composer on Escape, and the key goes no further', () => {
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    render(<DiffView diff={DIFF} notes={TARGET} />);
    fireEvent.click(button('Note on line 1 after the change'));
    fireEvent.keyDown(screen.getByTestId('diff-note-text'), { key: 'Escape' });
    expect(screen.queryByTestId('diff-note-composer')).toBeNull();
    expect(onWindow).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindow);
  });

  it('shows each note under its end line, in queued, waiting and sent words', () => {
    const base = { ...TARGET, side: 'new' as const, excerpt: '' };
    const queued = store().add({ ...base, start: 1, end: 1, text: 'First' });
    const waiting = store().add({ ...base, start: 2, end: 2, text: 'Second' });
    const sent = store().add({ ...base, start: 3, end: 3, text: 'Third' });
    if (queued === null || waiting === null || sent === null) throw new Error('refused');
    useUpNextStore.getState().enqueue('c-1', entry('up-1'));
    store().hold([waiting.id], 'up-1');
    store().markSent([sent.id], Date.now());
    // A note on another commit is not this diff's.
    store().add({ ...base, commit: 'd'.repeat(40), start: 1, end: 1, text: 'Elsewhere' });
    const { container } = render(<DiffView diff={DIFF} notes={TARGET} />);
    const notes = screen.getAllByTestId('diff-note');
    expect(notes.map((n) => n.dataset.status)).toEqual(['queued', 'waiting', 'sent']);
    expect(screen.getAllByTestId('diff-note-status').map((n) => n.textContent)).toEqual([
      'Queued for the agent',
      'Waiting in Up next',
      'Sent to the agent just now',
    ]);
    // Under its end line: the queued note follows the first context line.
    const first = container.querySelector('[data-kind="context"]');
    expect(first?.nextElementSibling?.contains(notes[0])).toBe(true);
    // Only the queued one can be removed.
    expect(within(notes[0]).queryByTestId('diff-note-remove')).toBeTruthy();
    expect(within(notes[1]).queryByTestId('diff-note-remove')).toBeNull();
    // Its entry removed, the waiting note reads queued again.
    act(() => useUpNextStore.getState().remove('c-1', 'up-1'));
    expect(screen.getAllByTestId('diff-note-status')[1].textContent).toBe('Queued for the agent');
  });

  it('removes a queued note', () => {
    store().add({ ...TARGET, side: 'new', start: 1, end: 1, excerpt: '', text: 'Gone' });
    render(<DiffView diff={DIFF} notes={TARGET} />);
    fireEvent.click(screen.getByTestId('diff-note-remove'));
    expect(screen.queryByTestId('diff-note')).toBeNull();
    expect(store().notes).toEqual([]);
  });

  it('keeps the draft across a re-render', () => {
    const { rerender } = render(<DiffView diff={DIFF} notes={TARGET} />);
    fireEvent.click(button('Note on line 1 after the change'));
    fireEvent.change(screen.getByTestId('diff-note-text'), { target: { value: 'Half a tho' } });
    rerender(<DiffView diff={DIFF} notes={{ ...TARGET }} />);
    expect(screen.getByTestId('diff-note-text')).toHaveProperty('value', 'Half a tho');
  });
});
