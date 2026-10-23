import { describe, expect, it } from 'vitest';
import { upNextRow, type UpNextRowState } from '@/agent/elements/composerQueue';
import type { UpNextEntry } from '@/agent/upNextQueue';

/**
 * Up next's rows (M57.5, M91.12a): what each entry offers beside its line —
 * Steer while a turn runs, Run now while on hold, Edit on what the person
 * typed, Remove on anything — and nothing while it starts or is edited.
 */

const entry = (id: string, over: Partial<UpNextEntry> = {}): UpNextEntry => ({
  id,
  text: `message ${id}`,
  skill: null,
  narrowing: {},
  turn: { systemPrompt: () => '', place: null, conversationId: 'c-1' },
  vault: '/vault',
  queuedAt: 0,
  ...over,
});

const idle: UpNextRowState = { held: false, steering: null, editing: null, busy: false };

describe('upNextRow', () => {
  it('offers Edit and Remove on a typed entry while nothing runs', () => {
    expect(upNextRow(entry('a'), idle)).toEqual({
      starting: false,
      editing: false,
      actions: ['edit', 'remove'],
    });
  });

  it('offers Steer while a turn is busy, only while a stop can be resumed', () => {
    const busy = { ...idle, busy: true };
    expect(upNextRow(entry('a'), busy, true).actions).toEqual(['steer', 'edit', 'remove']);
    expect(upNextRow(entry('a'), busy, false).actions).toEqual(['edit', 'remove']);
  });

  it('offers Run now while on hold and idle, never while a turn is busy', () => {
    expect(upNextRow(entry('a'), { ...idle, held: true }).actions).toEqual([
      'run-now',
      'edit',
      'remove',
    ]);
    expect(upNextRow(entry('a'), { ...idle, held: true, busy: true }, true).actions).toEqual([
      'steer',
      'edit',
      'remove',
    ]);
  });

  it('offers no Edit on a page’s ask or on review notes', () => {
    expect(upNextRow(entry('h', { prompt: 'REVISE A' }), idle).actions).toEqual(['remove']);
    expect(upNextRow(entry('n', { notes: { ids: ['rn-1'] } }), idle).actions).toEqual(['remove']);
  });

  it('is starting while steered, offering nothing, and no other row offers Steer', () => {
    const steering = { ...idle, busy: true, steering: 'h' };
    expect(upNextRow(entry('h'), steering, true)).toEqual({
      starting: true,
      editing: false,
      actions: [],
    });
    expect(upNextRow(entry('a'), steering, true).actions).toEqual(['edit', 'remove']);
  });

  it('opens a typed entry’s editor, offering nothing until it closes', () => {
    const editing = { ...idle, editing: 'a' };
    expect(upNextRow(entry('a'), editing)).toEqual({
      starting: false,
      editing: true,
      actions: [],
    });
    expect(upNextRow(entry('b'), editing).actions).toEqual(['edit', 'remove']);
    // An entry that is not typed never shows an editor, even when asked to.
    expect(upNextRow(entry('h', { prompt: 'REVISE' }), { ...idle, editing: 'h' })).toEqual({
      starting: false,
      editing: false,
      actions: [],
    });
  });
});
