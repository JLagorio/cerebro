import { describe, expect, it } from 'vitest';
import type { SubagentRun, ToolCall } from '@/agent/types';
import {
  callDuration,
  callSubject,
  callWords,
  handoffRunId,
  isShellCall,
  laidOut,
  shellCommand,
  stepStateOf,
  subagentWords,
} from './turnTitles';

/**
 * A call's line (M91.13): the manifest's status phrases in its state's
 * tense, its name and its state in words where it names none, and what it
 * was aimed at.
 */

function call(name: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id: 'c', name, input: '{}', output: 'ok', done: true, failed: false, ...over };
}

const phrases = {
  running: 'appending to a note',
  done: 'appended to a note',
  failed: 'failed to append to a note',
};
const withPhrases = () => ({ phrases });
const without = () => ({ phrases: null });

describe('callWords', () => {
  const append = call('mcp__cerebro__append_to_note');

  it('says a row’s phrases in its state’s tense, which say the state', () => {
    expect(callWords(append, 'running', withPhrases)).toEqual({
      title: 'Appending to a note',
      statusText: null,
    });
    expect(callWords(append, 'done', withPhrases)).toEqual({ title: 'Appended to a note' });
    expect(callWords(append, 'failed', withPhrases)).toEqual({
      title: 'Failed to append to a note',
    });
  });

  it('says a name where the row has no phrases, and a failure on the line', () => {
    expect(callWords(append, 'running', without)).toEqual({ title: 'append to note' });
    expect(callWords(append, 'done', without)).toEqual({ title: 'append to note' });
    expect(callWords(append, 'failed', without)).toEqual({ title: 'Failed: append to note' });
  });

  it('says Denied for a call Claude Code refused, and a name for one that never finished', () => {
    expect(callWords(append, 'denied', withPhrases)).toEqual({ title: 'Denied: append to note' });
    for (const state of ['interrupted', 'waiting', 'cancelled', 'not_run', 'paused'] as const) {
      expect(callWords(append, state, withPhrases)).toEqual({ title: 'append to note' });
    }
  });

  it('reads the shipped manifest: a writer’s phrases, a read’s name', () => {
    expect(callWords(append, 'done').title).toBe('Appended to a note');
    expect(callWords(call('mcp__cerebro__search_notes'), 'done').title).toBe('search notes');
    expect(callWords(call('Bash'), 'running')).toEqual({
      title: 'Running a command',
      statusText: null,
    });
    expect(callWords(call('mcp__gmail__get_thread'), 'done').title).toBe('get thread');
  });
});

describe('stepStateOf', () => {
  it('reads a call Claude Code refused as denied, whatever its status', () => {
    const refused = call('Agent', { failed: true, denied: 'Denied by a rule.' });
    expect(stepStateOf(refused, 'failed')).toBe('denied');
    expect(stepStateOf(call('Agent'), 'done')).toBe('done');
  });
});

describe('callSubject', () => {
  it('names where a change landed, else the path or query its input names', () => {
    const created = call('mcp__cerebro__create_canvas', {
      input: JSON.stringify({ folder: 'boards', slug: 'plan' }),
      output: JSON.stringify({ path: 'boards/plan-2.canvas' }),
    });
    expect(callSubject(created)).toBe('boards/plan-2.canvas');
    expect(callSubject(call('mcp__cerebro__search_notes', { input: '{"query":"risk"}' }))).toBe(
      'risk',
    );
  });

  it('names a CLI call by the input field its manifest row names', () => {
    const bash = call('Bash', { input: JSON.stringify({ command: 'ls', description: 'List' }) });
    expect(callSubject(bash)).toBe('ls');
    expect(shellCommand(bash)).toBe('ls');
    const fetch = call('WebFetch', { input: JSON.stringify({ url: 'https://example.com' }) });
    expect(callSubject(fetch)).toBe('https://example.com');
    expect(callSubject(call('mcp__cerebro__navigate', { input: '{}' }))).toBeNull();
  });
});

describe('isShellCall', () => {
  it('knows a command by its shell result or its manifest family, never by its name', () => {
    expect(isShellCall(call('Bash'))).toBe(true);
    expect(
      isShellCall(
        call('Unlisted', {
          result: { type: 'shell', stdout: '', stderr: '', interrupted: false, truncated: false },
        }),
      ),
    ).toBe(true);
    expect(isShellCall(call('Read'))).toBe(false);
  });
});

describe('callDuration', () => {
  it('times a call only from two recorded times that run forwards (CV-05)', () => {
    const timed = call('Bash', {
      startedAt: '2026-10-22T09:00:00.000Z',
      endedAt: '2026-10-22T09:00:01.900Z',
    });
    expect(callDuration(timed)).toBe(1900);
    expect(callDuration(call('Bash', { startedAt: '2026-10-22T09:00:00.000Z' }))).toBeUndefined();
    expect(
      callDuration(
        call('Bash', {
          startedAt: '2026-10-22T09:00:02.000Z',
          endedAt: '2026-10-22T09:00:01.000Z',
        }),
      ),
    ).toBeUndefined();
  });
});

describe('handoffRunId', () => {
  it('reads the run a hand-off started from its answer, or none', () => {
    expect(
      handoffRunId(
        'Started Release scout (run 0f1e2d3c4b5a69788796a5b4c3d2e1f0) with what you handed it.',
      ),
    ).toBe('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    expect(handoffRunId('night-owl is paused.')).toBeNull();
    expect(handoffRunId(null)).toBeNull();
  });
});

describe('subagentWords', () => {
  const run = (description: string): SubagentRun => ({
    type: '',
    description,
    status: 'failed',
    parts: [],
    tools: [],
  });
  it('says Denied for a refused Agent call, never an empty task', () => {
    expect(subagentWords(run('Read the risks'), true)).toEqual({
      title: 'Denied: Read the risks',
      statusText: null,
    });
    expect(subagentWords(run(''), true)).toEqual({ title: 'Denied a subagent', statusText: null });
    expect(subagentWords(run('Read the risks'), false)).toBeNull();
  });
});

describe('laidOut', () => {
  it('lays out JSON objects and leaves anything else as it came', () => {
    expect(laidOut('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true });
    expect(laidOut('"text"')).toEqual({ text: '"text"', json: false });
    expect(laidOut('{"cut')).toEqual({ text: '{"cut', json: false });
  });
});
