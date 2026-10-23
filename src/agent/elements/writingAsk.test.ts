import { describe, expect, it } from 'vitest';
import { aiBlockRun, askAiWorking, rewriteDecision } from './writingAsk';

/**
 * The editor's asks in words (M91.14): what Ask AI says while it works, the
 * card that decides a rewrite, and the AI block's run button.
 */

describe('askAiWorking', () => {
  it('says what is being done to the passage', () => {
    expect(askAiWorking()).toBe('Rewriting the passage…');
    expect(askAiWorking('tighten')).toBe('Running /tighten on the passage…');
  });
});

describe('rewriteDecision', () => {
  it('counts what is taken, and applies only when something is', () => {
    expect(rewriteDecision(3, 2)).toEqual({
      title: 'Apply the rewrite?',
      summary: '2 of 3 changes · click one to toggle it',
      apply: 'Apply',
    });
    expect(rewriteDecision(1, 0)).toEqual({
      title: 'Apply the rewrite?',
      summary: '0 of 1 change · click one to toggle it',
      apply: 'Keep mine',
    });
  });

  it('says an unchanged passage came back as it was, with nothing to count', () => {
    expect(rewriteDecision(0, 0)).toEqual({
      title: 'The assistant left the passage as it was.',
      summary: null,
      apply: 'Keep mine',
    });
  });
});

describe('aiBlockRun', () => {
  it('works only while running, and otherwise answers or recomputes', () => {
    expect(aiBlockRun('', true)).toEqual({ label: 'Working…', working: true });
    expect(aiBlockRun('2026-10-12', true)).toEqual({ label: 'Working…', working: true });
    expect(aiBlockRun('', false)).toEqual({ label: 'Answer', working: false });
    expect(aiBlockRun('2026-10-12', false)).toEqual({ label: 'Recompute', working: false });
  });
});
