import { describe, expect, it } from 'vitest';
import { railWaiting, waitingRowId } from '@/agent/elements/railWaiting';
import { applyEvent } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage, PendingInteraction } from '@/agent/types';
import type { WaitingCard } from '@/agent/useAgentChat';

/**
 * The rail's Waiting card (M92.4): the thread's own card, what it asks, and
 * the subagent whose call asks, when a subagent's does; the same object
 * while neither the card nor the asking reply's calls change.
 */

const APPEND = 'mcp__cerebro__append_to_note';

function card(over: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    id: '0123456789abcdef0123456789abcdef',
    kind: 'permission',
    tool_name: APPEND,
    tool_id: 'ask-1',
    session_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    summary: 'append to note · notes/inbox.md',
    input: '{}',
    asked_at: '2026-07-28T12:00:00Z',
    ...over,
  };
}

function waiting(over: Partial<WaitingCard> = {}): WaitingCard {
  return { card: card(), messageId: 'reply', answering: false, stale: null, ...over };
}

/** A reply as the live stream left it when the call `ask-1` was held. */
function held(events: AgentStreamEvent[]): ChatMessage {
  let message: ChatMessage = { id: 'reply', role: 'assistant', text: '', tools: [] };
  for (const event of [
    ...events,
    { kind: 'ToolDeferred', tool_id: 'ask-1', tool_name: APPEND } as AgentStreamEvent,
  ]) {
    message = applyEvent(message, event, 'live');
  }
  return message;
}

const asking = (parent?: string): AgentStreamEvent => ({
  kind: 'ToolStart',
  tool_name: APPEND,
  tool_id: 'ask-1',
  input: '{"path":"notes/inbox.md"}',
  ...(parent === undefined ? {} : { parent }),
});

const agent = (input: Record<string, unknown> | null): AgentStreamEvent => ({
  kind: 'ToolStart',
  tool_name: 'Agent',
  tool_id: 'agent-1',
  input: input === null ? null : JSON.stringify(input),
});

describe('railWaiting', () => {
  it('is nothing while no card waits', () => {
    expect(railWaiting(null, [held([asking()])])).toBeNull();
  });

  it('says what the card asks, and names no one when the turn’s own call asks', () => {
    expect(railWaiting(waiting(), [held([asking()])])).toEqual({
      id: '0123456789abcdef0123456789abcdef',
      toolName: APPEND,
      summary: 'append to note · notes/inbox.md',
      asker: null,
      answering: false,
      stale: null,
    });
  });

  it('names the subagent whose own call asks', () => {
    const reply = held([
      agent({ description: 'Read the open risks', subagent_type: 'cerebro-researcher' }),
      asking('agent-1'),
    ]);
    expect(railWaiting(waiting(), [reply])?.asker).toEqual({
      type: 'cerebro-researcher',
      description: 'Read the open risks',
    });
  });

  it('says nothing was recorded of a subagent that named neither its kind nor its task', () => {
    const reply = held([agent(null), asking('agent-1')]);
    expect(railWaiting(waiting(), [reply])?.asker).toEqual({ type: '', description: '' });
  });

  it('names no one for a call the reply does not hold', () => {
    expect(railWaiting(waiting({ messageId: 'gone' }), [held([asking()])])?.asker).toBeNull();
  });

  it('carries an answer on its way, and Rust’s words for one too late', () => {
    const reply = held([asking()]);
    expect(railWaiting(waiting({ answering: true }), [reply])?.answering).toBe(true);
    expect(
      railWaiting(waiting({ stale: 'No longer waiting: this request was already answered.' }), [
        reply,
      ])?.stale,
    ).toBe('No longer waiting: this request was already answered.');
  });

  it('gives back the same object while the card and its reply’s calls hold', () => {
    let reply = held([asking()]);
    const question: ChatMessage = { id: 'u', role: 'user', text: 'Note it', tools: [] };
    const shown = waiting();
    const first = railWaiting(shown, [question, reply]);
    for (let at = 0; at < 50; at += 1) {
      reply = applyEvent(reply, { kind: 'TextDelta', text: `${at} ` }, 'live');
      expect(railWaiting(shown, [question, reply])).toBe(first);
    }
    // A new card is a new answer.
    expect(railWaiting({ ...shown, answering: true }, [question, reply])).not.toBe(first);
  });

  it('gives back the same object while another step in the reply names the same asker', () => {
    let reply = held([
      agent({ description: 'Read the open risks', subagent_type: 'cerebro-researcher' }),
      asking('agent-1'),
    ]);
    const shown = waiting();
    const first = railWaiting(shown, [reply]);
    // The researcher's sibling works on: its steps make new calls.
    reply = applyEvent(
      reply,
      {
        kind: 'ToolStart',
        tool_name: 'Agent',
        tool_id: 'agent-2',
        input: JSON.stringify({ description: 'Check the dates', subagent_type: 'Explore' }),
      },
      'live',
    );
    const tools = reply.tools;
    reply = applyEvent(
      reply,
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__get_note',
        tool_id: 'sub-2',
        input: '{"path":"notes/dates.md"}',
        parent: 'agent-2',
      },
      'live',
    );
    expect(reply.tools).not.toBe(tools);
    expect(railWaiting(shown, [reply])).toBe(first);
  });

  it('names the transcript row a card is drawn in', () => {
    expect(waitingRowId('abc')).toBe('waiting:abc');
  });
});
