// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Chat } from './Chat';
import { MessageScrollerItem, type MessageScrollerCommands } from './MessageScroller';

/**
 * Chat (M91.8): the thread in a Message Scroller, the empty state in its
 * place while it holds no rows, and the composer under both.
 */

afterEach(cleanup);

const composer = <textarea aria-label="Message" />;

function Thread({ turns, busy }: { turns: string[]; busy?: boolean }) {
  return (
    <Chat
      data-testid="chat"
      empty={<p>What would you like to work on?</p>}
      composer={composer}
      busy={busy}
      label="Conversation"
    >
      {turns.map((turn, at) => (
        <MessageScrollerItem key={turn} messageId={turn} scrollAnchor={at % 2 === 0}>
          {turn}
        </MessageScrollerItem>
      ))}
      {false}
      {null}
    </Chat>
  );
}

describe('Chat', () => {
  it('shows the empty state in the thread’s place while it holds no rows', () => {
    render(<Thread turns={[]} />);
    expect(screen.getByText('What would you like to work on?')).toBeTruthy();
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.getByTestId('chat').hasAttribute('data-empty')).toBe(true);
  });

  it('keeps the composer’s own node when the first turn arrives', () => {
    const { rerender } = render(<Thread turns={[]} />);
    const field = screen.getByLabelText('Message');
    rerender(<Thread turns={['Plan the launch', 'Here is a plan.']} />);
    expect(screen.getByLabelText('Message')).toBe(field);
    expect(screen.queryByText('What would you like to work on?')).toBeNull();
    expect(screen.getByTestId('chat').hasAttribute('data-empty')).toBe(false);
  });

  it('draws the rows in a named region’s log, busy while a turn streams', () => {
    const { rerender } = render(<Thread turns={['Plan the launch']} busy />);
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeTruthy();
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-busy')).toBe('true');
    expect(log.textContent).toContain('Plan the launch');
    rerender(<Thread turns={['Plan the launch']} />);
    expect(screen.getByRole('log').hasAttribute('aria-busy')).toBe(false);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
  });

  it('draws the thread when there is no empty state to show, and no composer slot without one', () => {
    render(<Chat data-testid="bare" />);
    expect(screen.getByRole('log')).toBeTruthy();
    expect(screen.getByTestId('bare').querySelector('[data-slot="chat-composer"]')).toBeNull();
  });

  it('hands its scroll commands to a host outside the thread, through its empty state (M92.4)', () => {
    const scroller = createRef<MessageScrollerCommands>();
    const { rerender } = render(<Chat scrollerRef={scroller} empty={<p>Nothing yet</p>} />);
    expect(Object.keys(scroller.current ?? {}).sort()).toEqual([
      'scrollToElement',
      'scrollToEnd',
      'scrollToMessage',
      'scrollToStart',
    ]);
    const commands = scroller.current as MessageScrollerCommands;
    // Asked before a row is drawn, a jump waits for it.
    let moved: boolean[] = [];
    act(() => {
      moved = [commands.scrollToMessage('u-1')];
    });
    expect(moved).toEqual([true]);
    rerender(
      <Chat scrollerRef={scroller} empty={<p>Nothing yet</p>}>
        <MessageScrollerItem messageId="u-1">Plan the launch</MessageScrollerItem>
      </Chat>,
    );
    // The same commands, over the thread now drawn.
    expect(scroller.current).toBe(commands);
    const row = screen.getByText('Plan the launch');
    act(() => {
      moved = [
        commands.scrollToMessage('missing'),
        commands.scrollToElement(row),
        commands.scrollToElement(document.createElement('div')),
      ];
    });
    expect(moved).toEqual([false, true, false]);
  });

  it('gives its jump to the latest the caller’s test id, and none unasked', () => {
    render(<Thread turns={['Plan the launch']} />);
    const jump = () => screen.getByRole('button', { name: 'Jump to latest' });
    expect(jump().hasAttribute('data-testid')).toBe(false);
    cleanup();
    render(
      <Chat jumpTestId="jump-to-latest">
        <MessageScrollerItem messageId="u-1">Plan the launch</MessageScrollerItem>
      </Chat>,
    );
    expect(screen.getByTestId('jump-to-latest')).toBe(jump());
  });
});
