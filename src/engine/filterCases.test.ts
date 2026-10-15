/** D3: the query reader and the view replay the same authored cases. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeEntry } from './testHelpers';
import { buildSchema } from './schema';
import { evaluateFilters, numericText } from './viewFilters';
import { resolveSurface, sortEntries } from './surface';
import type { Entry, FilterGroup, SortSpec } from './types';
import fixture from '../../src-tauri/fixtures/filter-cases.json';

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
const corpus = fixture.corpus.map((row) => makeEntry(row as Partial<Entry>));
const schema = buildSchema(corpus);
type Case = {
  why: string;
  type?: string;
  filters?: FilterGroup;
  sort?: SortSpec[];
  expect: string[];
  zone?: string;
  today?: string;
};

describe('replays the shared filter cases', () => {
  for (const row of fixture.cases as Case[]) {
    it(row.why, () => {
      const result = withZone(row.zone ?? fixture.zone, () => {
        const source = corpus.filter(
          (entry) =>
            !entry.path.startsWith('templates/') &&
            (row.type !== undefined
              ? entry.type === row.type
              : entry.type !== 'Type' && !entry.path.startsWith('knowledge/')),
        );
        return sortEntries(
          source.filter(
            (entry) =>
              row.filters === undefined ||
              evaluateFilters(entry, row.filters, schema, {
                today: row.today ?? fixture.today,
                weekStart: 0,
              }),
          ),
          row.sort ?? [],
          schema,
        ).map((entry) => entry.path);
      });
      expect(result).toEqual(row.expect);
    });
  }
});

it('reads numbers as the shared cases say', () => {
  for (const row of fixture.numbers)
    expect(numericText(row.text) === row.reads, row.text).toBe(true);
});

it('the acceptance query is the Work item view', () => {
  const golden = JSON.parse(
    readFileSync(join(__dirname, '../../conformance/scan/entries.json'), 'utf8'),
  ) as { demo_vault: Partial<Entry>[] };
  const entries = golden.demo_vault.map((entry) => makeEntry(entry));
  const type = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
  // Only this in-memory copy gets the acceptance view: no demo bytes change.
  const view = [
    {
      id: 'acceptance',
      name: 'Acceptance',
      filters: fixture.acceptance.filters,
      presentation: { type: 'table', sort: fixture.acceptance.sort },
    },
  ];
  type.properties = { ...type.properties, views: view } as unknown as Entry['properties'];
  const surface = resolveSurface(
    { kind: 'type', name: fixture.acceptance.type, view: 'acceptance' },
    entries,
    buildSchema(entries),
    [],
  );
  const paths = surface.entries.map((entry) => entry.path);
  expect(paths).toEqual(fixture.acceptance.expect);
});
