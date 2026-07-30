import { describe, expect, it } from 'vitest';
import { childLink, childTypeOf, createTarget, recordsFolder } from '@/engine/createRecord';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';

const project = makeEntry({
  path: 'projects/atlas/project.md',
  type: 'Project',
  title: 'Atlas',
  properties: { key: 'ATL' },
});

describe('createTarget', () => {
  it('puts work items inside their project folder with a generated key', () => {
    const target = createTarget('Work item', { project, entries: [project] });
    expect(target.folder).toBe('projects/atlas/items');
    expect(target.frontmatter.type).toBe('Work item');
    expect(target.frontmatter.key).toMatch(/^ATL-/);
  });

  it('puts other types under the records convention', () => {
    const target = createTarget('Risk', { project: null, entries: [] });
    expect(target.folder).toBe('records/risks');
    expect(target.frontmatter.key).toBeUndefined();
  });

  it('presets the band value it was created in', () => {
    const target = createTarget('Risk', {
      project: null,
      entries: [],
      groupBy: 'severity',
      groupValue: 'high',
    });
    expect(target.frontmatter.severity).toBe('high');
  });

  // Presetting `field: ''` from the synthetic groups would write a property
  // nobody asked for.
  it('never presets from the no-value or all-items bands', () => {
    for (const groupValue of ['__none__', '', null]) {
      const target = createTarget('Risk', {
        project: null,
        entries: [],
        groupBy: 'severity',
        groupValue,
      });
      expect(target.frontmatter.severity).toBeUndefined();
    }
  });
});

describe('recordsFolder', () => {
  it('pluralizes English-ish type names', () => {
    expect(recordsFolder('Risk')).toBe('records/risks');
    expect(recordsFolder('Key result')).toBe('records/key-results');
    expect(recordsFolder('Story')).toBe('records/stories');
    expect(recordsFolder('Process')).toBe('records/processes');
  });
});

describe('childLink', () => {
  const objective = makeEntry({ path: 'o.md', type: 'Objective', title: 'Ship it' });

  it('links a child back through a reverse relation', () => {
    const link = childLink(objective, {
      direction: 'reverse',
      type: 'Key result',
      field: 'objective',
    });
    expect(link?.frontmatter).toEqual({ objective: '[[Ship it]]' });
  });

  // A forward descent means the PARENT holds the list, so the child cannot
  // express the relationship at all — the caller has to patch the parent.
  it('returns null for a forward descent', () => {
    expect(childLink(objective, { direction: 'forward', field: 'key_results' })).toBeNull();
  });
});

describe('childTypeOf', () => {
  const schema = buildSchema([
    makeEntry({
      path: 'types/key-result.md',
      title: 'Key result',
      type: 'Type',
      properties: {
        fields: { deliverables: { kind: 'relation', target: 'Work item' } },
      } as unknown as Record<string, never>,
    }),
  ]);

  it('reads a reverse descent straight off the spec', () => {
    expect(childTypeOf({ direction: 'reverse', type: 'Key result', field: 'objective' }, 'Objective', schema)).toBe(
      'Key result',
    );
  });

  it('resolves a forward descent through the relation target', () => {
    expect(childTypeOf({ direction: 'forward', field: 'deliverables' }, 'Key result', schema)).toBe(
      'Work item',
    );
  });

  it('is null when the relation declares no target', () => {
    expect(childTypeOf({ direction: 'forward', field: 'mystery' }, 'Key result', schema)).toBeNull();
  });
});
