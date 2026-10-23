// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Icon } from '@/components/ui/Icon';
import {
  Bubble,
  BubbleContent,
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
  MessageToolbar,
} from './Message';

/**
 * Message (M91.8): the person's turn at the end in a bubble, the agent's at
 * the start, and the turn's actions — Copy, Retry, Edit and Branch, each only
 * when it has something to do, and no feedback toggles.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Message', () => {
  it('puts the person’s turn at the end and the agent’s at the start', () => {
    render(
      <MessageGroup data-testid="group">
        <Message from="user" data-testid="mine">
          <MessageContent>
            <Bubble>
              <BubbleContent>{'Two lines\nof text'}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
        <Message data-testid="reply">
          <MessageHeader>Assistant</MessageHeader>
          <MessageContent>Here is a plan.</MessageContent>
        </Message>
        <Message from="user" align="start" data-testid="moved" />
      </MessageGroup>,
    );
    const mine = screen.getByTestId('mine');
    expect(mine.dataset.role).toBe('user');
    expect(mine.dataset.align).toBe('end');
    const reply = screen.getByTestId('reply');
    expect(reply.dataset.role).toBe('assistant');
    expect(reply.dataset.align).toBe('start');
    expect(screen.getByTestId('moved').dataset.align).toBe('start');
    const bubble = mine.querySelector('[data-slot="bubble"]') as HTMLElement;
    expect(bubble.dataset.variant).toBe('default');
    expect(bubble.className).toBe('cb-ai-bubble');
    expect(screen.getByText(/Two lines/).textContent).toBe('Two lines\nof text');
    expect(screen.getByTestId('group').className).toBe('cb-ai-message-group');
  });

  it('draws an avatar from a name, or the caller’s own icon, as decoration', () => {
    render(
      <>
        <MessageAvatar name="Ada Lovelace" data-testid="person" />
        <MessageAvatar data-testid="agent">
          <Icon name="sparkles" />
        </MessageAvatar>
      </>,
    );
    const person = screen.getByTestId('person');
    expect(person.getAttribute('aria-hidden')).toBe('true');
    expect(person.textContent).toBe('AL');
    expect(screen.getByTestId('agent').querySelector('[data-icon="sparkles"]')).toBeTruthy();
  });
});

describe('MessageToolbar', () => {
  it('draws only the actions it is given, in order, in a named group', () => {
    const retry = vi.fn();
    const branch = vi.fn();
    render(
      <MessageFooter>
        <MessageToolbar copy="Here is a plan." onRetry={retry} onBranch={branch} />
      </MessageFooter>,
    );
    const group = screen.getByRole('group', { name: 'Message actions' });
    const names = within(group)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['Copy', 'Retry', 'Branch from here']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Branch from here' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(branch).toHaveBeenCalledOnce();
  });

  it('offers no feedback toggles', () => {
    render(<MessageToolbar copy="x" onRetry={vi.fn()} onEdit={vi.fn()} onBranch={vi.fn()} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.hasAttribute('aria-pressed')).toBe(false);
    }
    expect(screen.queryByRole('button', { name: /good|bad|like/i })).toBeNull();
  });

  it('puts the person’s text back with Edit, and names Branch for its turn', () => {
    const edit = vi.fn();
    render(
      <MessageToolbar
        onEdit={edit}
        onBranch={vi.fn()}
        branchLabel="Branch the conversation from “Plan the launch”"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(edit).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'Branch the conversation from “Plan the launch”' }),
    ).toBeTruthy();
  });

  it('copies the turn and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<MessageToolbar copy="Here is a plan." />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledWith('Here is a plan.');
    expect(screen.getByRole('status').textContent).toBe('Copied');
  });

  it('draws nothing with nothing to do, and disables what it draws on request', () => {
    const { container, rerender } = render(<MessageToolbar />);
    expect(container.innerHTML).toBe('');
    rerender(<MessageToolbar copy="x" onRetry={vi.fn()} disabled />);
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
