import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveOutcome } from './documentOwner';
import { SaveParticipants, type SaveParticipant } from './saveParticipants';

const key = { vaultId: 'vault-a', path: 'a.md', ownerId: 'p1' };
function participant(overrides: Partial<SaveParticipant> = {}): SaveParticipant {
  return {
    key,
    snapshot: () => ({
      latestDraft: 'exact draft',
      generation: 1,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
    }),
    prepare: () => undefined,
    flush: async () => ({ kind: 'failed', ownerId: key.ownerId, generation: 1, code: 'disk_full' }),
    ...overrides,
  };
}
afterEach(() => vi.useRealTimers());

describe('mounted save participants', () => {
  it('retains exact child payload after a clean body releases', async () => {
    const book = new SaveParticipants();
    const childDrafts = { sheets: '{"cell":"exact refused text"}' };
    const release = book.register(
      participant({
        snapshot: () => ({
          latestDraft: 'saved body',
          generation: 1,
          acknowledgedGeneration: 1,
          inFlightGeneration: null,
          failure: null,
          childDrafts,
        }),
        flush: async () => ({ kind: 'clean', ownerId: key.ownerId, generation: 1 }),
      }),
    );
    release();
    expect(book.unresolved()).toEqual([expect.objectContaining({ childDrafts })]);
    expect((await book.flush()).unresolvedOwnerIds).toHaveLength(1);
  });

  it('recognizes an independently retried successful generation after a failed barrier', async () => {
    const book = new SaveParticipants();
    let acknowledged = 0;
    book.register(
      participant({
        snapshot: () => ({
          latestDraft: 'exact',
          generation: 1,
          acknowledgedGeneration: acknowledged,
          inFlightGeneration: null,
          failure: null,
        }),
      }),
    );
    expect((await book.flush()).unresolvedOwnerIds).toHaveLength(1);
    acknowledged = 1;
    expect(book.unresolved()).toEqual([]);
  });

  it('retains a failed child preparation on a clean body until preparation succeeds', () => {
    const book = new SaveParticipants();
    let valid = false;
    book.register(
      participant({
        snapshot: () => ({
          latestDraft: 'body already saved',
          generation: 1,
          acknowledgedGeneration: 1,
          inFlightGeneration: null,
          failure: null,
        }),
        prepare: () => {
          if (!valid) throw new Error('invalid child');
        },
      }),
    );
    book.prepare();
    expect(book.unresolved()).toHaveLength(1);
    valid = true;
    book.prepare();
    expect(book.unresolved()).toEqual([]);
  });
  it('prepares every child buffer before any participant serializes', async () => {
    const book = new SaveParticipants();
    const steps: string[] = [];
    for (const path of ['a.md', 'b.md'])
      book.register(
        participant({
          key: { ...key, path },
          prepare: () => {
            steps.push(`prepare ${path}`);
          },
          flush: async () => {
            steps.push(`save ${path}`);
            return { kind: 'clean', ownerId: 'p1', generation: 0 };
          },
          snapshot: () => ({
            latestDraft: '',
            generation: 0,
            acknowledgedGeneration: 0,
            inFlightGeneration: null,
            failure: null,
          }),
        }),
      );
    const report = await book.flush();
    expect(steps).toEqual(['prepare a.md', 'prepare b.md', 'save a.md', 'save b.md']);
    expect(report.unresolvedOwnerIds).toEqual([]);
  });

  it('retains exact failed state after release and retries without another edit', async () => {
    const book = new SaveParticipants();
    let saved = false;
    const flush = vi.fn(async (): Promise<SaveOutcome> =>
      saved
        ? {
            kind: 'acknowledged',
            ownerId: 'p1',
            generation: 1,
            write: { kind: 'file', contentHash: 'confirmed' },
          }
        : { kind: 'failed', ownerId: 'p1', generation: 1, code: 'disk_full' },
    );
    const release = book.register(
      participant({
        flush,
        snapshot: () => ({
          latestDraft: 'exact draft\n',
          generation: 1,
          acknowledgedGeneration: saved ? 1 : 0,
          inFlightGeneration: null,
          failure: null,
        }),
      }),
    );
    expect((await book.flush()).unresolvedOwnerIds).toHaveLength(1);
    release();
    expect(book.unresolved()[0].latestDraft).toBe('exact draft\n');
    saved = true;
    expect((await book.flush()).unresolvedOwnerIds).toEqual([]);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(book.size).toBe(0);
  });

  it('does not confuse the same pane and path in different vaults', async () => {
    const book = new SaveParticipants();
    book.register(participant());
    book.register(participant({ key: { ...key, vaultId: 'vault-b' } }));
    const report = await book.flush();
    expect(new Set(report.unresolvedOwnerIds).size).toBe(2);
    expect(book.unresolved().map((s) => s.key.vaultId)).toEqual(['vault-a', 'vault-b']);
  });

  it('reports deadline and retains a hung writer instead of treating it as clean', async () => {
    vi.useFakeTimers();
    const book = new SaveParticipants();
    book.register(participant({ flush: () => new Promise(() => undefined) }));
    const pending = book.flush(100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: 'blocked', reason: 'deadline' }),
    ]);
    expect(result.unresolvedOwnerIds).toHaveLength(1);
    expect(book.unresolved()[0].latestDraft).toBe('exact draft');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a thrown preparation unresolved and never invokes its writer', async () => {
    const book = new SaveParticipants();
    const write = vi.fn();
    book.register(
      participant({
        prepare: () => {
          throw new Error('invalid field');
        },
        flush: write,
      }),
    );
    const report = await book.flush();
    expect(report.outcomes[0]).toMatchObject({ kind: 'failed', code: 'prepare_failed' });
    expect(report.unresolvedOwnerIds).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
  });

  it('checks current generations after an acknowledged older write', async () => {
    const book = new SaveParticipants();
    book.register(
      participant({
        snapshot: () => ({
          latestDraft: 'newer',
          generation: 2,
          acknowledgedGeneration: 1,
          inFlightGeneration: null,
          failure: null,
        }),
        flush: async () => ({
          kind: 'acknowledged',
          ownerId: 'p1',
          generation: 1,
          write: { kind: 'file', contentHash: 'older' },
        }),
      }),
    );
    expect((await book.flush()).unresolvedOwnerIds).toHaveLength(1);
  });

  it('an old registration release cannot retire its replacement', async () => {
    const book = new SaveParticipants();
    const release = book.register(participant());
    const replacement = vi.fn(async (): Promise<SaveOutcome> => ({
      kind: 'failed',
      ownerId: 'p1',
      generation: 2,
      code: 'full',
    }));
    book.register(participant({ flush: replacement }));
    release();
    await book.flush();
    expect(replacement).toHaveBeenCalledOnce();
  });
});

it('retires only wrappers of one captured identity and rejects their later registration after reset', async () => {
  const book = new SaveParticipants();
  const captured = {};
  const newer = {};
  const waiting = { kind: 'deferred' as const, settled: Promise.resolve() };
  const retiredPrepare = vi.fn();
  const old = participant({ identity: captured, prepare: retiredPrepare });
  const oldSibling = participant({ identity: captured });
  const release = book.register(old, waiting);
  const releaseSibling = book.register(oldSibling, waiting);
  const live = participant({
    identity: newer,
    snapshot: () => ({
      latestDraft: 'Exact newer authored draft',
      generation: 2,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
    }),
  });
  book.register(live);
  expect(book.unresolved()).toHaveLength(3);
  book.retireIdentity(captured);
  release();
  releaseSibling();
  book.register(old, waiting);
  expect(book.get(key)).toBe(live);
  expect(book.unresolved()).toHaveLength(1);
  expect(book.unresolved()[0].latestDraft).toBe('Exact newer authored draft');
  await book.flush();
  expect(retiredPrepare).not.toHaveBeenCalled();
  book.clear();
  book.register(old, waiting);
  expect(book.size).toBe(0);
  book.register(live);
  expect(book.unresolved()[0].latestDraft).toBe('Exact newer authored draft');
});

it('identity retirement cannot delete a newer reentrant replacement or a participant with the same key', () => {
  const book = new SaveParticipants();
  const captured = {};
  const newer = participant();
  const releaseRetention = vi.fn(() => {
    book.register(newer);
  });
  book.register(
    participant({ identity: captured, retention: { held: () => true, release: releaseRetention } }),
  );
  book.retireIdentity(captured);
  expect(releaseRetention).toHaveBeenCalledOnce();
  expect(book.get(key)).toBe(newer);
  expect(book.unresolved()).toHaveLength(1);
});
