import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RULES from '../../shared/workspace/authority.v2.json';
import { sha256Hex } from './sha256';
import type { PropertyValue } from './generated/workspace';
import {
  projectSelectedValue,
  scanSelectedMock,
  setSelectedFullWidth,
  selectedFixtureForTest,
  seedSelectedWorkspaceForTest,
  resetSelectedWorkspacesForTest,
  setSelectedMarkerForTest,
} from './selectedMock';
import * as mock from './mockIpc';
import * as git from './gitIpc';
import { runAgent, stopAgent, stopAllAgents } from '@/agent/agentIpc';
import { useVaultStore } from '@/stores/vaultStore';

const SELECTED = '/fixture-selected-guards';
const PATH = 'page.md';
async function seed() {
  seedSelectedWorkspaceForTest({
    vault: SELECTED,
    workspaceId: '3ee5b6eb-9f80-4bac-9538-f2a0c5938a62',
    records: [
      {
        id: '4a22406a-07d5-44d8-bc24-b67e61070bea',
        path: PATH,
        body: '# Selected body\r\n',
        metadata: { kind: 'object', value: { type: { kind: 'string', value: 'Note' } } },
      },
    ],
  });
  // This legacy copy proves an unadopted selected door cannot fall through the
  // old global mock files map, even when a matching old path exists there.
  expect(
    await mock.createNote('/demo-vault', '', 'page', { full_width: false }, '# Legacy copy\n'),
  ).toBe(PATH);
}
beforeEach(async () => {
  mock.resetMockFs();
  resetSelectedWorkspacesForTest();
  await seed();
});
afterEach(async () => {
  await stopAllAgents();
  resetSelectedWorkspacesForTest();
});

describe('selected exact browser projection shared cases', () => {
  for (const item of RULES.projectionCases)
    it(item.name, async () => {
      const value = item.source as PropertyValue;
      if ('expected' in item) expect(projectSelectedValue(value)).toEqual(item.expected);
      else
        await expect(
          Promise.resolve().then(() => projectSelectedValue(value)),
        ).rejects.toMatchObject({
          kind: item.refused,
        });
    });
});

it('actual mock source and human metadata/body doors refuse before legacy fallback effects', async () => {
  const before = mock.peekFile(PATH);
  await expect(mock.readNoteSource(SELECTED, PATH)).rejects.toMatchObject({
    kind: 'unsupported_operation',
  });
  await expect(mock.updateFrontmatter(SELECTED, PATH, { full_width: true })).rejects.toMatchObject({
    kind: 'unsupported_operation',
  });
  expect(mock.peekFile(PATH)).toBe(before);
});

it('known selected fixture with removed marker cannot use a legacy write door', async () => {
  const before = mock.peekFile(PATH);
  setSelectedMarkerForTest(SELECTED, 'missing');
  await expect(mock.updateFrontmatter(SELECTED, PATH, { full_width: true })).rejects.toMatchObject({
    kind: 'missing_marker',
  });
  expect(mock.peekFile(PATH)).toBe(before);
});

it('actual body saves refuse before a legacy fallback write', async () => {
  const before = mock.peekFile(PATH);
  await expect(
    mock.saveNoteBody({ vault: SELECTED, path: PATH, body: '# forbidden' }),
  ).rejects.toMatchObject({ kind: 'unsupported_operation' });
  expect(mock.peekFile(PATH)).toBe(before);
});

it('actual Git requests use their requested vault across visible-vault switches', async () => {
  useVaultStore.setState({ vaultPath: '/demo-vault' });
  await expect(git.gitWorkspaceInfo(SELECTED)).rejects.toMatchObject({
    kind: 'unsupported_operation',
  });
  await expect(git.initGitRepo(SELECTED)).rejects.toMatchObject({ kind: 'unsupported_operation' });
  useVaultStore.setState({ vaultPath: SELECTED });
  await expect(git.gitWorkspaceInfo('/demo-vault')).resolves.toBeDefined();
});

it('actual Agent admission and Stop keep the request/run identity across visible-vault switches', async () => {
  useVaultStore.setState({ vaultPath: '/demo-vault' });
  await expect(
    runAgent(SELECTED, { message: 'wait for me', shell: 'off', connectors: false, attended: true }),
  ).rejects.toMatchObject({ kind: 'unsupported_operation' });
  useVaultStore.setState({ vaultPath: SELECTED });
  const legacy = await runAgent('/demo-vault', {
    message: 'wait for me',
    shell: 'off',
    connectors: false,
    attended: true,
  });
  if ('deferred' in legacy || 'settled' in legacy || 'observed_generation' in legacy)
    throw new Error('Attended legacy run unexpectedly withheld.');
  await expect(stopAgent(legacy.run)).resolves.toBeDefined();
});

describe('selected one-key metadata action shared cases', () => {
  for (const [index, item] of RULES.fullWidthCases.entries())
    it(item.name, () => {
      const vault = `/fixture-selected-full-width-${index}`;
      seedSelectedWorkspaceForTest({
        vault,
        workspaceId: '3ee5b6eb-9f80-4bac-9538-f2a0c5938a62',
        records: [
          {
            id: '4a22406a-07d5-44d8-bc24-b67e61070bea',
            path: PATH,
            body: '# Exact body\r\n',
            metadata: item.before as PropertyValue,
          },
        ],
      });
      const before = scanSelectedMock(vault)![0];
      const ack = setSelectedFullWidth(
        vault,
        PATH,
        before.version,
        item.mode as 'wide' | 'default',
      );
      expect(ack.kind === 'applied').toBe(item.changed);
      expect(ack.fullWidth).toBe(item.fullWidth);
      expect(selectedFixtureForTest(vault)?.records[0].metadata).toEqual(item.expected);
      expect(selectedFixtureForTest(vault)?.receipts).toHaveLength(Number(item.changed));
      expect(selectedFixtureForTest(vault)?.records[0].body).toBe(before.body);
    });
});

it('actual selected browser reads and the one-key action refuse a mismatched canonical body pairing', async () => {
  const vault = '/fixture-selected-body-pairing';
  seedSelectedWorkspaceForTest({
    vault,
    workspaceId: '3ee5b6eb-9f80-4bac-9538-f2a0c5938a62',
    records: [
      {
        id: '4a22406a-07d5-44d8-bc24-b67e61070bea',
        path: PATH,
        body: '# Outside body edit\n',
        pairedBodyHash: 'a'.repeat(64),
        metadata: { kind: 'object', value: {} },
      },
    ],
  });
  await expect(mock.scanVault(vault)).rejects.toMatchObject({ kind: 'source_changed' });
  await expect(mock.readNote(vault, PATH)).rejects.toMatchObject({ kind: 'source_changed' });
  await expect(
    Promise.resolve().then(() =>
      setSelectedFullWidth(
        vault,
        PATH,
        {
          kind: 'sqlite_metadata',
          workspaceId: '3ee5b6eb-9f80-4bac-9538-f2a0c5938a62',
          recordId: '4a22406a-07d5-44d8-bc24-b67e61070bea',
          metadataRevision: '1',
          metadataHash: sha256Hex('{"kind":"object","value":{}}'),
          bodyHash: sha256Hex('# Outside body edit\n'),
        },
        'wide',
      ),
    ),
  ).rejects.toMatchObject({ kind: 'source_changed' });
  expect(selectedFixtureForTest(vault)?.receipts).toHaveLength(0);
});
