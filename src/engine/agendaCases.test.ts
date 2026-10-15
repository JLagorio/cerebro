/** D3: src-tauri/fixtures/agenda-cases.json pins stored date placement to
 * vault/agenda.rs. Minute windows and answer labels belong to Rust alone. */
import { describe, expect, it } from 'vitest';
import cases from '../../src-tauri/fixtures/agenda-cases.json';
import { readDateValue } from './dateGrammar';
import { parseDateProperty } from './dates';
import { spanOf, spanOfValue } from './schedule';
import { placementOfValue } from './timeGrid';
import { repeatFieldFor } from './recurrence';
import { makeEntry } from './testHelpers';
import { buildSchema } from './schema';

function withZone<T>(zone: string, run: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe('replays shared agenda values', () => {
  for (const row of cases.values)
    it(row.why, () =>
      withZone(row.zone, () => {
        const entry = makeEntry({ properties: { when: row.value } });
        const span = spanOf(entry, 'when');
        if (typeof row.expect === 'string') {
          expect(span).toBeNull();
          expect(parseDateProperty(row.value)).toBeNull();
          return;
        }
        const value = parseDateProperty(row.value);
        expect(value).not.toBeNull();
        if (value === null) return;
        const date = readDateValue(row.value);
        const converted = date?.start.instant === true || date?.end?.instant === true;
        expect(converted).toBe(row.expect.converted);
        expect(span).toEqual({ start: row.expect.days[0], end: row.expect.days[1] });
        expect(placementOfValue(value, converted).kind === 'point').toBe(row.expect.point);
      }),
    );
});

describe('replays shared agenda day windows', () => {
  for (const row of cases.windows.filter((row) => !('rust_only' in row && row.rust_only)))
    it(row.why, () =>
      withZone(row.zone, () => {
        const value = parseDateProperty(row.value);
        const span = value === null ? null : spanOfValue(value);
        expect(span !== null && span.start < row.window[1] && span.end >= row.window[0]).toBe(
          row.in,
        );
      }),
    );
});

describe('replays shared agenda repeat pairs', () => {
  for (const row of cases.repeat_pairs)
    it(row.why, () => {
      const doc = makeEntry({
        path: 'types/event.md',
        title: 'Event',
        type: 'Type',
        properties: {
          fields: Object.fromEntries([
            ...row.fields.map(([name, kind]) => [name, { kind }]),
            ['repeat', { kind: 'repeat' }],
          ]),
        },
      });
      const entry = makeEntry({ type: 'Event' });
      const pair = repeatFieldFor(entry, buildSchema([doc, entry]));
      expect(pair?.date.name ?? null).toBe(row.pair);
    });
});
