import { describe, expect, it } from 'vitest';
import {
  isPlace,
  placeKey,
  placeLabel,
  placeOf,
  samePlace,
  selectionKey,
  type Place,
} from '@/engine/place';
import type { CollectionFile, ListFile, Selection } from '@/engine/types';
import { makeEntry } from '@/test/factories';

const list = (over: Partial<ListFile> = {}): ListFile => ({
  id: 'roadmap',
  collection: 'product',
  project: null,
  path: 'product/roadmap.list.yml',
  definition: {
    name: 'Roadmap',
    icon: null,
    color: null,
    order: null,
    source: { type: 'Work item', project: null },
    views: [],
  },
  ...over,
});

/**
 * One selection of every kind, lenses filled in (M53.14). The mapped type is
 * the point: a kind added to Selection does not compile here until it has a
 * row, and every test that walks this table then covers it unasked.
 */
const ONE_OF_EACH: { [K in Selection['kind']]: Extract<Selection, { kind: K }> } = {
  home: { kind: 'home' },
  inbox: { kind: 'inbox' },
  mywork: { kind: 'mywork' },
  knowledge: { kind: 'knowledge', nav: { tab: 'runs', run: 'run-1' }, path: 'knowledge/a.md' },
  doc: { kind: 'doc', path: 'a/b.md', tab: 'spec' },
  diagram: { kind: 'diagram', path: 'a/flow.mmd' },
  collection: { kind: 'collection', folder: 'a/b' },
  list: { kind: 'list', id: 'x', collection: 'a', view: 'board' },
  type: { kind: 'type', name: 'Work item', view: 'at-risk' },
  changes: { kind: 'changes' },
  pulse: { kind: 'pulse' },
  library: { kind: 'library', tab: 'agent', path: 'agents/scout.md' },
  workspace: { kind: 'workspace', root: 'cerebro', path: 'README.md' },
  studio: { kind: 'studio', project: 'landing' },
  agents: { kind: 'agents', actor: 'process:release-scout' },
  settings: { kind: 'settings' },
};

/** Every shape a place can take: ONE_OF_EACH, plus what its filled-in rows
 * cannot reach — the bare Studio and Agents lobbies, and the two Knowledge
 * navs a place keeps. */
const EVERY_SHAPE: Selection[] = [
  ...Object.values(ONE_OF_EACH),
  { kind: 'studio' },
  { kind: 'agents' },
  { kind: 'knowledge', nav: { tab: 'section', folder: 'knowledge/ops' } },
  { kind: 'knowledge', nav: { tab: 'entity', key: 'Acme' } },
];

describe('placeOf — a place is a subject, not a lens', () => {
  it('is the same place whichever view tab of a List is open', () => {
    const board: Selection = { kind: 'list', id: 'roadmap', collection: 'product', view: 'board' };
    const table: Selection = { kind: 'list', id: 'roadmap', collection: 'product', view: 'table' };
    expect(selectionKey(board)).toBe(selectionKey(table));
  });

  it('is the same place whichever saved view of a type screen is open', () => {
    expect(selectionKey({ kind: 'type', name: 'Work item', view: 'at-risk' })).toBe(
      selectionKey({ kind: 'type', name: 'Work item' }),
    );
  });

  it('separates two Lists that share an id in different Collections', () => {
    // ListPage resolves by (collection, id) for exactly this reason; a place
    // that collapsed them would put two Collections' threads in one pile.
    expect(selectionKey({ kind: 'list', id: 'roadmap', collection: 'product' })).not.toBe(
      selectionKey({ kind: 'list', id: 'roadmap', collection: 'marketing' }),
    );
  });

  it('reads an omitted collection as a top-level List, not as a third place', () => {
    expect(selectionKey({ kind: 'list', id: 'roadmap' })).toBe(
      selectionKey({ kind: 'list', id: 'roadmap', collection: null }),
    );
  });

  it("collapses Knowledge's filter tabs but keeps sections and dossiers apart", () => {
    const all = selectionKey({ kind: 'knowledge', nav: { tab: 'all' } });
    expect(selectionKey({ kind: 'knowledge', nav: { tab: 'review' } })).toBe(all);
    expect(selectionKey({ kind: 'knowledge', nav: { tab: 'activity' } })).toBe(all);
    expect(selectionKey({ kind: 'knowledge' })).toBe(all);
    expect(selectionKey({ kind: 'knowledge', nav: { tab: 'entity', key: 'acme' } })).not.toBe(all);
    expect(selectionKey({ kind: 'knowledge', nav: { tab: 'section', folder: 'ops' } })).not.toBe(
      all,
    );
  });

  it('drops a deep-linked concept: it is context beside your work, not a move', () => {
    expect(selectionKey({ kind: 'knowledge', path: 'knowledge/concepts/a.md' })).toBe(
      selectionKey({ kind: 'knowledge' }),
    );
  });

  it('round-trips to a navigable selection', () => {
    // The whole reason placeOf returns a Selection: "go back to where this
    // thread happened" must not need a parser.
    const place = placeOf({ kind: 'list', id: 'roadmap', collection: 'product', view: 'board' });
    expect(place).toEqual({ kind: 'list', id: 'roadmap', collection: 'product' });
  });

  it('does not collide across kinds that share a name', () => {
    const keys = [
      selectionKey({ kind: 'doc', path: 'notes.md' }),
      selectionKey({ kind: 'collection', folder: 'notes' }),
      selectionKey({ kind: 'type', name: 'notes' }),
      selectionKey({ kind: 'list', id: 'notes' }),
      selectionKey({ kind: 'home' }),
      selectionKey({ kind: 'inbox' }),
      selectionKey({ kind: 'changes' }),
      selectionKey({ kind: 'pulse' }),
      selectionKey({ kind: 'settings' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('samePlace', () => {
  it('treats two absent places as the same and an absent one as unequal to a real one', () => {
    expect(samePlace(null, undefined)).toBe(true);
    expect(samePlace(null, { kind: 'home' })).toBe(false);
    expect(samePlace({ kind: 'home' }, { kind: 'home' })).toBe(true);
  });
});

describe('placeLabel', () => {
  it('names a doc by its title and falls back to the filename when it is gone', () => {
    const entries = [makeEntry({ path: 'docs/spec.md', title: 'The spec' })];
    expect(placeLabel({ kind: 'doc', path: 'docs/spec.md' }, { entries })).toBe('The spec');
    expect(placeLabel({ kind: 'doc', path: 'docs/gone.md' }, { entries })).toBe('gone');
  });

  it('names a Knowledge place the way its page does, never by a raw path (M51.5)', () => {
    const entries = [makeEntry({ path: 'projects/phoenix.md', title: 'Phoenix rollout' })];
    const knowledge = (nav: Parameters<typeof placeLabel>[0] & { kind: 'knowledge' }) =>
      placeLabel(nav, { entries });
    expect(knowledge({ kind: 'knowledge', nav: { tab: 'section', folder: 'key-results' } })).toBe(
      'Knowledge / Key results',
    );
    expect(
      knowledge({ kind: 'knowledge', nav: { tab: 'entity', key: 'projects/phoenix.md' } }),
    ).toBe('Knowledge / Phoenix rollout');
    // A subject nobody has written a page for keeps what the agent typed.
    expect(knowledge({ kind: 'knowledge', nav: { tab: 'entity', key: 'kestrel' } })).toBe(
      'Knowledge / kestrel',
    );
  });

  it('names a List by its definition and falls back to its id', () => {
    const views = [list()];
    expect(placeLabel({ kind: 'list', id: 'roadmap', collection: 'product' }, { views })).toBe(
      'Roadmap',
    );
    // A thread outlives the List it was about; a blank label is not an option.
    expect(placeLabel({ kind: 'list', id: 'roadmap', collection: 'sales' }, { views })).toBe(
      'roadmap',
    );
  });

  it('names a Collection by its stored name only when one was declared', () => {
    const collections: CollectionFile[] = [
      {
        folder: 'product',
        declared: true,
        definition: { name: 'Product', icon: null, color: null, order: null, description: null },
      },
      {
        folder: 'ops',
        declared: false,
        definition: { name: 'ops', icon: null, color: null, order: null, description: null },
      },
    ];
    expect(placeLabel({ kind: 'collection', folder: 'product' }, { collections })).toBe('Product');
    expect(placeLabel({ kind: 'collection', folder: 'team/ops' }, { collections })).toBe('ops');
  });

  it('labels every place kind with something non-empty and no vault at all', () => {
    // `toMatch` also fails on undefined, which `not.toBe('')` let through.
    for (const sel of EVERY_SHAPE) expect(placeLabel(placeOf(sel)), sel.kind).toMatch(/\S/);
  });
});

describe('isPlace — the loader guard', () => {
  it('accepts what placeOf produces for every kind, after a JSON round trip (M53.14)', () => {
    // The round trip is localStorage's. My work and Work threads failed this
    // guard and came back unanchored on every reload.
    for (const sel of EVERY_SHAPE) {
      const stored: unknown = JSON.parse(JSON.stringify(placeOf(sel)));
      expect(isPlace(stored), JSON.stringify(sel)).toBe(true);
      expect(placeKey(stored as Place)).toBe(selectionKey(sel));
      expect(placeLabel(stored as Place)).toMatch(/\S/);
    }
  });

  it('rejects anything it could not key or label', () => {
    // localStorage holds whatever an older build wrote. A place this build
    // cannot render must read as "not anchored", never as a crash.
    for (const raw of [
      null,
      undefined,
      'home',
      42,
      {},
      { kind: 'doc' },
      { kind: 'doc', path: 7 },
      { kind: 'list', collection: 'a' },
      { kind: 'list', id: 'x', collection: 3 },
      { kind: 'collection', folder: null },
      { kind: 'knowledge', nav: { tab: 'entity' } },
      { kind: 'knowledge', nav: 'all' },
      // Every kind Selection has retired, in the shape it had. `review` still
      // passed until M53.14 and came back as a place nothing renders.
      { kind: 'view', id: 'roadmap' }, // M10
      { kind: 'project', path: 'onboarding/project.md' }, // M12.5
      { kind: 'review' }, // M33.3
      { kind: 'pipeline' }, // M33.4
      { kind: 'status', section: 'fleet' }, // M33a.2
      { kind: 'docs' }, // M38.3
    ]) {
      expect(isPlace(raw), JSON.stringify(raw)).toBe(false);
    }
  });
});

describe('placeKey', () => {
  it("cannot be confused between a Collection's path and a List's id", () => {
    // The encoding is only unambiguous because an id is a filename STEM and so
    // can never contain a slash. This pins the assumption: if ids ever gained
    // one, `a/b` + `c` and `a` + `b/c` would key identically and two different
    // Lists would share a thread.
    expect(placeKey({ kind: 'list', id: 'c', collection: 'a/b' })).toBe('list:a/b/c');
    expect(list().id).not.toContain('/');
  });
});
