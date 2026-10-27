import { afterEach, expect, it, vi } from 'vitest';
import { FieldSaveParticipant } from './fieldSaveParticipant';
import {
  __resetOpenPages,
  flushOpenPages,
  registerSaveParticipant,
  retainedSaveParticipant,
  unresolvedOpenPages,
} from './openPages';
const key = { vaultId: '/field-vault', path: 'page.md', ownerId: 'field:estimate' };
const numeric = (text: string) =>
  Number.isFinite(Number(text))
    ? { ok: true as const, value: Number(text) }
    : { ok: false as const, error: 'Enter a finite number.' };
afterEach(__resetOpenPages);
it('captures focused exact input, reports invalid values unresolved, and retries without an edit', async () => {
  const write = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const owner = new FieldSaveParticipant(key, '3', numeric, write);
  registerSaveParticipant(owner);
  owner.edit('  Infinity  ');
  expect(unresolvedOpenPages()[0].latestDraft).toBe('  Infinity  ');
  expect((await flushOpenPages()).unresolvedOwnerIds).toHaveLength(1);
  expect(write).not.toHaveBeenCalled();
  owner.edit('  8  ');
  expect((await flushOpenPages()).unresolvedOwnerIds).toHaveLength(1);
  expect(owner.snapshot().latestDraft).toBe('  8  ');
  const retried = await flushOpenPages();
  expect(retried.unresolvedOwnerIds).toEqual([]);
  expect(retried.outcomes[0]).toMatchObject({ kind: 'committed', source: 'guarded_field' });
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith(8);
});
it('joins in-flight work and acknowledges only its captured generation before draining the latest', async () => {
  let finish!: (ok: boolean) => void;
  const write = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(true);
  const owner = new FieldSaveParticipant(key, '0', numeric, write);
  owner.edit('1');
  const first = owner.flush();
  const joined = owner.flush();
  expect(joined).toBe(first);
  expect(write).toHaveBeenCalledTimes(1);
  owner.edit('2');
  finish(true);
  await first;
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith(2);
  expect(owner.snapshot()).toMatchObject({
    latestDraft: '2',
    generation: 2,
    acknowledgedGeneration: 2,
    inFlightGeneration: null,
  });
});
it('retains failed exact input after unmount for a later retry and retires only after success', async () => {
  const owner = new FieldSaveParticipant(
    key,
    'old',
    (text) => ({ ok: true, value: text }),
    vi.fn().mockRejectedValueOnce(Error('disk full')).mockResolvedValue(true),
  );
  const release = registerSaveParticipant(owner);
  owner.edit('  Keep this  ');
  await owner.flush();
  release();
  expect(retainedSaveParticipant(key)).toBe(owner);
  expect(unresolvedOpenPages()[0].latestDraft).toBe('  Keep this  ');
  await flushOpenPages();
  expect(unresolvedOpenPages()).toEqual([]);
  expect(retainedSaveParticipant(key)).toBeUndefined();
});
it('allocates the in-flight promise before a writer can reenter Save', async () => {
  let nested: Promise<unknown> | undefined;
  const write = vi.fn(async () => {
    if (write.mock.calls.length === 1) nested = owner.flush();
    return true;
  });
  const owner = new FieldSaveParticipant(key, 'old', (text) => ({ ok: true, value: text }), write);
  owner.edit('latest');
  const first = owner.flush();
  await first;
  expect(write).toHaveBeenCalledTimes(1);
  expect(nested).toBe(first);
});
it('settles an explicitly unchanged semantic generation as clean without claiming a commit', async () => {
  const owner = new FieldSaveParticipant(
    key,
    'Before',
    (text) => ({ ok: true, value: text.trim() }),
    vi.fn().mockResolvedValue('unchanged'),
  );
  owner.edit('  Before  ');
  const result = await owner.flush();
  expect(result).toEqual({ kind: 'clean', ownerId: key.ownerId, generation: 1 });
  expect(owner.snapshot()).toMatchObject({
    generation: 1,
    acknowledgedGeneration: 1,
    failure: null,
  });
});
