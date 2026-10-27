import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CreationContext } from '@/engine/creationDestination';
import { fixtureVault } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import {
  clearCreationDraftsForVault,
  readCreationDraft,
  readCreationSubmission,
  saveCreationDraft,
} from '@/stores/creationDraftStore';
import { submitCreationDraft } from './creationSubmission';
const context: CreationContext = {
  vault: '/submit-tests',
  pane: 'p1',
  destination: { kind: 'page', folder: '', recipe: { kind: 'blank' } },
};
const save = (ctx = context, revision = 1) =>
  saveCreationDraft({
    context: ctx,
    revision,
    title: '  Exact title  ',
    values: {},
    createMore: false,
    fieldErrors: {},
    formError: null,
  });
beforeEach(() =>
  useVaultStore.setState({
    vaultPath: context.vault,
    entriesVault: context.vault,
    status: 'ready',
    entries: fixtureVault(),
  }),
);
afterEach(() => clearCreationDraftsForVault(context.vault));
it('owns one writer across same-tick submit, close and vault switch, preserving the original failure', async () => {
  let reject!: (error: Error) => void;
  const createItem = vi.fn(
    () =>
      new Promise<string>((_, no) => {
        reject = no;
      }),
  );
  useVaultStore.setState({ createItem });
  save();
  const first = submitCreationDraft(context, 1);
  const repeat = submitCreationDraft(context, 1);
  expect(first.kind).toBe('started');
  expect(repeat.kind).toBe('pending');
  if (first.kind === 'stale' || repeat.kind === 'stale') throw Error('missing operation');
  expect(first.submission.id).toBe(repeat.submission.id);
  expect(createItem).toHaveBeenCalledTimes(1);
  useVaultStore.setState({ vaultPath: '/elsewhere' });
  reject(Error('disk full'));
  await vi.waitFor(() => expect(readCreationSubmission(context)?.state).toBe('failed'));
  expect(readCreationDraft(context)).toMatchObject({
    title: '  Exact title  ',
    formError: 'disk full',
  });
  expect(readCreationDraft({ ...context, vault: '/elsewhere' })).toBeNull();
});
it('submits immutable recipes with separate IDs and clears only the acknowledged revision', async () => {
  let resolve!: (path: string) => void;
  const writer = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((yes) => {
          resolve = yes;
        }),
    )
    .mockResolvedValue('sheet.md');
  useVaultStore.setState({ createItem: writer });
  save();
  const sheet: CreationContext = {
    ...context,
    destination: { kind: 'page', folder: '', recipe: { kind: 'sheet', sheetName: 'Sheet1' } },
  };
  save(sheet);
  const plain = submitCreationDraft(context, 1);
  const workbook = submitCreationDraft(sheet, 1);
  if (plain.kind === 'stale' || workbook.kind === 'stale') throw Error('missing operation');
  expect(plain.submission.id).not.toBe(workbook.submission.id);
  expect(writer.mock.calls[0][0].body).toBe('# Exact title\n');
  expect(writer.mock.calls[1][0].body).toContain('```cerebro-sheet\n');
  save(context, 2);
  resolve('plain.md');
  await vi.waitFor(() => expect(readCreationSubmission(context)?.state).toBe('succeeded'));
  expect(readCreationDraft(context)?.revision).toBe(2);
});
it.each(['database', 'host'])(
  're-resolves a missing %s before the guarded writer',
  async (missing) => {
    const ctx: CreationContext = {
      ...context,
      destination: {
        kind: 'record',
        typeName: missing === 'database' ? 'Removed' : 'Work item',
        host: missing === 'host' ? { path: 'gone.md', field: 'project' } : null,
        group: null,
      },
    };
    const writer = vi.fn();
    useVaultStore.setState({ createItem: writer });
    save(ctx);
    submitCreationDraft(ctx, 1);
    await vi.waitFor(() => expect(readCreationSubmission(ctx)?.state).toBe('failed'));
    expect(writer).not.toHaveBeenCalled();
    expect(readCreationDraft(ctx)?.title).toBe('  Exact title  ');
    expect(readCreationDraft(ctx)?.formError).toMatch(/Choose/);
  },
);
it('related host membership wins over group input and allocates its next capability-based key', async () => {
  const entries = fixtureVault();
  const definition = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
  definition.properties.fields = {
    ...(definition.properties.fields as object),
    project: { kind: 'relation', target: 'Project' },
  } as never;
  const host = entries.find((entry) => entry.type === 'Project')!;
  const ctx: CreationContext = {
    ...context,
    destination: {
      kind: 'record',
      typeName: 'Work item',
      host: { path: host.path, field: 'project' },
      group: { field: 'project', value: 'Other project' },
    },
  };
  const writer = vi.fn().mockResolvedValue('created.md');
  useVaultStore.setState({ entries, createItem: writer });
  saveCreationDraft({
    context: ctx,
    revision: 1,
    title: 'Child',
    values: { project: '[[Wrong host]]', status: 'todo' },
    createMore: false,
    fieldErrors: {},
    formError: null,
  });
  submitCreationDraft(ctx, 1);
  await vi.waitFor(() => expect(readCreationSubmission(ctx)?.state).toBe('succeeded'));
  expect(writer.mock.calls[0][0]).toMatchObject({
    folder: 'records/work-items',
    frontmatter: { type: 'Work item', key: 'FLD-3', project: '[[onboarding]]' },
  });
});
