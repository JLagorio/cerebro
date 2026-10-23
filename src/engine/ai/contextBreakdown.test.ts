import { describe, expect, it } from 'vitest';
import fixture from '../../../src-tauri/fixtures/context-breakdown.json';
import {
  CONTEXT_BREAKDOWN_LIMITS,
  readContextBreakdown,
  type ContextBreakdown,
} from './contextBreakdown';

/**
 * Claude Code's context breakdown as it crosses (M92.14): the meter writes
 * each case's `wire` from Claude Code's answer (M92.13), and the reader
 * reads that wire back whole. A wire the meter never writes is read
 * defensively, to the same rules: a count that is not one is left out,
 * never 0 (CV-05), a long name is cut and marked, and past a cap the rows
 * are counted, never shown.
 */

const cases = fixture.cases as { name: string; response: unknown; wire: ContextBreakdown | null }[];
const wires = cases.flatMap(({ name, wire }) => (wire === null ? [] : [[name, wire] as const]));

/** A wire that reads, with `over` laid on it. */
const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  categories: [{ name: 'Messages', tokens: 962, kind: 'used' }],
  total: 15_247,
  max: 200_000,
  ...over,
});

describe('the shared cases (context-breakdown.json)', () => {
  it('hold the limits both readers hold', () => {
    expect(fixture.limits).toEqual({
      categories: CONTEXT_BREAKDOWN_LIMITS.categories,
      mcp_servers: CONTEXT_BREAKDOWN_LIMITS.mcpServers,
      name_chars: CONTEXT_BREAKDOWN_LIMITS.nameChars,
      count_max: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each(wires)('reads back whole: %s', (_name, written) => {
    expect(readContextBreakdown(written)).toEqual(written);
  });

  it('reads nothing of an answer the meter keeps nothing of', () => {
    const none = cases.filter(({ wire: written }) => written === null);
    expect(none.length).toBeGreaterThan(0);
    for (const { response } of none) expect(readContextBreakdown(response)).toBeNull();
  });

  it('never carries a memory file’s path, a tool’s name or a colour', () => {
    for (const [, written] of wires) {
      const text = JSON.stringify(written);
      expect(text).not.toMatch(/CLAUDE\.md|mcp__|"color"|"path"|gridRows|apiUsage/);
    }
  });
});

describe('readContextBreakdown, on a wire the meter never writes', () => {
  it('is nothing for anything but an object holding a list of rows', () => {
    for (const value of [null, undefined, 7, 'breakdown', [], {}, { categories: 'Messages' }]) {
      expect(readContextBreakdown(value)).toBeNull();
    }
  });

  it('leaves out a count that is not one, never reading it as 0', () => {
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, -1, 12.5, '962', null, 2 ** 53]) {
      const read = readContextBreakdown(
        wire({
          categories: [{ name: 'Messages', tokens: odd, kind: 'used' }],
          total: odd,
          max: odd,
          memoryFiles: odd,
          autocompact: { enabled: true, threshold: odd },
          mcpServers: [{ name: 'cerebro', tools: 2, loaded: 1, tokens: odd }],
        }),
      );
      expect(read).toEqual({
        categories: [{ name: 'Messages', kind: 'used' }],
        autocompact: { enabled: true },
        mcpServers: [{ name: 'cerebro', tools: 2, loaded: 1 }],
      });
    }
  });

  it('keeps no window of 0', () => {
    expect(readContextBreakdown(wire({ max: 0 }))?.max).toBeUndefined();
    expect(readContextBreakdown(wire({ total: 0 }))?.total).toBe(0);
  });

  it('cuts a name past 128 characters to 127 and an ellipsis, counting code points', () => {
    const long = 'a'.repeat(200);
    const astral = '\u{1D4C2}'.repeat(129);
    const read = readContextBreakdown(
      wire({
        categories: [
          { name: long, tokens: 1, kind: 'used' },
          { name: 'b'.repeat(128), tokens: 2, kind: 'used' },
          { name: astral, tokens: 3, kind: 'used' },
        ],
        model: long,
        mcpServers: [{ name: astral, tools: 1, loaded: 0, tokens: 0 }],
      }),
    );
    const names = read?.categories.map((row) => row.name) ?? [];
    expect(names[0]).toBe(`${'a'.repeat(127)}…`);
    expect(names[1]).toBe('b'.repeat(128));
    expect(Array.from(names[2])).toHaveLength(128);
    expect(names[2]).toBe(`${'\u{1D4C2}'.repeat(127)}…`);
    expect(read?.model).toBe(`${'a'.repeat(127)}…`);
    expect(read?.mcpServers?.[0].name).toBe(`${'\u{1D4C2}'.repeat(127)}…`);
  });

  it('counts the rows past each cap, adding to what the wire already counted', () => {
    const { categories: rowCap, mcpServers: serverCap } = CONTEXT_BREAKDOWN_LIMITS;
    const read = readContextBreakdown(
      wire({
        categories: Array.from({ length: rowCap + 3 }, (_, i) => ({
          name: `Row ${i}`,
          tokens: i,
          kind: 'used',
        })),
        categoriesMore: 2,
        mcpServers: Array.from({ length: serverCap + 1 }, (_, i) => ({
          name: `s${i}`,
          tools: 1,
          loaded: 1,
          tokens: 1,
        })),
      }),
    );
    expect(read?.categories).toHaveLength(rowCap);
    expect(read?.categoriesMore).toBe(5);
    expect(read?.mcpServers).toHaveLength(serverCap);
    expect(read?.mcpServersMore).toBe(1);
  });

  it('leaves out a More count of none, and one that is not a count', () => {
    const read = readContextBreakdown(
      wire({ categoriesMore: 0, mcpServers: [], mcpServersMore: Number.NaN }),
    );
    expect(read).toEqual({
      categories: [{ name: 'Messages', tokens: 962, kind: 'used' }],
      total: 15_247,
      max: 200_000,
      mcpServers: [],
    });
  });

  it('drops a row that does not read: no name, a kind it does not know, more loaded than offered', () => {
    const read = readContextBreakdown(
      wire({
        categories: [
          { name: 'System prompt', tokens: 6_797, kind: 'used' },
          { name: '', tokens: 1, kind: 'used' },
          { tokens: 2, kind: 'used' },
          { name: 'Messages', tokens: 3, kind: 'hidden' },
          { name: 'Skills', tokens: 4 },
          'Messages',
          null,
        ],
        mcpServers: [
          { name: 'cerebro', tools: 2, loaded: 3, tokens: 1 },
          { name: 'gmail', tools: 2, tokens: 1 },
          { name: '', tools: 1, loaded: 1 },
          { name: 'toy', tools: 1, loaded: 0, tokens: 0 },
        ],
      }),
    );
    expect(read?.categories).toEqual([{ name: 'System prompt', tokens: 6_797, kind: 'used' }]);
    expect(read?.mcpServers).toEqual([{ name: 'toy', tools: 1, loaded: 0, tokens: 0 }]);
  });

  it('says the servers were not recorded, never none, when no list of them came', () => {
    expect(readContextBreakdown(wire())).not.toHaveProperty('mcpServers');
    expect(readContextBreakdown(wire({ mcpServers: 'cerebro' }))).not.toHaveProperty('mcpServers');
    expect(readContextBreakdown(wire({ mcpServers: [] }))?.mcpServers).toEqual([]);
  });

  it('reads autocompact only with a switch that is on or off', () => {
    expect(readContextBreakdown(wire({ autocompact: { enabled: 'true' } }))).not.toHaveProperty(
      'autocompact',
    );
    expect(readContextBreakdown(wire({ autocompact: { enabled: false } }))?.autocompact).toEqual({
      enabled: false,
    });
  });

  it('keeps nothing it does not know, a memory file’s path among it', () => {
    const read = readContextBreakdown(
      wire({
        categories: [{ name: 'Messages', tokens: 962, kind: 'used', color: 'claude' }],
        memoryFiles: [{ path: '/vault/CLAUDE.md' }],
        gridRows: [[]],
        apiUsage: { input_tokens: 10 },
      }),
    );
    expect(read).toEqual({
      categories: [{ name: 'Messages', tokens: 962, kind: 'used' }],
      total: 15_247,
      max: 200_000,
    });
  });
});
