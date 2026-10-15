/**
 * The date grammar, TS side (M60.3): byte identity with Rust, the shared
 * cases replayed zone by zone, the same refusals, and the two adapters in
 * dates.ts that read through it.
 *
 * @see shared/calendar/dates.v1.json
 * @see src-tauri/src/vault/dates.rs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/sha256';
import {
  DATE_GRAMMAR,
  DATES_DIGEST_PATH,
  DATES_PATH,
  dateRangeFault,
  isDateText,
  parseDateGrammar,
  readDateValue,
} from './dateGrammar';
import { parseDateProperty, parseEndpoint } from './dates';

const REPO = join(__dirname, '../..');
const RAW = readFileSync(join(REPO, DATES_PATH), 'utf8');

interface DateCase {
  name: string;
  input: unknown;
  zone: string;
  valid: boolean;
  read: unknown;
}

const tz = process.env.TZ;
afterEach(() => {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

describe('the shared grammar is one artifact', () => {
  it('hashes to the digest the Rust reader also asserts', () => {
    // Regenerate deliberately after an edit with
    // `cargo test --lib vault::dates::tests::write_dates_digest -- --ignored`.
    const committed = readFileSync(join(REPO, DATES_DIGEST_PATH), 'utf8').trim();
    expect(sha256Hex(RAW)).toBe(committed);
    expect(JSON.parse(RAW)).toEqual(DATE_GRAMMAR);
  });

  it('replays the shared date cases', () => {
    const cases = DATE_GRAMMAR.cases as DateCase[];
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      process.env.TZ = c.zone;
      const valid =
        c.input !== null && typeof c.input === 'object' && !Array.isArray(c.input)
          ? dateRangeFault(c.input) === null
          : isDateText(c.input);
      expect(valid, `valid: ${c.name}`).toBe(c.valid);
      expect(readDateValue(c.input), `read: ${c.name}`).toEqual(c.read);
    }
  });
});

describe("refuses malformed grammars in Rust's words", () => {
  const base = () => JSON.parse(RAW) as Record<string, unknown>;

  it.each([
    ['format 2', { format: 2 }, 'dates: format must be 1, not 2'],
    ['an empty rule_version', { rule_version: '' }, 'dates: rule_version is empty'],
    ['an unknown form', { forms: ['date', 'week'] }, 'dates: unknown form week'],
    ['no separators', { time_separators: [] }, 'dates: time_separators is empty'],
    ['no cases', { cases: [] }, 'dates: no cases'],
  ])('%s', (_label, edit, words) => {
    expect(() => parseDateGrammar({ ...base(), ...edit })).toThrow(words);
  });

  it('refuses malformed relative sections in the shared words', () => {
    const edits: [string, unknown, string][] = [
      ['relative', null, 'dates: relative has an invalid shape'],
      ['days', [], 'dates: relative tokens must be non-empty and unique'],
      ['week_starts', [1, 0], 'dates: relative week_starts must be 0, 1 in order'],
      ['words', {}, 'dates: relative words must name {n}'],
    ];
    for (const [key, value, words] of edits) {
      const edited = structuredClone(DATE_GRAMMAR);
      if (key === 'relative') (edited as unknown as Record<string, unknown>)[key] = value;
      else (edited.relative as unknown as Record<string, unknown>)[key] = value;
      expect(() => parseDateGrammar(edited)).toThrow(words);
    }
    const badOffsets = structuredClone(DATE_GRAMMAR);
    badOffsets.relative.offsets.max = 1000;
    expect(() => parseDateGrammar(badOffsets)).toThrow('dates: relative offsets are invalid');
    const badPeriod = structuredClone(DATE_GRAMMAR);
    Object.assign(badPeriod.relative.periods[0], { unit: 'year' });
    expect(() => parseDateGrammar(badPeriod)).toThrow(
      'dates: relative period unit has an unknown word year',
    );
    expect(() => parseDateGrammar({ ...DATE_GRAMMAR, relative_cases: [] })).toThrow(
      'dates: no relative cases',
    );
  });
});

describe('the dates.ts adapters read through the grammar', () => {
  it('parseEndpoint and parseDateProperty adapt the reader', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(parseEndpoint('2026-07-28 14:30')).toEqual({
      date: '2026-07-28',
      time: '14:30',
      instant: false,
    });
    expect(parseEndpoint(' 2026-07-28 ')).toEqual({
      date: '2026-07-28',
      time: null,
      instant: false,
    });
    expect(parseEndpoint('2026-07-28 kickoff')).toBeNull();
    expect(parseEndpoint(20260728)).toBeNull();
    // The scanner's stamp, read in Los Angeles.
    expect(parseDateProperty('2026-07-28T00:00:00Z')).toMatchObject({
      start: '2026-07-27',
      startTime: '17:00',
      end: null,
    });
    // A junk end reads as an open range.
    expect(parseDateProperty({ start: '2026-07-28', end: 'soon' })).toMatchObject({
      start: '2026-07-28',
      end: null,
      endTime: null,
    });
  });
});
