// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/workspace/highlighter', () => ({ highlight: vi.fn(async () => null) }));

import { Message } from './ChatTurn';
import type { ChatMessage, ToolCall } from './types';

/**
 * Motion (owner, 2026-10-19): a call the conversation watches being made
 * comes in on its own line; what a turn was first drawn with, restored or
 * new, came in with it. jsdom plays no animation, so a mark stays put.
 */

afterEach(cleanup);

function call(id: string, name: string): ToolCall {
  return {
    id,
    name: `mcp__cerebro__${name}`,
    input: JSON.stringify({ path: `notes/${id}.md` }),
    output: 'ok',
    done: true,
    failed: false,
  };
}

const reply = (tools: ToolCall[], streaming: boolean): ChatMessage => ({
  id: 'reply',
  role: 'assistant',
  text: '',
  tools,
  streaming,
});

const handlers = { onOpen: vi.fn(), onOpenPath: vi.fn() };

/** Whether each call's line carries the arrival mark, in order. */
const marks = () =>
  [...document.querySelectorAll('.cb-chat-row')].map((row) => row.hasAttribute('data-arrive'));

describe("a turn's lines", () => {
  it('brings in each call a watched turn adds, and none it was drawn with', () => {
    const first = call('a', 'edit_note');
    const second = call('b', 'create_note');
    const { rerender } = render(<Message message={reply([first], true)} {...handlers} />);
    expect(marks()).toEqual([false]);
    rerender(<Message message={reply([first, second], true)} {...handlers} />);
    expect(marks()).toEqual([false, true]);
  });

  it('brings in nothing of a turn restored with its calls', () => {
    render(
      <Message
        message={reply([call('a', 'edit_note'), call('b', 'create_note')], false)}
        {...handlers}
      />,
    );
    expect(marks()).toEqual([false, false]);
  });
});
