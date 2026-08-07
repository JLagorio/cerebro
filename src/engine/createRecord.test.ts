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

const emptySchema = buildSchema([]);

describe('createTarget', () => {
  it('puts work items inside their project folder with a generated key', () => {
    const target = createTarget('Work item', {
      project,
      entries: [project],
      schema: emptySchema,
    });
    expect(target.folder).toBe('projects/atlas/items');
    expect(target.frontmatter.type).toBe('Work item');
    expect(target.frontmatter.key).toMatch(/^ATL-/);
  });

  it('puts other types under the records convention', () => {
    const target = createTarget('Risk', { project: null, entries: [], schema: emptySchema });
    expect(target.folder).toBe('records/risks');
    expect(target.frontmatter.key).toBeUndefined();
  });

  it('presets the band value it was created in', () => {
    const target = createTarget('Risk', {
      project: null,
      entries: [],
      schema: emptySchema,
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
        schema: emptySchema,
        groupBy: 'severity',
        groupValue,
      });
      expect(target.frontmatter.severity).toBeUndefined();
    }
  });

  /**
   * M20.1. A band KEY is not a stored VALUE, and this wrote it verbatim: the
   * table's "+ New" inside a relation band produced `epic: Bonsai`, which the
   * scanner files under `properties` rather than `relationships` — so the link
   * did not exist and the record did not come back to the band it was created
   * in on reload. The board had the rule and nothing else did; it lives here
   * now, so every create affordance shares it.
   */
  describe('coerces a band key into what the field stores', () => {
    const typeDocs = [
      makeEntry({
        path: 'types/work-item.md',
        title: 'Work item',
        type: 'Type',
        properties: {
          fields: {
            epic: { kind: 'relation', target: 'Epic' },
            assignee: { kind: 'person' },
            done: { kind: 'checkbox' },
            labels: { kind: 'multiselect' },
            status: { kind: 'status' },
          },
        } as unknown as Record<string, never>,
      }),
    ];
    const item = makeEntry({ path: 'w/1.md', type: 'Work item', title: 'One' });
    const entries = [...typeDocs, item];
    const schema = buildSchema(entries);
    const seed = (groupBy: string, groupValue: string) =>
      createTarget('Work item', { project: null, entries, schema, groupBy, groupValue })
        .frontmatter;

    it('wraps a relation band as a wikilink', () => {
      expect(seed('epic', 'epic-bonsai').epic).toBe('[[epic-bonsai]]');
    });

    it('wraps a person band as a wikilink', () => {
      expect(seed('assignee', 'ana-rios').assignee).toBe('[[ana-rios]]');
    });

    // `String(true)` is what bucketed the record; a string is not what the
    // field holds, and `done: "false"` is truthy everywhere that reads it.
    it('writes a checkbox band as a boolean', () => {
      expect(seed('done', 'true').done).toBe(true);
      expect(seed('done', 'false').done).toBe(false);
    });

    // A multi-select record sits in several bands at once, so one scalar
    // cannot express the band without deleting the record's other values.
    it('seeds nothing for a multi-select band', () => {
      expect(seed('labels', 'urgent').labels).toBeUndefined();
    });

    it('leaves a status band exactly as it is keyed', () => {
      expect(seed('status', 'todo').status).toBe('todo');
    });

    // The kind is resolved by `bandKind` — the first entry that DECLARES the
    // field — so a heterogeneous surface whose first record does not declare
    // it still takes the right branch (M16.19).
    it('resolves the kind past records that do not declare the field', () => {
      const stranger = makeEntry({ path: 'd/1.md', type: 'Doc', title: 'Doc' });
      const mixed = [...typeDocs, stranger, item];
      const target = createTarget('Work item', {
        project: null,
        entries: mixed,
        schema: buildSchema(mixed),
        groupBy: 'epic',
        groupValue: 'epic-bonsai',
      });
      expect(target.frontmatter.epic).toBe('[[epic-bonsai]]');
    });
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
    expect(
      childTypeOf(
        { direction: 'reverse', type: 'Key result', field: 'objective' },
        'Objective',
        schema,
      ),
    ).toBe('Key result');
  });

  it('resolves a forward descent through the relation target', () => {
    expect(childTypeOf({ direction: 'forward', field: 'deliverables' }, 'Key result', schema)).toBe(
      'Work item',
    );
  });

  it('is null when the relation declares no target', () => {
    expect(
      childTypeOf({ direction: 'forward', field: 'mystery' }, 'Key result', schema),
    ).toBeNull();
  });
});
