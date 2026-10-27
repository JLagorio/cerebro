// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import type {
  MetadataPatchRequest,
  MetadataPatchResult,
  MetadataPatchOperation,
  SelectedPropertySnapshot,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';
import type { FieldKind } from '@/engine/types';
import { makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { __resetRescans, useVaultStore } from '@/stores/vaultStore';
import { __resetOpenPages, flushOpenPages } from '@/editor/openPages';
import { SelectedMetadataRecoveryHost } from '@/editor/SelectedMetadataRecoveryHost';
import { FieldEditor } from './FieldEditor';
const path = 'records/contact.md';
const field = 'contact';
const target = {
  workspaceId: '915781f1-6812-478c-8063-3f41322547f5',
  recordId: '76b64da5-34b6-45f2-8ab2-e2779227ace3',
};
let vault = '';
let serial = 0;
let canonical: SelectedRecordVersion;
let value = 'before';
let editable = true;
const frame = (): SelectedPropertySnapshot => ({
  path,
  target: { ...target },
  field,
  version: { ...canonical },
  value: { kind: 'present', value: { kind: 'string', value } },
  editable,
  readOnlyReason: editable ? null : 'This contact property belongs to its governed writer.',
  coherence: 'paired',
  observedBodyHash: canonical.bodyHash,
});
function operation(q: MetadataPatchRequest): MetadataPatchOperation {
  const after = {
    ...q.expectedVersion,
    metadataRevision: (BigInt(q.expectedVersion.metadataRevision) + 1n).toString(),
    metadataHash: 'c'.repeat(64),
  };
  return {
    path,
    target: { ...q.target },
    requestKey: q.requestKey,
    operationId: 'fca816d3-e22f-47a9-8c19-3fa5ef6aa85c',
    version: after,
    receipt: {
      workspaceId: target.workspaceId,
      recordId: target.recordId,
      epoch: '2',
      previousRevision: q.expectedVersion.metadataRevision,
      revision: after.metadataRevision,
      metadataBeforeHash: q.expectedVersion.metadataHash,
      metadataAfterHash: after.metadataHash,
      bodyBeforeHash: q.expectedVersion.bodyHash,
      bodyAfterHash: after.bodyHash,
      actor: 'human:me',
      operation: 'metadata.patch',
      at: '2026-10-26T00:00:00Z',
    },
  };
}
function applied(q: MetadataPatchRequest): MetadataPatchResult {
  const op = q.original ?? operation(q);
  canonical = { ...op.version };
  const change = q.changes[0];
  if (change?.op === 'set' && change.value.kind === 'string') value = change.value.value;
  return {
    kind: 'applied',
    operation: op,
    currentVersion: { ...canonical },
    reconcileRequired: false,
  };
}
beforeEach(() => {
  cleanup();
  __resetOpenPages();
  __resetRescans();
  vi.restoreAllMocks();
  vault = '/selected-contact-' + ++serial;
  value = 'before';
  editable = true;
  canonical = {
    kind: 'sqlite_metadata',
    ...target,
    metadataRevision: '9007199254740993',
    metadataHash: 'a'.repeat(64),
    bodyHash: 'b'.repeat(64),
  };
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    status: 'ready',
    error: null,
    entries: [
      makeEntry({
        path,
        title: 'Contact',
        type: 'Task',
        authority: { ...canonical },
        hash: canonical.bodyHash,
        properties: { contact: value, unrelated: 'keep' },
        canonicalProperties: {
          value: {
            kind: 'object',
            value: {
              type: { kind: 'string', value: 'Task' },
              contact: { kind: 'string', value },
              unrelated: { kind: 'string', value: 'keep' },
            },
          },
          unavailableLegacyKeys: [],
        },
      }),
    ],
    rescan: vi.fn(async () => {}),
    patchFrontmatter: vi.fn(async () => true),
  });
  vi.spyOn(ipc, 'supportsSelectedEditor').mockReturnValue(true);
  vi.spyOn(ipc, 'readSelectedProperty').mockImplementation(async () => frame());
  vi.spyOn(ipc, 'patchSelectedMetadata').mockImplementation(async (_vault, _path, q) => applied(q));
  vi.spyOn(ipc, 'saveNoteBody');
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  __resetRescans();
  vi.restoreAllMocks();
});
function mount(kind: FieldKind, initial = 'before') {
  value = initial;
  const entry: ReturnType<typeof makeEntry> = {
    ...useVaultStore.getState().entries[0],
    properties: { contact: value, unrelated: 'keep' },
    canonicalProperties: {
      value: {
        kind: 'object',
        value: {
          type: { kind: 'string', value: 'Task' },
          contact: { kind: 'string', value },
          unrelated: { kind: 'string', value: 'keep' },
        },
      },
      unavailableLegacyKeys: [],
    },
  };
  useVaultStore.setState({ entries: [entry] });
  return render(
    <>
      <FieldEditor entry={entry} def={{ name: field, kind }} schema={buildSchema([entry])} />
      <SelectedMetadataRecoveryHost />
    </>,
  );
}
async function edit(initial: string, text: string) {
  fireEvent.click(screen.getByRole('button', { name: initial }));
  const input = await screen.findByRole('textbox', { name: 'Contact' });
  fireEvent.change(input, { target: { value: text } });
  return input;
}
async function submit(input: HTMLElement) {
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce());
  expect(useVaultStore.getState().patchFrontmatter).not.toHaveBeenCalled();
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();
}
it.each([
  {
    kind: 'email' as const,
    mode: 'email',
    initial: 'old@example.test',
    text: ' User+007@EXAMPLE.test ',
  },
  { kind: 'phone' as const, mode: 'tel', initial: '007', text: '+44 (0)20 007' },
  {
    kind: 'url' as const,
    mode: 'url',
    initial: 'https://old.test',
    text: 'HTTPS://EXAMPLE.test/a?x=007#Fragment',
  },
])(
  'selected $kind uses exact String owner and keyboard hint without HTML value sanitation',
  async (row) => {
    const expected = { ...canonical };
    mount(row.kind, row.initial);
    const input = await edit(row.initial, row.text);
    expect(input).toHaveProperty('type', 'text');
    expect(input).toHaveProperty('inputMode', row.mode);
    await submit(input);
    expect(ipc.readSelectedProperty).toHaveBeenCalledWith(vault, path, target, field);
    expect(vi.mocked(ipc.patchSelectedMetadata).mock.calls[0][2]).toMatchObject({
      expectedVersion: expected,
      phase: 'start',
      changes: [{ op: 'set', key: field, value: { kind: 'string', value: row.text } }],
    });
    expect(value).toBe(row.text);
  },
);
it('unknown URL outlives its cell and barrier only resolves original exact String/key/version', async () => {
  const initial = 'https://old.test';
  const text = 'https://new.test/007';
  vi.mocked(ipc.patchSelectedMetadata).mockRejectedValueOnce(new Error('lost original reply'));
  const view = mount('url', initial);
  await submit(await edit(initial, text));
  const first = structuredClone(vi.mocked(ipc.patchSelectedMetadata).mock.calls[0][2]);
  view.unmount();
  await act(async () => {
    await flushOpenPages();
  });
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledTimes(2);
  expect(vi.mocked(ipc.patchSelectedMetadata).mock.calls[1][2]).toEqual({
    ...first,
    phase: 'resolve',
  });
  expect(value).toBe(text);
});
it('native invalid URL refusal keeps exact unsanitized draft and never normalizes/falls back', async () => {
  vi.mocked(ipc.patchSelectedMetadata).mockRejectedValue({
    kind: 'metadata_refused',
    error: {
      code: 'capability_unavailable',
      kind: 'unsupported_projection',
      message: 'Contact must be a URL (https://…).',
      retryable: false,
    },
  });
  mount('url', 'https://old.test');
  const input = await edit('https://old.test', 'example.test/007');
  await submit(input);
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/URL.*draft/i));
  expect(input).toHaveProperty('value', 'example.test/007');
  expect(vi.mocked(ipc.patchSelectedMetadata).mock.calls[0][2].changes).toEqual([
    { op: 'set', key: field, value: { kind: 'string', value: 'example.test/007' } },
  ]);
  expect(value).toBe('https://old.test');
});
it('native readonly Email never opens a scalar or legacy writer', async () => {
  editable = false;
  mount('email', 'old@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'old@example.test' }));
  expect(
    await screen.findByText('This contact property belongs to its governed writer.'),
  ).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(ipc.patchSelectedMetadata).not.toHaveBeenCalled();
  expect(useVaultStore.getState().patchFrontmatter).not.toHaveBeenCalled();
});
it('caller-owned phone draft stays onPatch with its existing behavior', async () => {
  const entry = useVaultStore.getState().entries[0];
  const onPatch = vi.fn();
  render(
    <FieldEditor
      entry={entry}
      def={{ name: field, kind: 'phone' }}
      schema={buildSchema([entry])}
      onPatch={onPatch}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit Contact' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '+44 007' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onPatch).toHaveBeenCalledWith('+44 007');
  expect(ipc.readSelectedProperty).not.toHaveBeenCalled();
  expect(ipc.patchSelectedMetadata).not.toHaveBeenCalled();
});
