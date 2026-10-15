import { beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/test/factories';
import { parseIcs } from '@/engine/ics';
import { IMPORT_MAX_BYTES } from '@/engine/fileKinds';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { describeIcsImport, importIcs, readIcsFile } from './icsActions';
const scan = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({ scanVault: scan }));
const apply = vi.fn();
const entries = [
  makeEntry({
    path: 'types/Occasion.md',
    title: 'Occasion',
    type: 'Type',
    properties: { fields: { when: { kind: 'daterange' } } } as unknown as Entry['properties'],
  }),
];
const calendar = parseIcs(
  'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one\nSUMMARY:Lunch\nDTSTART:20260703T120000Z\nEND:VEVENT\nEND:VCALENDAR',
);
const mapping = { type: 'Occasion', date: 'when', person: null, location: null };
beforeEach(() => {
  scan.mockReset().mockResolvedValue(entries);
  apply
    .mockReset()
    .mockResolvedValue({ batchId: 'batch', files: [], imports: [{ outcome: 'created' }] });
  useVaultStore.setState({
    vaultPath: '/vault',
    entriesVault: '/vault',
    status: 'ready',
    entries,
    applyBatch: apply,
  });
  useUiStore.setState({ toasts: [] });
});
it('refuses oversized and invalid UTF-8 before any import', async () => {
  const arrayBuffer = vi.fn();
  expect(await readIcsFile({ size: IMPORT_MAX_BYTES + 1, arrayBuffer })).toMatchObject({
    ok: false,
  });
  expect(arrayBuffer).not.toHaveBeenCalled();
  arrayBuffer.mockResolvedValue(Uint8Array.from([0xc3, 0x28]).buffer);
  expect(await readIcsFile({ size: 2, arrayBuffer })).toEqual({
    ok: false,
    reason: 'The calendar is not valid UTF-8 text.',
  });
  arrayBuffer.mockResolvedValue(
    new TextEncoder().encode('BEGIN:VCALENDAR\n\0\nEND:VCALENDAR').buffer,
  );
  expect(await readIcsFile({ size: 40, arrayBuffer })).toMatchObject({
    ok: false,
    reason: expect.stringContaining('NUL'),
  });
});
it('plans against the fresh schema then writes one labelled import batch and navigates', async () => {
  expect(await importIcs(calendar, mapping)).not.toBeNull();
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    [
      expect.objectContaining({
        op: 'import',
        system: 'ics',
        recordId: 'one -',
        path: 'records/occasions/2026-07-03-lunch.md',
      }),
    ],
    { undo: 'Imported 1 events' },
  );
  expect(useNavStore.getState().selection).toMatchObject({ kind: 'type', name: 'Occasion' });
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe('1 imported');
});
it('never writes if the mapping became invalid, scan failed, or its owner closed', async () => {
  scan.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('unavailable'));
  expect(await importIcs(calendar, mapping)).toBeNull();
  expect(await importIcs(calendar, mapping)).toBeNull();
  expect(await importIcs(calendar, mapping, () => false)).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
it('retires a delayed scan even after switching away and back', async () => {
  let resolve!: (value: Entry[]) => void;
  scan.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = importIcs(calendar, mapping);
  useVaultStore.setState({ vaultPath: '/other' });
  useVaultStore.setState({ vaultPath: '/vault' });
  resolve(entries);
  expect(await pending).toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
it('reports safe re-import outcomes separately and never throws a batch refusal', async () => {
  expect(
    describeIcsImport({
      batchId: '',
      files: [],
      imports: ['unchanged', 'unchanged', 'kept'].map((outcome, index) => ({
        index,
        outcome,
        system: 'ics',
        recordId: String(index),
        path: '',
        alsoAt: [],
        reason: null,
        first: null,
      })) as Parameters<typeof describeIcsImport>[0]['imports'],
    }),
  ).toBe('2 already imported, unchanged; 1 kept with your changes');
  apply.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(null);
  expect(await importIcs(calendar, mapping)).toBeNull();
  expect(await importIcs(calendar, mapping)).toBeNull();
});
