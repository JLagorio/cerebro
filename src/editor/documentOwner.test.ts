import { describe, expect, it, vi } from 'vitest';
import { DocumentOwner, type NoteWriteAck } from './documentOwner';

const ack: NoteWriteAck = { kind: 'file', contentHash: 'authoritative' };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const key = { vaultId: 'vault', path: 'a.md', ownerId: 'pane' };

describe('document generations', () => {
  it('flush_of_an_untouched_owner_is_clean_without_writing', async () => {
    let writes = 0;
    const owner = new DocumentOwner(key, 'untouched exact text', async () => {
      writes += 1;
      return ack;
    });
    expect(await owner.flush()).toEqual({ kind: 'clean', ownerId: 'pane', generation: 0 });
    expect(writes).toBe(0);
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'untouched exact text',
      generation: 0,
      acknowledgedGeneration: 0,
    });
  });
  it('retry_without_edit_uses_latest_draft', async () => {
    const saved: string[] = [];
    let failures = 2;
    const owner = new DocumentOwner(key, 'initial', async (body) => {
      saved.push(body);
      if (failures-- > 0) throw new Error('unavailable');
      return ack;
    });
    owner.edit('first');
    await owner.flush();
    owner.edit('latest exact draft');
    expect((await owner.flush()).kind).toBe('failed');
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'latest exact draft',
      acknowledgedGeneration: 0,
    });
    expect(await owner.retry()).toMatchObject({ kind: 'acknowledged', generation: 2, write: ack });
    expect(saved).toEqual(['first', 'latest exact draft', 'latest exact draft']);
    expect(owner.snapshot().acknowledgedGeneration).toBe(2);
  });
  it('old_ack_does_not_clean_new_generation', async () => {
    const pending = deferred<NoteWriteAck>();
    let count = 0;
    const owner = new DocumentOwner(key, 'initial', async () => {
      if (++count === 1) return pending.promise;
      throw new Error('second failure');
    });
    owner.edit('first');
    const saving = owner.flush();
    owner.edit('second');
    pending.resolve(ack);
    await saving;
    expect(owner.snapshot()).toMatchObject({
      generation: 2,
      acknowledgedGeneration: 1,
      latestDraft: 'second',
      failure: { generation: 2 },
    });
  });
  it('writes_are_serial_and_coalesced', async () => {
    const first = deferred<NoteWriteAck>();
    const saved: string[] = [];
    const owner = new DocumentOwner(key, 'initial', async (body) => {
      saved.push(body);
      return saved.length === 1 ? first.promise : ack;
    });
    owner.edit('one');
    const saving = owner.flush();
    owner.edit('two');
    const again = owner.flush();
    owner.edit('three');
    expect(saved).toEqual(['one']);
    first.resolve(ack);
    await Promise.all([saving, again]);
    expect(saved).toEqual(['one', 'three']);
    expect(owner.snapshot().acknowledgedGeneration).toBe(3);
  });
  it('old_owner_completion_cannot_clean_renamed_owner', async () => {
    const pending = deferred<NoteWriteAck>();
    const old = new DocumentOwner(key, 'initial', () => pending.promise);
    old.edit('old');
    const saving = old.flush();
    const renamed = new DocumentOwner(
      { ...key, path: 'renamed.md', ownerId: 'new' },
      'old',
      async () => ack,
    );
    renamed.edit('renamed draft');
    pending.resolve(ack);
    await saving;
    expect(renamed.snapshot()).toMatchObject({
      latestDraft: 'renamed draft',
      generation: 1,
      acknowledgedGeneration: 0,
    });
  });
  it('a_coalesced_generation_rechecks_the_reconciliation_gate', async () => {
    const pending = deferred<NoteWriteAck>();
    const bodies: string[] = [];
    let held = false;
    const owner = new DocumentOwner(key, 'initial', async (body) => {
      bodies.push(body);
      return pending.promise;
    });
    owner.setWriteGate(() => (held ? 'choice' : null));
    owner.edit('first');
    const saving = owner.flush();
    held = true;
    owner.edit('exact pending draft');
    pending.resolve(ack);
    expect(await saving).toMatchObject({ kind: 'blocked', generation: 2, reason: 'choice' });
    expect(bodies).toEqual(['first']);
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'exact pending draft',
      generation: 2,
      acknowledgedGeneration: 1,
    });
  });

  it.each(['before', 'after'] as const)(
    'external_acceptance_rereads_after_an_old_write_lands_%s_the_initial_read',
    async (ordering) => {
      const pending = deferred<NoteWriteAck>();
      let disk = 'initial';
      const bodies: string[] = [];
      const owner = new DocumentOwner(key, disk, async (body) => {
        bodies.push(body);
        if (ordering === 'before') disk = body;
        const result = await pending.promise;
        if (ordering === 'after') disk = body;
        return result;
      });
      owner.edit('mine');
      const saving = owner.flush();
      disk = 'outside';
      expect(owner.acceptExternal(disk)).toBe(false);
      expect(owner.snapshot()).toMatchObject({
        latestDraft: 'mine',
        acknowledgedGeneration: 0,
        reconcileRequired: true,
      });
      pending.resolve(ack);
      await saving;
      expect(owner.acceptExternal(disk)).toBe(true);
      owner.finishReconcile();
      expect(owner.snapshot()).toMatchObject({
        latestDraft: ordering === 'before' ? 'outside' : 'mine',
        failure: null,
        reconcileRequired: false,
      });
      expect(bodies).toEqual(['mine']);
      expect((await owner.flush()).kind).toBe('clean');
    },
  );

  it('a_failed_old_write_requires_a_fresh_read_before_external_acceptance', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<NoteWriteAck>((_, fail) => {
      reject = fail;
    });
    const owner = new DocumentOwner(key, 'initial', () => pending);
    owner.edit('mine');
    const saving = owner.flush();
    expect(owner.acceptExternal('outside')).toBe(false);
    reject(new Error('old write failed'));
    await saving;
    expect(owner.snapshot().reconcileRequired).toBe(true);
    expect(owner.acceptExternal('fresh outside read')).toBe(true);
    owner.finishReconcile();
    expect(owner.snapshot()).toMatchObject({
      latestDraft: 'fresh outside read',
      failure: null,
      generation: 2,
      acknowledgedGeneration: 2,
    });
  });
});

it('retains exact nested draft payloads and refuses even a clean body flush until resolved', async () => {
  const write = vi.fn().mockResolvedValue({ kind: 'file', contentHash: 'accepted' });
  const owner = new DocumentOwner(
    { vaultId: '/vault', path: 'page.md', ownerId: 'p1' },
    'body',
    write,
  );
  const exact = JSON.stringify([{ text: '  exact cell  ', source: '1' }]);
  owner.setChildDrafts('sheets', exact);
  expect(owner.snapshot().childDrafts).toEqual({ sheets: exact });
  expect(await owner.flush()).toMatchObject({ kind: 'blocked', reason: 'choice' });
  owner.edit('new body');
  expect(await owner.flush()).toMatchObject({ kind: 'blocked', reason: 'choice' });
  expect(write).not.toHaveBeenCalled();
  owner.setChildDrafts('sheets', null);
  expect(await owner.flush()).toMatchObject({ kind: 'acknowledged' });
  expect(owner.snapshot().childDrafts).toEqual({});
  expect(write).toHaveBeenCalledOnce();
});
it('captures body format with each serial generation and retains source after failure', async () => {
  const pending = deferred<NoteWriteAck>();
  const saved: { body: string; format: string | undefined }[] = [];
  const owner = new DocumentOwner(key, 'initial', async (body, format) => {
    saved.push({ body, format });
    if (saved.length === 1) return pending.promise;
    if (saved.length === 2) throw new Error('source offline');
    return ack;
  });
  owner.edit('rich first', 'rich');
  const saving = owner.flush();
  owner.edit('raw\r\n<div>exact</div>\r\n', 'source');
  pending.resolve(ack);
  await saving;
  expect(owner.snapshot()).toMatchObject({
    bodyFormat: 'source',
    latestDraft: 'raw\r\n<div>exact</div>\r\n',
    acknowledgedGeneration: 1,
  });
  await owner.retry();
  expect(saved).toEqual([
    { body: 'rich first', format: 'rich' },
    { body: 'raw\r\n<div>exact</div>\r\n', format: 'source' },
    { body: 'raw\r\n<div>exact</div>\r\n', format: 'source' },
  ]);
});

it('explicit recovery bypass is limited to one failed generation in the serial drain', async () => {
  const writes: { body: string; bypass?: string }[] = [];
  const pending = deferred<NoteWriteAck>();
  const owner = new DocumentOwner(key, 'initial', async (body, _format, bypass?: string) => {
    writes.push({ body, bypass });
    if (!bypass) throw new Error('recovery_required:nonce');
    return pending.promise;
  });
  owner.edit('exact failed draft');
  await owner.flush();
  const saving = owner.saveWithoutRecoveryCopy('nonce', 1);
  owner.edit('newest draft');
  pending.resolve(ack);
  await saving;
  expect(writes).toEqual([
    { body: 'exact failed draft' },
    { body: 'exact failed draft', bypass: 'nonce' },
    { body: 'newest draft' },
  ]);
  expect(owner.snapshot()).toMatchObject({
    latestDraft: 'newest draft',
    acknowledgedGeneration: 1,
    failure: { generation: 2 },
  });
});
it.each(['edit', 'format', 'owner'] as const)(
  'invalidates recovery choice after %s changes',
  async (change) => {
    const bypasses: (string | undefined)[] = [];
    const writer = async (
      _body: string,
      _format?: string,
      bypass?: string,
    ): Promise<NoteWriteAck> => {
      bypasses.push(bypass);
      throw new Error('recovery_required:nonce');
    };
    let owner = new DocumentOwner(key, 'old', writer);
    owner.edit('failed');
    await owner.flush();
    if (change === 'edit') owner.edit('new');
    if (change === 'format') owner.present('failed', 'source');
    if (change === 'owner')
      owner = new DocumentOwner({ ...key, ownerId: 'replacement' }, 'failed', writer);
    expect((await owner.saveWithoutRecoveryCopy('nonce', 1)).kind).toBe('blocked');
    expect(bypasses).toEqual([undefined]);
  },
);
it('a clean presentation switch does not capture or submit any write', async () => {
  let writes = 0;
  const owner = new DocumentOwner(key, 'same', async () => {
    writes++;
    return ack;
  });
  owner.present('same', 'source');
  expect((await owner.flush()).kind).toBe('clean');
  owner.present('same', 'rich');
  expect((await owner.flush()).kind).toBe('clean');
  expect(writes).toBe(0);
});
