import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@/agent/types';
import { turnSources } from './turnSources';

/**
 * What a reply drew on (M91.13): in the order the turn met them, its
 * searches' results and fetched pages, the vault pages its reads opened
 * (its subagents' too), and the links in its words; nothing a call that
 * failed brought back.
 */

function call(id: string, name: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name, input: '{}', output: 'ok', done: true, failed: false, ...over };
}

const search = call('s', 'WebSearch', {
  result: {
    type: 'web_search',
    query: 'scanners',
    results: [{ title: 'Lead times', url: 'https://example.com/lead' }],
  },
});
const read = call('r', 'mcp__cerebro__get_note', {
  input: JSON.stringify({ path: 'notes/plan.md' }),
});

describe('turnSources', () => {
  it('lists what the turn met in order, deduped, its words last', () => {
    const message: ChatMessage = {
      id: 'm',
      role: 'assistant',
      text: 'See [lead times](https://example.com/lead) and https://example.org/x.',
      tools: [search, read],
      parts: [
        { kind: 'tool', toolId: 's' },
        { kind: 'tool', toolId: 'r' },
        {
          kind: 'text',
          id: 'text-1',
          text: 'See [lead times](https://example.com/lead) and https://example.org/x.',
        },
      ],
    };
    expect(turnSources(message)).toEqual([
      { kind: 'url', url: 'https://example.com/lead', title: 'Lead times', via: 'search' },
      { kind: 'vault', path: 'notes/plan.md', via: 'read' },
      { kind: 'url', url: 'https://example.org/x', via: 'text' },
    ]);
  });

  it('counts nothing a failed call brought back, and no read that opens no page', () => {
    const message: ChatMessage = {
      id: 'm',
      role: 'assistant',
      text: '',
      tools: [
        { ...read, failed: true },
        call('q', 'mcp__cerebro__search_notes', { input: '{"query":"risk"}' }),
        call('f', 'WebFetch', {
          failed: true,
          result: { type: 'web_fetch', url: 'https://example.com/a', code: 200 },
        }),
      ],
    };
    expect(turnSources(message)).toEqual([]);
  });

  it('counts a subagent’s reads where its call stands', () => {
    const agent = call('a', 'Agent', {
      subagent: {
        type: 'cerebro-researcher',
        description: 'Read',
        status: 'done',
        parts: [{ kind: 'tool', toolId: 'r' }],
        tools: [read],
      },
    });
    const message: ChatMessage = { id: 'm', role: 'assistant', text: '', tools: [agent] };
    expect(turnSources(message)).toEqual([{ kind: 'vault', path: 'notes/plan.md', via: 'read' }]);
  });
});
