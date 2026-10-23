import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { UpNext, type UpNextView } from './UpNext';
import type { UpNextEntry } from './upNextQueue';

// STEER_BY_RESTART is the kill-resume recording's to decide (F17); a test
// flips it here to see Steer hide.
const flags = vi.hoisted(() => ({ steer: true }));
vi.mock('./upNextQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./upNextQueue')>();
  return {
    ...actual,
    get STEER_BY_RESTART() {
      return flags.steer;
    },
  };
});

afterEach(() => {
  cleanup();
  flags.steer = true;
});

const entry = (id: string, over: Partial<UpNextEntry> = {}): UpNextEntry => ({
  id,
  text: `message ${id}`,
  skill: null,
  narrowing: {},
  turn: { systemPrompt: () => '', place: null, conversationId: 'c-1' },
  vault: '/vault',
  queuedAt: 0,
  ...over,
});

const view = (over: Partial<UpNextView> = {}): UpNextView => ({
  entries: [entry('a'), entry('h', { text: 'Ask to revise · A', prompt: 'REVISE A' })],
  held: false,
  steering: null,
  editing: null,
  full: false,
  busy: false,
  edit: vi.fn(() => true),
  beginEdit: vi.fn(),
  endEdit: vi.fn(),
  remove: vi.fn(),
  steer: vi.fn(),
  resume: vi.fn(),
  ...over,
});

describe('UpNext (M57.5)', () => {
  it('draws nothing while nothing waits', () => {
    render(<UpNext upNext={view({ entries: [] })} />);
    expect(screen.queryByTestId('up-next')).toBeNull();
  });

  it('lists entries in run order, next first, under its heading', () => {
    render(<UpNext upNext={view()} />);
    expect(screen.getByRole('heading', { name: 'Up next' })).toBeDefined();
    const rows = screen.getAllByTestId('up-next-entry');
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['a', 'h']);
  });

  it('offers Steer only while a turn is busy', () => {
    const steer = vi.fn();
    const { rerender } = render(<UpNext upNext={view({ steer })} />);
    expect(screen.queryByTestId('up-next-steer')).toBeNull();
    rerender(<UpNext upNext={view({ steer, busy: true })} />);
    const buttons = screen.getAllByTestId('up-next-steer');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(steer).toHaveBeenCalledWith('h');
  });

  it('hides Steer when the transport cannot restart a stopped run', () => {
    flags.steer = false;
    render(<UpNext upNext={view({ busy: true })} />);
    expect(screen.queryByTestId('up-next-steer')).toBeNull();
    // Up next still edits and removes.
    expect(screen.getAllByTestId('up-next-remove')).toHaveLength(2);
    expect(screen.getAllByTestId('up-next-edit')).toHaveLength(1);
  });

  it('offers Run now only while held, and the held banner with Resume', () => {
    const steer = vi.fn();
    const resume = vi.fn();
    const { rerender } = render(<UpNext upNext={view({ steer, resume })} />);
    expect(screen.queryByTestId('up-next-run-now')).toBeNull();
    expect(screen.queryByTestId('up-next-held')).toBeNull();
    rerender(<UpNext upNext={view({ steer, resume, held: true })} />);
    expect(screen.getByTestId('up-next-held').textContent).toContain(
      'Up next is on hold because the last turn stopped.',
    );
    fireEvent.click(screen.getAllByTestId('up-next-run-now')[0]);
    expect(steer).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByTestId('up-next-resume'));
    expect(resume).toHaveBeenCalledOnce();
  });

  it('offers Edit only on typed entries, never on a page ask', () => {
    const beginEdit = vi.fn();
    render(<UpNext upNext={view({ beginEdit })} />);
    const edits = screen.getAllByTestId('up-next-edit');
    expect(edits).toHaveLength(1);
    fireEvent.click(edits[0]);
    expect(beginEdit).toHaveBeenCalledWith('a');
  });

  it('offers no Edit on a review-notes entry (M58.5)', () => {
    render(
      <UpNext
        upNext={view({
          entries: [entry('n', { text: 'I reviewed your changes…', notes: { ids: ['rn-1'] } })],
        })}
      />,
    );
    expect(screen.getByTestId('up-next-entry')).toBeTruthy();
    expect(screen.queryByTestId('up-next-edit')).toBeNull();
    expect(screen.getByTestId('up-next-remove')).toBeTruthy();
  });

  it('saves the editor on Enter and on blur, and cancels on Escape', () => {
    const edit = vi.fn(() => true);
    const endEdit = vi.fn();
    const { unmount } = render(<UpNext upNext={view({ editing: 'a', edit, endEdit })} />);
    const editor = screen.getByTestId('up-next-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe('message a');
    fireEvent.change(editor, { target: { value: 'better words' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(edit).toHaveBeenCalledWith('a', 'better words');
    expect(endEdit).toHaveBeenCalledOnce();
    // The blur that follows the save does not save twice.
    fireEvent.blur(editor);
    expect(edit).toHaveBeenCalledOnce();
    unmount();

    const blurred = vi.fn(() => true);
    const { unmount: unmountBlur } = render(
      <UpNext upNext={view({ editing: 'a', edit: blurred, endEdit })} />,
    );
    const second = screen.getByTestId('up-next-editor');
    fireEvent.change(second, { target: { value: 'on blur' } });
    fireEvent.blur(second);
    expect(blurred).toHaveBeenCalledWith('a', 'on blur');
    unmountBlur();

    const cancelled = vi.fn(() => true);
    const cancelEnd = vi.fn();
    render(<UpNext upNext={view({ editing: 'a', edit: cancelled, endEdit: cancelEnd })} />);
    const third = screen.getByTestId('up-next-editor');
    fireEvent.change(third, { target: { value: 'never mind' } });
    fireEvent.keyDown(third, { key: 'Escape' });
    fireEvent.blur(third);
    expect(cancelled).not.toHaveBeenCalled();
    expect(cancelEnd).toHaveBeenCalledOnce();
  });

  it('leaves the Enter that ends an IME composition to the composition', () => {
    const edit = vi.fn(() => true);
    render(<UpNext upNext={view({ editing: 'a', edit })} />);
    const editor = screen.getByTestId('up-next-editor');
    fireEvent.change(editor, { target: { value: 'にほんご' } });
    expect(fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(edit).toHaveBeenCalledWith('a', 'にほんご');
  });

  it('removes an entry', () => {
    const remove = vi.fn();
    render(<UpNext upNext={view({ remove })} />);
    fireEvent.click(screen.getAllByTestId('up-next-remove')[1]);
    expect(remove).toHaveBeenCalledWith('h');
  });

  it('reads Starting… on the steered row, and offers no second Steer', () => {
    render(<UpNext upNext={view({ busy: true, steering: 'h' })} />);
    const [first, steered] = screen.getAllByTestId('up-next-entry');
    expect(steered.textContent).toContain('Starting…');
    expect(steered.querySelector('[data-testid="up-next-remove"]')).toBeNull();
    expect(first.querySelector('[data-testid="up-next-steer"]')).toBeNull();
  });

  it('states the cap when full', () => {
    render(<UpNext upNext={view({ full: true })} />);
    expect(screen.getByTestId('up-next-full').textContent).toBe(
      'Up next holds 10 messages. Remove one, or wait for this turn to finish.',
    );
  });

  // Motion (owner, 2026-10-19): what the conversation opened holding is
  // simply there; the list comes in when it comes to hold something, and an
  // entry joining it on its own.
  it('brings in what comes to wait, and nothing it opened with', () => {
    const marked = () =>
      [screen.getByTestId('up-next'), ...screen.getAllByTestId('up-next-entry')].map((el) =>
        el.hasAttribute('data-arrive'),
      );
    const opened = render(<UpNext upNext={view()} />);
    expect(marked()).toEqual([false, false, false]);
    opened.unmount();
    const { rerender } = render(<UpNext upNext={view({ entries: [] })} />);
    rerender(<UpNext upNext={view({ entries: [entry('a')] })} />);
    expect(marked()).toEqual([true, false]);
    rerender(<UpNext upNext={view({ entries: [entry('a'), entry('b')] })} />);
    expect(marked()).toEqual([true, false, true]);
  });

  // M91.12a — the list is a Queue: a named region over its heading, items
  // whose actions sit beside their line, and a starting row that says so in
  // words before its message.
  it('is a Queue: the region and heading Up next, and each entry an item with its actions beside it', () => {
    render(<UpNext upNext={view({ held: true })} />);
    const region = screen.getByRole('region', { name: 'Up next' });
    expect(region).toBe(screen.getByTestId('up-next'));
    expect(region.dataset.slot).toBe('queue');
    const heading = screen.getByRole('heading', { level: 3, name: 'Up next' });
    expect(heading.querySelector('[title]')?.getAttribute('title')).toBe(
      'Up next holds up to 10 messages.',
    );
    // Resume is the section's action, beside its heading, and the hold is
    // said in the section above the list.
    const resume = screen.getByTestId('up-next-resume');
    expect(resume.closest('[data-slot="queue-section-actions"]')).not.toBeNull();
    expect(heading.contains(resume)).toBe(false);
    const [first] = screen.getAllByTestId('up-next-entry');
    expect(first.tagName).toBe('LI');
    expect(first.dataset.slot).toBe('queue-item');
    const remove = within(first).getByRole('button', { name: 'Remove from Up next' });
    expect(remove.closest('[data-slot="queue-item-actions"]')?.parentElement).toBe(first);
    expect(remove.closest('[data-slot="trace-line"]')).toBeNull();
    // Its words are the line's own sentence, the whole of them on hover.
    const text = within(first).getByTestId('up-next-text');
    expect(text.textContent).toBe('message a');
    expect(text.dataset.slot).toBe('trace-title');
    expect(text.getAttribute('title')).toBe('message a');
  });

  it('says Starting… before the steered message, the working light standing for its actions', () => {
    render(<UpNext upNext={view({ busy: true, steering: 'h' })} />);
    const steered = screen.getAllByTestId('up-next-entry')[1];
    const line = steered.querySelector('[data-slot="trace-line"]') as HTMLElement;
    expect(line.querySelector('.sr-only')?.textContent).toBe('Starting…: ');
    const light = steered.querySelector('.cb-working-text') as HTMLElement;
    expect(light.textContent).toBe('Starting…');
    expect(light.getAttribute('aria-hidden')).toBe('true');
    expect(within(steered).queryAllByRole('button')).toEqual([]);
  });

  it('opens the editor in place of its line, offering nothing beside it', () => {
    render(<UpNext upNext={view({ editing: 'a' })} />);
    const [editing] = screen.getAllByTestId('up-next-entry');
    const editor = within(editing).getByTestId('up-next-editor');
    expect(editor.closest('[data-slot="queue-item-detail"]')).not.toBeNull();
    // No words and no icon: the line is empty, and the editor stands for it.
    expect(editing.querySelector('[data-slot="trace-line"]')?.childNodes).toHaveLength(0);
    expect(within(editing).queryByTestId('up-next-text')).toBeNull();
    expect(within(editing).queryAllByRole('button')).toEqual([]);
  });
});
