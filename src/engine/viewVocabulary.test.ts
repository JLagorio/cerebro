/** Shared artifact: shared/schema/views.v1.json; its Rust reader replays the same shape controls. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@/lib/sha256';
import { CHART_AGGS, CHART_KINDS, CHART_SORTS, DATE_BUCKETINGS, VIEW_TYPES } from './types';
import { MAX_GROUP_DEPTH, MAX_SORT_KEYS, parseViewList } from './views';
import {
  type ViewVocabulary,
  parseViewVocabulary,
  VIEWS_DIGEST_PATH,
  VIEWS_PATH,
  VIEW_VOCABULARY as V,
} from './viewVocabulary';
const raw = readFileSync(join(__dirname, '../..', VIEWS_PATH), 'utf8');
const copy = () => structuredClone(JSON.parse(raw)) as ViewVocabulary;
describe('the shared views vocabulary', () => {
  it('hashes to the digest the Rust reader also asserts', () => {
    expect(sha256Hex(raw)).toBe(
      readFileSync(join(__dirname, '../..', VIEWS_DIGEST_PATH), 'utf8').trim(),
    );
    expect(parseViewVocabulary(JSON.parse(raw))).toEqual(V);
  });
  it('holds the app unions and limits to the artifact', () => {
    expect(V.view_types.map((v) => v.id)).toEqual(VIEW_TYPES);
    expect(V.chart_kinds.map((v) => v.id)).toEqual(CHART_KINDS);
    expect(V.chart_aggs).toEqual(CHART_AGGS);
    expect(V.chart_sorts).toEqual(CHART_SORTS);
    expect(V.date_buckets).toEqual(DATE_BUCKETINGS);
    expect(V.limits.group_levels).toBe(MAX_GROUP_DEPTH);
    expect(V.limits.sort_keys).toBe(MAX_SORT_KEYS);
    for (const zoom of V.zooms)
      expect(
        parseViewList([{ id: 'v', name: 'V', presentation: { type: 'timeline', zoom } }])[0]
          .presentation.zoom,
      ).toBe(zoom);
    for (const calendarSpan of V.calendar_spans)
      expect(
        parseViewList([{ id: 'v', name: 'V', presentation: { type: 'calendar', calendarSpan } }])[0]
          .presentation.calendarSpan ?? 'month',
      ).toBe(calendarSpan);
  });
  it.each([
    [
      'shape',
      (v: ViewVocabulary) => {
        Object.assign(v, { extra: true });
      },
      'views: invalid table shape',
    ],
    [
      'format',
      (v: ViewVocabulary) => {
        v.format = 2;
      },
      'views: format must be 1, not 2',
    ],
    [
      'rule',
      (v: ViewVocabulary) => {
        v.rule_version = ' ';
      },
      'views: rule_version is empty',
    ],
    [
      'version',
      (v: ViewVocabulary) => {
        v.artifact_version = 0;
      },
      'views: artifact_version must be positive',
    ],
    [
      'duplicate',
      (v: ViewVocabulary) => {
        v.view_types.push(v.view_types[0]);
      },
      'views: view_types must be non-empty and unique',
    ],
    [
      'need',
      (v: ViewVocabulary) => {
        v.view_types[0].needs = ['absent'];
      },
      'views: unknown need absent',
    ],
    [
      'chart read',
      (v: ViewVocabulary) => {
        v.chart_kinds[0].reads.push('absent');
      },
      'views: chart kind bar reads unknown key absent',
    ],
    [
      'slot',
      (v: ViewVocabulary) => {
        v.slots.group.fact = 'absent';
      },
      'views: slot group names unknown fact absent',
    ],
    [
      'limit',
      (v: ViewVocabulary) => {
        v.limits.columns = 0;
      },
      'views: limit columns must be a positive integer',
    ],
  ])('refuses malformed %s in Rust words', (_name, mutate, error) => {
    const value = copy();
    mutate(value);
    expect(() => parseViewVocabulary(value)).toThrow(error);
  });
});
