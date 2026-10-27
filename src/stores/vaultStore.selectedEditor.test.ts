// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetRescans, acceptSelectedEditorVersion, useVaultStore } from './vaultStore';
import { __resetOpenPages, registerSaveParticipant, retainDocumentOwner } from '@/editor/openPages';
import { makeEntry } from '@/test/factories';
import { sha256Hex } from '@/lib/sha256';
import * as ipc from '@/lib/ipc';
import type {
  EditorOperation,
  EditorSaveRequest,
  EditorSaveResult,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';

const vault = '/selected-entry-toy';
const path = 'page.md';
const target = {
  workspaceId: '51d68354-28be-4e1d-b4fd-776c7d49f94e',
  recordId: 'e3592157-40ca-442c-9905-bac1885238b1',
};
const before: SelectedRecordVersion = {
  kind: 'sqlite_metadata',
  ...target,
  metadataRevision: '9007199254740992',
  metadataHash: 'a'.repeat(64),
  bodyHash: sha256Hex('before'),
};
const after: SelectedRecordVersion = {
  ...before,
  metadataRevision: '9007199254740993',
  bodyHash: sha256Hex('after'),
};
const entry = () =>
  makeEntry({
    path,
    authority: before,
    hash: before.bodyHash,
    properties: { full_width: false, code: '007' },
    relationships: { related: ['Keep this exact projection'] },
  });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
/** Descriptive native reply fixture. Real native service/exit86 tests establish
 * the receipt; this test exercises only existing owner/store ordering. */
function operation(request: EditorSaveRequest): EditorOperation {
  return {
    path,
    target,
    requestKey: request.requestKey,
    operationId: '67d4b330-a190-41b2-ab25-6d95ca4e16ab',
    version: after,
    receipt: {
      workspaceId: target.workspaceId,
      recordId: target.recordId,
      epoch: '9007199254740994',
      previousRevision: before.metadataRevision,
      revision: after.metadataRevision,
      metadataBeforeHash: before.metadataHash,
      metadataAfterHash: after.metadataHash,
      bodyBeforeHash: before.bodyHash,
      bodyAfterHash: after.bodyHash,
      actor: 'human',
      operation: 'page.body',
      at: '2026-10-24T00:00:00Z',
    },
  };
}
beforeEach(() => {
  __resetOpenPages();
  __resetRescans();
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    entries: [entry()],
    status: 'ready',
    rescan: async () => undefined,
  });
});
afterEach(() => {
  __resetOpenPages();
  __resetRescans();
  vi.restoreAllMocks();
});

it('selected_verified_body_version_updates_only_hash_and_authority_preserving_metadata_projection', () => {
  const original = useVaultStore.getState().entries[0];
  expect(acceptSelectedEditorVersion(vault, path, target, after)).toBe(true);
  const projected = useVaultStore.getState().entries[0];
  expect(projected.authority).toEqual(after);
  expect(projected.hash).toBe(after.bodyHash);
  expect(projected.properties).toBe(original.properties);
  expect(projected.relationships).toBe(original.relationships);
  expect(projected.title).toBe(original.title);
});

it('selected_late_version_cannot_replace_newer_foreign_or_same_revision_conflicting_entry', () => {
  const newest = { ...after, metadataRevision: '9007199254740994', bodyHash: sha256Hex('newest') };
  useVaultStore.setState({ entries: [{ ...entry(), authority: newest, hash: newest.bodyHash }] });
  const original = useVaultStore.getState().entries;
  expect(acceptSelectedEditorVersion(vault, path, target, after)).toBe(false);
  expect(acceptSelectedEditorVersion('/other-vault', path, target, newest)).toBe(false);
  expect(acceptSelectedEditorVersion(vault, 'other.md', target, newest)).toBe(false);
  expect(
    acceptSelectedEditorVersion(vault, path, { ...target, recordId: 'different' }, newest),
  ).toBe(false);
  expect(
    acceptSelectedEditorVersion(vault, path, target, {
      ...newest,
      bodyHash: sha256Hex('contradiction'),
    }),
  ).toBe(false);
  expect(useVaultStore.getState().entries).toBe(original);
  expect(acceptSelectedEditorVersion(vault, path, target, newest)).toBe(true);
});

it('selected_full_width_waits_for_body_and_uses_verified_post_save_version_while_rescan_is_held', async () => {
  const bodyReply = deferred<EditorSaveResult>();
  const scan = deferred<void>();
  let started: EditorSaveRequest | null = null;
  const rescan = vi.fn(() => scan.promise);
  useVaultStore.setState({ rescan });
  const fullWidth = vi
    .spyOn(ipc, 'setPageFullWidth')
    .mockImplementation(async (_vault, _path, expected) => {
      return {
        kind: 'applied',
        fullWidth: true,
        version: { ...expected, metadataRevision: '9007199254740994' },
      };
    });
  const owner = retainDocumentOwner(
    { vaultId: vault, path, ownerId: 'pane' },
    'before',
    async (_body, _format, _bypass, _hash, _destination, request) => {
      expect(request).toBeDefined();
      if (!request) throw new Error('missing selected request');
      started = request;
      const reply = await bodyReply.promise;
      if (reply.kind === 'selected_applied')
        acceptSelectedEditorVersion(vault, path, target, reply.currentVersion);
      else if (reply.kind === 'selected_unchanged')
        acceptSelectedEditorVersion(vault, path, target, reply.version);
      // Same ordering required at NoteBodyEditor's existing callback: its
      // verified projection is synchronous; rescan remains an observer.
      void useVaultStore.getState().rescan();
      return reply;
    },
    target,
  );
  const unmount = registerSaveParticipant({
    key: owner.key,
    identity: owner,
    prepare: () => undefined,
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  owner.edit('after', 'source');
  const change = useVaultStore.getState().patchFrontmatter(path, { full_width: true });
  try {
    // One bounded event turn lets either the real flush or the old early
    // metadata call run; no indefinite wait can hide which path was reached.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fullWidth).not.toHaveBeenCalled();
    expect(started).not.toBeNull();
    if (started === null) throw new Error('Full width never reached the real body owner');
    bodyReply.resolve({
      kind: 'selected_applied',
      operation: operation(started),
      currentVersion: after,
      reconcileRequired: false,
      recovery: null,
    });
    await vi.waitFor(() => expect(fullWidth).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(fullWidth.mock.calls[0][2]).toEqual(after);
    expect(owner.snapshot().acknowledgedGeneration).toBe(1);
    expect(rescan).toHaveBeenCalled();
    expect(useVaultStore.getState().entries[0].hash).toBe(after.bodyHash);
  } finally {
    // Also settle the fixture callback if an earlier assertion failed. This
    // cleanup cannot change the test's recorded failure or start a new write.
    bodyReply.resolve({ kind: 'selected_unchanged', version: after });
    scan.resolve();
    await change;
    unmount();
  }
});

it('selected_full_width_refuses_an_unresolved_body_before_its_metadata_ipc', async () => {
  const fullWidth = vi
    .spyOn(ipc, 'setPageFullWidth')
    .mockResolvedValue({ kind: 'unchanged', fullWidth: false, version: before });
  const owner = retainDocumentOwner(
    { vaultId: vault, path, ownerId: 'pane' },
    'before',
    async (_body, _format, _bypass, _hash, _destination, request) => {
      expect(request).toBeDefined();
      if (!request) throw new Error('missing request');
      return {
        kind: 'selected_pending',
        operation: operation(request),
        error: {
          code: 'capability_unavailable',
          kind: 'recovery_required',
          message: 'Recovery needed.',
          retryable: true,
        },
      };
    },
    target,
  );
  const unmount = registerSaveParticipant({
    key: owner.key,
    identity: owner,
    prepare: () => undefined,
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  owner.edit('after');
  try {
    expect(await useVaultStore.getState().patchFrontmatter(path, { full_width: true })).toBe(false);
    expect(fullWidth).not.toHaveBeenCalled();
    expect(owner.snapshot().acknowledgedGeneration).toBe(0);
  } finally {
    unmount();
  }
});

it('selected_body_projection_refuses_newer_metadata_hash_until_the_actual_metadata_reread', () => {
  const original = useVaultStore.getState().entries;
  const newerMetadata = { ...after, metadataHash: 'b'.repeat(64) };
  expect(acceptSelectedEditorVersion(vault, path, target, newerMetadata)).toBe(false);
  expect(useVaultStore.getState().entries).toBe(original);
  expect(useVaultStore.getState().entries[0].properties).toEqual({
    full_width: false,
    code: '007',
  });
  expect(useVaultStore.getState().entries[0].authority).toEqual(before);
});

// M99 observation/ack separation: version-only acceptance cannot claim it read
// canonical bytes, nor leave a presentation coherence flag tied to an old pair.
it.each([
  { label: 'independently_observed_C', observed: 'outside C', coherence: 'external_change' },
  { label: 'matching_observed_B', observed: 'after', coherence: 'paired' },
] as const)(
  'selected_external_observation_version_acceptance_$label keeps_observed_bytes_truthful',
  ({ observed, coherence }) => {
    const hash = sha256Hex(observed);
    useVaultStore.setState({
      entries: [
        {
          ...entry(),
          hash,
          bodyObservation: { coherence: 'external_change', observedBodyHash: hash },
        },
      ],
    });
    const original = useVaultStore.getState().entries[0];
    expect(acceptSelectedEditorVersion(vault, path, target, after)).toBe(true);
    const projected = useVaultStore.getState().entries[0];
    expect(projected.authority).toEqual(after);
    expect(projected.hash).toBe(hash);
    expect(projected.bodyObservation).toEqual({ coherence, observedBodyHash: hash });
    expect(projected.properties).toBe(original.properties);
    expect(projected.relationships).toBe(original.relationships);
    expect(projected.title).toBe(original.title);
  },
);

it('selected_external_observation_metadata_revision_acceptance_cannot_replace_observed_hash_with_canonical_A', () => {
  const hash = sha256Hex('outside B');
  const observation = { coherence: 'external_change' as const, observedBodyHash: hash };
  useVaultStore.setState({ entries: [{ ...entry(), hash, bodyObservation: observation }] });
  const metadataVersion = { ...before, metadataRevision: after.metadataRevision };
  expect(acceptSelectedEditorVersion(vault, path, target, metadataVersion)).toBe(true);
  const projected = useVaultStore.getState().entries[0];
  expect(projected.authority).toEqual(metadataVersion);
  expect(projected.hash).toBe(hash);
  expect(projected.bodyObservation).toEqual(observation);
});

it('selected_external_observation_rejected_version_does_not_touch_independent_observation_or_metadata', () => {
  const hash = sha256Hex('outside C');
  useVaultStore.setState({
    entries: [
      {
        ...entry(),
        hash,
        bodyObservation: { coherence: 'external_change', observedBodyHash: hash },
      },
    ],
  });
  const original = useVaultStore.getState().entries;
  expect(
    acceptSelectedEditorVersion(vault, path, target, { ...after, metadataHash: 'b'.repeat(64) }),
  ).toBe(false);
  expect(
    acceptSelectedEditorVersion(vault, path, { ...target, recordId: 'replaced-record' }, after),
  ).toBe(false);
  expect(acceptSelectedEditorVersion('/another-opening', path, target, after)).toBe(false);
  expect(useVaultStore.getState().entries).toBe(original);
});
