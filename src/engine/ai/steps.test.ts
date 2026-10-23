import { describe, expect, it } from 'vitest';
import { summarizeSteps } from './steps';
import type { StepInput, StepStatus } from './types';

const step = (status: StepStatus, folds: boolean, kind: StepInput['kind'] = 'tool'): StepInput => ({
  kind,
  status,
  folds,
});

describe('summarizeSteps', () => {
  it('counts the steps, the failures and what sits inside the fold', () => {
    expect(
      summarizeSteps([
        step('done', true, 'reasoning'),
        step('done', true, 'group'),
        step('failed', false),
        step('done', false, 'subagent'),
      ]),
    ).toEqual({ running: false, total: 4, failed: 1, folded: 2 });
  });

  it('is running while any step runs, inside the fold or not', () => {
    expect(summarizeSteps([step('done', true), step('running', false)]).running).toBe(true);
    expect(summarizeSteps([step('running', true, 'reasoning')]).running).toBe(true);
  });

  it.each(['interrupted', 'waiting', 'cancelled', 'not_run', 'paused'] as const)(
    'counts a step that is %s as neither running nor failed',
    (status) => {
      expect(summarizeSteps([step(status, false)])).toEqual({
        running: false,
        total: 1,
        failed: 0,
        folded: 0,
      });
    },
  );

  it('sums up no steps as none', () => {
    expect(summarizeSteps([])).toEqual({ running: false, total: 0, failed: 0, folded: 0 });
  });
});
