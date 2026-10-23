import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockContextBook, type ContextUseRecorded } from '@/agent/agentIpc';
import { contextUsageOf } from '@/agent/elements/composerContext';
import { RAIL_CONTEXT_WORDS, railContext, type RailContext } from '@/agent/elements/contextCard';
import { useContextUse, type ContextUseState } from '@/agent/useContextUse';
import { contextFigure, contextName, contextTokens } from '@/components/ai/Context';
import type { ContextBreakdown } from '@/engine/ai/contextBreakdown';
import { instantText } from '@/engine/whenText';

/**
 * The rail's Context card (M92.14): what the composer's pull read, as the
 * card says it. One figure with the composer's ring (O3); the breakdown's
 * rows, servers and facts where it came; partial without it or without a
 * window; a deferred row "not loaded", never 0; and when it was read, or
 * that it is the previous turn's while a turn streams.
 */

afterEach(cleanup);

const AT = '2026-07-28T11:58:00.000Z';
const OPEN: { session: string | null; streaming: boolean } = {
  session: '00000000-0000-4000-8000-000000092140',
  streaming: false,
};

const BREAKDOWN: ContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 6_797, kind: 'used' },
    { name: 'MCP tools', tokens: 412, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 438, kind: 'deferred' },
    { name: 'Messages', tokens: 26_038, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { name: 'Free space', tokens: 133_753, kind: 'free' },
  ],
  total: 33_247,
  max: 200_000,
  model: 'claude-sonnet-5',
  autocompact: { enabled: true, threshold: 167_000 },
  mcpServers: [
    { name: 'cerebro', tools: 31, loaded: 2, tokens: 412 },
    { name: 'toy', tools: 1, loaded: 0, tokens: 0 },
  ],
  memoryFiles: 2,
};

function recorded(over: Partial<ContextUseRecorded> = {}): ContextUseRecorded {
  return {
    state: 'recorded',
    used: 33_247,
    window: 200_000,
    model: 'claude-sonnet-5',
    at: AT,
    breakdown: BREAKDOWN,
    ...over,
  };
}

const card = (reading: ContextUseState, open = OPEN): RailContext => railContext(reading, open);

describe('railContext', () => {
  it('says a conversation with no session has had no turn, and claims nothing else', () => {
    const empty = card(recorded(), { session: null, streaming: false });
    expect(empty).toMatchObject({ state: 'empty', none: RAIL_CONTEXT_WORDS.noTurns });
    expect(empty.figure).toBeNull();
    expect(empty.categories).toBeNull();
    expect(empty.freshness).toBeNull();
  });

  it('waits on the pull’s first answer, and tells not recorded from unavailable', () => {
    expect(card({ state: 'loading' }).state).toBe('reading');
    expect(card({ state: 'not_recorded' })).toMatchObject({ state: 'not-recorded', figure: null });
    expect(card({ state: 'unavailable' })).toMatchObject({ state: 'unavailable', figure: null });
    // A count that is not one could not be read: never a figure.
    expect(card(recorded({ used: Number.NaN, breakdown: undefined })).state).toBe('unavailable');
  });

  it('draws a reading with its breakdown whole: the rows, the facts and the servers', () => {
    const ready = card(recorded());
    expect(ready.state).toBe('ready');
    expect(ready.count).toBe('17% used');
    expect(ready.figure).toBe('33,247 of 200,000 tokens');
    expect(ready.notes).toEqual([]);
    expect(ready.window).toBe(200_000);
    expect(ready.categories?.map((row) => [row.name, row.kind, row.tokens])).toEqual([
      ['System prompt', 'used', 6_797],
      ['MCP tools', 'used', 412],
      ['MCP tools (deferred)', 'deferred', 438],
      ['Messages', 'used', 26_038],
      ['Autocompact buffer', 'buffer', 33_000],
      ['Free space', 'free', 133_753],
    ]);
    expect(ready.facts).toEqual([
      { term: 'Model', value: 'claude-sonnet-5' },
      { term: 'Autocompact', value: 'at 167,000 tokens' },
      { term: 'Memory files', value: '2' },
    ]);
    expect(ready.servers).toEqual({
      state: 'listed',
      rows: [
        { key: '0', name: 'cerebro', tools: '31 tools, 2 loaded', value: '412', deferred: false },
        { key: '1', name: 'toy', tools: '1 tool', value: 'not loaded', deferred: true },
      ],
      more: null,
    });
  });

  it('reads a server none of whose tools is loaded as not loaded, never 0', () => {
    const servers = card(recorded()).servers;
    const toy = servers?.state === 'listed' ? servers.rows[1] : null;
    expect(toy?.value).toBe(RAIL_CONTEXT_WORDS.notLoaded);
    expect(toy?.value).not.toMatch(/\d/);
  });

  it('is partial with no breakdown for the turn: the count alone, and why', () => {
    const partial = card(recorded({ used: 124_000, breakdown: undefined }));
    expect(partial).toMatchObject({
      state: 'partial',
      count: '62% used',
      figure: '124,000 of 200,000 tokens',
      notes: [RAIL_CONTEXT_WORDS.noBreakdown],
      categories: null,
      servers: null,
    });
    expect(partial.facts).toEqual([{ term: 'Model', value: 'claude-sonnet-5' }]);
  });

  it('is partial with no window: a count, rows with no share, and why', () => {
    const { max: _max, ...noMax } = BREAKDOWN;
    const partial = card(recorded({ used: 41_200, window: undefined, breakdown: noMax }));
    expect(partial.state).toBe('partial');
    expect(partial.count).toBe('41.2K tokens');
    expect(partial.figure).toBe('41,200 tokens used');
    expect(partial.notes).toEqual([RAIL_CONTEXT_WORDS.noWindow]);
    expect(partial.window).toBeNull();
    expect(partial.categories).not.toBeNull();
  });

  it('says what the breakdown did not record, never a zero', () => {
    const sparse = card(
      recorded({
        model: undefined,
        breakdown: {
          categories: [{ name: 'Messages', kind: 'used' }],
          total: 33_247,
          max: 200_000,
        },
      }),
    );
    expect(sparse.state).toBe('ready');
    expect(sparse.categories).toEqual([{ key: '0', name: 'Messages', kind: 'used', tokens: null }]);
    expect(sparse.facts).toEqual([
      { term: 'Model', value: 'not recorded' },
      { term: 'Autocompact', value: 'not recorded' },
      { term: 'Memory files', value: 'not recorded' },
    ]);
    expect(sparse.servers).toEqual({ state: 'not-recorded' });
  });

  it('words autocompact, the memory files and the servers past the cap', () => {
    const facts = (breakdown: ContextBreakdown) => card(recorded({ breakdown })).facts;
    expect(facts({ ...BREAKDOWN, autocompact: { enabled: true } })[1].value).toBe('on');
    expect(facts({ ...BREAKDOWN, autocompact: { enabled: false } })[1].value).toBe('off');
    expect(facts({ ...BREAKDOWN, memoryFiles: 0 })[2].value).toBe('None');
    expect(card(recorded({ breakdown: { ...BREAKDOWN, mcpServers: [] } })).servers).toBeNull();
    const more = card(recorded({ breakdown: { ...BREAKDOWN, mcpServersMore: 3 } })).servers;
    expect(more?.state === 'listed' && more.more).toBe('3 more servers not shown');
  });

  it('says when it was read, or, while a turn streams, that it is the previous turn’s', () => {
    expect(card(recorded()).freshness).toEqual({
      words: 'Read when the last turn ended',
      at: AT,
      time: instantText(AT),
    });
    expect(card(recorded(), { ...OPEN, streaming: true }).freshness?.words).toBe(
      'From the previous turn',
    );
  });

  it('hands back the same card for the same reading while a turn streams', () => {
    const reading = recorded();
    const streaming = { ...OPEN, streaming: true };
    const first = card(reading, streaming);
    expect(card(reading, streaming)).toBe(first);
    expect(card(reading)).not.toBe(first);
    expect(card(reading)).toBe(card(reading));
  });
});

describe('one figure (O3)', () => {
  it('is the composer ring’s: Claude Code’s total of its window, wherever a breakdown came', async () => {
    const session = '00000000-0000-4000-8000-000000092149';
    // The latest request sent 33,300 tokens of a million-token window, and
    // Claude Code counts 33,247 of the 200,000 it measures against.
    mockContextBook.record(session, recorded({ used: 33_300, window: 1_000_000 }));
    const { result } = renderHook(() => useContextUse(session, { streaming: false }));
    await waitFor(() => expect(result.current.state).toBe('recorded'));
    const ring = contextUsageOf(result.current);
    expect(ring).toEqual({
      state: 'recorded',
      used: 33_247,
      window: 200_000,
      model: 'claude-sonnet-5',
    });
    const shown = card(result.current, { session, streaming: false });
    expect(shown.usage).toEqual(ring);
    expect(shown.count).toBe(`${contextFigure(ring)} used`);
    expect(shown.figure).toBe(contextTokens(ring));
    expect(contextName(ring)).toBe('17% of context used');
  });
});
