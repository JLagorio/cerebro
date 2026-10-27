// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetMockFs, saveNoteBody } from './mockIpc';
import { sha256Hex } from './sha256';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(resetMockFs);
afterEach(() => vi.restoreAllMocks());
it('acknowledges the exact ordinary file bytes', async () => {
  fs().set('notes/a.md', '# Before\n');
  expect(
    await saveNoteBody({ vault: '/demo-vault', path: 'notes/a.md', body: '# After\n' }),
  ).toEqual({ kind: 'file', contentHash: sha256Hex('# After\n'), recovery: { kind: 'off' } });
  expect(fs().get('notes/a.md')).toBe('# After\n');
});
it('refuses a governed projection whose materialization cannot be confirmed', async () => {
  fs().set('knowledge/ack.md', '# Before\n');
  const original = fs().set.bind(fs());
  vi.spyOn(fs(), 'set').mockImplementation((path, text) =>
    original(path, path === 'knowledge/ack.md' ? 'outside bytes' : text),
  );
  await expect(
    saveNoteBody({ vault: '/demo-vault', path: 'knowledge/ack.md', body: '# After\n' }),
  ).rejects.toThrow('projection_confirmation_failed');
});
it('returns a confirmed governed identity and preserves legacy refusal boundaries', async () => {
  fs().set('knowledge/ack.md', '# Before\n');
  expect(
    await saveNoteBody({ vault: '/demo-vault', path: 'knowledge/ack.md', body: '# After\n' }),
  ).toEqual({ kind: 'governed', projectionHash: sha256Hex('# After\n') });
  for (const path of ['../a.md', 'notes/missing.md']) {
    await expect(
      saveNoteBody({ vault: '/demo-vault', path, body: 'must not create' }),
    ).rejects.toThrow();
    expect(fs().has(path)).toBe(false);
  }
});
it('refuses governed source saves explicitly before writing', async () => {
  fs().set('knowledge/a.md', '# Before\n');
  await expect(
    saveNoteBody({
      vault: '/demo-vault',
      path: 'knowledge/a.md',
      body: 'source',
      bodyFormat: 'source',
    }),
  ).rejects.toThrow('governed_source_unavailable');
  expect(fs().get('knowledge/a.md')).toBe('# Before\n');
});
it('refuses an unknown body format without falling back to rich normalization', async () => {
  fs().set('notes/a.md', '\ufeff# Before\r\n');
  await expect(
    saveNoteBody({
      vault: '/demo-vault',
      path: 'notes/a.md',
      body: 'new',
      bodyFormat: 'unknown' as 'source',
    }),
  ).rejects.toThrow('unsupported_body_format');
  expect(fs().get('notes/a.md')).toBe('\ufeff# Before\r\n');
});
