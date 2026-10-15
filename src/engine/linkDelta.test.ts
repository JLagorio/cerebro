import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import type { FieldDef } from './types';
import { fileUnderPatch, pointsAt, unfileFromPatch } from './linkDelta';

const host = makeEntry({
  path: 'projects/atlas/project.md',
  title: 'Atlas programme',
  properties: { key: 'ATL-1' },
});
const other = makeEntry({ path: 'records/other.md', title: 'Other' });
const def: FieldDef = { name: 'project', kind: 'relation' };
const row = (links: string[]) =>
  makeEntry({ path: 'records/task.md', relationships: { project: links } });

describe('stored relation deltas', () => {
  it.each(['atlas', 'ATLAS', 'Atlas programme', 'atl-1', 'atlas#Scope'])(
    'recognizes %s without adding a duplicate',
    (spelling) => {
      const record = row([spelling]);
      expect(pointsAt(record, 'project', host, [host, other, record])).toBe(true);
      expect(fileUnderPatch(record, def, host, [host, other, record])).toBeNull();
    },
  );

  it('preserves existing spellings and order while appending the host stem', () => {
    const record = row(['OTHER', 'missing']);
    expect(fileUnderPatch(record, def, host, [host, other, record])).toEqual({
      project: ['[[OTHER]]', '[[missing]]', '[[atlas]]'],
    });
  });

  it('replaces a limit-1 owner instead of adding another host', () => {
    const record = row(['other']);
    expect(fileUnderPatch(record, { ...def, limit: 1 }, host, [host, other, record])).toEqual({
      project: ['[[atlas]]'],
    });
  });

  it('removes every spelling of the host and leaves unrelated or unresolved links in order', () => {
    const record = row(['atlas', 'other', 'ATLAS PROGRAMME', 'missing', 'ATL-1']);
    expect(unfileFromPatch(record, 'project', host, [host, other, record])).toEqual({
      project: ['[[other]]', '[[missing]]'],
    });
  });

  it('clears the final link with null and skips a missing link', () => {
    expect(unfileFromPatch(row(['atlas']), 'project', host, [host])).toEqual({ project: null });
    expect(unfileFromPatch(row(['other']), 'project', host, [host, other])).toBeNull();
  });

  it('resolves collisions using the shared target index, never a title equality shortcut', () => {
    const winner = makeEntry({ path: 'a/atlas.md', title: 'Another page' });
    expect(pointsAt(row(['atlas']), 'project', host, [host, winner])).toBe(false);
  });
});
