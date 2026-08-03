// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FieldPopover } from '@/detail/FieldPopover';

afterEach(cleanup);

const OPTIONS = [
  { id: 'todo', label: 'Todo', color: null },
  { id: 'doing', label: 'Doing', color: null },
];

describe('FieldPopover', () => {
  // The multi-value footer promises "Esc or click away to close" and the
  // component had no keydown handler at all — Escape fell through to the
  // record panel's window listener and destroyed the record instead.
  it('closes itself on Escape', () => {
    const onClose = vi.fn();
    render(<FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // …and it must swallow the keystroke so nothing behind it also acts.
  it('stops Escape from reaching listeners behind it', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      render(
        <FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={() => {}} />,
      );
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('leaves other keys alone', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      render(
        <FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={() => {}} />,
      );
      fireEvent.keyDown(window, { key: 'a' });
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('keeps the dismiss scrim out of the tab order', () => {
    render(<FieldPopover options={OPTIONS} activeIds={[]} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText('Close popover').getAttribute('tabindex')).toBe('-1');
  });

  // A freshly declared Select has no options; "No matches" told the user
  // nothing about where options come from.
  it('explains an empty option set instead of saying "No matches"', () => {
    render(
      <FieldPopover
        options={[]}
        activeId={null}
        emptyHint="No options yet — add them on the type screen."
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('No options yet — add them on the type screen.')).toBeTruthy();
  });

  it('offers to create a label that matches no option', () => {
    const onCreate = vi.fn();
    render(
      <FieldPopover
        searchable
        options={OPTIONS}
        activeId={null}
        onCreate={onCreate}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Blocked' } });
    fireEvent.click(screen.getByText('Blocked').closest('button')!);
    expect(onCreate).toHaveBeenCalledWith('Blocked');
  });
});
