import { describe, expect, it } from 'vitest';
import {
  DATABASE_FENCE,
  parseDatabaseRef,
  pointerOccurrence,
  resolveDatabaseRef,
  serializeDatabaseRef,
} from './databaseBlock';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { Entry } from './types';

const typeDoc = (title: string, properties: Record<string, unknown> = {}): Entry =>
  makeEntry({
    path: `types/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Type',
    properties: properties as Entry['properties'],
  });

const view = (id: string) => ({ id, name: id, presentation: { type: 'table' } });

describe('parseDatabaseRef', () => {
  it('reads the database and the view it names', () => {
    expect(parseDatabaseRef('database: Reading list\nview: shelf\n')).toEqual({
      database: 'Reading list',
      view: 'shelf',
    });
  });

  it('leaves `view` null when the fence names none', () => {
    expect(parseDatabaseRef('database: Reading list\n')).toEqual({
      database: 'Reading list',
      view: null,
    });
  });

  it('trims, so a hand-typed trailing space is not part of the name', () => {
    expect(parseDatabaseRef('database: "  Reading list  "\nview: "  shelf "\n')).toEqual({
      database: 'Reading list',
      view: 'shelf',
    });
  });

  /**
   * A pointer with no target is not a BROKEN pointer, it is not a pointer —
   * and the caller's contract is to leave such a fence as the ordinary code
   * block it already is. That is the only behaviour that cannot lose what
   * someone typed: turning a half-finished fence into a database block would
   * replace their text with an error message about their text.
   */
  it('is null for anything that does not name a database', () => {
    for (const body of [
      '', // an empty fence
      'view: shelf\n', // a view with nothing to view
      'database:\n', // the key with no value
      'database: "   "\n', // whitespace is not a name
      'database: 42\n', // a number is not a name
      'database: [Reading list]\n', // nor is a list
      '- Reading list\n', // a sequence, not a mapping
      'Reading list\n', // a bare scalar
      'database: "unclosed\n', // broken YAML
    ]) {
      expect(parseDatabaseRef(body)).toBeNull();
    }
  });
});

describe('serializeDatabaseRef', () => {
  it('round-trips a pointer through the fence body', () => {
    for (const ref of [
      { database: 'Reading list', view: 'shelf' },
      { database: 'Reading list', view: null },
    ]) {
      expect(parseDatabaseRef(serializeDatabaseRef(ref))).toEqual(ref);
    }
  });

  /**
   * The one place the deviations-only serializer rule does NOT apply. An
   * absent `view:` means "the database's first", which is POSITIONAL — so
   * omitting the id of the view that happens to be first today would let
   * someone reordering that database's tabs silently change what this page
   * shows, months later, from a different surface.
   */
  it('writes the view id even when it is the first one', () => {
    expect(serializeDatabaseRef({ database: 'Reading list', view: 'shelf' })).toContain(
      'view: shelf',
    );
  });

  it('omits `view:` only when the pointer genuinely names none', () => {
    expect(serializeDatabaseRef({ database: 'Reading list', view: null })).toBe(
      'database: Reading list',
    );
  });

  /**
   * A database is named whatever its author typed. Written raw, each of these
   * read back as a parse error, a truncated name (`Notes #1` → `Notes`), a
   * number, a boolean or a list — every one a pointer lost on the next load,
   * and the truncated one written back over the original on the next save.
   */
  it('round-trips names YAML would otherwise read as something else', () => {
    for (const database of [
      'Books: 2026',
      'Notes #1',
      '2026',
      'true',
      'null',
      '~',
      '[draft]',
      '? q',
      '@home',
      'x'.repeat(120),
    ]) {
      for (const view of [null, 'shelf', '2026']) {
        expect(parseDatabaseRef(serializeDatabaseRef({ database, view }))).toEqual({
          database,
          view,
        });
      }
    }
  });
});

describe('pointerOccurrence', () => {
  const db = (id: string, database: string, view = '') => ({
    id,
    type: 'database',
    props: { database, view },
  });
  const doc = [
    db('a', 'Reading list', 'shelf'),
    { id: 'p', type: 'paragraph' },
    db('b', 'Reading list', 'stack'),
    {
      id: 'cols',
      type: 'columnList',
      children: [{ id: 'c1', type: 'column', children: [db('c', 'Reading list', 'shelf')] }],
    },
    db('d', 'Reading list', 'shelf'),
  ];

  // Two embeds of one view on one page are two copies, told apart by order —
  // including one nested in a column — so each folds on its own.
  it('counts earlier blocks showing the same database and view, in document order', () => {
    expect(['a', 'c', 'd'].map((id) => pointerOccurrence(doc, id))).toEqual([0, 1, 2]);
  });

  it('does not count a different view of the same database', () => {
    expect(pointerOccurrence(doc, 'b')).toBe(0);
  });

  it('answers 0 for a block it cannot find', () => {
    expect(pointerOccurrence(doc, 'nope')).toBe(0);
  });
});

describe('resolveDatabaseRef', () => {
  const schema = buildSchema([
    typeDoc('Reading list', { views: [view('shelf'), view('stack')] }),
    typeDoc('Grocery list'),
  ]);

  it('resolves the named view', () => {
    const res = resolveDatabaseRef({ database: 'Reading list', view: 'stack' }, schema);
    expect(res).toMatchObject({ kind: 'ok', database: 'Reading list' });
    expect(res.kind === 'ok' && res.view.id).toBe('stack');
  });

  it('takes the first view when the pointer names none', () => {
    const res = resolveDatabaseRef({ database: 'Reading list', view: null }, schema);
    expect(res.kind === 'ok' && res.view.id).toBe('shelf');
  });

  /**
   * A database that saved no views still resolves — `typeViews` synthesizes a
   * default table — so `views[0]` is never undefined and a brand-new database
   * is embeddable the moment it exists.
   */
  it('resolves a database that has saved no views of its own', () => {
    const res = resolveDatabaseRef({ database: 'Grocery list', view: null }, schema);
    expect(res.kind === 'ok' && res.view.id).toBe('all');
  });

  /**
   * "Not there" and "empty" are opposite sentences. A page pointing at a
   * database nobody has created must be able to say WHICH one is missing —
   * the same rule that keeps `section-unavailable` distinct from an empty
   * section.
   */
  it('names the database it could not find, rather than resolving to nothing', () => {
    expect(resolveDatabaseRef({ database: 'Wine cellar', view: null }, schema)).toEqual({
      kind: 'no-database',
      database: 'Wine cellar',
    });
  });

  /**
   * "Show the Board" with no Board is not the same sentence as "show whatever
   * is first". The fallback is carried so a caller can still render something,
   * but the kind stays distinct so nothing can silently substitute one for the
   * other and present the wrong data confidently.
   */
  it('keeps a named-but-missing view distinct from an unnamed one', () => {
    const res = resolveDatabaseRef({ database: 'Reading list', view: 'board' }, schema);
    expect(res).toMatchObject({ kind: 'no-view', database: 'Reading list', view: 'board' });
    expect(res.kind === 'no-view' && res.fallback.id).toBe('shelf');
  });
});

describe('DATABASE_FENCE', () => {
  /**
   * The fence language is the on-disk contract: it appears in every vault
   * this ships to and cannot be renamed without a migration. Pinned so the
   * cost of changing it is visible in a diff.
   */
  it('is the namespaced language, not a bare word another tool might claim', () => {
    expect(DATABASE_FENCE).toBe('cerebro-database');
  });
});
