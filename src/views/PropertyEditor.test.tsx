import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BatchOp } from '@/engine/batch';
import { buildSchema } from '@/engine/schema';
import type { ColumnSpec, Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { PropertyEditor } from '@/views/PropertyEditor';

const betDoc = makeEntry({
  path: 'types/bet.md',
  title: 'Bet',
  type: 'Type',
  properties: {
    fields: { stake: { kind: 'text' }, odds: { kind: 'number' } },
  } as unknown as Entry['properties'],
});
const bet = (n: number, stake: string) =>
  makeEntry({
    path: `records/bets/bet-${n}.md`,
    title: `Bet ${n}`,
    type: 'Bet',
    properties: { stake } as Entry['properties'],
  });

afterEach(cleanup);

function setup(stakes: string[]) {
  const entries = [betDoc, ...stakes.map((s, i) => bet(i + 1, s))];
  const patches: { path: string; patch: Record<string, unknown> }[] = [];
  const batches: BatchOp[][] = [];
  const toasts: string[] = [];
  useVaultStore.setState({
    entries,
    views: [],
    patchFrontmatter: vi.fn(async (path: string, patch: Record<string, unknown>) => {
      patches.push({ path, patch });
      return true;
    }),
    // M60.6: a database-wide change lands as one batch; its patch ops are
    // the writes, in order.
    applyBatch: vi.fn(async (ops: BatchOp[]) => {
      batches.push(ops);
      for (const op of ops) if (op.op === 'patch') patches.push({ path: op.path, patch: op.set });
      return { batchId: 'b'.repeat(32), files: [] };
    }),
  });
  useUiStore.setState({ toast: (m: string) => void toasts.push(m) });
  const schema = buildSchema(entries);
  const def = schema.types.get('Bet')!.fields.find((f) => f.name === 'stake')!;
  const columns: ColumnSpec[] = [{ field: 'stake' }, { field: 'odds' }];
  const onColumnsChange = vi.fn();
  const onRenamed = vi.fn();
  render(
    <PropertyEditor
      def={def}
      sourceType="Bet"
      schema={schema}
      columns={columns}
      onColumnsChange={onColumnsChange}
      onRenamed={onRenamed}
    />,
  );
  return { patches, batches, toasts, onColumnsChange, onRenamed };
}

async function pick(user: ReturnType<typeof userEvent.setup>, kind: string) {
  await user.click(screen.getByTestId('property-editor-type'));
  await user.click(screen.getByTestId(`change-type-${kind}`));
}

describe('PropertyEditor Change type (M60.5)', () => {
  it('asks to change in place when every value converts, and counts the rewrites', async () => {
    const user = userEvent.setup();
    const { patches } = setup(['12', '7']);
    await pick(user, 'number');
    expect(screen.getByText('Change "Stake" to Number?')).toBeTruthy();
    expect(screen.getByTestId('kind-change-body').textContent).toBe(
      'Every value converts. This rewrites 2 records on disk.',
    );
    // M60.7: the change is undoable, so the dialog no longer says otherwise.
    expect(screen.queryByText(/not from the app|cannot be undone/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Change type' }));
    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches[0].path).toBe('types/bet.md');
    expect(patches.slice(1).map((p) => p.patch)).toEqual([{ stake: 12 }, { stake: 7 }]);
  });

  it('says when no record changes on disk', async () => {
    const user = userEvent.setup();
    setup(['Big', 'Small']);
    await pick(user, 'select');
    expect(screen.getByTestId('kind-change-body').textContent).toBe(
      'Every value converts, and no record changes on disk.',
    );
  });

  it('offers Convert into a new property, quoting three values that do not convert', async () => {
    const user = userEvent.setup();
    const { patches, onColumnsChange } = setup(['12', 'abc', 'n/a', 'TBD']);
    await pick(user, 'number');
    expect(screen.getByText('Convert "Stake" into a new Number property?')).toBeTruthy();
    expect(screen.getByTestId('kind-change-body').textContent).toBe(
      "3 won't convert: “abc”, “n/a”, “TBD”. A new property, “Stake number”, is added after " +
        'Stake holding the 1 value that does. Stake keeps every value.',
    );
    expect(document.body.textContent).not.toContain('dropped');
    await user.click(screen.getByRole('button', { name: 'Convert into a new property' }));
    await waitFor(() =>
      expect(onColumnsChange).toHaveBeenCalledWith([
        { field: 'stake' },
        { field: 'stake_number' },
        { field: 'odds' },
      ]),
    );
    expect(patches.map((p) => p.path)).toEqual(['types/bet.md', 'records/bets/bet-1.md']);
    expect(patches[1].patch).toEqual({ stake_number: 12 });
  });
});

/**
 * The name and Delete (M60.2). A rename's batch renames every stored view's
 * column itself, so the editor never rewrites the open view from its
 * pre-rename props; a delete still prunes the open view's column.
 */
describe('PropertyEditor rename and delete (M60.2)', () => {
  it('a rename reports the normalized name and never rewrites the open view', async () => {
    const user = userEvent.setup();
    const { batches, onColumnsChange, onRenamed } = setup(['12']);
    const input = screen.getByLabelText('Rename Stake');
    await user.clear(input);
    await user.type(input, 'Wager size{Enter}');
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('wager_size'));
    expect(batches).toHaveLength(1);
    expect(batches[0].map((op) => op.path)).toEqual(['types/bet.md', 'records/bets/bet-1.md']);
    expect(onColumnsChange).not.toHaveBeenCalled();
  });

  it('a delete still prunes the open view’s column', async () => {
    const user = userEvent.setup();
    const { onColumnsChange } = setup(['12']);
    await user.click(screen.getByRole('button', { name: 'Delete property' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onColumnsChange).toHaveBeenCalledWith([{ field: 'odds' }]));
  });
});
