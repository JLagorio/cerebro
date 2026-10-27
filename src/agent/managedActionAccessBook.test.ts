import { describe, expect, it, vi } from 'vitest';
import type { RunActionAccessView, SetRunActionAccessResult } from '@/lib/generated/actions';
import { createRunActionAccessBook } from './managedActionAccessBook';
import {
  createRunActionAccessSession,
  type RunActionAccessApi,
} from './managedActionAccessSession';
const view = (run = 41, request = 'request-a'): RunActionAccessView => ({
  runId: `original-${run}`,
  accessRevision: 'revision-a',
  accessRequestId: request,
  accounts: [],
  definitions: [],
  grants: [],
});
function api() {
  return {
    read: vi.fn<RunActionAccessApi['read']>().mockImplementation(async (run) => view(run)),
    set: vi.fn<RunActionAccessApi['set']>().mockImplementation(async (run) => ({
      state: 'changed',
      view: { ...view(run), accessRequestId: null },
      sourceCurrent: true,
      requestClosed: true,
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('original access sheet ownership', () => {
  it('retains the exact pending save across view remount without replacing its API or submission', async () => {
    const book = createRunActionAccessBook();
    const first = api();
    const pending = deferred<SetRunActionAccessResult>();
    first.set.mockReturnValueOnce(pending.promise);
    const session = book.acquire(41, 'request-a', first);
    expect(session).not.toBeNull();
    if (!session) return;
    await session.refresh();
    const saving = session.save();
    const replacement = api();
    const remounted = book.acquire(41, 'request-a', replacement);
    expect(remounted).toBe(session);
    await remounted?.save();
    expect(first.set).toHaveBeenCalledTimes(1);
    expect(replacement.set).not.toHaveBeenCalled();
    pending.resolve({
      state: 'changed',
      view: { ...view(), accessRequestId: null },
      sourceCurrent: true,
      requestClosed: true,
    });
    await saving;
    expect(session.getSnapshot().phase).toBe('saved');
  });
  it('retires only the exact original run and request', async () => {
    const book = createRunActionAccessBook();
    const source = api();
    const original = book.acquire(41, 'request-a', source);
    const other = book.acquire(42, 'request-a', source);
    const next = book.acquire(41, 'request-b', source);
    expect(original).not.toBeNull();
    expect(other).not.toBeNull();
    expect(next).not.toBeNull();
    book.retire(41, 'request-a');
    expect(original?.getSnapshot().retired).toBe(true);
    expect(other?.getSnapshot().retired).toBe(false);
    expect(next?.getSnapshot().retired).toBe(false);
    book.retire(41);
    expect(next?.getSnapshot().retired).toBe(true);
    expect(other?.getSnapshot().retired).toBe(false);
  });
  it('keeps retired in-flight writes within capacity until their original acknowledgement settles', async () => {
    const book = createRunActionAccessBook(1);
    const source = api();
    const pending = deferred<SetRunActionAccessResult>();
    source.set.mockReturnValueOnce(pending.promise);
    const original = book.acquire(41, 'request-a', source);
    expect(original).not.toBeNull();
    if (!original) return;
    await original.refresh();
    const saving = original.save();
    book.retire(41);
    expect(book.acquire(42, 'request-a', source)).toBeNull();
    pending.resolve({
      state: 'changed',
      view: { ...view(), accessRequestId: null },
      sourceCurrent: false,
      requestClosed: false,
    });
    await saving;
    expect(original.getSnapshot()).toMatchObject({
      retired: true,
      phase: 'saved',
      sourceCurrent: false,
    });
    expect(book.acquire(42, 'request-a', source)).not.toBeNull();
  });
  it('blocks new work on a retired ready sheet and refuses a late read from reopening it', async () => {
    const source = api();
    const ready = createRunActionAccessSession(41, 'request-a', source);
    await ready.refresh();
    ready.retire();
    await ready.save();
    await ready.refresh();
    expect(source.set).not.toHaveBeenCalled();
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(ready.getSnapshot()).toMatchObject({ retired: true, phase: 'closed' });
    const pending = deferred<RunActionAccessView>();
    source.read.mockReturnValueOnce(pending.promise);
    const late = createRunActionAccessSession(41, 'request-a', source);
    const reading = late.refresh();
    late.retire();
    pending.resolve(view());
    await reading;
    expect(late.getSnapshot()).toMatchObject({ retired: true, phase: 'closed' });
    await late.save();
    expect(source.set).not.toHaveBeenCalled();
  });
  it('retains an uncertain original save result after retirement without permitting a resend or reload', async () => {
    const source = api();
    const pending = deferred<SetRunActionAccessResult>();
    source.set.mockReturnValueOnce(pending.promise);
    const session = createRunActionAccessSession(41, 'request-a', source);
    await session.refresh();
    const saving = session.save();
    session.retire();
    pending.resolve({ state: 'commit_unknown', message: 'private detail' });
    await saving;
    expect(session.getSnapshot()).toMatchObject({ retired: true, phase: 'unknown' });
    expect(session.getSnapshot().failure).toContain('Could not confirm');
    await session.refresh();
    await session.save();
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(source.set).toHaveBeenCalledTimes(1);
  });
});

it('retains the first genuine zero-run access owner through an unknown save without borrowing another run', async () => {
  const book = createRunActionAccessBook();
  const source = api();
  const pending = deferred<SetRunActionAccessResult>();
  source.set.mockReturnValueOnce(pending.promise);
  const original = book.acquire(0, 'request-a', source);
  const other = book.acquire(1, 'request-a', source);
  expect(original).not.toBeNull();
  expect(other).not.toBeNull();
  if (original === null || other === null) return;
  await original.refresh();
  const saving = original.save();
  expect(book.acquire(0, 'request-a', api())).toBe(original);
  expect(original.getSnapshot().phase).toBe('saving');
  expect(other.getSnapshot().phase).toBe('idle');
  pending.resolve({ state: 'commit_unknown', message: 'lost acknowledgement' });
  await saving;
  expect(original.getSnapshot().phase).toBe('unknown');
  expect(book.acquire(0, 'request-a', api())).toBe(original);
  await original.save();
  expect(source.set).toHaveBeenCalledTimes(1);
  expect(source.read).toHaveBeenCalledExactlyOnceWith(0);
});
