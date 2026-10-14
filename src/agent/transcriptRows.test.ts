import { describe, expect, it } from 'vitest';
import {
  groupLabel,
  toolStatus,
  transcriptRows,
  type ToolGroupRow,
  type TranscriptRow,
} from '@/agent/transcriptRows';
import type { ToolCall } from '@/agent/types';

/**
 * Transcript rows (M56.8): which calls fold, under what label, and what a
 * call's status is. The manifest's phrases are the real ones, read through
 * toolFacts, so a phrase edit in tools.v1.json moves these labels.
 */

let next = 0;
function call(name: string, over: Partial<ToolCall> = {}): ToolCall {
  next += 1;
  return {
    id: `t-${next}`,
    name: `mcp__cerebro__${name}`,
    input: '{}',
    output: 'ok',
    done: true,
    failed: false,
    ...over,
  };
}

const cli = (name: string, over: Partial<ToolCall> = {}): ToolCall => ({
  ...call(name, over),
  name,
});

/** Each row as a short word: the tool's bare name, or `group(label)`. */
function shape(rows: TranscriptRow[]): string[] {
  return rows.map((row) =>
    row.kind === 'group'
      ? `group(${row.label})`
      : row.tool.name.replace('mcp__cerebro__', '') + `:${row.status}`,
  );
}

describe('transcriptRows', () => {
  it('folds five get_note calls into one row reading "Read 5 notes"', () => {
    const tools = Array.from({ length: 5 }, () => call('get_note'));
    const rows = transcriptRows(tools, false);
    expect(rows).toHaveLength(1);
    const [group] = rows as [ToolGroupRow];
    expect(group.kind).toBe('group');
    expect(group.label).toBe('Read 5 notes');
    expect(group.members.map((m) => m.tool.id)).toEqual(tools.map((t) => t.id));
    expect(group.running).toBe(false);
  });

  it('breaks a run of reads at a write, which keeps its own row', () => {
    const rows = transcriptRows(
      [call('get_note'), call('get_note'), call('edit_note'), call('get_note'), call('get_note')],
      false,
    );
    expect(shape(rows)).toEqual(['group(Read 2 notes)', 'edit_note:done', 'group(Read 2 notes)']);
  });

  it('stands a failed read alone, outside any group', () => {
    const rows = transcriptRows(
      [
        call('get_note'),
        call('get_note', { failed: true, output: 'no note at x.md' }),
        call('get_note'),
      ],
      false,
    );
    expect(shape(rows)).toEqual(['get_note:done', 'get_note:failed', 'get_note:done']);
  });

  it('stands an interrupted read alone once the turn has stopped', () => {
    const rows = transcriptRows(
      [call('get_note'), call('get_note'), call('get_note', { done: false, output: null })],
      false,
    );
    expect(shape(rows)).toEqual(['group(Read 2 notes)', 'get_note:interrupted']);
  });

  it('keeps one read a card', () => {
    expect(shape(transcriptRows([call('search_notes')], false))).toEqual(['search_notes:done']);
  });

  it('labels mixed reads by tool, in the order first seen', () => {
    const two = transcriptRows([call('search_notes'), call('get_note'), call('get_note')], false);
    expect(shape(two)).toEqual(['group(Searched notes and read 2 notes)']);
    const three = transcriptRows(
      [
        call('get_vault_context'),
        call('get_note'),
        call('search_notes'),
        call('get_note'),
        call('search_notes'),
      ],
      false,
    );
    expect(shape(three)).toEqual([
      'group(Read the vault overview, read 2 notes, and searched notes 2 times)',
    ]);
    // The CLI's own readers fold too, by their manifest rows.
    expect(shape(transcriptRows([cli('Read'), cli('Read'), cli('Grep')], false))).toEqual([
      'group(Read 2 files and searched files)',
    ]);
  });

  it('never groups hand_to, commit_proposals or write_concept', () => {
    const owned = [
      call('hand_to'),
      call('hand_to'),
      call('commit_proposals'),
      call('commit_proposals'),
      call('write_concept'),
      call('write_concept'),
      call('recheck_concept'),
    ];
    expect(transcriptRows(owned, false).every((row) => row.kind === 'tool')).toBe(true);
  });

  it('never groups a connector tool or one the manifest does not know', () => {
    const tools = [
      { ...call('x'), name: 'mcp__gmail__search_threads' },
      { ...call('x'), name: 'mcp__gmail__search_threads' },
      { ...call('x'), name: 'SomethingNew' },
      { ...call('x'), name: 'SomethingNew' },
    ];
    expect(transcriptRows(tools, false).every((row) => row.kind === 'tool')).toBe(true);
  });

  it('lets a running read join its group while the turn streams', () => {
    const rows = transcriptRows(
      [call('get_note'), call('get_note', { done: false, output: null })],
      true,
    );
    expect(rows).toHaveLength(1);
    const [group] = rows as [ToolGroupRow];
    expect(group.label).toBe('Read 2 notes');
    expect(group.running).toBe(true);
    expect(group.members.map((m) => m.status)).toEqual(['done', 'running']);
  });

  it('reads unfinished calls as interrupted once the turn stops', () => {
    const tools = [
      call('edit_note', { done: false, output: null }),
      call('get_note', { done: false, output: null }),
    ];
    expect(shape(transcriptRows(tools, true))).toEqual(['edit_note:running', 'get_note:running']);
    expect(shape(transcriptRows(tools, false))).toEqual([
      'edit_note:interrupted',
      'get_note:interrupted',
    ]);
  });

  it('reads the manifest through the facts it is handed', () => {
    const facts = (name: string) =>
      name === 'mcp__cerebro__open_note'
        ? { fold: { one: 'opened a note', many: 'opened {n}' } }
        : null;
    const rows = transcriptRows(
      [call('open_note'), call('open_note'), call('get_note')],
      false,
      facts,
    );
    expect(shape(rows)).toEqual(['group(Opened 2)', 'get_note:done']);
  });
});

describe('groupLabel and toolStatus', () => {
  it('counts the short and the full spelling as one tool', () => {
    expect(groupLabel([call('get_note'), { ...call('x'), name: 'get_note' }])).toBe('Read 2 notes');
  });

  it('says what a call is from done, failed and its message', () => {
    expect(toolStatus(call('get_note'), true)).toBe('done');
    expect(toolStatus(call('get_note', { failed: true }), false)).toBe('failed');
    expect(toolStatus(call('get_note', { done: false }), true)).toBe('running');
    expect(toolStatus(call('get_note', { done: false }), false)).toBe('interrupted');
  });

  it('reads a held call as waiting, cancelled, not run or paused, never interrupted (M57.1)', () => {
    const held = call('append_to_note', { done: false, output: null, deferred: true });
    expect(toolStatus(held, false, held.id)).toBe('waiting');
    expect(toolStatus(held, true, held.id)).toBe('waiting');
    expect(toolStatus(held, false)).toBe('not_run');
    expect(toolStatus(held, false, 'another-call')).toBe('not_run');
    expect(toolStatus({ ...held, cancelled: true }, false, held.id)).toBe('cancelled');
    expect(toolStatus({ ...held, paused: true }, false)).toBe('paused');
    // Answered, it is what it did.
    expect(toolStatus({ ...held, done: true }, false, held.id)).toBe('done');
    expect(toolStatus({ ...held, done: true, failed: true }, false)).toBe('failed');
  });

  it('never folds a held call out of sight (M57.1)', () => {
    const before = call('get_note');
    const held = call('get_note', { done: false, output: null, deferred: true });
    const after = call('get_note');
    for (const [over, waiting, status] of [
      [{}, held.id, 'waiting'],
      [{ cancelled: true }, held.id, 'cancelled'],
      [{ paused: true }, null, 'paused'],
    ] as const) {
      const rows = transcriptRows([before, { ...held, ...over }, after], false, undefined, waiting);
      expect(shape(rows)).toEqual(['get_note:done', `get_note:${status}`, 'get_note:done']);
    }
    const rows = transcriptRows([before, held, after], false);
    expect(shape(rows)).toEqual(['get_note:done', 'get_note:not_run', 'get_note:done']);
  });
});
