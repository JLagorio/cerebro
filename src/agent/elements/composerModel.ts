import type { ModelSelectorChoice } from '@/components/ai/ModelSelector';
import {
  CLAUDE_CODE_DEFAULT,
  EFFORT_LEVELS,
  isUnset,
  MODEL_SUGGESTIONS,
  type RunChoice,
} from '@/engine/runOptions';

/**
 * The composer's Model Selector (M91.12a) over a conversation's run choice
 * (M56.5): the radios `run-options.v1.json` offers, which the choice checks,
 * and the choice a pick makes. Nothing here lists a model or an effort of
 * its own; the artifact does (CV-04). Pure.
 */

/** The radio that stands for Claude Code's own default: no flag. Blank is
 *  unset, so no model or effort id is ever this value. */
export const DEFAULT_PICK = '';

/** The Model group: Claude Code's default, then the suggested aliases. A
 *  full model name has no radio; Other holds it. */
export const MODEL_CHOICES: readonly ModelSelectorChoice[] = [
  { value: DEFAULT_PICK, label: CLAUDE_CODE_DEFAULT, testId: 'run-model-default' },
  ...MODEL_SUGGESTIONS.map((model) => ({
    value: model.id,
    label: model.label,
    testId: `run-model-${model.id}`,
  })),
];

/** The Effort group: Claude Code's default, then the levels in order. */
export const EFFORT_CHOICES: readonly ModelSelectorChoice[] = [
  { value: DEFAULT_PICK, label: CLAUDE_CODE_DEFAULT, testId: 'run-effort-default' },
  ...EFFORT_LEVELS.map((level) => ({
    value: level.id,
    label: level.label,
    testId: `run-effort-${level.id}`,
  })),
];

/** The radio a stored value checks: the default when it is unset, its own
 *  when one of `choices` names it, and none for anything else. */
function pickOf(value: string | null, choices: readonly ModelSelectorChoice[]): string | null {
  if (isUnset(value)) return DEFAULT_PICK;
  return choices.some((choice) => choice.value === value) ? value : null;
}

/** The Model radio the choice checks, or null when it names a model no
 *  radio offers (Other's). */
export function modelPick(choice: RunChoice): string | null {
  return pickOf(choice.model, MODEL_CHOICES);
}

/** The Effort radio the choice checks, or null for a stored effort the
 *  artifact does not offer: Rust refuses that one before a run starts. */
export function effortPick(choice: RunChoice): string | null {
  return pickOf(choice.effort, EFFORT_CHOICES);
}

/** What Other starts holding: the model in use when no radio names it. */
export function otherModel(choice: RunChoice): string {
  return modelPick(choice) === null ? (choice.model ?? '') : '';
}

/** The choice with the picked Model radio; the default unsets it. */
export function withModel(choice: RunChoice, pick: string): RunChoice {
  return { ...choice, model: pick === DEFAULT_PICK ? null : pick };
}

/** The choice with the picked Effort radio; the default unsets it. */
export function withEffort(choice: RunChoice, pick: string): RunChoice {
  return { ...choice, effort: pick === DEFAULT_PICK ? null : pick };
}
