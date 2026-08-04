import { describe, expect, it } from 'vitest';
import { isBeingRead, newRunId, shouldYield, type RunRecord } from '@/agent/runs';

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: newRunId(),
  owner: 'chat',
  label: 'what is at risk',
  place: null,
  path: null,
  conversationId: 'c-1',
  run: 8,
  startedAt: 0,
  ...over,
});

describe('newRunId', () => {
  it('never repeats, so two tasks cannot share a row', () => {
    const ids = [newRunId(), newRunId(), newRunId()];
    expect(new Set(ids).size).toBe(3);
  });
});

describe('shouldYield', () => {
  it('is false with nothing running', () => {
    expect(shouldYield([])).toBe(false);
  });

  it('holds off for a typed turn — someone is waiting on a reply', () => {
    expect(shouldYield([run({ owner: 'chat' })])).toBe(true);
  });

  it('holds off for another background job — the queue drains one at a time', () => {
    expect(shouldYield([run({ owner: 'job', path: 'notes/a.md' })])).toBe(true);
  });
});

describe('isBeingRead', () => {
  const reading = run({ owner: 'job', path: 'notes/a.md', conversationId: null });

  it('answers for the note actually being read', () => {
    expect(isBeingRead([reading], 'notes/a.md')).toBe(true);
    expect(isBeingRead([reading], 'notes/b.md')).toBe(false);
  });

  it('does not mistake a chat turn for the distiller reading a note', () => {
    // `learningPath` was a single global string, so anything that set it
    // claimed to be the background reader. A chat run has no `path` at all.
    expect(isBeingRead([run({ owner: 'chat' })], 'notes/a.md')).toBe(false);
  });
});
