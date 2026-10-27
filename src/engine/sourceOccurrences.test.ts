import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@/lib/sha256';
import { findSourceOccurrencesWith, type OccurrenceSource } from './sourceOccurrences';
import type { Entry } from './types';
import { makeEntry } from './testHelpers';
import { searchableFields } from './searchable';
import cases from '../../shared/knowledge/source-occurrences-cases.json';
import type { OccurrenceMode } from './sourceOccurrences';

const query = (...args: Parameters<typeof findSourceOccurrencesWith>) => {
  const result = findSourceOccurrencesWith(...args);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error(result.reason);
  return result;
};
const hash = 'a'.repeat(64);
const source = (path: string, body: string, patch: Partial<Entry> = {}): OccurrenceSource => ({
  entry: makeEntry({
    path,
    filename: path.split('/').at(-1)!,
    folder: path.split('/').slice(0, -1).join('/'),
    ...patch,
  }),
  body,
  fields: [],
  sourceHash: hash,
  carrier: 'markdown',
  capped: false,
});
const target = source('target.md', '# Target', { title: 'Target' });
const scope = { vaultId: 'vault', admits: (_: string) => true };

describe('bounded source occurrences', () => {
  it.each(cases.cases)('replays the shared occurrence case: $name', (fixture) => {
    const sources = fixture.sources.map((input) => {
      const item = source(input.path, input.body, {
        title: input.title,
        properties: 'key' in input ? { key: input.key! } : {},
        relationships: 'relationships' in input ? input.relationships! : {},
      });
      item.sourceHash = sha256Hex(input.body);
      item.fields = searchableFields(item.entry);
      return item;
    });
    const page = query(scope, sources, fixture.targetPath, fixture.mode as OccurrenceMode);
    expect(
      page.rows.map((row) => ({
        path: row.location.path,
        quote: row.location.quote,
        kind: row.location.kind,
        ...(row.location.propertyKey ? { key: row.location.propertyKey } : {}),
        ...(row.targetFragment === undefined ? {} : { fragment: row.targetFragment }),
        ...(row.location.bodyUtf8Range ?? {}),
      })),
    ).toEqual(fixture.expected);
    if ('expectedIds' in fixture)
      expect(page.rows.map((row) => row.id)).toEqual(fixture.expectedIds);
  });

  it('an oversized work source advances with capped disclosure instead of a stuck cursor', () => {
    const huge = source('a.md', 'quiet');
    huge.fields = [{ key: 'large', text: 'x'.repeat(8 * 1024 * 1024 + 1) }];
    const page = query(scope, [huge, source('b.md', 'target'), target], 'target.md', 'mention');
    expect(page.counts.cappedSources).toBe(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = query(
      scope,
      [huge, source('b.md', 'target'), target],
      'target.md',
      'mention',
      page.nextCursor,
    );
    expect(next.rows).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
  });

  it('an unlocatable long wikilink is disclosed as capped', () => {
    const longName = 'x'.repeat(241);
    const page = query(
      scope,
      [source('target.md', '', { title: longName }), source('a.md', `[[${longName}]]`)],
      'target.md',
      'linked',
    );
    expect(page.rows).toEqual([]);
    expect(page.counts.cappedSources).toBe(1);
  });

  it('repeated_body_links_have_distinct_occurrences', () => {
    const body = '😀 [[target|one]] and [[Target#Notes|two]].';
    const page = query(scope, [target, source('a.md', body)], 'target.md', 'linked');
    expect(page.status).toBe('ready');
    expect(page.rows).toHaveLength(2);
    expect(new Set(page.rows.map((row) => row.id)).size).toBe(2);
    expect(page.rows[0].location.bodyUtf8Range).toEqual({ start: 5, end: 19 });
    expect(page.rows[1].targetFragment).toBe('Notes');
    expect(page.counts).toMatchObject({ shownOccurrences: 2, shownPages: 1 });
  });

  it('relation_fragment_uses_property_row', () => {
    const input = source('a.md', '', {
      relationships: { project: ['target#Notes', 'target#Notes'] },
    });
    input.fields = [{ key: 'project', text: 'target#Notes, target#Notes' }];
    const page = query(scope, [target, input], 'target.md', 'linked');
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].location).toMatchObject({ kind: 'property', propertyKey: 'project' });
    expect(page.rows[0].location.bodyUtf8Range).toBeUndefined();
    expect(page.rows[0].targetFragment).toBe('Notes');
  });

  it('mentions use canonical duplicate precedence and exclude existing aliases', () => {
    const duplicate = source('z.md', '', { title: 'Target' });
    const body = 'Target and targetish. [[target|Target]] TARGET.';
    const page = query(scope, [target, duplicate, source('a.md', body)], 'target.md', 'mention');
    expect(page.rows.map((row) => row.location.quote)).toEqual(['Target', 'TARGET']);
    expect(query(scope, [target, duplicate, source('a.md', body)], 'z.md', 'mention').rows).toEqual(
      [],
    );
  });

  it('a fifty-row page continues within one source without dropping the next occurrence', () => {
    const sources = [target, source('a.md', '[[target]] '.repeat(52))];
    const first = query(scope, sources, 'target.md', 'linked');
    expect(first.rows).toHaveLength(50);
    expect(first.truncated).toBe(true);
    const second = query(scope, sources, 'target.md', 'linked', first.nextCursor);
    expect(second.rows).toHaveLength(2);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(52);
    expect(second.nextCursor).toBeNull();
  });

  it('cursor_refuses_changed_scope without returning cached text', () => {
    const sources = [target, source('a.md', '[[target]] '.repeat(51))];
    const first = query(scope, sources, 'target.md', 'linked');
    const second = findSourceOccurrencesWith(
      { ...scope, admits: (path: string) => path !== 'a.md' },
      sources,
      'target.md',
      'linked',
      first.nextCursor,
    );
    expect(second.status).toBe('changedSnapshot');
    expect(JSON.stringify(second)).not.toContain('[[target]]');
    expect('rows' in second).toBe(false);
  });

  it('cursor_refuses_changed_corpus', () => {
    const sources = [target, source('a.md', '[[target]] '.repeat(51))];
    const first = query(scope, sources, 'target.md', 'linked');
    const changed = [target, { ...sources[1], sourceHash: 'b'.repeat(64) }];
    expect(
      findSourceOccurrencesWith(scope, changed, 'target.md', 'linked', first.nextCursor).status,
    ).toBe('changedSnapshot');
  });

  it('capped_scan_does_not_claim_no_mentions', () => {
    const sources = [
      ...Array.from({ length: 501 }, (_, i) =>
        source(`a${String(i).padStart(3, '0')}.md`, 'quiet'),
      ),
      target,
    ];
    const first = query(scope, sources, 'target.md', 'mention');
    expect(first.rows).toEqual([]);
    expect(first.counts.examinedSources).toBe(500);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.truncated).toBe(true);
  });
});
