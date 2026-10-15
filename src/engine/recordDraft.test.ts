import { describe, expect, it } from 'vitest';
import { makeEntry, fixtureVault } from '@/test/factories';
import { buildSchema } from './schema';
import {
  composerFields,
  draftEntry,
  draftFrontmatter,
  initialStatus,
  initialValues,
  pickSimilar,
  recordSlug,
} from './recordDraft';

function fixture() {
  const entries = fixtureVault();
  const type = entries.find((entry) => entry.title === 'Work item' && entry.type === 'Type')!;
  type.properties.layout = {
    heading: ['priority', 'status', 'total', 'children', 'assets'],
  } as never;
  type.properties.fields = {
    ...(type.properties.fields as object),
    total: { kind: 'rollup' },
    children: { kind: 'relation', from: { type: 'Work item', field: 'parent' } },
    assets: { kind: 'files' },
  } as never;
  return { entries, schema: buildSchema(entries) };
}

describe('record drafts', () => {
  it('uses only editable heading fields in their declared order', () => {
    const { schema } = fixture();
    expect(composerFields('Work item', schema).map((field) => field.name)).toEqual([
      'priority',
      'status',
    ]);
  });

  it('falls back to status then the declared deadline when no editable heading remains', () => {
    const { schema } = fixture();
    const type = schema.types.get('Work item')!;
    type.layout.heading = ['total', 'children', 'assets'];
    type.deadline = 'due';
    expect(composerFields('Work item', schema).map((field) => field.name)).toEqual([
      'status',
      'due',
    ]);
    expect(composerFields('missing', schema)).toEqual([]);
    expect(composerFields('Project', schema)).toEqual([]);
  });

  it('stores draft links bracket-stripped, leaves scalar values in properties and has no file hash', () => {
    expect(
      draftEntry(
        'Work item',
        { priority: 'high', estimate: 0, project: '[[atlas]]', people: ['[[ana]]', '[[elena]]'] },
        'New task',
      ),
    ).toMatchObject({
      path: '(draft)',
      title: 'New task',
      hash: null,
      properties: { priority: 'high', estimate: 0 },
      relationships: { project: ['atlas'], people: ['ana', 'elena'] },
    });
  });

  it('seeds the status capability by its declared name and starts with the first active option', () => {
    const { schema } = fixture();
    const type = schema.types.get('Work item')!;
    type.fields.find((field) => field.name === 'status')!.name = 'stage';
    type.statuses = [type.statuses[2], type.statuses[0], type.statuses[1]];
    expect(initialStatus('Work item', schema)).toBe('todo');
    expect(initialValues('Work item', schema)).toEqual({ stage: 'todo' });
    expect(initialValues('Project', schema)).toEqual({});
    expect(initialStatus('missing', schema)).toBeNull();
  });

  it('keeps zero and false, omits unset values, and reports invalid drafts before a write', () => {
    const { schema } = fixture();
    const result = draftFrontmatter(
      { type: 'Work item', status: 'todo' },
      { status: 'doing', priority: '', due: null, people: [], count: 0, check: false },
      'Work item',
      schema,
    );
    expect(result).toEqual({
      frontmatter: { type: 'Work item', status: 'doing', count: 0, check: false },
      problems: [],
    });
    expect(
      draftFrontmatter({}, { due: 'not a day' }, 'Work item', schema).problems.length,
    ).toBeGreaterThan(0);
  });

  it('makes bounded slugs, cutting long words only at a dash and using a caller fallback', () => {
    expect(recordSlug('Ship the fix!', 'fallback')).toBe('ship-the-fix');
    expect(recordSlug('💡', 'record-1')).toBe('record-1');
    expect(recordSlug('long '.repeat(30), 'fallback').length).toBeLessThanOrEqual(80);
    expect(recordSlug('a'.repeat(81), 'record-2')).toBe('record-2');
    expect(recordSlug('a'.repeat(80), 'fallback')).toHaveLength(80);
  });

  it('keeps the search ranking, at most two unique records of the chosen type, and ignores widened hits', () => {
    const entries = [
      makeEntry({ path: 'a.md', type: 'Ticket' }),
      makeEntry({ path: 'b.md', type: 'Project' }),
      makeEntry({ path: 'c.md', type: 'Ticket' }),
      makeEntry({ path: 'd.md', type: 'Ticket' }),
    ];
    const result = {
      widened: false,
      hits: ['missing.md', 'b.md', 'c.md', 'c.md', 'a.md', 'd.md'].map((path) => ({ path })),
    };
    expect(pickSimilar(result, 'Ticket', entries).map((entry) => entry.path)).toEqual([
      'c.md',
      'a.md',
    ]);
    expect(pickSimilar({ ...result, widened: true }, 'Ticket', entries)).toEqual([]);
  });
});
