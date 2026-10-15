import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { buildSchema } from './schema';
import type { Entry } from './types';
import { MAX_BATCH_OPS } from './batch';
import {
  BULK_CHANGED,
  BULK_KNOWLEDGE,
  BULK_UNREADABLE,
  bulkFailureText,
  bulkSetFields,
  planBulkDelete,
  planBulkSet,
} from './bulkPlan';

const type = (name: string, fields: Record<string, unknown>) =>
  makeEntry({
    path: `types/${name}.md`,
    title: name,
    type: 'Type',
    properties: { fields } as unknown as Entry['properties'],
  });
const doc = type('Task', {
  priority: { kind: 'select', options: [{ id: 'low' }, { id: 'high' }] },
  done: 'checkbox',
  points: 'number',
  owner: 'person',
  files: 'files',
  edited: 'last_edited_time',
  total: 'rollup',
  reverse: { kind: 'relation', from: { type: 'Task', field: 'owner' } },
});
const schema = buildSchema([
  doc,
  type('Idea', { priority: { kind: 'select', options: [{ id: 'soon' }] }, notes: 'text' }),
]);
const row = (path: string, props: Record<string, string | number | boolean> = {}) =>
  makeEntry({ path, title: path, type: 'Task', hash: 'a'.repeat(64), properties: props });
const reads = (entries: Entry[]) =>
  new Map(entries.map((entry) => [entry.path, { content: '# A\n', hash: entry.hash! }]));

describe('bulk plans', () => {
  it('offers stored editable fields from the source type or the mixed-table union', () => {
    const entries = [row('a.md'), { ...row('b.md'), type: 'Idea' }];
    expect(bulkSetFields(entries, schema, 'Task').map((field) => field.name)).toEqual([
      'priority',
      'done',
      'points',
      'owner',
    ]);
    expect(bulkSetFields(entries, schema, null).map((field) => field.name)).toEqual([
      'priority',
      'done',
      'points',
      'owner',
      'notes',
    ]);
  });

  it('checks each row in order and keeps only ready, hashed writes', () => {
    const knowledge = row('knowledge/concepts/a.md');
    const missing = { ...row('missing.md'), type: 'Other' };
    const choice = { ...row('choice.md'), type: 'Idea' };
    const unreadable = row('unreadable.md');
    const changed = row('changed.md');
    const skipped = row('skipped.md', { priority: 'low', points: 2 });
    const ready = row('ready.md', { priority: 'high' });
    const entries = [knowledge, missing, choice, unreadable, changed, skipped, ready];
    const source = reads(entries);
    source.delete(unreadable.path);
    source.set(changed.path, { content: '# New\n', hash: 'b'.repeat(64) });
    // Earlier refusals win over a read error.
    source.delete(knowledge.path);
    source.delete(missing.path);
    source.delete(choice.path);
    const plan = planBulkSet(entries, 'priority', 'low', schema, source);
    expect([...plan.failed]).toEqual([
      [knowledge.path, BULK_KNOWLEDGE],
      [missing.path, 'Other has no Priority'],
      [choice.path, "“low” isn't one of Priority's options"],
      [unreadable.path, BULK_UNREADABLE],
      [changed.path, BULK_CHANGED],
    ]);
    expect(plan.skipped).toEqual([skipped.path]);
    expect(plan.ops).toEqual([
      { op: 'patch', path: ready.path, set: { priority: 'low' }, expectHash: ready.hash },
    ]);
  });

  it('validates shapes before reading and never treats an unknown hash as unchanged', () => {
    const entry = row('a.md');
    expect(
      planBulkSet([entry], 'points', 'nonsense', schema, new Map()).failed.get(entry.path),
    ).not.toBe(BULK_UNREADABLE);
    const unknown = { ...entry, hash: null };
    expect(planBulkSet([unknown], 'points', 5, schema, reads([entry])).failed.get(entry.path)).toBe(
      BULK_CHANGED,
    );
  });

  it('recognizes an unchanged relationship and lets a clear remove it', () => {
    const entry = { ...row('a.md'), relationships: { owner: ['alex'] } };
    expect(planBulkSet([entry], 'owner', '[[alex]]', schema, reads([entry])).skipped).toEqual([
      'a.md',
    ]);
    expect(planBulkSet([entry], 'owner', null, schema, reads([entry])).ops).toEqual([
      { op: 'patch', path: 'a.md', set: { owner: null }, expectHash: entry.hash },
    ]);
  });

  it('deletes only rows with the version the table showed, once per path', () => {
    const a = row('a.md');
    const b = row('b.md');
    const source = reads([a, b]);
    source.set(b.path, { content: 'new', hash: 'b'.repeat(64) });
    const plan = planBulkDelete([a, a, b], source);
    expect(plan.ops).toEqual([{ op: 'delete', path: a.path, expectHash: a.hash }]);
    expect([...plan.failed]).toEqual([[b.path, BULK_CHANGED]]);
  });

  it('refuses all ready rows when the atomic batch exceeds its step cap', () => {
    const entries = Array.from({ length: MAX_BATCH_OPS + 1 }, (_, i) => row(`${i}.md`));
    for (const plan of [
      planBulkDelete(entries, reads(entries)),
      planBulkSet(entries, 'points', 1, schema, reads(entries)),
    ]) {
      expect(plan.ops).toEqual([]);
      expect(plan.failed.size).toBe(entries.length);
      expect(new Set(plan.failed.values())).toEqual(
        new Set([`more than ${MAX_BATCH_OPS} at once`]),
      );
    }
  });

  it('names three failed records, then counts the rest', () => {
    const entries = ['A', 'B', 'C', 'D', 'E'].map((title) => ({ ...row(`${title}.md`), title }));
    expect(
      bulkFailureText('set', new Map(entries.map((entry) => [entry.path, BULK_CHANGED])), entries),
    ).toBe(
      "Couldn't set 5: “A” (changed since the table showed it), “B” (changed since the table showed it), “C” (changed since the table showed it) and 2 more.",
    );
    expect(bulkFailureText('delete', new Map(), entries)).toBeNull();
  });
});
