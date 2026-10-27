import { afterEach, beforeEach, expect, it } from 'vitest';
import type { PropertyValue } from './generated/workspace';
import * as mock from './mockIpc';
import { seedSelectedWorkspaceForTest, resetSelectedWorkspacesForTest } from './selectedMock';
const vault = '/test-only-selected-carrier';
const workspaceId = '78f2380d-9702-4c12-a356-e7e7a1d9337c';
const recordId = '5e71f4a1-2a42-41bd-a76c-2be6093364de';
beforeEach(() => {
  mock.resetMockFs();
  resetSelectedWorkspacesForTest();
});
afterEach(() => resetSelectedWorkspacesForTest());
function seed(value: PropertyValue) {
  seedSelectedWorkspaceForTest({
    vault,
    workspaceId,
    records: [
      {
        id: recordId,
        path: 'page.md',
        body: '# Canonical body\n',
        metadata: {
          kind: 'object',
          value: { type: { kind: 'string', value: 'Task' }, amount: value },
        },
      },
    ],
  });
}
it('actual selected mock scan keeps huge Decimal exact while declaring only that compatibility key unavailable', async () => {
  const value: PropertyValue = { kind: 'decimal', value: '1e400' };
  seed(value);
  const rows = await mock.scanVault(vault);
  expect(rows[0]).toMatchObject({
    authority: { kind: 'sqlite_metadata', workspaceId, recordId },
    canonicalProperties: {
      value: { kind: 'object', value: { amount: value } },
      unavailableLegacyKeys: ['amount'],
    },
  });
  expect(rows[0].properties).not.toHaveProperty('amount');
  expect(rows[0].properties.type).toBe('Task');
});
it('actual selected mock Date carrier retains its tag alongside native-compatible legacy text', async () => {
  const value: PropertyValue = { kind: 'date', value: '2028-02-29' };
  seed(value);
  const rows = await mock.scanVault(vault);
  expect(rows[0]).toMatchObject({
    canonicalProperties: {
      value: { kind: 'object', value: { amount: value } },
      unavailableLegacyKeys: [],
    },
  });
  expect(rows[0].properties.amount).toBe('2028-02-29');
});
it('selected mock search explicitly refuses before reading a same-path legacy copy', async () => {
  await mock.createNote('/demo-vault', '', 'page', {}, '# Legacy title\nlegacy-only-needle\n');
  seed({ kind: 'string', value: 'canonical text' });
  await expect(mock.searchVault(vault, 'legacy-only-needle')).rejects.toMatchObject({
    code: 'capability_unavailable',
    kind: 'unsupported_operation',
  });
  expect(await mock.readNote(vault, 'page.md')).toBe('# Canonical body\n');
});
