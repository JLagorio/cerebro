import { describe, expect, it } from 'vitest';
import RUN_OPTIONS from '../../shared/policy/run-options.v1.json';
import {
  CLAUDE_CODE_DEFAULT,
  EFFORT_LEVELS,
  MODEL_SUGGESTIONS,
  effortLabel,
  effortRefusal,
  isEffort,
  isModelName,
  isUnset,
  modelLabel,
  modelRefusal,
  runOptionsRefusal,
  storedChoice,
} from './runOptions';

describe('run options (M56.5)', () => {
  it('replays shared/policy/run-options.v1.json, the cases run_options.rs replays too', () => {
    expect(RUN_OPTIONS.cases.length).toBeGreaterThan(20);
    for (const c of RUN_OPTIONS.cases) {
      const value = c.value;
      const refusal = c.field === 'effort' ? effortRefusal(value) : modelRefusal(value);
      const label = JSON.stringify(c);
      if (c.verdict === 'unset') {
        expect(isUnset(value), label).toBe(true);
        expect(refusal, label).toBeNull();
      } else if (c.verdict === 'valid') {
        expect(refusal, label).toBeNull();
        expect(c.field === 'effort' ? isEffort(value!) : isModelName(value!), label).toBe(true);
      } else {
        expect(c.verdict, label).toBe('refused');
        expect(refusal, label).not.toBeNull();
        if ('message' in c && typeof c.message === 'string') expect(refusal, label).toBe(c.message);
      }
    }
  });

  it('labels a level and a suggestion, and leaves anything else raw', () => {
    expect(EFFORT_LEVELS.map((l) => l.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLabel('xhigh')).toBe('Extra high');
    expect(effortLabel('turbo')).toBe('turbo');
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(CLAUDE_CODE_DEFAULT).toBe('Claude Code default');
  });

  it('suggests the aliases Claude Code 2.1.250 names, each a model name', () => {
    expect(MODEL_SUGGESTIONS.map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    for (const m of MODEL_SUGGESTIONS) expect(isModelName(m.id)).toBe(true);
  });

  it('refuses in argv order, model first', () => {
    expect(runOptionsRefusal({ model: '-x', effort: 'turbo' })).toMatch(/^model "-x"/);
    expect(runOptionsRefusal({ model: 'opus', effort: 'turbo' })).toMatch(/^effort "turbo"/);
    expect(runOptionsRefusal({ model: null, effort: null })).toBeNull();
    expect(runOptionsRefusal({})).toBeNull();
  });

  it('reads a stored value trimmed, and blank or a non-string as unset', () => {
    expect(storedChoice(' opus ')).toBe('opus');
    expect(storedChoice('  ')).toBeNull();
    expect(storedChoice(3)).toBeNull();
    expect(storedChoice(undefined)).toBeNull();
  });
});
