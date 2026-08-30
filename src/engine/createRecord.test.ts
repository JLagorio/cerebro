import { describe, expect, it } from 'vitest';
import { childLink, childTypeOf, createTarget, recordsFolder } from '@/engine/createRecord';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
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

  /**
   * Found by M47.4, which made this visible. People name databases in the
   * PLURAL — Tasks, Notes, Groceries — and the sibilant rule read every one
   * of them as wanting `es`. It did not matter while `recordsFolder` was an
   * implicit fallback nobody could see; `createDatabase` writes the folder
   * into the user's own Type doc, where `folder: records/grocerieses` is a
   * misspelling they have to look at and fix.
   */
  it('leaves an already-plural name alone', () => {
    expect(recordsFolder('Groceries')).toBe('records/groceries');
    expect(recordsFolder('Tasks')).toBe('records/tasks');
    expect(recordsFolder('Notes')).toBe('records/notes');
  });

  // `ss` is not a plural ending, so the sibilant rule still owns it.
  it('still pluralizes a name that merely ends in a sibilant', () => {
    expect(recordsFolder('Process')).toBe('records/processes');
    expect(recordsFolder('Class')).toBe('records/classes');
    expect(recordsFolder('Box')).toBe('records/boxes');
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

/**
 * `folder:` on a Type doc (M47.1).
 *
 * M12.2 built this and nothing has ever exercised it: no Type doc in
 * `demo-vault/` declares a `folder:`, and no test declared one either. M47
 * makes it load-bearing — it is where a database's new rows land — so it gets
 * measured before anything is built on top of it.
 */
describe('createTarget honours a declared home folder', () => {
  const typeDoc = (properties: Record<string, unknown>, path = 'types/reading.md') =>
    makeEntry({ path, title: 'Reading', type: 'Type', properties: properties as never });

  /** Schema built from the same entries, exactly as every call site does. */
  const homeOf = (entries: Entry[], inProject: Entry | null = null) =>
    createTarget('Reading', { project: inProject, entries, schema: buildSchema(entries) }).folder;

  it('places new records in the folder the Type doc declares', () => {
    expect(homeOf([typeDoc({ folder: 'reading' })])).toBe('reading');
  });

  /**
   * The database page may BE the folder note of its own folder
   * (`reading/reading.md`) — decision D8 of the M47 spec. It holds because a
   * Type doc is found by TITLE: `buildSchema` scans every entry and never
   * looks at the path. Pinned so D8 is a measured fact, not a hoped-for one.
   */
  it('finds the Type doc by title, wherever the file sits', () => {
    expect(homeOf([typeDoc({ folder: 'reading' }, 'reading/reading.md')])).toBe('reading');
  });

  it('strips wrapping slashes, so `/reading/` is not a sibling of the vault', () => {
    expect(homeOf([typeDoc({ folder: '/reading/' })])).toBe('reading');
  });

  /**
   * Vault-tolerant, like every other read of a hand-edited file. The blank
   * case matters more than it looks: `''` is a legal folder path meaning the
   * VAULT ROOT, so a `folder:` that fell through as-written would spray new
   * records across the top level of someone's vault.
   */
  it('falls back to the records convention when `folder:` says nothing usable', () => {
    for (const folder of ['', '   ', 42, null, ['reading'], { path: 'reading' }]) {
      expect(homeOf([typeDoc({ folder })])).toBe('records/readings');
    }
  });

  /**
   * Containment is a property of the CONTEXT, not of the type (M12.2), and
   * that rule outranks `folder:` — a record created inside a project lands in
   * the project. Worth pinning because it is the one case where a database's
   * declared home does NOT win, and M47's create affordances have to know it.
   */
  it('yields to a project context, which still wins over the declared folder', () => {
    expect(homeOf([project, typeDoc({ folder: 'reading' })], project)).toBe('projects/atlas/items');
  });
});
