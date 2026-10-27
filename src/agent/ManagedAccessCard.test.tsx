import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedAccessCard } from './ManagedAccessCard';
import type { WaitingCard } from './useAgentChat';

afterEach(cleanup);
const waiting = (): WaitingCard => ({
  card: {
    id: 'c'.repeat(32),
    kind: 'managed_access',
    run: 41,
    tool_name: 'mcp__cerebro__list_actions',
    tool_id: null,
    session_id: 'original-session',
    summary: '<b>Choose access</b>',
    input: '',
    asked_at: '2026-10-26T12:00:00Z',
  },
  messageId: 'original-reply',
  answering: false,
  stale: null,
});
describe('held managed access card', () => {
  it('offers an account choice on the exact original run and request without effect approval', () => {
    const choose = vi.fn();
    render(<ManagedAccessCard interaction={waiting()} onChooseAccess={choose} />);
    const card = screen.getByRole('group', { name: 'Choose access for this run' });
    expect(card.getAttribute('data-slot')).toBe('confirmation');
    expect(screen.queryByRole('button', { name: /allow|deny/i })).toBeNull();
    expect(choose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose access' }));
    expect(choose).toHaveBeenCalledExactlyOnceWith(41, 'c'.repeat(32));
    expect(card.querySelector('b')).toBeNull();
  });
  it('makes a missing or unsafe original native run unavailable without inventing a selector', () => {
    for (const run of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const current = waiting();
      current.card.run = run;
      const choose = vi.fn();
      const shown = render(<ManagedAccessCard interaction={current} onChooseAccess={choose} />);
      expect(
        screen.getByText(
          'The original run was not recorded. Access cannot be changed from this card.',
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Choose access' })).toBeNull();
      expect(choose).not.toHaveBeenCalled();
      shown.unmount();
    }
  });
  it('does not offer an editable access sheet after the original wait has become stale', () => {
    const current = waiting();
    current.stale = 'This run has ended.';
    const choose = vi.fn();
    render(<ManagedAccessCard interaction={current} onChooseAccess={choose} />);
    expect(screen.getByText('This run has ended.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose access' })).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });
  it('shows unavailable when this presentation has no access controller', () => {
    render(<ManagedAccessCard interaction={waiting()} />);
    expect(screen.getByText('Access controls are unavailable in this view.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose access' })).toBeNull();
  });
});

it('chooses access for the genuine first original native run zero', () => {
  const interaction = waiting();
  interaction.card.run = 0;
  const choose = vi.fn();
  render(<ManagedAccessCard interaction={interaction} onChooseAccess={choose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose access' }));
  expect(choose).toHaveBeenCalledExactlyOnceWith(0, 'c'.repeat(32));
});
