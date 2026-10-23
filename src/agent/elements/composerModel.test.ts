import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PICK,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  effortPick,
  modelPick,
  otherModel,
  withEffort,
  withModel,
} from '@/agent/elements/composerModel';
import {
  CLAUDE_CODE_DEFAULT,
  EFFORT_LEVELS,
  MODEL_SUGGESTIONS,
  type RunChoice,
} from '@/engine/runOptions';

/**
 * The composer's Model Selector over a conversation's run choice (M91.12a):
 * the artifact's radios under the ids the run-options spec presses, the
 * radio a stored choice checks, and the choice a pick makes.
 */

const UNSET: RunChoice = { model: null, effort: null };

describe('the radios', () => {
  it('offer Claude Code’s default, then the artifact’s suggestions, by their spec ids', () => {
    expect(MODEL_CHOICES.map((choice) => choice.testId)).toEqual([
      'run-model-default',
      ...MODEL_SUGGESTIONS.map((model) => `run-model-${model.id}`),
    ]);
    expect(MODEL_CHOICES[0]).toEqual({
      value: DEFAULT_PICK,
      label: CLAUDE_CODE_DEFAULT,
      testId: 'run-model-default',
    });
    expect(MODEL_CHOICES.map((choice) => choice.label)).toContain('Opus');
  });

  it('offer Claude Code’s default, then every effort level in order', () => {
    expect(EFFORT_CHOICES.map((choice) => choice.value)).toEqual([
      DEFAULT_PICK,
      ...EFFORT_LEVELS.map((level) => level.id),
    ]);
    expect(EFFORT_CHOICES.find((choice) => choice.value === 'xhigh')).toEqual({
      value: 'xhigh',
      label: 'Extra high',
      testId: 'run-effort-xhigh',
    });
  });

  it('name nothing blank but the default: no id collides with it', () => {
    for (const choices of [MODEL_CHOICES, EFFORT_CHOICES]) {
      expect(choices.filter((choice) => choice.value === DEFAULT_PICK)).toHaveLength(1);
    }
  });
});

describe('what a stored choice checks', () => {
  it('checks the default for an unset or blank value', () => {
    expect(modelPick(UNSET)).toBe(DEFAULT_PICK);
    expect(effortPick({ model: '  ', effort: '' })).toBe(DEFAULT_PICK);
  });

  it('checks a suggestion and a level by their ids', () => {
    expect(modelPick({ model: 'opus', effort: null })).toBe('opus');
    expect(effortPick({ model: null, effort: 'high' })).toBe('high');
  });

  it('checks no radio for a full model name, which Other holds', () => {
    const choice = { model: 'claude-opus-5-5[1m]', effort: null };
    expect(modelPick(choice)).toBeNull();
    expect(otherModel(choice)).toBe('claude-opus-5-5[1m]');
    expect(otherModel({ model: 'opus', effort: null })).toBe('');
    expect(otherModel(UNSET)).toBe('');
  });

  it('checks no radio for an effort the artifact does not offer', () => {
    expect(effortPick({ model: null, effort: 'MAX' })).toBeNull();
  });
});

describe('the choice a pick makes', () => {
  it('sets the picked model or effort and keeps the other', () => {
    const choice = { model: 'sonnet', effort: 'low' };
    expect(withModel(choice, 'haiku')).toEqual({ model: 'haiku', effort: 'low' });
    expect(withEffort(choice, 'max')).toEqual({ model: 'sonnet', effort: 'max' });
  });

  it('unsets either for Claude Code’s default, never storing a blank', () => {
    const choice = { model: 'sonnet', effort: 'low' };
    expect(withModel(choice, DEFAULT_PICK)).toEqual({ model: null, effort: 'low' });
    expect(withEffort(choice, DEFAULT_PICK)).toEqual({ model: 'sonnet', effort: null });
  });
});
