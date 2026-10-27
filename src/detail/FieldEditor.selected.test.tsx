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
import { makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { __resetRescans, useVaultStore } from '@/stores/vaultStore';
import { __resetOpenPages, flushOpenPages } from '@/editor/openPages';
import { SelectedMetadataRecoveryHost } from '@/editor/SelectedMetadataRecoveryHost';
import { FieldEditor } from './FieldEditor';
const path = 'records/page.md';
const field = 'code';
const target = {
  workspaceId: '915781f1-6812-478c-8063-3f41322547f5',
  recordId: '76b64da5-34b6-45f2-8ab2-e2779227ace3',
};
let vault = '';
let serial = 0;
let canonical: SelectedRecordVersion;
let value = 'before';
let editable = true;
let coherence: 'paired' | 'external_change' = 'paired';
const frame = (): SelectedPropertySnapshot => ({
  path,
  target: { ...target },
  field,
  version: { ...canonical },
  value: { kind: 'present', value: { kind: 'string', value } },
  editable,
  readOnlyReason: editable ? null : 'This field belongs to its governed writer.',
  coherence,
  observedBodyHash: coherence === 'paired' ? canonical.bodyHash : 'f'.repeat(64),
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
const unknown = (): MetadataPatchResult => ({
  kind: 'outcome_unknown',
  requestKey: 'unused',
  error: {
    code: 'capability_unavailable',
    kind: 'metadata_unavailable',
    message: 'Original outcome is unknown.',
    retryable: false,
  },
});
beforeEach(() => {
  cleanup();
  __resetOpenPages();
  __resetRescans();
  vi.restoreAllMocks();
  vault = '/selected-property-' + ++serial;
  value = 'before';
  editable = true;
  coherence = 'paired';
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
        title: 'Page',
        type: 'Task',
        hash: canonical.bodyHash,
        authority: { ...canonical },
        properties: { code: 'before', unrelated: 'keep' },
        canonicalProperties: {
          value: {
            kind: 'object',
            value: {
              type: { kind: 'string', value: 'Task' },
              code: { kind: 'string', value: 'before' },
              unrelated: { kind: 'string', value: 'keep' },
            },
          },
          unavailableLegacyKeys: [],
        },
        relationships: { related: ['keep'] },
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
function mount() {
  const entry = useVaultStore.getState().entries[0];
  return render(
    <>
      <FieldEditor
        entry={entry}
        def={{ name: field, kind: 'text' }}
        schema={buildSchema([entry])}
      />
      <SelectedMetadataRecoveryHost />
    </>,
  );
}
async function edit(text = '007') {
  fireEvent.click(screen.getByRole('button', { name: 'before' }));
  const input = await screen.findByRole('textbox', { name: 'Code' });
  fireEvent.change(input, { target: { value: text } });
  return input;
}
async function submit(input: HTMLElement) {
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(
      vi.mocked(ipc.patchSelectedMetadata).mock.calls.length +
        vi.mocked(useVaultStore.getState().patchFrontmatter).mock.calls.length,
    ).toBeGreaterThan(0),
  );
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce();
  expect(useVaultStore.getState().patchFrontmatter).not.toHaveBeenCalled();
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();
}
it('ordinary selected text cell reads guarded requested field and sends literal tagged metadata CAS only', async () => {
  const expected = { ...canonical };
  mount();
  await submit(await edit(' 007 '));
  expect(ipc.readSelectedProperty).toHaveBeenCalledWith(vault, path, target, field);
  expect(vi.mocked(ipc.patchSelectedMetadata).mock.calls[0]).toMatchObject([
    vault,
    path,
    {
      target,
      expectedVersion: expected,
      phase: 'start',
      changes: [{ op: 'set', key: field, value: { kind: 'string', value: ' 007 ' } }],
    },
  ]);
  expect(useVaultStore.getState().entries[0].properties.unrelated).toBe('keep');
  expect(useVaultStore.getState().entries[0].relationships).toEqual({ related: ['keep'] });
});
it('metadata-only interleave refuses the captured complete version and keeps authored text', async () => {
  mount();
  const input = await edit();
  const expected = { ...canonical };
  canonical = { ...canonical, metadataRevision: '9007199254740994', metadataHash: 'd'.repeat(64) };
  vi.mocked(ipc.patchSelectedMetadata).mockRejectedValue({
    kind: 'metadata_refused',
    error: {
      code: 'capability_unavailable',
      kind: 'stale_metadata',
      message: 'Canonical metadata changed.',
      retryable: false,
    },
  });
  await submit(input);
  expect(vi.mocked(ipc.patchSelectedMetadata).mock.calls[0][2].expectedVersion).toEqual(expected);
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveProperty('value', '007'),
  );
  expect(screen.getByRole('status').textContent).toMatch(/draft|changed/i);
});
it('unpaired external body never opens a selected inline writer or falls back to YAML', async () => {
  coherence = 'external_change';
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'before' }));
  await waitFor(() => expect(ipc.readSelectedProperty).toHaveBeenCalledOnce());
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('status').textContent).toMatch(/body|changed|paired/i);
  expect(ipc.patchSelectedMetadata).not.toHaveBeenCalled();
  expect(useVaultStore.getState().patchFrontmatter).not.toHaveBeenCalled();
});
it('readonly native decision remains visible without entering legacy scalar input', async () => {
  editable = false;
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'before' }));
  await waitFor(() => expect(ipc.readSelectedProperty).toHaveBeenCalledOnce());
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText('This field belongs to its governed writer.')).toBeTruthy();
  expect(useVaultStore.getState().patchFrontmatter).not.toHaveBeenCalled();
});
it('unknown original survives cell unmount and vault switch; mounted recovery checks original request', async () => {
  vi.mocked(ipc.patchSelectedMetadata).mockRejectedValueOnce(new Error('reply lost'));
  const view = mount();
  await submit(await edit());
  const first = vi.mocked(ipc.patchSelectedMetadata).mock.calls[0];
  view.unmount();
  act(() =>
    useVaultStore.setState({
      vaultPath: '/replacement-vault',
      entriesVault: '/replacement-vault',
      entries: [],
    }),
  );
  render(<SelectedMetadataRecoveryHost />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check save' }));
  await waitFor(() => expect(ipc.patchSelectedMetadata).toHaveBeenCalledTimes(2));
  expect(vi.mocked(ipc.patchSelectedMetadata).mock.calls[1]).toMatchObject([
    first[0],
    first[1],
    { ...first[2], phase: 'resolve' },
  ]);
  await act(async () => {
    await flushOpenPages();
  });
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledTimes(2);
});
it('Use current after terminal unknown never replays old field at the next barrier', async () => {
  vi.mocked(ipc.patchSelectedMetadata).mockImplementationOnce(async (_vault, _path, q) => {
    canonical = {
      ...canonical,
      metadataRevision: '9007199254740994',
      metadataHash: 'c'.repeat(64),
    };
    value = 'current';
    return { ...unknown(), requestKey: q.requestKey };
  });
  const view = mount();
  await submit(await edit());
  view.unmount();
  render(<SelectedMetadataRecoveryHost />);
  fireEvent.click(await screen.findByRole('button', { name: 'Compare versions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use current' }));
  await act(async () => {
    await flushOpenPages();
  });
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce();
  expect(value).toBe('current');
});
it('Keep mine requires a stable second guarded observation and uses a fresh request key', async () => {
  vi.mocked(ipc.patchSelectedMetadata).mockImplementationOnce(async (_vault, _path, q) => {
    canonical = {
      ...canonical,
      metadataRevision: '9007199254740994',
      metadataHash: 'd'.repeat(64),
    };
    value = 'current';
    return { ...unknown(), requestKey: q.requestKey };
  });
  const view = mount();
  await submit(await edit());
  const first = vi.mocked(ipc.patchSelectedMetadata).mock.calls[0][2];
  view.unmount();
  render(<SelectedMetadataRecoveryHost />);
  fireEvent.click(await screen.findByRole('button', { name: 'Compare versions' }));
  const expected = { ...canonical };
  fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
  await waitFor(() => expect(ipc.patchSelectedMetadata).toHaveBeenCalledTimes(2));
  const next = vi.mocked(ipc.patchSelectedMetadata).mock.calls[1][2];
  expect(next.requestKey).not.toBe(first.requestKey);
  expect(next.expectedVersion).toEqual(expected);
  expect(next.changes).toEqual(first.changes);
  expect(value).toBe('007');
});
it('a known native ACK survives presentation refresh failure without resending the mutation', async () => {
  useVaultStore.setState({
    rescan: vi.fn(async () => {
      throw new Error('presentation unavailable');
    }),
  });
  mount();
  await submit(await edit());
  await act(async () => {
    await flushOpenPages();
  });
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce();
  expect(value).toBe('007');
});
it('selected cell owns input clicks and composing Enter without accidental save or grid movement', async () => {
  const click = vi.fn();
  const key = vi.fn();
  const entry = useVaultStore.getState().entries[0];
  render(
    <div role="grid" aria-label="Records" onClick={click} onKeyDown={key}>
      <FieldEditor
        entry={entry}
        def={{ name: field, kind: 'text' }}
        schema={buildSchema([entry])}
      />
    </div>,
  );
  const input = await edit();
  click.mockClear();
  key.mockClear();
  fireEvent.click(input);
  expect(click).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(ipc.patchSelectedMetadata).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce());
});
it('caller-owned onPatch draft stays local even when its display entry has selected authority', async () => {
  const onPatch = vi.fn();
  const entry = useVaultStore.getState().entries[0];
  render(
    <FieldEditor
      entry={entry}
      def={{ name: field, kind: 'text' }}
      schema={buildSchema([entry])}
      onPatch={onPatch}
    />,
  );
  const input = await edit();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onPatch).toHaveBeenCalledWith('007');
  expect(ipc.readSelectedProperty).not.toHaveBeenCalled();
  expect(ipc.patchSelectedMetadata).not.toHaveBeenCalled();
});

it('inline Use current readonly closes the original editable presentation before another edit', async () => {
  vi.mocked(ipc.patchSelectedMetadata).mockImplementationOnce(async (_vault, _path, q) => {
    editable = false;
    value = 'current';
    canonical = {
      ...canonical,
      metadataRevision: '9007199254740994',
      metadataHash: 'd'.repeat(64),
    };
    return {
      kind: 'outcome_unknown',
      requestKey: q.requestKey,
      error: {
        code: 'capability_unavailable',
        kind: 'metadata_unavailable',
        message: 'Original result unknown.',
        retryable: false,
      },
    };
  });
  mount();
  await submit(await edit());
  fireEvent.click(await screen.findByRole('button', { name: 'Compare versions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use current' }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Code' })).toBeNull());
  await act(async () => {
    await flushOpenPages();
  });
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'before' }));
  expect(await screen.findByText('This field belongs to its governed writer.')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(ipc.patchSelectedMetadata).toHaveBeenCalledOnce();
});
