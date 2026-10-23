/**
 * A turn's chain of thought, summed up (M91.10): the counts its title is
 * worded from. The words themselves live in the ChainOfThought element
 * (§3.3); this says only how many steps there are, how many failed, how many
 * sit inside the chain's fold, and whether one is still running. Pure: no
 * DOM.
 */

import type { StepInput } from './types';

export interface StepSummary {
  running: boolean;
  total: number;
  failed: number;
  /** Steps inside the chain's fold rather than lines of their own. */
  folded: number;
}

export function summarizeSteps(steps: readonly StepInput[]): StepSummary {
  return {
    running: steps.some((step) => step.status === 'running'),
    total: steps.length,
    failed: steps.filter((step) => step.status === 'failed').length,
    folded: steps.filter((step) => step.folds).length,
  };
}
