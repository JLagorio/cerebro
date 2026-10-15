import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CSV_MAX_BYTES, parseCsv } from '@/engine/csv';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUndoStore } from '@/stores/undoStore';
import { columnNames, exportViewCsv, importCsv, nameProblem, readCsvFile } from './csvActions';
import { useUiStore } from '@/stores/uiStore';

const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const draft = () => ({
  name: 'Books',
  table: parseCsv('Title,Pages\nDune,412'),
  titleColumn: 0,
  columns: [
    { name: 'title_2', kind: 'text' as const },
    { name: 'pages', kind: 'number' as const },
  ],
});
beforeEach(async () => {
  vi.restoreAllMocks();
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
  useUndoStore.getState().clear();
  useNavStore.setState({ selection: { kind: 'home' } });
  useUiStore.setState({ toasts: [] });
});

describe('CSV read and import actions', () => {
  it('counts an oversized record set while retaining only a bounded preview', async () => {
    const bytes = new TextEncoder().encode('Title\n' + 'A\n'.repeat(10000));
    const result = await readCsvFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer });
    if (!result.ok) throw new Error(result.reason);
    expect(result.table.rowCount).toBe(10000);
    expect(result.table.rows).toHaveLength(2000);
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(
      await importCsv({
        ...draft(),
        table: result.table,
        columns: [{ name: 'title_2', kind: 'text' }],
      }),
    ).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe(
      'One import can create up to 1999 records; this CSV has 10000 rows.',
    );
  });
  it('refuses a large file before reading and invalid UTF-8 without replacement', async () => {
    const arrayBuffer = vi.fn();
    expect(await readCsvFile({ size: CSV_MAX_BYTES + 1, arrayBuffer })).toEqual({
      ok: false,
      reason: 'Choose a CSV smaller than 16 MB.',
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(
      await readCsvFile({ size: 2, arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('UTF-8') });
    expect(
      await readCsvFile({
        size: 1,
        arrayBuffer: async () => {
          throw new Error('disk');
        },
      }),
    ).toMatchObject({ ok: false });
  });
  it('reads a valid UTF-8 file and normalizes every name without reserved keys or collisions', async () => {
    const bytes = new TextEncoder().encode('\uFEFFTitle\nDune');
    expect(
      await readCsvFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer }),
    ).toMatchObject({ ok: true, table: { headers: ['Title'], rows: [['Dune']] } });
    expect(
      columnNames([
        'Type',
        'TITLE',
        'Icon',
        'cover',
        'Fields',
        ' A B ',
        'a b',
        '',
        '_hidden',
        'type_2',
      ]),
    ).toEqual([
      'type_2',
      'title_2',
      'icon_2',
      'cover_2',
      'fields_2',
      'a_b',
      'a_b_2',
      'column_8',
      'hidden',
      'type_2_2',
    ]);
  });
  it('uses database name refusals for blank, reserved and duplicate names', () => {
    const entries = [makeEntry({ path: 'records/book.md', type: 'Book' })];
    const schema = buildSchema(entries);
    expect(nameProblem(' ', entries, schema)).toBe('Name the database.');
    expect(nameProblem('Agent', entries, schema)).toContain('reserves');
    expect(nameProblem('bOOk', entries, schema)).toBe('A database named “bOOk” already exists.');
    expect(nameProblem('Books', entries, schema)).toBeNull();
  });
  it('writes one labelled batch, opens its database, and undoes all files together', async () => {
    const before = new Map(fs());
    const batch = vi.spyOn(ipc, 'applyBatch');
    expect(await importCsv(draft())).toBe('Books');
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][1].map((op) => op.op)).toEqual(['create', 'create']);
    expect(useNavStore.getState().selection).toEqual({ kind: 'type', name: 'Books' });
    expect(useUndoStore.getState().past).toHaveLength(1);
    expect(useUndoStore.getState().past[0].label).toBe('Imported 1 records into “Books”');
    expect(await useUndoStore.getState().undo()).toBe(true);
    expect(new Map([...fs()].filter(([path]) => !path.startsWith('.trash/')))).toEqual(before);
  });
  it('a refused batch leaves every file and navigation alone', async () => {
    const before = new Map(fs());
    vi.spyOn(ipc, 'applyBatch').mockRejectedValueOnce(new Error('journal unavailable'));
    expect(await importCsv(draft())).toBeNull();
    expect(new Map(fs())).toEqual(before);
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });
  it('a failed scan never creates from stale data', async () => {
    const batch = vi.spyOn(ipc, 'applyBatch');
    vi.spyOn(ipc, 'scanVault').mockRejectedValueOnce(new Error('unavailable'));
    expect(await importCsv(draft())).toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });
  it('a vault switch during the fresh scan never writes into the new vault', async () => {
    const batch = vi.spyOn(ipc, 'applyBatch');
    vi.spyOn(ipc, 'scanVault').mockImplementationOnce(async () => {
      useVaultStore.setState({ vaultPath: '/other', entriesVault: '/other', entries: [] });
      return [];
    });
    expect(await importCsv(draft())).toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('exporting a saved tab', () => {
  it('exports a closed tab using its own filters and names the downloaded file', async () => {
    const save = vi.spyOn(ipc, 'exportCsv').mockResolvedValue('work-item-at-risk.csv');
    const { entries, views } = useVaultStore.getState();
    const type = entries.find((entry) => entry.path === 'types/work-item.md')!;
    const schema = buildSchema(entries);
    const risk = schema.types.get('Work item')!.views.find((view) => view.name === 'At risk')!;
    expect(risk).toBeDefined();
    useNavStore.setState({ selection: { kind: 'type', name: 'Work item', view: 'all' } });
    expect(await exportViewCsv({ kind: 'type', name: type.title, view: risk.id }, views)).toBe(
      true,
    );
    expect(save.mock.calls[0][0]).toBe('work-item-at-risk.csv');
    const table = parseCsv(save.mock.calls[0][1]);
    expect(table.headers).toEqual(['Name', 'Status', 'Priority', 'Assignee', 'Due', 'Estimate']);
    expect(table.rows.length).toBeGreaterThan(0);
    const expected = entries
      .filter(
        (entry) =>
          entry.type === 'Work item' &&
          ['urgent', 'high'].includes(String(entry.properties.priority)) &&
          ['progress', 'review'].includes(String(entry.properties.status)),
      )
      .map((entry) => entry.title)
      .sort();
    expect(table.rows.map((row) => row[0]).sort()).toEqual(expected);
    expect(table.rows.length).toBeLessThan(
      entries.filter((entry) => entry.type === 'Work item').length,
    );
  });
  it('cancel says nothing and a save failure never throws', async () => {
    const save = vi
      .spyOn(ipc, 'exportCsv')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('disk full'));
    const selection = { kind: 'type' as const, name: 'Work item' };
    expect(await exportViewCsv(selection, useVaultStore.getState().views)).toBe(false);
    expect(useUiStore.getState().toasts).toEqual([]);
    expect(await exportViewCsv(selection, useVaultStore.getState().views)).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe(
      "Couldn't export the view: disk full",
    );
  });
});
