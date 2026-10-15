// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARD_COPY, CARD_RENDERERS, InteractionCard } from '@/agent/InteractionCard';
import type { WaitingCard } from '@/agent/useAgentChat';

/**
 * The card a held call shows (M57.1): what it names, what its buttons send,
 * and how it reads once an answer is on its way or came too late.
 */

afterEach(cleanup);

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

describe('InteractionCard', () => {
  it('names the tool and the summary, the input behind a disclosure, as text', () => {
    render(<InteractionCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('interaction-card');
    expect(card.getAttribute('data-kind')).toBe('permission');
    expect(card.getAttribute('data-state')).toBe('waiting');
    expect(card.textContent).toContain(CARD_COPY.title);
    expect(screen.getByTestId('interaction-tool').textContent).toBe('append to note');
    expect(screen.getByTestId('interaction-summary').textContent).toBe(
      'Append to a note · notes/inbox.md',
    );
    const input = screen.getByTestId('interaction-input');
    expect(input.closest('details')).not.toBeNull();
    // The agent's input is text, never markup.
    expect(input.textContent).toContain('<b>bold</b>');
    expect(input.querySelector('b')).toBeNull();
    expect(screen.getByTestId('interaction-deny-message').getAttribute('placeholder')).toBe(
      'Tell the agent why (optional)',
    );
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

  it('is disabled while an answer is in flight', () => {
    const onAnswer = vi.fn();
    render(<InteractionCard interaction={waiting({ answering: true })} onAnswer={onAnswer} />);
    expect(screen.getByTestId('interaction-card').getAttribute('data-state')).toBe('answering');
    for (const id of ['interaction-allow', 'interaction-deny', 'interaction-deny-message']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
    fireEvent.click(screen.getByTestId('interaction-allow'));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('says when an answer came too late, and takes no other', () => {
    const stale = 'No longer waiting: this request was already answered or cancelled.';
    render(<InteractionCard interaction={waiting({ stale })} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('interaction-stale').textContent).toBe(stale);
    expect(screen.getByTestId('interaction-card').getAttribute('data-state')).toBe('stale');
    expect((screen.getByTestId('interaction-allow') as HTMLButtonElement).disabled).toBe(true);
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
