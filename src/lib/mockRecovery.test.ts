// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as mock from './mockIpc';

beforeEach(() => mock.resetMockFs());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('ordinary saves report recovery off without inventing a copy', async () => {
  await mock.createNote('v', '', 'recovery', {}, 'before');
  const ack = await mock.saveNoteBody({ vault: 'v', path: 'recovery.md', body: 'after' });
  expect(ack).toMatchObject({ kind: 'file', recovery: { kind: 'off' } });
  expect(mock.peekFile('recovery.md')).toBe('after');
});

import { MockRecovery, recoveryLimits, type RecoveryRow } from './mockRecovery';
import { sha256Hex } from './sha256';
it('opt-in retains exact preimage including source prefix and reports global usage', () => {
  const journal = new MockRecovery();
  const raw = '\uFEFF---\r\ntitle: Exact\r\n--- \r\n\r\nold\r\n';
  journal.setEnabled('v', true);
  expect(journal.capture('v', 'a.md', raw, 'new')).toMatchObject({ kind: 'retained' });
  expect(journal.list('v', 'a.md')).toMatchObject([
    {
      beforeHash: sha256Hex(raw),
      afterHash: sha256Hex('new'),
      attribution: 'outside, unattributed',
    },
  ]);
  expect(journal.status('other')).toMatchObject({
    enabled: false,
    entries: 1,
    retainedBytes: new TextEncoder().encode(raw).length,
  });
});
it('storage failure blocks the save and an exact one-use permit cannot authorize another draft', () => {
  class Broken extends Map<string, RecoveryRow> {
    override set(): this {
      throw new Error('full');
    }
  }
  const journal = new MockRecovery(new Broken());
  journal.setEnabled('v', true);
  let code = '';
  try {
    journal.capture('v', 'a.md', 'before', 'after');
  } catch (e) {
    code = (e as Error).message;
  }
  expect(code).toMatch(/^recovery_required:/);
  const nonce = code.slice('recovery_required:'.length);
  expect(() => journal.capture('v', 'a.md', 'before', 'newer', nonce)).toThrow();
  expect(() => journal.capture('v', 'a.md', 'before', 'after')).toThrow(/^recovery_required:/);
});
it('privacy and entry limits produce honest no-copy outcomes', () => {
  const journal = new MockRecovery();
  journal.setEnabled('v', true);
  expect(journal.capture('v', 'sources/mail/inbox/a.md', 'private', 'new')).toEqual({
    kind: 'not_retained',
    reason: 'privacy',
  });
  expect(journal.capture('v', 'a.md', 'x'.repeat(recoveryLimits.entryBytes + 1), 'new')).toEqual({
    kind: 'not_retained',
    reason: 'entry_limit',
  });
  expect(journal.status('v').entries).toBe(0);
});

import { mockRecovery } from './mockRecovery';
it('the existing body writer captures before replacing', async () => {
  await mock.createNote('v', '', 'recovery', {}, 'before');
  mockRecovery.setEnabled('v', true);
  const first = await mock.saveNoteBody({ vault: 'v', path: 'recovery.md', body: 'after' });
  expect(first).toMatchObject({ recovery: { kind: 'retained' } });
  const rows = mockRecovery.list('v', 'recovery.md');
  expect(mockRecovery.read('v', 'recovery.md', rows[0].id)).toBe('before');
});

it('source saves preserve the exact prefix and restore checks current hash and missing target', async () => {
  await mock.createNote('v', '', 'recovery', {}, 'before');
  const raw = '\uFEFF---\r\ntitle: Exact\r\n--- \r\n\r\nold\r\n';
  mock.restoreFile('recovery.md', raw);
  mockRecovery.setEnabled('v', true);
  await mock.saveNoteBody({
    vault: 'v',
    path: 'recovery.md',
    body: '\r\nnew\r\n',
    bodyFormat: 'source',
  });
  const saved = mock.peekFile('recovery.md')!;
  expect(saved).toBe('\uFEFF---\r\ntitle: Exact\r\n--- \r\n\r\nnew\r\n');
  const row = mockRecovery.list('v', 'recovery.md')[0];
  expect(mockRecovery.read('v', 'recovery.md', row.id)).toBe(raw);
  await expect(
    mock.restoreRecovery('v', 'recovery.md', row.id, sha256Hex('wrong')),
  ).rejects.toThrow('stale_content');
  expect(mock.peekFile('recovery.md')).toBe(saved);
  await mock.restoreRecovery('v', 'recovery.md', row.id, sha256Hex(saved));
  expect(mock.peekFile('recovery.md')).toBe(raw);
  await mock.deleteNote('v', 'recovery.md');
  await expect(mock.restoreRecovery('v', 'recovery.md', row.id, sha256Hex(raw))).rejects.toThrow();
  expect(mock.peekFile('recovery.md')).toBeNull();
});
it('a capture failure leaves the existing file unchanged', async () => {
  await mock.createNote('v', '', 'recovery', {}, 'before');
  const capture = vi.spyOn(mockRecovery, 'capture').mockImplementation(() => {
    throw new Error('recovery_required:failure');
  });
  await expect(
    mock.saveNoteBody({ vault: 'v', path: 'recovery.md', body: 'after' }),
  ).rejects.toThrow('recovery_required:failure');
  expect(mock.peekFile('recovery.md')).toBe('before');
  capture.mockRestore();
});
it('a valid bypass is one use and does not disable protection', () => {
  class Broken extends Map<string, RecoveryRow> {
    override set(): this {
      throw new Error('full');
    }
  }
  const journal = new MockRecovery(new Broken());
  journal.setEnabled('v', true);
  let nonce = '';
  try {
    journal.capture('v', 'a.md', 'before', 'after');
  } catch (e) {
    nonce = (e as Error).message.split(':')[1];
  }
  expect(journal.failure('v', 'a.md', nonce).expiresAt).toBeGreaterThan(Date.now() / 1000);
  expect(journal.capture('v', 'a.md', 'before', 'after', nonce)).toEqual({ kind: 'without_copy' });
  expect(() => journal.capture('v', 'a.md', 'before', 'after', nonce)).toThrow(
    'recovery_bypass_invalid',
  );
  expect(journal.status('v').enabled).toBe(true);
});
it('finished copies expire globally while pending copies still require an explicit capacity choice', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  const rows = new Map<string, RecoveryRow>();
  const journal = new MockRecovery(rows);
  journal.setEnabled('v', true);
  journal.capture('v', 'a.md', 'before', 'after');
  vi.advanceTimersByTime((recoveryLimits.retentionSeconds + 1) * 1000);
  expect(journal.status('inactive').entries).toBe(0);
  rows.set('pending', {
    id: 'pending',
    vault: 'other',
    path: 'a.md',
    raw: 'pending',
    beforeHash: 'old',
    afterHash: 'new',
    capturedAt: Date.now() / 1000 - recoveryLimits.retentionSeconds - 1,
    bytes: recoveryLimits.globalBytes,
    state: 'pending',
    attribution: 'outside, unattributed',
  });
  expect(() => journal.capture('v', 'a.md', 'before', 'after')).toThrow(/^recovery_required:/);
  let nonce = '';
  try {
    journal.capture('v', 'a.md', 'before', 'after');
  } catch (e) {
    nonce = (e as Error).message.split(':')[1];
  }
  expect(journal.failure('v', 'a.md', nonce).reason).toBe('pending_capacity');
  expect(journal.status('v').pending).toBe(1);
  vi.useRealTimers();
});
it('capacity evicts the oldest finished copy and reports the count', () => {
  const rows = new Map<string, RecoveryRow>();
  rows.set('old', {
    id: 'old',
    vault: 'other',
    path: 'a.md',
    raw: 'old',
    beforeHash: sha256Hex('old'),
    afterHash: 'b',
    capturedAt: Math.floor(Date.now() / 1000),
    bytes: recoveryLimits.globalBytes,
    state: 'committed',
    attribution: 'outside, unattributed',
  });
  const journal = new MockRecovery(rows);
  journal.setEnabled('v', true);
  expect(journal.capture('v', 'a.md', 'new preimage', 'new')).toMatchObject({
    kind: 'retained',
    evicted: 1,
  });
  expect(journal.list('other', 'a.md')).toEqual([]);
});
it('disabled vault settings remain bounded', () => {
  const journal = new MockRecovery();
  for (let i = 0; i < recoveryLimits.maxVaults; i++) journal.setEnabled(String(i), false);
  expect(() => journal.setEnabled('overflow', true)).toThrow();
});
it('storage failure during capacity admission preserves existing finished copies', () => {
  class FailingStore extends Map<string, RecoveryRow> {
    fail = false;
    override set(key: string, value: RecoveryRow): this {
      if (this.fail) throw new Error('full');
      return super.set(key, value);
    }
  }
  const rows = new FailingStore();
  rows.set('old', {
    id: 'old',
    vault: 'other',
    path: 'a.md',
    raw: 'old',
    beforeHash: sha256Hex('old'),
    afterHash: 'b',
    capturedAt: Math.floor(Date.now() / 1000),
    bytes: recoveryLimits.globalBytes,
    state: 'committed',
    attribution: 'outside, unattributed',
  });
  rows.fail = true;
  const journal = new MockRecovery(rows);
  journal.setEnabled('v', true);
  expect(() => journal.capture('v', 'a.md', 'before', 'after')).toThrow(/^recovery_required:/);
  expect(rows.get('old')?.raw).toBe('old');
});
it('pending copies cannot be read or deleted and block clear without partial deletion', () => {
  const rows = new Map<string, RecoveryRow>();
  const row: RecoveryRow = {
    id: 'pending',
    vault: 'v',
    path: 'a.md',
    raw: 'before',
    beforeHash: sha256Hex('before'),
    afterHash: sha256Hex('after'),
    capturedAt: Math.floor(Date.now() / 1000),
    bytes: 6,
    state: 'pending',
    attribution: 'outside, unattributed',
  };
  rows.set(row.id, row);
  rows.set('finished', { ...row, id: 'finished', state: 'committed' });
  const journal = new MockRecovery(rows);
  expect(() => journal.read('v', 'a.md', 'pending')).toThrow();
  expect(journal.delete('v', 'a.md', 'pending')).toBe(false);
  expect(() => journal.clear('v')).toThrow('recovery_pending');
  expect(journal.status('v').entries).toBe(2);
});
