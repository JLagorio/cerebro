import { describe, expect, it } from 'vitest';
import { contextUsageOf } from '@/agent/elements/composerContext';
import { contextName, contextShare } from '@/components/ai/Context';
import type { ContextUseState } from '@/agent/useContextUse';

/**
 * The composer's Context reading (M91.12a): what the pull answered, as the
 * element's three readings. Waiting is not a reading and absent is never
 * zero (CV-05); a window that is not a count is not divided by.
 */

const AT = '2026-10-22T12:00:08.000Z';

describe('contextUsageOf', () => {
  it('carries a recorded reading, its window and its model', () => {
    const usage = contextUsageOf({
      state: 'recorded',
      used: 124_000,
      window: 200_000,
      model: 'claude-sonnet-5',
      at: AT,
    });
    expect(usage).toEqual({
      state: 'recorded',
      used: 124_000,
      window: 200_000,
      model: 'claude-sonnet-5',
    });
    expect(contextName(usage)).toBe('62% of context used');
  });

  it('says what Claude Code did not report, and never divides by it', () => {
    const usage = contextUsageOf({ state: 'recorded', used: 41_200, at: AT });
    expect(usage).toEqual({ state: 'recorded', used: 41_200, window: null, model: null });
    expect(contextName(usage)).toBe('41,200 tokens of context used');
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const odd = contextUsageOf({ state: 'recorded', used: 41_200, window, at: AT });
      expect(odd.state === 'recorded' && odd.window).toBeNull();
      expect(contextShare(odd)).toBeNull();
    }
    const blank = contextUsageOf({ state: 'recorded', used: 5, model: '  ', at: AT });
    expect(blank.state === 'recorded' && blank.model).toBeNull();
  });

  it('reads a count that is not one as unavailable, never as a figure', () => {
    for (const used of [Number.NaN, -1]) {
      expect(contextUsageOf({ state: 'recorded', used, window: 200_000, at: AT })).toEqual({
        state: 'unavailable',
      });
    }
  });

  it.each<[ContextUseState, string]>([
    [{ state: 'not_recorded' }, 'Context use not recorded'],
    [{ state: 'loading' }, 'Context use not recorded'],
    [{ state: 'unavailable' }, 'Context use unavailable'],
  ])('%j reads “%s”, never a zero and never “Context:”', (reading, name) => {
    const usage = contextUsageOf(reading);
    expect(contextName(usage)).toBe(name);
    expect(contextName(usage)).not.toMatch(/^Context:/);
    expect(contextName(usage)).not.toMatch(/\d/);
  });
});
