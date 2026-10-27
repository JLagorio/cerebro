// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import * as vaultStore from '@/stores/vaultStore';
import { __resetRescans, useVaultStore } from '@/stores/vaultStore';
import { __resetOpenPages } from '@/editor/openPages';
import type {
  MetadataPatchRequest,
  MetadataPatchResult,
  MetadataPatchOperation,
  SelectedPropertySnapshot,
} from '@/lib/generated/workspace';
import { makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { FieldEditor } from './FieldEditor';
const target = {
  workspaceId: '915781f1-6812-478c-8063-3f41322547f5',
  recordId: '76b64da5-34b6-45f2-8ab2-e2779227ace3',
};
let serial = 0;
function applied(q: MetadataPatchRequest): MetadataPatchResult {
  const version = {
    ...q.expectedVersion,
    metadataRevision: (BigInt(q.expectedVersion.metadataRevision) + 1n).toString(),
    metadataHash: 'c'.repeat(64),
  };
  const operation: MetadataPatchOperation = {
    path: 'focus.md',
    target: { ...target },
    requestKey: q.requestKey,
    operationId: 'fca816d3-e22f-47a9-8c19-3fa5ef6aa85c',
    version,
    receipt: {
      workspaceId: target.workspaceId,
      recordId: target.recordId,
      epoch: '2',
      previousRevision: q.expectedVersion.metadataRevision,
      revision: version.metadataRevision,
      metadataBeforeHash: q.expectedVersion.metadataHash,
      metadataAfterHash: version.metadataHash,
      bodyBeforeHash: version.bodyHash,
      bodyAfterHash: version.bodyHash,
      actor: 'human:me',
      operation: 'metadata.patch',
      at: '2026-10-26T00:00:00Z',
    },
  };
  return { kind: 'applied', operation, currentVersion: { ...version }, reconcileRequired: false };
}
beforeEach(() => {
  cleanup();
  __resetOpenPages();
  __resetRescans();
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  __resetRescans();
  vi.restoreAllMocks();
});
async function recovery() {
  const frame: SelectedPropertySnapshot = {
    path: 'focus.md',
    field: 'amount',
    target,
    version: {
      kind: 'sqlite_metadata',
      ...target,
      metadataRevision: '9007199254740993',
      metadataHash: 'a'.repeat(64),
      bodyHash: 'b'.repeat(64),
    },
    observedBodyHash: 'b'.repeat(64),
    coherence: 'paired',
    editable: true,
    readOnlyReason: null,
    value: { kind: 'present', value: { kind: 'decimal', value: '9007199254740993.125' } },
  };
  const vault = '/number-recovery-focus-' + ++serial;
  const entry = makeEntry({
    path: 'focus.md',
    authority: frame.version,
    hash: frame.version.bodyHash,
    properties: { amount: 42 },
  });
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    status: 'ready',
    entries: [entry],
    rescan: vi.fn(async () => {}),
  });
  vi.spyOn(ipc, 'supportsSelectedEditor').mockReturnValue(true);
  vi.spyOn(ipc, 'readSelectedProperty').mockResolvedValue(frame);
  let settle: (() => void) | undefined;
  vi.spyOn(ipc, 'patchSelectedMetadata')
    .mockRejectedValueOnce(new Error('lost original reply'))
    .mockImplementationOnce(
      async (_vault, _path, q) =>
        new Promise<MetadataPatchResult>((resolve) => {
          settle = () => resolve(applied(q));
        }),
    );
  render(
    <>
      <div role="grid" tabIndex={0} aria-label="Original recovery grid">
        <FieldEditor
          entry={entry}
          def={{ name: 'amount', kind: 'number' }}
          schema={buildSchema([entry])}
        />
      </div>
      <button type="button">Outside action</button>
    </>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit Amount' }));
  const input = await screen.findByRole('textbox', { name: 'Amount' });
  fireEvent.change(input, { target: { value: '1e400' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  const check = await screen.findByRole('button', { name: 'Check save' });
  check.focus();
  expect(document.activeElement).toBe(check);
  fireEvent.click(check);
  await waitFor(() => expect(ipc.patchSelectedMetadata).toHaveBeenCalledTimes(2));
  // Check save is conditional on unknown phase; sending removes that original
  // node. Assert the actual busy controls instead of a detached node's props.
  expect(check.isConnected).toBe(false);
  expect(input).toHaveProperty('readOnly', true);
  expect(screen.getByRole('button', { name: 'Compare versions' })).toHaveProperty('disabled', true);
  expect(document.activeElement).toBe(document.body);
  return {
    grid: screen.getByRole('grid', { name: 'Original recovery grid' }),
    outside: screen.getByRole('button', { name: 'Outside action' }),
    settle: async () => {
      if (!settle) throw new Error('actual original Resolve was not dispatched');
      await act(async () => {
        settle!();
      });
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Amount' })).toBeNull());
    },
  };
}
it('original Check save restores its connected grid after the initiating control is removed while busy', async () => {
  const h = await recovery();
  await h.settle();
  expect(document.activeElement).toBe(h.grid);
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledTimes(2);
  const first = vi.mocked(ipc.patchSelectedMetadata).mock.calls[0]![2];
  expect(vi.mocked(ipc.patchSelectedMetadata).mock.calls[1]![2]).toEqual({
    ...first,
    phase: 'resolve',
  });
});
it('recovery completion cannot steal intentionally moved outside focus', async () => {
  const h = await recovery();
  h.outside.focus();
  expect(document.activeElement).toBe(h.outside);
  await h.settle();
  expect(document.activeElement).toBe(h.outside);
});
it('recovery completion cannot focus an inactive original grid', async () => {
  const h = await recovery();
  h.grid.setAttribute('data-active', 'false');
  await h.settle();
  expect(document.activeElement).toBe(document.body);
});
it('recovery completion cannot focus a replacement opening at the same presentation path', async () => {
  const opening = vi.spyOn(vaultStore, 'getVaultOpening').mockReturnValue(100);
  const h = await recovery();
  opening.mockReturnValue(101);
  await h.settle();
  expect(document.activeElement).toBe(document.body);
});
it('recovery completion cannot reclaim focus after the window deliberately loses focus', async () => {
  const h = await recovery();
  fireEvent(window, new Event('blur'));
  await h.settle();
  expect(document.activeElement).toBe(document.body);
});
it('recovery completion cannot steal back focus after an intentional outside focus was later cleared', async () => {
  const h = await recovery();
  h.outside.focus();
  h.outside.blur();
  expect(document.activeElement).toBe(document.body);
  await h.settle();
  expect(document.activeElement).toBe(document.body);
});
it('recovery completion cannot focus the grid after an outside pointer action left body focused', async () => {
  const h = await recovery();
  fireEvent.pointerDown(h.outside);
  await h.settle();
  expect(document.activeElement).toBe(document.body);
});
