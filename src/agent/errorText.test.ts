import { describe, expect, it } from 'vitest';
import {
  ERROR_SUMMARY_CHARS,
  ERROR_SUMMARY_LINES,
  readErrorText,
  unwrapToolError,
} from '@/agent/errorText';

/** A refused call naming a tool the run did not hold: Claude Code lists every
 * tool it did, on one line. */
const CATALOGUE = Array.from({ length: 400 }, (_, i) => `mcp__cerebro__tool_${i}`).join(', ');
const NOT_FOUND = `<tool_use_error>Error calling tool (mcp__cerebro__get_note): Error: MCP tool not found. Available MCP tools: ${CATALOGUE}</tool_use_error>`;

describe('unwrapToolError', () => {
  it('takes off the tags around a refused call, either or both', () => {
    expect(unwrapToolError('<tool_use_error>No such file</tool_use_error>')).toBe('No such file');
    expect(unwrapToolError('  <tool_use_error>\nNo such file\n</tool_use_error>\n')).toBe(
      'No such file',
    );
    expect(unwrapToolError('<tool_use_error>Cut before its end')).toBe('Cut before its end');
    expect(unwrapToolError('Ended on its tag</tool_use_error>')).toBe('Ended on its tag');
  });

  it('leaves words alone that only mention the tag', () => {
    const said = 'The reply named <tool_use_error> in the middle.';
    expect(unwrapToolError(said)).toBe(said);
    expect(unwrapToolError('API Error: 400 bad request')).toBe('API Error: 400 bad request');
  });
});

describe('readErrorText', () => {
  it('shows a short failure whole, with nothing to unfold', () => {
    expect(readErrorText('API Error: 400 the request was not one Claude could take')).toEqual({
      full: 'API Error: 400 the request was not one Claude could take',
      summary: 'API Error: 400 the request was not one Claude could take',
      cut: false,
    });
  });

  it('keeps the first lines of a long failure and all of it to unfold', () => {
    const raw = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const read = readErrorText(raw);
    expect(read.summary).toBe('one\ntwo\nthree…');
    expect(read.summary.split('\n')).toHaveLength(ERROR_SUMMARY_LINES);
    expect(read.full).toBe(raw);
    expect(read.cut).toBe(true);
  });

  it('cuts a line that never breaks, and unwraps the whole', () => {
    const read = readErrorText(NOT_FOUND);
    expect(read.cut).toBe(true);
    expect(read.summary.startsWith('Error calling tool (mcp__cerebro__get_note)')).toBe(true);
    expect(read.summary.endsWith('…')).toBe(true);
    expect(read.summary.length).toBeLessThanOrEqual(ERROR_SUMMARY_CHARS + 1);
    expect(read.full).toBe(unwrapToolError(NOT_FOUND));
    expect(read.full).not.toContain('tool_use_error');
    expect(read.full.endsWith('mcp__cerebro__tool_399')).toBe(true);
  });

  it('cuts nothing from three lines and their trailing blank ones', () => {
    expect(readErrorText('one\ntwo\nthree\n\n')).toEqual({
      full: 'one\ntwo\nthree',
      summary: 'one\ntwo\nthree',
      cut: false,
    });
  });
});
