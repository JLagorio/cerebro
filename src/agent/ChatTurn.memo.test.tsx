// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { drawn } = vi.hoisted(() => ({ drawn: vi.fn() }));
vi.mock('@/agent/MessageMarkdown', () => ({
  MessageText: ({ text }: { text: string }) => {
    drawn(text);
    return <p>{text}</p>;
  },
}));

import { Message } from './ChatTurn';
import type { ChatMessage } from './types';

/**
 * A streamed delta replaces only the message it grows (useAgentChat), so with
 * the panel's stable handlers every earlier turn skips the redraw: before
 * Message was memoized, each delta redrew the whole thread.
 */

afterEach(() => {
  cleanup();
  drawn.mockReset();
});

const onOpen = () => undefined;
const onOpenPath = () => undefined;
const onRetry = () => undefined;

const reply = (id: string, text: string, streaming = false): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  tools: [],
  streaming,
});

describe('a memoized turn', () => {
  it('a delta to the latest reply redraws no earlier turn', () => {
    const earlier = reply('a', 'first answer');
    let grow: (text: string) => void = () => undefined;
    function Thread() {
      const [latest, setLatest] = useState(reply('b', 'second', true));
      grow = (text) => setLatest(reply('b', text, true));
      return (
        <>
          {[earlier, latest].map((message) => (
            <Message
              key={message.id}
              message={message}
              onOpen={onOpen}
              onOpenPath={onOpenPath}
              onRetry={onRetry}
            />
          ))}
        </>
      );
    }
    render(<Thread />);
    act(() => grow('second, growing'));
    act(() => grow('second, growing more'));
    expect(drawn.mock.calls.filter(([text]) => text === 'first answer')).toHaveLength(1);
    expect(drawn).toHaveBeenLastCalledWith('second, growing more');
  });
});
