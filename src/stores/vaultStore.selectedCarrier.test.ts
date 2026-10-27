// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { SelectedEntryProperties, SelectedRecordVersion } from '@/lib/generated/workspace';
import { makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { __resetOpenPages } from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import { __resetRescans, useVaultStore } from './vaultStore';
const realRescan = useVaultStore.getState().rescan;
afterEach(() => {
  __resetOpenPages();
  __resetRescans();
  vi.restoreAllMocks();
});
it('a known Full width ACK never pairs a changed metadata hash with the prior canonical carrier when rescan is unavailable', async () => {
  __resetOpenPages();
  __resetRescans();
  const vault = '/test-only-selected-width-carrier';
  const before: SelectedRecordVersion = {
    kind: 'sqlite_metadata',
    workspaceId: 'workspace',
    recordId: 'record',
    metadataRevision: '1',
    metadataHash: 'a'.repeat(64),
    bodyHash: 'b'.repeat(64),
  };
  const after: SelectedRecordVersion = {
    ...before,
    metadataRevision: '2',
    metadataHash: 'c'.repeat(64),
  };
  const carrier: SelectedEntryProperties = {
    value: {
      kind: 'object',
      value: {
        full_width: { kind: 'boolean', value: false },
        amount: { kind: 'decimal', value: '1e400' },
      },
    },
    unavailableLegacyKeys: ['amount'],
  };
  const entry = Object.assign(
    makeEntry({
      path: 'page.md',
      authority: before,
      hash: before.bodyHash,
      properties: { full_width: false },
    }),
    { canonicalProperties: carrier },
  );
  useVaultStore.setState({
    vaultPath: vault,
    entriesVault: vault,
    entries: [entry],
    status: 'ready',
    error: null,
    views: [],
    collections: [],
    folders: [],
    scanObservation: null,
    rescan: realRescan,
  });
  const write = vi
    .spyOn(ipc, 'setPageFullWidth')
    .mockResolvedValue({ kind: 'applied', version: after, fullWidth: true });
  vi.spyOn(ipc, 'scanVault').mockRejectedValue(
    new Error('explicit unavailable descriptive rescan after known native width ACK'),
  );
  expect(await useVaultStore.getState().patchFrontmatter('page.md', { full_width: true })).toBe(
    true,
  );
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith(vault, 'page.md', before, 'wide');
  expect(useVaultStore.getState().scanObservation?.outcome).toBe('unavailable');
  const current = useVaultStore.getState().entries[0];
  expect(current.authority).toEqual(after);
  expect(current.properties.full_width).toBe(true);
  if (current.canonicalProperties) {
    expect(current.canonicalProperties.value).toMatchObject({
      kind: 'object',
      value: { full_width: { kind: 'boolean', value: true } },
    });
  } else {
    expect(buildSchema([current]).resolveField(current, 'amount')).toMatchObject({
      unavailableReason: expect.any(String),
    });
  }
  expect(write).toHaveBeenCalledOnce();
});
