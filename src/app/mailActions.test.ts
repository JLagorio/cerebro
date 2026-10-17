import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { __seedConnectorStatus, __seedMailGate, resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUndoStore } from '@/stores/undoStore';
import { addSweepAgent, pruneDigests } from './mailActions';
import { pruneCandidates } from '@/engine/mailSweep';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(async () => {
  resetMockFs();
  __seedMailGate({ state: 'open', kinds: ['thread', 'thread_text'] });
  __seedConnectorStatus([
    {
      connector: 'gmail',
      cli_name: 'gmail',
      refused: null,
      state: 'working',
      signal: null,
      seen_at: null,
      run_id: null,
    },
  ]);
  await useVaultStore.getState().openVault('/demo-vault');
});
afterEach(() => vi.restoreAllMocks());
it('adds the paused record once and opens its page, or opens the existing record', async () => {
  const navigate = vi.spyOn(useNavStore.getState(), 'navigate');
  const create = vi.spyOn(useVaultStore.getState(), 'createItem');
  expect(await addSweepAgent('gmail')).toBe('records/agents/mail-sweep.md');
  expect(create).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenLastCalledWith({ kind: 'doc', path: 'records/agents/mail-sweep.md' });
  expect(fs().get('records/agents/mail-sweep.md')).toContain('paused: true');
  await addSweepAgent('gmail');
  expect(create).toHaveBeenCalledOnce();
});
it('a closed gate or failed status writes nothing and never throws', async () => {
  __seedMailGate({ state: 'closed', kinds: ['thread'] });
  expect(await addSweepAgent('gmail')).toBeNull();
  __seedMailGate({ state: 'open', kinds: ['thread'] });
  __seedConnectorStatus('fail');
  expect(await addSweepAgent('gmail')).toBeNull();
  expect(fs().has('records/agents/mail-sweep.md')).toBe(false);
});
it('a vault switch retires an add while its gate is being read', async () => {
  let release!: (value: ipc.MailGateRead) => void;
  vi.spyOn(ipc, 'mailGateRead').mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const action = addSweepAgent('gmail');
  useVaultStore.setState({ vaultPath: '/other' });
  useVaultStore.setState({ vaultPath: '/demo-vault' });
  release({ state: 'open', kinds: ['thread'] });
  expect(await action).toBeNull();
  expect(fs().has('records/agents/mail-sweep.md')).toBe(false);
});
it('removes a preview in one undoable batch and restores identical bytes', async () => {
  const bytes = {
    'sources/mail/a.md':
      '---\nsource_kind: thread\nsource_id: a\nlast_message_at: 2026-01-01T00:00:00Z\n---\n# A\n',
    'sources/mail/a-text.md': '---\nsource_kind: thread_text\nsource_id: a\n---\n# Private text\n',
  };
  for (const [path, body] of Object.entries(bytes)) fs().set(path, body);
  await useVaultStore.getState().rescan();
  const plan = pruneCandidates(useVaultStore.getState().entries, '2026-04-01');
  const apply = vi.spyOn(useVaultStore.getState(), 'applyBatch');
  expect(await pruneDigests(plan, '/demo-vault')).toBe(true);
  expect(apply).toHaveBeenCalledExactlyOnceWith(plan.ops, { undo: 'Removed 1 mail digest' });
  for (const path of Object.keys(bytes)) expect(fs().has(path)).toBe(false);
  await useUndoStore.getState().undo();
  for (const [path, body] of Object.entries(bytes)) expect(fs().get(path)).toBe(body);
});
it('a stale preview and a foreign vault both refuse without deleting newer bytes', async () => {
  fs().set(
    'sources/mail/a.md',
    '---\nsource_kind: thread\nlast_message_at: 2026-01-01T00:00:00Z\n---\n# Old\n',
  );
  await useVaultStore.getState().rescan();
  const plan = pruneCandidates(useVaultStore.getState().entries, '2026-04-01');
  fs().set('sources/mail/a.md', '# Changed since preview\n');
  expect(await pruneDigests(plan, '/other')).toBe(false);
  expect(await pruneDigests(plan, '/demo-vault')).toBe(false);
  expect(fs().get('sources/mail/a.md')).toBe('# Changed since preview\n');
});
it('retention is called only by its human Settings control', () => {
  const source = readFileSync('src/app/MailSettings.tsx', 'utf8');
  expect(source).toContain('pruneDigests(plan, vault)');
  expect(readFileSync('src/engine/mailSweep.ts', 'utf8')).not.toContain('pruneDigests');
});
