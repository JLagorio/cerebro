import { expect, it } from 'vitest';
import type { Selection } from './types';
import { makeEntry } from './testHelpers';
import { parseCollectionYaml } from './collections';
import { parseListYaml } from './views';
import { placeResolves, readSelection, restorablePlace, type PlaceSnapshot } from './placeResolves';
const ONE_OF_EACH = {
  home: { kind: 'home' },
  inbox: { kind: 'inbox' },
  mywork: { kind: 'mywork' },
  changes: { kind: 'changes' },
  pulse: { kind: 'pulse' },
  settings: { kind: 'settings' },
  doc: { kind: 'doc', path: 'page.md', tab: 'body', thread: 'thread' },
  diagram: { kind: 'diagram', path: 'map.mmd' },
  file: { kind: 'file', path: 'attachments/a.pdf' },
  knowledge: { kind: 'knowledge', path: 'knowledge/idea.md', nav: { tab: 'runs', run: 'run' } },
  library: { kind: 'library', tab: 'skill', path: 'skill.md' },
  collection: { kind: 'collection', folder: 'work' },
  list: { kind: 'list', id: 'all', collection: 'work', view: 'table' },
  type: { kind: 'type', name: 'Work' },
  workspace: { kind: 'workspace', root: 'repo', path: 'README.md' },
  studio: { kind: 'studio', project: 'test' },
  agents: { kind: 'agents', actor: 'process:scout' },
} satisfies { [Kind in Selection['kind']]: Extract<Selection, { kind: Kind }> };
const snapshot: PlaceSnapshot = {
  entries: ['page.md', 'map.mmd', 'knowledge/idea.md', 'skill.md']
    .map((path) => makeEntry({ path }))
    .concat(
      makeEntry({
        path: 'agents/scout.md',
        type: 'Agent',
        title: 'Scout',
        properties: { slug: 'scout' },
      }),
    ),
  collections: [parseCollectionYaml('work', 'name: Work')],
  views: [parseListYaml('all', 'name: All\nsource: {type: Work}', { collection: 'work' })],
  types: ['Work'],
  roots: [{ id: 'repo' }],
  rootsLoaded: true,
  inboxEnabled: true,
  folders: ['studio/test'],
};
it('reads and resolves every Selection kind with an exhaustive fixture table', () => {
  for (const place of Object.values(ONE_OF_EACH)) {
    expect(readSelection(JSON.parse(JSON.stringify(place)))).toEqual(place);
    expect(placeResolves(place, snapshot), place.kind).toBe(true);
  }
});
it('drops gone targets, respects loading roots, and keeps standing places and constructs', () => {
  const empty: PlaceSnapshot = {
    entries: [],
    collections: [],
    views: [],
    types: [],
    roots: [],
    rootsLoaded: true,
    folders: [],
    inboxEnabled: false,
  };
  const standing = new Set(['home', 'mywork', 'changes', 'pulse', 'settings', 'file']);
  for (const place of Object.values(ONE_OF_EACH))
    expect(placeResolves(place, empty), place.kind).toBe(standing.has(place.kind));
  expect(placeResolves(ONE_OF_EACH.workspace, { ...empty, rootsLoaded: false })).toBe(true);
  expect(placeResolves({ kind: 'agents', actor: 'agent:construct' }, empty)).toBe(true);
  for (const place of [
    { kind: 'knowledge' },
    { kind: 'library' },
    { kind: 'studio' },
    { kind: 'agents' },
    { kind: 'workspace' },
  ] as Selection[])
    expect(placeResolves(place, empty)).toBe(true);
  expect(placeResolves({ ...ONE_OF_EACH.list, collection: 'elsewhere' }, snapshot)).toBe(false);
});
it('rejects junk and malformed lenses without accepting a library tab array', () => {
  for (const raw of [
    null,
    [],
    1,
    'home',
    {},
    { kind: 'unknown' },
    { kind: 'doc' },
    { kind: 'doc', path: 1 },
    { kind: 'doc', path: 'p', thread: 4 },
    { kind: 'library', tab: ['agent'] },
    { kind: 'type', name: '' },
    { kind: 'workspace', root: 0 },
    { kind: 'list', id: 'list', collection: 2 },
    { kind: 'knowledge', nav: { tab: 'section' } },
    { kind: 'knowledge', nav: { tab: 'entity', key: 0 } },
    { kind: 'knowledge', nav: { tab: 'runs', run: 2 } },
    { kind: 'knowledge', nav: { tab: 'bad' } },
  ])
    expect(readSelection(raw), JSON.stringify(raw)).toBeNull();
  expect(readSelection({ kind: 'home', irrelevant: 'ignored' })).toEqual({ kind: 'home' });
});
it('keeps useful lenses but drops visit-only thread and run identities', () => {
  expect(restorablePlace(ONE_OF_EACH.doc)).toEqual({ kind: 'doc', path: 'page.md', tab: 'body' });
  expect(restorablePlace(ONE_OF_EACH.knowledge)).toEqual({
    kind: 'knowledge',
    path: 'knowledge/idea.md',
    nav: { tab: 'runs' },
  });
  expect(restorablePlace(ONE_OF_EACH.type)).toEqual(ONE_OF_EACH.type);
});

it('keeps unscanned attachments until a byte probe proves absence', () => {
  const file = { kind: 'file', path: 'attachments/a.pdf' } as const;
  expect(placeResolves(file, { ...snapshot, entries: [] })).toBe(true);
  expect(placeResolves(file, { ...snapshot, missingFiles: ['attachments/a.pdf'] })).toBe(false);
});
