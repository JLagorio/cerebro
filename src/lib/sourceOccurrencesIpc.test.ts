// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as ipc from './ipc';
import { __seedRunHistoryRegistry, resetMockFs } from './mockIpc';
import { sha256Hex } from './sha256';
import { failNext, resetFaults } from './mockFaults';
import { targetIndexFor } from '@/engine/wikilink';
import type { OccurrenceMode, OccurrencePage } from '@/engine/sourceOccurrences';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const query = (
  vault: string,
  target: string,
  mode: OccurrenceMode,
  cursor?: string | null,
): Promise<OccurrencePage> => {
  const find = Reflect.get(ipc, 'findSourceOccurrences');
  expect(find, 'the human occurrence read uses the existing IPC adapter').toBeTypeOf('function');
  return (
    find as (
      vault: string,
      target: string,
      mode: OccurrenceMode,
      cursor?: string | null,
    ) => Promise<OccurrencePage>
  )(vault, target, mode, cursor);
};
beforeEach(() => {
  resetMockFs();
  resetFaults();
  __seedRunHistoryRegistry({ '/vault': 'vault' });
  invoke.mockReset();
  fs().set('occurrence-target.md', '# Occurrence target');
  fs().set(
    'occurrence-source.md',
    '😀 [[occurrence-target]] and [[occurrence-target#Notes|again]].',
  );
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
it('invokes the literal bounded query command and exact parameter keys', async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockResolvedValueOnce({ status: 'changedSnapshot', reason: 'Changed.' });
  await query('/vault', 'occurrence-target.md', 'linked', 'opaque');
  expect(invoke).toHaveBeenCalledWith('find_source_occurrences', {
    vault: '/vault',
    targetPath: 'occurrence-target.md',
    mode: 'linked',
    cursor: 'opaque',
  });
});
it('the mock preserves same-read full raw hash and repeated original UTF8 occurrences', async () => {
  const raw = fs().get('occurrence-source.md')!;
  const page = await query('/vault', 'occurrence-target.md', 'linked');
  expect(page.status).toBe('ready');
  if (page.status !== 'ready') throw new Error(page.reason);
  const rows = page.rows.filter((row) => row.location.path === 'occurrence-source.md');
  expect(rows).toHaveLength(2);
  expect(rows[0].location).toMatchObject({
    sourceHash: sha256Hex(raw),
    bodyUtf8Range: { start: 5, end: 26 },
  });
  expect(rows[1].targetFragment).toBe('Notes');
});
it('a browser query read fault rejects instead of becoming no mentions', async () => {
  failNext('find_source_occurrences');
  await expect(query('/vault', 'occurrence-target.md', 'mention')).rejects.toThrow(
    'told to fail once',
  );
});
it('an unknown vault never discloses excerpts', async () => {
  await expect(query('/other', 'occurrence-target.md', 'linked')).rejects.toThrow('unavailable');
});

it('the general mock scanner supplies canonical UTF8 path order to the existing target resolver', async () => {
  fs().clear();
  fs().set('😀.md', '# Shared');
  fs().set('\ue000.md', '# Shared');
  const entries = await ipc.scanVault('/vault');
  expect(targetIndexFor(entries).resolveLink('Shared')?.entry.path).toBe('\ue000.md');
});

it('returns a bounded continuation from a dense capped mention body', async () => {
  fs().clear();
  fs().set('target.md', '# A');
  fs().set('source.md', 'A '.repeat(51_200));
  const page = await query('/vault', 'target.md', 'mention');
  expect(page.status).toBe('ready');
  if (page.status !== 'ready') throw new Error(page.reason);
  expect(page.rows).toHaveLength(50);
  expect(page.rows.every((row) => row.location.quote === 'A')).toBe(true);
  expect(page.nextCursor).toEqual(expect.any(String));
  expect(page.truncated).toBe(true);
}, 60_000);
