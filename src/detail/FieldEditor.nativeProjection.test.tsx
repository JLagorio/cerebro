// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NATIVE from '../../shared/workspace/selected-entry-projection-native.v1.json';
import type { MetadataPatchRequest, MetadataPatchResult, SelectedPropertySnapshot } from '@/lib/generated/workspace';
import type { Entry } from '@/engine/types';
import { buildSchema } from '@/engine/schema';
import * as ipc from '@/lib/ipc';
import { __resetOpenPages, flushOpenPages, unresolvedOpenPages } from '@/editor/openPages';
import { __resetRescans, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { FieldEditor } from './FieldEditor';

// The ignored Rust exporter captures actual production scan/read_property,
// original request, and native ACK from one disposable kernel transaction.
// This replay supplies transport only; rescan/buildSchema/render stay real.
type NativeSample = {
  request: MetadataPatchRequest;
  ack: MetadataPatchResult;
  before: { entries: Entry[]; field: SelectedPropertySnapshot };
  after: { entries: Entry[]; field: SelectedPropertySnapshot };
};
const realRescan = useVaultStore.getState().rescan;
const { vault, path, field } = NATIVE.scope;
let sample: NativeSample;
let currentField: SelectedPropertySnapshot;
let failObservation = false;

beforeEach(() => {
  cleanup(); __resetOpenPages(); __resetRescans(); vi.restoreAllMocks();
  failObservation = false;
  useUiStore.setState({ toasts: [] });
});
afterEach(() => { cleanup(); __resetOpenPages(); __resetRescans(); vi.restoreAllMocks(); });

function setSample(kind: 'number' | 'date'): void {
  // Generated JSON is decoded to the generated contracts, never reconstructed.
  sample = structuredClone(NATIVE.samples[kind]) as unknown as NativeSample;
  currentField = sample.before.field;
  useVaultStore.setState({ vaultPath: vault, entriesVault: vault, entries: sample.before.entries,
    views: [], collections: [], folders: [], status: 'ready', error: null, scanObservation: null, rescan: realRescan });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(sample.request.requestKey as ReturnType<Crypto['randomUUID']>);
  vi.spyOn(ipc, 'supportsSelectedEditor').mockReturnValue(true);
  vi.spyOn(ipc, 'readSelectedProperty').mockImplementation(async () => structuredClone(currentField));
  vi.spyOn(ipc, 'patchSelectedMetadata').mockImplementation(async (originalVault, originalPath, request) => {
    expect([originalVault, originalPath]).toEqual([vault, path]);
    expect(request).toEqual(sample.request);
    currentField = sample.after.field;
    return structuredClone(sample.ack);
  });
  vi.spyOn(ipc, 'scanVault').mockImplementation(async originalVault => {
    expect(originalVault).toBe(vault);
    if (failObservation) throw new Error('explicit descriptive scan failure after known native ACK');
    return structuredClone(sample.after.entries);
  });
  vi.spyOn(ipc, 'listViews').mockResolvedValue([]);
  vi.spyOn(ipc, 'listCollections').mockResolvedValue([]);
  vi.spyOn(ipc, 'listFolders').mockResolvedValue([]);
  vi.spyOn(ipc, 'saveNoteBody');
  vi.spyOn(ipc, 'updateFrontmatter');
}

function MountedField({ kind }: { kind: 'number' | 'date' }) {
  const entries = useVaultStore(state => state.entries);
  const entry = entries.find(row => row.path === path);
  if (!entry) throw new Error('native fixture must retain its original page');
  return <FieldEditor entry={entry} def={{ name: field, kind }} schema={buildSchema(entries)} />;
}

async function saveFixture(kind: 'number' | 'date'): Promise<void> {
  render(<MountedField kind={kind} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit Flag' }));
  const input = await screen.findByRole('textbox', { name: 'Flag' });
  const change = sample.request.changes[0];
  if (change.op !== 'set' || (change.value.kind !== 'decimal' && change.value.kind !== 'date')) throw new Error('exported exact scalar request required');
  expect(input).toHaveProperty('value', sample.before.field.value.kind === 'present' && 'value' in sample.before.field.value.value ? sample.before.field.value.value.value : undefined);
  fireEvent.change(input, { target: { value: change.value.value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce());
  await waitFor(() => expect(ipc.scanVault).toHaveBeenCalledOnce());
}

it.each(['number', 'date'] as const)('actual native %s ACK survives real store.rescan and renders the exact canonical after-value', async kind => {
  setSample(kind);
  await saveFixture(kind);
  await waitFor(() => expect(useVaultStore.getState().scanObservation?.outcome).toBe('scanned'));
  expect(useVaultStore.getState().entries).toEqual(sample.after.entries);
  expect(useVaultStore.getState().entries.find(row => row.path === path)?.authority).toEqual(sample.after.field.version);
  const after = sample.after.field.value;
  if (after.kind !== 'present' || (after.value.kind !== 'decimal' && after.value.kind !== 'date')) throw new Error('exact exported after-value required');
  const expectedText = after.value.value;
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Flag' }).textContent).toBe(expectedText));
  await act(async () => { await flushOpenPages(); });
  expect(unresolvedOpenPages()).toEqual([]);
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce();
  expect(ipc.updateFrontmatter).not.toHaveBeenCalled();
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();
});

it('a failed descriptive rescan preserves the known native Applied outcome without retrying it', async () => {
  setSample('number'); failObservation = true;
  await saveFixture('number');
  await waitFor(() => expect(useVaultStore.getState().scanObservation?.outcome).toBe('unavailable'));
  expect(useVaultStore.getState().entries).toEqual(sample.before.entries);
  await act(async () => { await flushOpenPages(); });
  expect(unresolvedOpenPages()).toEqual([]);
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce();
  expect(screen.queryByText('Check save')).toBeNull();
});
