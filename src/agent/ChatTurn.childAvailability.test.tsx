// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Message } from './ChatTurn';
import { loadConversations, newConversation, saveConversations } from './conversations';
import { applyEvent, endLiveTurn, healFromTranscript, replaceLastTurn } from './transcript';
import type { ChatMessage } from './types';

const reply = (): ChatMessage => ({
  id: 'reply',
  role: 'assistant',
  text: 'The parent answer.',
  tools: [],
});
const partial = () =>
  applyEvent(
    reply(),
    { kind: 'Text', parent: 'missing-child', message_id: 'lost', text: 'Unattributed words' },
    'live',
  );

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

it('discloses unavailable child details before and after Done without rendering orphan words', () => {
  const message = partial();
  const handlers = { onOpen: vi.fn(), onOpenPath: vi.fn() };
  const view = render(<Message message={message} {...handlers} />);
  expect(screen.getByTestId('child-trace-unavailable').getAttribute('role')).toBe('status');
  expect(screen.getByTestId('child-trace-unavailable').textContent).toContain(
    'Some subagent details are unavailable.',
  );
  expect(screen.getByTestId('chat-message').textContent).not.toContain('Unattributed words');
  view.rerender(<Message message={endLiveTurn(message)} {...handlers} />);
  expect(screen.getByTestId('child-trace-unavailable').getAttribute('role')).toBe('status');
  expect(screen.getByTestId('child-trace-unavailable').textContent).toContain(
    'Some subagent details are unavailable.',
  );
  expect(screen.getByTestId('chat-message').textContent).toContain('The parent answer.');
});

it('retains the availability fact in the real conversation cache without orphan contents', () => {
  saveConversations([{ ...newConversation(), messages: [partial()] }]);
  expect(loadConversations()[0].messages[0]).toHaveProperty('childTraceUnavailable', true);
  expect(window.localStorage.getItem('cerebro.conversations')).not.toContain('Unattributed words');
});

it.each([false, 'true', 1, {}, null])(
  'rejects a malformed stored availability mark: %j',
  (mark) => {
    window.localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        { ...newConversation(), messages: [{ ...reply(), childTraceUnavailable: mark }] },
      ]),
    );
    expect(loadConversations()[0].messages[0]).not.toHaveProperty('childTraceUnavailable');
  },
);

it('carries a replayed missing-child fact through partial healing and final-turn replacement', () => {
  const rebuilt = partial();
  expect(healFromTranscript([reply()], [rebuilt])[0]).toHaveProperty('childTraceUnavailable', true);
  expect(replaceLastTurn([reply()], 'reply', [rebuilt])[0]).toHaveProperty(
    'childTraceUnavailable',
    true,
  );
});
