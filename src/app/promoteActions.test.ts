import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixtureVault } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import type { ChecklistLine } from '@/engine/promote';
import { useVaultStore } from '@/stores/vaultStore';
import { createPromoted } from './promoteActions';

const line = (title: string): ChecklistLine => ({
  blockId: title,
  checked: false,
  title,
  due: null,
  extraDates: [],
  people: [],
  flattened: false,
  onlyLink: false,
  text: title,
  snapshot: '',
});
beforeEach(() =>
  useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault', entriesVault: '/vault' }),
);
afterEach(() => vi.restoreAllMocks());

it('creates in line order, reports a failed line and keeps trying without throwing', async () => {
  const createItem = vi
    .fn()
    .mockResolvedValueOnce('first.md')
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce('last.md');
  useVaultStore.setState({ createItem });
  const result = await createPromoted(
    [line('First'), line('Middle'), line('Last')],
    'Work item',
    null,
    { person: 'assignee', parent: null },
    buildSchema(fixtureVault()),
  );
  expect(result.map((row) => row.outcome)).toEqual(['created', 'failed', 'created']);
  expect(createItem.mock.calls.map(([args]) => args.slug)).toEqual(['first', 'middle', 'last']);
  expect(createItem.mock.calls[0][0]).toEqual({
    folder: 'records/work-items',
    slug: 'first',
    frontmatter: { type: 'Work item', status: 'todo' },
    body: '# First\n',
  });
});

it('returns skips without writes and refuses an unknown target', async () => {
  const createItem = vi.fn();
  useVaultStore.setState({ createItem });
  const lines = [line(''), { ...line('Existing'), onlyLink: true }];
  const schema = buildSchema(fixtureVault());
  const results = await createPromoted(
    lines,
    'Work item',
    null,
    { person: null, parent: null },
    schema,
  );
  expect(results.map((row) => row.outcome)).toEqual(['skipped', 'skipped']);
  expect(results).toMatchObject([{ reason: 'Empty line' }, { reason: 'Already a link' }]);
  expect(
    (
      await createPromoted([line('New')], 'missing', null, { person: null, parent: null }, schema)
    )[0].outcome,
  ).toBe('failed');
  expect(createItem).not.toHaveBeenCalled();
});

it('a vault switch between lines never creates the remaining lines in another vault', async () => {
  const createItem = vi.fn(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    return 'first.md';
  });
  useVaultStore.setState({ createItem });
  const results = await createPromoted(
    [line('First'), line('Second')],
    'Work item',
    null,
    { person: null, parent: null },
    buildSchema(fixtureVault()),
  );
  expect(results.map((row) => row.outcome)).toEqual(['created', 'failed']);
  expect(createItem).toHaveBeenCalledTimes(1);
});

it('refuses remaining lines when the selected database changes during the first create', async () => {
  const entries = fixtureVault();
  const createItem = vi.fn(async () => {
    useVaultStore.setState({
      entries: entries.map((entry) =>
        entry.path === 'types/work-item.md'
          ? {
              ...entry,
              properties: { ...entry.properties, fields: { title: { kind: 'text' } } } as never,
            }
          : entry,
      ),
    });
    return 'first.md';
  });
  useVaultStore.setState({ entries, createItem });
  const results = await createPromoted(
    [line('First'), line('Second')],
    'Work item',
    null,
    { person: null, parent: null },
    buildSchema(entries),
  );
  expect(results.map((row) => row.outcome)).toEqual(['created', 'failed']);
  expect(results[1]).toMatchObject({ reason: 'The database or parent changed' });
  expect(createItem).toHaveBeenCalledTimes(1);
});

it('refuses a selected parent that no longer has the required status capability', async () => {
  const entries = fixtureVault().map((entry) =>
    entry.path === 'types/work-item.md'
      ? {
          ...entry,
          properties: {
            ...entry.properties,
            fields: {
              ...(entry.properties.fields as object),
              parent: { kind: 'relation', target: 'Work item', limit: 1 },
            },
          } as never,
        }
      : entry,
  );
  const source = entries.find((entry) => entry.path.endsWith('/fld-1.md'))!;
  const createItem = vi.fn();
  useVaultStore.setState({
    entries: entries.map((entry) =>
      entry.path === source.path ? { ...entry, type: 'Person' } : entry,
    ),
    createItem,
  });
  const results = await createPromoted(
    [line('Child')],
    'Work item',
    source,
    { person: null, parent: 'parent' },
    buildSchema(entries),
  );
  expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'The database or parent changed' });
  expect(createItem).not.toHaveBeenCalled();
});
