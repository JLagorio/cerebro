import { describe, expect, it } from 'vitest';
import {
  collectionsTree,
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
    expect(shape(tree.collections)).toEqual([
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
    expect(shape(tree.collections)).toEqual(['collection:Product', '  list:Roadmap']);
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
    expect(shape(tree.collections)).toEqual([
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
    expect(tree.collections.map((c) => c.label)).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  // The migration guarantee, at the UI layer: a pre-M10 vault's saved views
  // have no Collection, so they surface at the top level instead of being
  // force-fitted into an invented container.
  it('surfaces collection-less Lists separately rather than inventing a home', () => {
    const tree = collectionsTree(
      [collection('product', 'Product')],
      [
        list('product/roadmap.list.yml', 'Roadmap', 'product'),
        list('views/at-risk.yml', 'At risk', null),
      ],
      [],
      schema,
    );
    expect(shape(tree.collections)).toEqual(['collection:Product', '  list:Roadmap']);
    expect(shape(tree.loose)).toEqual(['list:At risk']);
  });

  it('leaves project-scoped legacy views out of the tree — they are project tabs', () => {
    const scoped = parseListYaml('delivery', 'name: Delivery\n', {
      project: 'projects/atlas/project.md',
      path: 'projects/atlas/views/delivery.yml',
    });
    const tree = collectionsTree([], [scoped], [], schema);
    expect(tree.collections).toEqual([]);
    expect(tree.loose).toEqual([]);
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
    expect(shape(tree.collections)).toEqual(['collection:Everything', '  doc:Real doc']);
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
    expect(nodeCount(tree.collections[0])).toBe(3);
  });
});
