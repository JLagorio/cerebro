// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { outsideVault, PERMISSION_COPY, PermissionCard } from '@/agent/PermissionCard';
import type { WaitingCard } from '@/agent/useAgentChat';

/**
 * The card the shell ceiling's asks show (M57.2), drawn as a Confirmation
 * (M91.12b): the exact subject, as text; the outside-the-vault line; the
 * three answers it sends, by pointer and by keyboard; and how it reads while
 * an answer is on its way or once it came too late.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

const ANSWERS = ['permission-allow-once', 'permission-allow-conversation', 'permission-deny'];

/** The keydown listeners added to window and document while `run` runs. */
function keydownsDuring(run: () => void): number {
  const onWindow = vi.spyOn(window, 'addEventListener');
  const onDocument = vi.spyOn(document, 'addEventListener');
  try {
    run();
    return [...onWindow.mock.calls, ...onDocument.mock.calls].filter(([type]) => type === 'keydown')
      .length;
  } finally {
    onWindow.mockRestore();
    onDocument.mockRestore();
  }
}

describe('PermissionCard', () => {
  it('titles the family and names the subject verbatim, as text', () => {
    render(<PermissionCard interaction={waiting()} onAnswer={vi.fn()} vaultPath="/v" />);
    const card = screen.getByTestId('permission-card');
    expect(card.getAttribute('data-family')).toBe('shell');
    expect(card.getAttribute('data-tool')).toBe('Bash');
    expect(card.textContent).toContain('Run this command?');
    expect(card.textContent).toContain(PERMISSION_COPY.lead);
    expect(screen.getByTestId('permission-subject').textContent).toBe(
      'git status && echo "<b>done</b>"',
    );
    expect(card.querySelector('b')).toBeNull();
    expect(screen.queryByTestId('permission-outside')).toBeNull();
  });

  it('is a Confirmation: a group named by what it asks, waiting', () => {
    render(<PermissionCard interaction={waiting()} onAnswer={vi.fn()} vaultPath="/v" />);
    const card = screen.getByRole('group', { name: 'Run this command?' });
    expect(card).toBe(screen.getByTestId('permission-card'));
    expect(card.dataset.slot).toBe('confirmation');
    expect(card.dataset.state).toBe('waiting');
    expect(card.getAttribute('aria-busy')).toBeNull();
    expect(
      card.querySelector('[data-icon="shield-question-mark"]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(screen.getByTestId('permission-subject').tagName).toBe('PRE');
    // Its answers are the three it always had: no reason field.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      PERMISSION_COPY.once,
      PERMISSION_COPY.conversation,
      PERMISSION_COPY.deny,
    ]);
  });

  it('titles a card with no family card by its own words', () => {
    render(
      <PermissionCard
        interaction={waiting({ family: 'file_read' })}
        onAnswer={vi.fn()}
        vaultPath="/v"
      />,
    );
    expect(screen.getByRole('group', { name: PERMISSION_COPY.fallbackTitle }).dataset.family).toBe(
      'file_read',
    );
  });

  it('names the summary when the call has no subject', () => {
    render(
      <PermissionCard
        interaction={waiting({ subject: null, summary: 'Bash · make release' })}
        onAnswer={vi.fn()}
        vaultPath="/v"
      />,
    );
    expect(screen.getByTestId('permission-subject').textContent).toBe('Bash · make release');
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

  it('answers from the keyboard, in reading order', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<PermissionCard interaction={waiting()} onAnswer={onAnswer} vaultPath="/v" />);
    const visited: (string | null)[] = [];
    for (let at = 0; at < ANSWERS.length; at += 1) {
      await user.tab();
      visited.push(document.activeElement?.getAttribute('data-testid') ?? null);
    }
    expect(visited).toEqual(ANSWERS);
    await user.keyboard('{Enter}');
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny' });
    await user.tab({ shift: true });
    await user.keyboard(' ');
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'allow', remember: 'conversation' });
  });

  it('adds no window or document keydown listener, drawn and answered', () => {
    const added = keydownsDuring(() => {
      render(<PermissionCard interaction={waiting()} onAnswer={vi.fn()} vaultPath="/v" />);
      fireEvent.keyDown(screen.getByTestId('permission-allow-once'), { key: 'Enter' });
      fireEvent.click(screen.getByTestId('permission-allow-once'));
    });
    expect(added).toBe(0);
  });

  it('is disabled while an answer is in flight, and once it came too late', () => {
    const onAnswer = vi.fn();
    const { rerender } = render(
      <PermissionCard
        interaction={waiting({}, { answering: true })}
        onAnswer={onAnswer}
        vaultPath="/v"
      />,
    );
    for (const id of ANSWERS) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    const card = screen.getByTestId('permission-card');
    expect(card.getAttribute('data-state')).toBe('answering');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('interaction-stale')).toBeNull();
    rerender(
      <PermissionCard
        interaction={waiting({}, { stale: 'No longer waiting.' })}
        onAnswer={onAnswer}
        vaultPath="/v"
      />,
    );
    expect(screen.getByTestId('permission-card').getAttribute('data-state')).toBe('stale');
    expect(screen.getByTestId('permission-card').getAttribute('aria-busy')).toBeNull();
    expect(screen.getByTestId('interaction-stale').textContent).toBe('No longer waiting.');
    for (const id of ANSWERS) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByTestId('permission-deny'));
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
