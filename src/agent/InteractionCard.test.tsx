// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_COPY, CARD_RENDERERS, InteractionCard } from '@/agent/InteractionCard';
import type { WaitingCard } from '@/agent/useAgentChat';

/**
 * The card a held call shows (M57.1), drawn as a Confirmation (M91.12b):
 * what it names, what its buttons send, by pointer and by keyboard, and how
 * it reads once an answer is on its way or came too late.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const waiting = (over: Partial<WaitingCard> = {}): WaitingCard => ({
  card: {
    id: 'c'.repeat(32),
    kind: 'permission',
    tool_name: 'mcp__cerebro__append_to_note',
    tool_id: 't-1',
    session_id: 's-1',
    summary: 'Append to a note · notes/inbox.md',
    input: '{\n  "path": "notes/inbox.md",\n  "content": "<b>bold</b>"\n}',
    asked_at: '2026-10-14T12:00:00.000Z',
  },
  messageId: 'm-2',
  answering: false,
  stale: null,
  ...over,
});

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

describe('InteractionCard', () => {
  it('names the tool and the summary, the input behind a disclosure, as text', () => {
    render(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('interaction-card');
    expect(card.getAttribute('data-kind')).toBe('permission');
    expect(card.getAttribute('data-tool')).toBe('mcp__cerebro__append_to_note');
    expect(card.getAttribute('data-state')).toBe('waiting');
    expect(card.textContent).toContain(CARD_COPY.title);
    expect(screen.getByTestId('interaction-tool').textContent).toBe('append to note');
    expect(screen.getByTestId('interaction-summary').textContent).toBe(
      'Append to a note · notes/inbox.md',
    );
    const input = screen.getByTestId('interaction-input');
    expect(input.closest('details')).not.toBeNull();
    expect((input.closest('details') as HTMLDetailsElement).open).toBe(false);
    // The agent's input is text, never markup.
    expect(input.textContent).toContain('<b>bold</b>');
    expect(input.querySelector('b')).toBeNull();
    expect(screen.getByTestId('interaction-deny-message').getAttribute('placeholder')).toBe(
      'Tell the agent why (optional)',
    );
  });

  it('is a Confirmation: a group named by its title, the reason above its answers', () => {
    render(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByRole('group', { name: CARD_COPY.title });
    expect(card).toBe(screen.getByTestId('interaction-card'));
    expect(card.dataset.slot).toBe('confirmation');
    expect(card.querySelector('[data-icon="clock"]')?.getAttribute('aria-hidden')).toBe('true');
    const reason = screen.getByRole('textbox', { name: CARD_COPY.denyPlaceholder });
    expect(reason).toBe(screen.getByTestId('interaction-deny-message'));
    expect(reason.getAttribute('maxlength')).toBe('2000');
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      CARD_COPY.allow,
      CARD_COPY.deny,
    ]);
    expect(
      reason.compareDocumentPosition(screen.getByTestId('interaction-allow')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('sends Allow once and Deny as the person’s answers', () => {
    const onAnswer = vi.fn();
    render(<InteractionCard interaction={waiting()} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId('interaction-allow'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'allow' });
    expect(screen.getByTestId('interaction-allow').textContent).toBe('Allow once');
    fireEvent.click(screen.getByTestId('interaction-deny'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny' });
    fireEvent.change(screen.getByTestId('interaction-deny-message'), {
      target: { value: '  not this week  ' },
    });
    fireEvent.click(screen.getByTestId('interaction-deny'));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny', message: 'not this week' });
  });

  it('answers from the keyboard: the reason, then Allow once, then Deny', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<InteractionCard interaction={waiting()} onAnswer={onAnswer} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('interaction-deny-message'));
    await user.keyboard('not today');
    // Enter in the reason field answers nothing: only a button does.
    await user.keyboard('{Enter}');
    expect(onAnswer).not.toHaveBeenCalled();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('interaction-allow'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('interaction-deny'));
    await user.keyboard('{Enter}');
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny', message: 'not today' });
    await user.tab({ shift: true });
    await user.keyboard(' ');
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'allow' });
  });

  it('adds no window or document keydown listener, drawn and answered', () => {
    const added = keydownsDuring(() => {
      render(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
      const reason = screen.getByTestId('interaction-deny-message');
      fireEvent.change(reason, { target: { value: 'Not now' } });
      fireEvent.keyDown(reason, { key: 'Enter' });
      fireEvent.click(screen.getByTestId('interaction-deny'));
    });
    expect(added).toBe(0);
  });

  it('is disabled while an answer is in flight', () => {
    const onAnswer = vi.fn();
    render(<InteractionCard interaction={waiting({ answering: true })} onAnswer={onAnswer} />);
    const card = screen.getByTestId('interaction-card');
    expect(card.getAttribute('data-state')).toBe('answering');
    expect(card.getAttribute('aria-busy')).toBe('true');
    for (const id of ['interaction-allow', 'interaction-deny', 'interaction-deny-message']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
    fireEvent.click(screen.getByTestId('interaction-allow'));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('keeps the person’s unsent reason while an answer comes and goes', () => {
    const { rerender } = render(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('interaction-card');
    fireEvent.change(screen.getByTestId('interaction-deny-message'), {
      target: { value: 'My unsent response' },
    });
    rerender(<InteractionCard interaction={waiting({ answering: true })} onAnswer={vi.fn()} />);
    rerender(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('interaction-card')).toBe(card);
    expect((screen.getByTestId('interaction-deny-message') as HTMLInputElement).value).toBe(
      'My unsent response',
    );
  });

  it('says when an answer came too late, and takes no other', () => {
    const onAnswer = vi.fn();
    const stale = 'No longer waiting: this request was already answered or cancelled.';
    render(<InteractionCard interaction={waiting({ stale })} onAnswer={onAnswer} />);
    expect(screen.getByTestId('interaction-stale').textContent).toBe(stale);
    expect(screen.getByTestId('interaction-card').getAttribute('data-state')).toBe('stale');
    for (const id of ['interaction-allow', 'interaction-deny', 'interaction-deny-message']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
    fireEvent.click(screen.getByTestId('interaction-allow'));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('draws by kind, and a kind this build does not know as a permission', () => {
    expect(Object.keys(CARD_RENDERERS)).toEqual(['permission', 'question']);
    const unknown = waiting();
    unknown.card = { ...unknown.card, kind: 'teleport' };
    render(<InteractionCard interaction={unknown} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('interaction-card').getAttribute('data-kind')).toBe('teleport');
    expect(screen.getByTestId('interaction-allow')).toBeTruthy();
  });

  it('draws a question as a question card (M57.3), and a permission as it was', () => {
    const asked = waiting();
    asked.card = {
      ...asked.card,
      kind: 'question',
      tool_name: 'AskUserQuestion',
      family: 'question',
      questions: [
        {
          question: 'Which format?',
          header: 'Format',
          options: [
            { label: 'Markdown', description: '', preview: null },
            { label: 'Plain text', description: '', preview: null },
          ],
          multiSelect: false,
        },
      ],
    };
    const { unmount } = render(<InteractionCard interaction={asked} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('question-card')).toBeTruthy();
    expect(screen.queryByTestId('interaction-card')).toBeNull();
    expect(screen.getByTestId('question-text').textContent).toBe('Which format?');
    unmount();
    render(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('interaction-card').getAttribute('data-kind')).toBe('permission');
    expect(screen.queryByTestId('question-card')).toBeNull();
  });
});
