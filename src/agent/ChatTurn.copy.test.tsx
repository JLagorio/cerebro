// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from './ChatTurn';
import type { ChatMessage } from './types';

const writeText = vi.fn<(text: string) => Promise<void>>();
const handlers = { onOpen: vi.fn(), onOpenPath: vi.fn() };
const answer = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'answer',
  role: 'assistant',
  text: 'The answer.',
  tools: [],
  ...over,
});

beforeEach(() => {
  writeText.mockReset().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('completed message Copy', () => {
  it('copies the entire question, including collapsed text and exact whitespace', async () => {
    const text = `  A long question\n${'More detail. '.repeat(60)}\n`;
    render(<Message message={answer({ role: 'user', text })} {...handlers} />);
    expect(screen.getByTestId('prompt-toggle').textContent).toBe('Show more');
    const actions = screen.getByRole('group', { name: 'Question actions' });
    const copy = within(actions).getByRole('button', { name: 'Copy' });
    expect(copy.tabIndex).toBe(0);
    expect(copy.closest('[hidden], [inert]')).toBeNull();
    fireEvent.click(copy);
    await within(actions).findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  });

  it('copies the displayed final answer, excluding narration, reasoning and tool payloads', async () => {
    const text = '  **Exact answer**\n\nKeep these lines.\n';
    const message = answer({
      text: 'An obsolete aggregate must not be copied.',
      parts: [
        { kind: 'text', id: 'narration', text: 'I will inspect the source.' },
        { kind: 'reasoning', id: 'reasoning', text: 'Private reasoning is not the answer.' },
        { kind: 'tool', toolId: 'read' },
        { kind: 'text', id: 'final', text },
      ],
      tools: [
        {
          id: 'read',
          name: 'mcp__cerebro__get_note',
          input: '{"path":"notes/a.md"}',
          output: 'Tool payload is not the answer.',
          done: true,
          failed: false,
        },
      ],
    });
    const original = structuredClone(message);
    render(<Message message={message} {...handlers} />);
    const actions = screen.getByRole('group', { name: 'Answer actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Copy' }));
    await within(actions).findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(message).toEqual(original);
  });

  it('reports a rejected clipboard write and retains the answer for another choice', async () => {
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    render(<Message message={answer()} {...handlers} />);
    const actions = screen.getByRole('group', { name: 'Answer actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Copy' }));
    await within(actions).findByRole('button', { name: "Couldn't copy" });
    expect(within(actions).getByRole('status').textContent).toBe("Couldn't copy");
    expect(screen.getByText('The answer.')).toBeTruthy();
  });

  it('withholds the answer action while streaming or waiting, then exposes settled text', () => {
    const { rerender } = render(<Message message={answer({ streaming: true })} {...handlers} />);
    expect(screen.queryByRole('group', { name: 'Answer actions' })).toBeNull();
    rerender(<Message message={answer()} waitingToolId="waiting" {...handlers} />);
    expect(screen.queryByRole('group', { name: 'Answer actions' })).toBeNull();
    rerender(<Message message={answer()} {...handlers} />);
    expect(screen.getByRole('group', { name: 'Answer actions' })).toBeTruthy();
  });

  it.each(['user', 'assistant'] as const)('offers no empty %s copy', (role) => {
    render(<Message message={answer({ role, text: ' \n\t' })} {...handlers} />);
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('waits for a gapped reply to heal before copying its final text', async () => {
    const { rerender } = render(
      <Message message={answer({ text: 'Only part arrived.', gap: true })} {...handlers} />,
    );
    expect(screen.queryByRole('group', { name: 'Answer actions' })).toBeNull();
    rerender(<Message message={answer({ text: 'The healed answer.' })} {...handlers} />);
    const actions = screen.getByRole('group', { name: 'Answer actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Copy' }));
    await within(actions).findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('The healed answer.');
  });

  it('withholds a suspended reply even when no waiting row is selected', () => {
    render(
      <Message
        message={answer({
          tools: [
            {
              id: 'pending',
              name: 'mcp__cerebro__get_note',
              input: '{"path":"notes/a.md"}',
              output: null,
              done: false,
              failed: false,
              deferred: true,
            },
          ],
        })}
        {...handlers}
      />,
    );
    expect(screen.queryByRole('group', { name: 'Answer actions' })).toBeNull();
  });
});
