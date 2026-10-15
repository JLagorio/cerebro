// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { outsideVault, PERMISSION_COPY, PermissionCard } from '@/agent/PermissionCard';
import type { WaitingCard } from '@/agent/useAgentChat';

/**
 * The card the shell ceiling's asks show (M57.2): the exact subject, as
 * text; the outside-the-vault line; and the three answers it sends.
 */

afterEach(cleanup);

const waiting = (over: Partial<WaitingCard['card']> = {}, state: Partial<WaitingCard> = {}) =>
  ({
    card: {
      id: 'c'.repeat(32),
      kind: 'permission',
      tool_name: 'Bash',
      tool_id: 't-1',
      session_id: 's-1',
      summary: 'Bash',
      family: 'shell',
      subject: 'git status && echo "<b>done</b>"',
      input: '{}',
      asked_at: '2026-10-14T12:00:00.000Z',
      ...over,
    },
    messageId: 'm-2',
    answering: false,
    stale: null,
    ...state,
  }) satisfies WaitingCard;

describe('PermissionCard', () => {
  it('titles the family and names the subject verbatim, as text', () => {
    render(<PermissionCard interaction={waiting()} onAnswer={vi.fn()} vaultPath="/v" />);
    const card = screen.getByTestId('permission-card');
    expect(card.getAttribute('data-family')).toBe('shell');
    expect(card.textContent).toContain('Run this command?');
    expect(card.textContent).toContain(PERMISSION_COPY.lead);
    expect(screen.getByTestId('permission-subject').textContent).toBe(
      'git status && echo "<b>done</b>"',
    );
    expect(card.querySelector('b')).toBeNull();
    expect(screen.queryByTestId('permission-outside')).toBeNull();
  });

  it('titles a file change, and says when its path is outside the vault', () => {
    const { rerender } = render(
      <PermissionCard
        interaction={waiting({ tool_name: 'Write', family: 'file_write', subject: '/etc/hosts' })}
        onAnswer={vi.fn()}
        vaultPath="/v"
      />,
    );
    expect(screen.getByTestId('permission-card').textContent).toContain('Change this file?');
    expect(screen.getByTestId('permission-outside').textContent).toBe(PERMISSION_COPY.outside);
    rerender(
      <PermissionCard
        interaction={waiting({
          tool_name: 'Write',
          family: 'file_write',
          subject: '/v/notes/a.md',
        })}
        onAnswer={vi.fn()}
        vaultPath="/v"
      />,
    );
    expect(screen.queryByTestId('permission-outside')).toBeNull();
  });

  it('reads only path subjects for the outside line', () => {
    expect(outsideVault('Write', '/v/a.md', '/v/')).toBe(false);
    expect(outsideVault('Write', '/vault-two/a.md', '/v')).toBe(true);
    expect(outsideVault('Edit', '../secrets.txt', '/v')).toBe(true);
    expect(outsideVault('Edit', 'notes/a.md', '/v')).toBe(false);
    expect(outsideVault('NotebookEdit', '~/a.ipynb', '/v')).toBe(true);
    // A command is not a path, whatever it holds.
    expect(outsideVault('Bash', '/etc/hosts', '/v')).toBe(false);
  });

  it('sends once, conversation and deny', () => {
    const onAnswer = vi.fn();
    render(<PermissionCard interaction={waiting()} onAnswer={onAnswer} vaultPath="/v" />);
    fireEvent.click(screen.getByTestId('permission-allow-once'));
    fireEvent.click(screen.getByTestId('permission-allow-conversation'));
    fireEvent.click(screen.getByTestId('permission-deny'));
    expect(onAnswer.mock.calls).toEqual([
      [{ kind: 'allow', remember: 'once' }],
      [{ kind: 'allow', remember: 'conversation' }],
      [{ kind: 'deny' }],
    ]);
  });

  it('is disabled while an answer is in flight, and once it came too late', () => {
    const { rerender } = render(
      <PermissionCard
        interaction={waiting({}, { answering: true })}
        onAnswer={vi.fn()}
        vaultPath="/v"
      />,
    );
    for (const id of [
      'permission-allow-once',
      'permission-allow-conversation',
      'permission-deny',
    ]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByTestId('permission-card').getAttribute('data-state')).toBe('answering');
    rerender(
      <PermissionCard
        interaction={waiting({}, { stale: 'No longer waiting.' })}
        onAnswer={vi.fn()}
        vaultPath="/v"
      />,
    );
    expect(screen.getByTestId('interaction-stale').textContent).toBe('No longer waiting.');
    expect((screen.getByTestId('permission-deny') as HTMLButtonElement).disabled).toBe(true);
  });
});
