import { describe, expect, it } from 'vitest';
import {
  collectionsTree,
  effectiveCollections,
  humanizeFolder,
  newCollectionDefinition,
  nodeCount,
  parseCollectionYaml,
  serializeCollection,
} from './collections';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import { parseListYaml } from './views';
import type { CollectionFile, CollectionNode, ListFile } from './types';

/**
 * M10: a Collection contains Lists, Folders, and Docs. These pin the tree the
 * sidebar draws — including the two things the container must NOT do: claim a
 * nested Collection's contents, or invent folders for empty directories.
 */

const schema = buildSchema([]);

const collection = (folder: string, name?: string): CollectionFile =>
  parseCollectionYaml(folder, name === undefined ? '' : `name: ${name}\n`);

const list = (path: string, name: string, collectionFolder: string | null): ListFile => {
  const id = (path.split('/').pop() ?? '').replace(/\.list\.yml$/, '');
  return parseListYaml(id, `name: ${name}\n`, { collection: collectionFolder, path });
};

const doc = (path: string, title: string) =>
  makeEntry({
    path,
    filename: path.split('/').pop() ?? path,
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    title,
  });

/** Compact tree shorthand: `kind:label` with children indented by depth. */
function shape(nodes: CollectionNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.kind}:${n.label}`,
    ...shape(n.children, depth + 1),
  ]);
}

describe('parseCollectionYaml', () => {
  it('reads name, icon, color, and order', () => {
    const c = parseCollectionYaml(
      'product',
      'name: Product\nicon: package\ncolor: "#3D8BE8"\norder: 2\n',
    );
    expect(c.folder).toBe('product');
    expect(c.declared).toBe(true);
    expect(c.definition).toEqual({
      name: 'Product',
      icon: 'package',
      color: '#3D8BE8',
      order: 2,
    });
  });

  // Tolerant like every other vault file: a fat-fingered collection.yml must
  // not make its folder vanish from the sidebar.
  it('never fails to load — a broken file still names itself after its folder', () => {
    expect(parseCollectionYaml('field-ops', 'name: [oops').definition.name).toBe('Field ops');
    expect(parseCollectionYaml('field-ops', '').definition.name).toBe('Field ops');
    expect(parseCollectionYaml('field-ops', 'name: "   "\n').definition.name).toBe('Field ops');
  });

  it('humanizes only the last segment of a nested folder', () => {
    expect(humanizeFolder('product/field_ops-team')).toBe('Field ops team');
    expect(parseCollectionYaml('a/b/customer-success', '').definition.name).toBe(
      'Customer success',
    );
  });

  it('round-trips through serialize', () => {
    const def = newCollectionDefinition('Product');
    expect(parseCollectionYaml('product', serializeCollection(def)).definition).toEqual(def);
  });
});

/**
 * The invariant: a Collection-less List cannot be represented. A folder holding
 * a List IS a Collection, so nothing can be orphaned — which is why there is no
 * "Lists" bucket in the sidebar and no load-time migration.
 */
describe('effectiveCollections', () => {
  it('returns the declared ones as declared', () => {
    const found = effectiveCollections([collection('product', 'Product')], []);
    expect(found.map((c) => [c.folder, c.declared])).toEqual([['product', true]]);
  });

  it('implies a Collection for a folder that holds a List but declares nothing', () => {
    const found = effectiveCollections([], [list('views/okr.list.yml', 'OKR tree', null)]);
    expect(found.map((c) => [c.folder, c.declared, c.definition.name])).toEqual([
      ['views', false, 'Views'],
    ]);
  });

  it('does not imply one when a declared Collection already contains the List', () => {
    const found = effectiveCollections(
      [collection('product', 'Product')],
      [list('product/q3/risks.list.yml', 'Risks', 'product')],
    );
    // The declared Collection above owns it; `product/q3` is a Folder, not a
    // second container.
    expect(found.map((c) => c.folder)).toEqual(['product']);
  });

  it('never implies one for a project-scoped List — those are project tabs', () => {
    const scoped = parseListYaml('delivery', 'name: Delivery\n', {
      project: 'projects/atlas/project.md',
      path: 'projects/atlas/views/delivery.yml',
    });
    expect(effectiveCollections([], [scoped])).toEqual([]);
  });

  it('leaves no List without a home, whatever shape it is on disk', () => {
    const lists = [
      list('product/roadmap.list.yml', 'Roadmap', 'product'),
      list('views/legacy.yml', 'Legacy', null),
      list('random/place/thing.list.yml', 'Thing', null),
    ];
    const found = effectiveCollections([collection('product', 'Product')], lists);
    for (const l of lists) {
      const dir = l.path.slice(0, l.path.lastIndexOf('/'));
      expect(found.some((c) => dir === c.folder || dir.startsWith(`${c.folder}/`))).toBe(true);
    }
  });
});

describe('collectionsTree', () => {
  it('nests Folders, Lists, and Docs under their Collection', () => {
    const tree = collectionsTree(
      [collection('product', 'Product')],
      [
        list('product/roadmap.list.yml', 'Roadmap', 'product'),
        list('product/q3/risks.list.yml', 'Risks', 'product'),
      ],
      [doc('product/charter.md', 'Charter'), doc('product/q3/plan.md', 'Q3 plan')],
      schema,
    );
    expect(shape(tree)).toEqual([
      'collection:Product',
      // Folders first, then Lists, then Docs — containers above contents.
      '  folder:Q3',
      '    list:Risks',
      '    doc:Q3 plan',
      '  list:Roadmap',
      '  doc:Charter',
    ]);
  });

  // A folder is meaningful once something is in it. Deriving folders from the
  // paths of their contents means an empty directory never shows up as an
  // empty node the user has to wonder about.
  it('invents no folder node for a directory holding nothing', () => {
    const tree = collectionsTree(
      [collection('product', 'Product')],
      [list('product/roadmap.list.yml', 'Roadmap', 'product')],
      [],
      schema,
    );
    expect(shape(tree)).toEqual(['collection:Product', '  list:Roadmap']);
  });

  it('gives a nested Collection its own subtree, and does not double-count it', () => {
    const tree = collectionsTree(
      [collection('product', 'Product'), collection('product/platform', 'Platform')],
      [
        list('product/roadmap.list.yml', 'Roadmap', 'product'),
        list('product/platform/services.list.yml', 'Services', 'product/platform'),
      ],
      [doc('product/platform/adr.md', 'ADR 1')],
      schema,
    );
    // Platform appears ONCE, inside Product — not also as a root, and not as a
    // plain folder duplicating what the nested collection already owns.
    expect(shape(tree)).toEqual([
      'collection:Product',
      '  collection:Platform',
      '    list:Services',
      '    doc:ADR 1',
      '  list:Roadmap',
    ]);
  });

  it('orders Collections by declared order, then name', () => {
    const tree = collectionsTree(
      [
        parseCollectionYaml('c', 'name: Charlie\norder: 1\n'),
        parseCollectionYaml('a', 'name: Alpha\norder: 3\n'),
        parseCollectionYaml('b', 'name: Bravo\norder: 1\n'),
      ],
      [],
      [],
      schema,
    );
    expect(tree.map((c) => c.label)).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  // A pre-M10 vault's saved views have no marker, so their folder becomes an
  // implied Collection named after itself. There is no second bucket for them
  // to sit in, and nothing is hidden.
  it('gives a legacy views/ folder its own implied Collection', () => {
    const tree = collectionsTree(
      [collection('product', 'Product')],
      [
        list('product/roadmap.list.yml', 'Roadmap', 'product'),
        list('views/at-risk.yml', 'At risk', null),
      ],
      [],
      schema,
    );
    expect(shape(tree)).toEqual([
      'collection:Product',
      '  list:Roadmap',
      'collection:Views',
      '  list:At risk',
    ]);
  });

  it('leaves project-scoped legacy views out of the tree — they are project tabs', () => {
    const scoped = parseListYaml('delivery', 'name: Delivery\n', {
      project: 'projects/atlas/project.md',
      path: 'projects/atlas/views/delivery.yml',
    });
    expect(collectionsTree([], [scoped], [], schema)).toEqual([]);
  });

  it('never renders a List outside a Collection', () => {
    const tree = collectionsTree(
      [],
      [
        list('a/one.list.yml', 'One', null),
        list('b/deep/two.list.yml', 'Two', null),
        list('three.list.yml', 'Three', null),
      ],
      [],
      schema,
    );
    // Every list node is a descendant of some collection node — the invariant
    // the "Lists" section used to violate.
    const walk = (nodes: CollectionNode[], insideCollection: boolean): string[] =>
      nodes.flatMap((n) => [
        ...(n.kind === 'list' && !insideCollection ? [n.label] : []),
        ...walk(n.children, insideCollection || n.kind === 'collection'),
      ]);
    expect(walk(tree, false)).toEqual([]);
    expect(tree.every((n) => n.kind === 'collection')).toBe(true);
  });

  // Type docs are the schema, templates are stationery, and the knowledge
  // bundle has its own author — none of them is content someone filed here.
  it('excludes type docs, templates, project.md, and the knowledge bundle', () => {
    const tree = collectionsTree(
      [collection('', 'Everything')],
      [],
      [
        doc('real.md', 'Real doc'),
        makeEntry({ path: 'types/risk.md', filename: 'risk.md', folder: 'types', title: 'Risk', type: 'Type' }),
        makeEntry({ path: 'templates/t.md', filename: 't.md', folder: 'templates', title: 'Template' }),
        makeEntry({ path: 'knowledge/c.md', filename: 'c.md', folder: 'knowledge', title: 'Concept' }),
        makeEntry({ path: 'proj/project.md', filename: 'project.md', folder: 'proj', title: 'A project' }),
      ],
      schema,
    );
    expect(shape(tree)).toEqual(['collection:Everything', '  doc:Real doc']);
  });

  it('counts everything inside a node, folders excluded from the total', () => {
    const tree = collectionsTree(
      [collection('product', 'Product')],
      [
        list('product/roadmap.list.yml', 'Roadmap', 'product'),
        list('product/q3/risks.list.yml', 'Risks', 'product'),
      ],
      [doc('product/q3/plan.md', 'Q3 plan')],
      schema,
    );
    // Roadmap + Risks + Q3 plan = 3; the Q3 folder itself is not a thing.
    expect(nodeCount(tree[0])).toBe(3);
  });
});
