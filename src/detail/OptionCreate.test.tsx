// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FieldEditor } from '@/detail/FieldEditor';
import { buildSchema } from '@/engine/schema';
import type { Entry, FieldDef } from '@/engine/types';
import { resetLayers } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

const TYPE_DOC = 'types/task.md';
const RECORD = 'records/task-1.md';

interface SetupArgs {
  /** `fields:` on the Type doc. */
  fields?: Record<string, unknown>;
  /** `statuses:` on the Type doc. */
  statuses?: unknown[];
  field?: string;
  extra?: Entry[];
  record?: Partial<Entry>;
}

function setup({ fields, statuses, field = 'stage', extra = [], record = {} }: SetupArgs = {}) {
  const typeDoc = makeEntry({
    path: TYPE_DOC,
    title: 'Task',
    type: 'Type',
    properties: {
      fields: fields ?? { stage: { kind: 'select', options: [{ id: 'in-progress' }] } },
      ...(statuses === undefined ? {} : { statuses }),
    } as unknown as Entry['properties'],
  });
  const rec = makeEntry({ path: RECORD, title: 'A task', type: 'Task', ...record });
  const all = [typeDoc, rec, ...extra];
  const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
  useVaultStore.setState({ entries: all, vaultPath: '/vault', patchFrontmatter });
  const schema = buildSchema(all);
  const def = schema.types.get('Task')?.fields.find((f) => f.name === field) as FieldDef;
  render(<FieldEditor entry={rec} def={def} schema={schema} />);
  return { patchFrontmatter, schema };
}

const writtenTo = (patch: ReturnType<typeof vi.fn>, path: string) => {
  const calls = (patch.mock.calls as [string, Record<string, unknown>][]).filter(
    (c) => c[0] === path,
  );
  return calls[calls.length - 1]?.[1];
};

const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole('button')[0]);
};

/**
 * Inline option creation (M16.12).
 *
 * The create row compared LABELS while ids are slugs, so two labels that slug
 * the same both got written — and because the write APPENDS and every lookup
 * is a `.find` on id, the FIRST one won. The new label was invisible forever,
 * the record kept rendering the old one, and the write reported success.
 */
describe('inline option creation', () => {
  beforeEach(() => {
    resetLayers();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it('creates an option the type does not have', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openPicker(user);
    await user.type(screen.getByPlaceholderText(/Search|Filter|/), 'Blocked');
    await user.click(await screen.findByText('Blocked'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const fields = writtenTo(patchFrontmatter, TYPE_DOC)?.fields as Record<
      string,
      { options: ({ id: string } | string)[] }
    >;
    // `optionToSpec` collapses an option with no colour and no custom label
    // to a bare string, so a plain option round-trips as YAML scalar.
    expect(fields.stage.options.map((o) => (typeof o === 'string' ? o : o.id))).toEqual([
      'in-progress',
      'blocked',
    ]);
  });

  // The bug. "In-Progress" and "In Progress" are one id.
  it('selects the colliding option instead of writing a shadowed twin', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openPicker(user);
    await user.type(screen.getByPlaceholderText(/Search|Filter|/), 'In-Progress');

    // No "Create" row at all — the option already exists under another label.
    expect(screen.queryByText(/^Create/)).toBeNull();
    // And it is offered rather than leaving a "No matches" dead end.
    const row = await screen.findByText('In progress');
    await user.click(row);

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    // The record took the EXISTING id, and the type was never rewritten.
    expect(writtenTo(patchFrontmatter, RECORD)).toEqual({ stage: 'in-progress' });
    expect(writtenTo(patchFrontmatter, TYPE_DOC)).toBeUndefined();
  });

  it('gives a new option a named colour, never a raw hex', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await openPicker(user);
    await user.type(screen.getByPlaceholderText(/Search|Filter|/), 'Shipped');
    await user.click(await screen.findByText('Shipped'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const fields = writtenTo(patchFrontmatter, TYPE_DOC)?.fields as Record<
      string,
      { options: { id: string; color?: string }[] }
    >;
    const created = fields.stage.options.find((o) => o.id === 'shipped');
    expect(created?.color).not.toMatch(/^#/);
    expect(created?.color).toBeTruthy();
  });
});

/**
 * Status was excluded outright (M16.12) and dead-ended with "add them on the
 * type screen" — which by M16.7 was not even the only route.
 */
describe('inline status creation', () => {
  beforeEach(() => {
    resetLayers();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  const statusFields = { stage: { kind: 'status' } };

  it('creates a status, writing the type’s status list', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup({
      fields: statusFields,
      statuses: [{ id: 'todo', group: 'active' }],
    });
    await openPicker(user);
    await user.type(screen.getByPlaceholderText(/Search|Filter|/), 'Blocked');
    await user.click(await screen.findByText('Blocked'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const written = writtenTo(patchFrontmatter, TYPE_DOC)?.statuses as {
      id: string;
      group: string;
    }[];
    expect(written.map((s) => s.id)).toEqual(['todo', 'blocked']);
    // The engine's own fallback — there is no group picker in a create row.
    expect(written[1].group).toBe('active');
  });

  // Spreading the defaults is deliberate: it materialises the chain the user
  // is looking at onto the Type doc.
  it('materialises the default chain when the type declares none', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup({ fields: statusFields });
    await openPicker(user);
    await user.type(screen.getByPlaceholderText(/Search|Filter|/), 'Blocked');
    await user.click(await screen.findByText('Blocked'));

    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    const written = writtenTo(patchFrontmatter, TYPE_DOC)?.statuses as { id: string }[];
    expect(written.length).toBeGreaterThan(1);
    expect(written[written.length - 1].id).toBe('blocked');
  });

  // Writing to the type would be a silent no-op — the override wins on the
  // very next read — so the picker says where the statuses actually live.
  it('refuses, and says where they live, under a project override', async () => {
    const project = makeEntry({
      path: 'projects/p/project.md',
      title: 'P',
      type: 'Project',
      properties: {
        statuses: [{ id: 'shaping', group: 'active' }],
      } as unknown as Entry['properties'],
    });
    setup({
      fields: statusFields,
      extra: [project],
      record: { project: 'projects/p/project.md' },
    });
    const user = userEvent.setup();
    await openPicker(user);
    // No search box at all — `searchable` is derived from onCreate — so the
    // explanation has to be a footer rather than a response to typing.
    expect(screen.queryByPlaceholderText(/Search|Filter/)).toBeNull();
    expect(screen.getByText(/Statuses come from this record’s project/)).toBeTruthy();
    expect(screen.queryByText(/^Create/)).toBeNull();
  });
});
