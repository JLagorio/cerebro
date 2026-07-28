import { describe, expect, it } from 'vitest';
import { applyFormat, formatNumber, progressRatio, rollupCalcMeta } from '@/engine/properties';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { FieldDef } from '@/engine/types';

const numberDef = (extra: Partial<FieldDef> = {}): FieldDef => ({
  name: 'score',
  kind: 'number',
  ...extra,
});

describe('numeric formats (M3.4)', () => {
  it('trims trailing zeros at the field precision', () => {
    expect(formatNumber(69.666, numberDef())).toBe('69.67');
    expect(formatNumber(3, numberDef())).toBe('3');
    expect(formatNumber(69.666, numberDef({ precision: 0 }))).toBe('70');
  });

  it('renders percent and progress with a % suffix', () => {
    expect(formatNumber(76, numberDef({ format: 'percent', precision: 0 }))).toBe('76%');
    expect(formatNumber(76, numberDef({ format: 'progress', precision: 0 }))).toBe('76%');
  });

  it('groups currency', () => {
    expect(formatNumber(1234.5, numberDef({ format: 'currency', precision: 2 }))).toBe('$1,234.5');
  });

  it('leaves non-numeric rollup output alone', () => {
    // `show` rollups join labels — formatting must not mangle them.
    expect(applyFormat('Thai, Oaxacan', numberDef({ format: 'percent' }))).toBe('Thai, Oaxacan');
  });

  it('clamps progress ratios into 0–100', () => {
    expect(progressRatio('76%')).toBe(76);
    expect(progressRatio('130%')).toBe(100);
    expect(progressRatio('-4')).toBe(0);
    expect(progressRatio('n/a')).toBeNull();
  });
});

describe('rollup configuration', () => {
  it('knows which calculations need a property', () => {
    expect(rollupCalcMeta('count').needsProperty).toBe(false);
    expect(rollupCalcMeta('avg').needsProperty).toBe(true);
    // Unknown/undefined falls back to count rather than throwing.
    expect(rollupCalcMeta(undefined).calc).toBe('count');
  });

  it('computes and formats a rollup through resolveField', () => {
    const entries = [
      makeEntry({
        path: 'types/objective.md',
        title: 'Objective',
        type: 'Type',
        properties: {
          fields: {
            key_results: { kind: 'relation', target: 'Key result' },
            progress: {
              kind: 'rollup',
              relation: 'key_results',
              property: 'attainment',
              calculate: 'avg',
              format: 'percent',
              precision: 0,
            },
          },
        } as never,
      }),
      makeEntry({
        path: 'types/key-result.md',
        title: 'Key result',
        type: 'Type',
        properties: { fields: { attainment: { kind: 'number' } } } as never,
      }),
      makeEntry({ path: 'krs/a.md', title: 'A', type: 'Key result', properties: { attainment: 80 } }),
      makeEntry({ path: 'krs/b.md', title: 'B', type: 'Key result', properties: { attainment: 40 } }),
      makeEntry({
        path: 'objs/o.md',
        title: 'O',
        type: 'Objective',
        relationships: { key_results: ['a', 'b'] },
      }),
    ];
    const schema = buildSchema(entries);
    const objective = entries[entries.length - 1];
    expect(schema.resolveField(objective, 'progress').display).toBe('60%');
  });

  it('round-trips format and precision through the Type doc parser', () => {
    const schema = buildSchema([
      makeEntry({
        path: 'types/kr.md',
        title: 'Key result',
        type: 'Type',
        properties: {
          fields: { attainment: { kind: 'number', format: 'progress', precision: 0 } },
        } as never,
      }),
    ]);
    const def = schema.types.get('Key result')?.fields[0];
    expect(def?.format).toBe('progress');
    expect(def?.precision).toBe(0);
  });
});
