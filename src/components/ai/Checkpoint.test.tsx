// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKPOINT_WORDS, Checkpoint } from './Checkpoint';

/**
 * Checkpoint (M91.9, Q8): "Branch from here", never "Restore" — a branch
 * starts a new conversation and rolls no file back, and says so — on a
 * labelled divider with no separator role (§3.3).
 */

afterEach(cleanup);

const TURN = 'your message “Plan the launch”';

describe('Checkpoint', () => {
  it('names its button with the turn it branches from, and says files stay', () => {
    render(<Checkpoint turn={TURN} onBranch={() => undefined} />);
    const button = screen.getByRole('button', {
      name: 'Branch from here, after your message “Plan the launch”',
      description: 'Files stay as they are',
    });
    expect(button.textContent).toBe('Branch from here');
    expect(screen.getByText('Files stay as they are')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/restore/i);
  });

  it('is a labelled divider with no separator role', () => {
    render(<Checkpoint turn={TURN} onBranch={() => undefined} data-testid="checkpoint" />);
    const root = screen.getByTestId('checkpoint');
    expect(root.getAttribute('role')).toBeNull();
    expect(document.querySelector('[role="separator"]')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(root.querySelector('[data-slot="checkpoint-icon"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('branches on a click, and not while it cannot', () => {
    const onBranch = vi.fn();
    const { rerender } = render(
      <Checkpoint turn={TURN} onBranch={onBranch} triggerTestId="branch-from-here" />,
    );
    fireEvent.click(screen.getByTestId('branch-from-here'));
    expect(onBranch).toHaveBeenCalledOnce();
    rerender(
      <Checkpoint turn={TURN} onBranch={onBranch} triggerTestId="branch-from-here" disabled />,
    );
    const button = screen.getByTestId('branch-from-here') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onBranch).toHaveBeenCalledOnce();
    expect(button.getAttribute('type')).toBe('button');
  });

  it('keeps its words in one place', () => {
    expect(CHECKPOINT_WORDS.branch).toBe('Branch from here');
    expect(CHECKPOINT_WORDS.note).toBe('Files stay as they are');
    expect(CHECKPOINT_WORDS.name('the third turn')).toBe('Branch from here, after the third turn');
  });
});
