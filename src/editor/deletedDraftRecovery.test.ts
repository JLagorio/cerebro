import { beforeEach, expect, it, vi } from 'vitest';
import {
  retainDocumentOwner,
  registerSaveParticipant,
  unresolvedOpenPages,
  __resetOpenPages,
} from './openPages';
import { FieldSaveParticipant, fieldKey } from './fieldSaveParticipant';
import {
  recoveryDrafts,
  discardRecovery,
  resetRecoveryRegistry,
  copyRecovery,
  recoveryBundle,
  saveRecoveryAs,
  resumeRecovery,
  holdRecovery,
} from './deletedDraftRecovery';

const key = { vaultId: '/vault-a', path: 'notes/gone.md', ownerId: 'pane-a' };
beforeEach(() => {
  __resetOpenPages();
  resetRecoveryRegistry();
});
it('keeps opaque source and children, then retires exactly one failed owner without resurrection', async () => {
  const write = vi.fn(async () => {
    throw new Error('missing');
  });
  const owner = retainDocumentOwner(key, 'before', write);
  owner.edit('\r\n<div>😀 exact</div>\r\n', 'source');
  owner.setChildDrafts('unknown-child', '  {not decoded}\r\n');
  const draft = recoveryDrafts(key)[0];
  expect(draft.payload.body).toEqual({ format: 'source', text: '\r\n<div>😀 exact</div>\r\n' });
  expect(draft.payload.children).toEqual({ 'unknown-child': '  {not decoded}\r\n' });
  expect(draft.payload.metadata).toEqual({ kind: 'unavailable' });
  expect(discardRecovery(draft.ref)).toEqual({ kind: 'discarded' });
  owner.edit('late editor cleanup');
  owner.setChildDrafts('sheets', 'late payload');
  await owner.flush();
  expect(write).not.toHaveBeenCalled();
  expect(recoveryDrafts(key)).toEqual([]);
  expect(unresolvedOpenPages()).toEqual([]);
  const replacement = retainDocumentOwner(key, 'new incarnation', write);
  replacement.edit('new draft');
  expect(discardRecovery(draft.ref).kind).toBe('retired');
  expect(recoveryDrafts(key)[0].payload.body?.text).toBe('new draft');
});
it('refuses discard during a real pending write and after a child-only revision changes', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const owner = retainDocumentOwner(key, 'before', async () => {
    await pending;
    throw new Error('missing');
  });
  owner.edit('latest');
  const save = owner.flush();
  expect(discardRecovery(recoveryDrafts(key)[0].ref)).toEqual({
    kind: 'blocked',
    reason: 'in_flight',
  });
  finish();
  await save;
  const old = recoveryDrafts(key)[0].ref;
  owner.setChildDrafts('sheets', 'exact invalid formula');
  expect(discardRecovery(old)).toEqual({ kind: 'blocked', reason: 'changed' });
  expect(recoveryDrafts(key)[0].payload.children.sheets).toBe('exact invalid formula');
});
it('copies exact invalid field data without submitting it and keeps it until explicit discard', async () => {
  const write = vi.fn(async () => false);
  const field = new FieldSaveParticipant(
    fieldKey(key.vaultId, key.path, 'date'),
    'before',
    () => ({ ok: false, error: 'invalid' }),
    write,
  );
  registerSaveParticipant(field);
  field.edit('  invalid value  ');
  const draft = recoveryDrafts(key)[0];
  const clipboard = vi.fn(async (_text: string) => undefined);
  expect(await copyRecovery(draft.ref, false, clipboard, () => true)).toEqual({ kind: 'copied' });
  expect(clipboard).toHaveBeenCalledWith('  invalid value  ');
  expect(write).not.toHaveBeenCalled();
  expect(recoveryDrafts(key)).toHaveLength(1);
  expect(JSON.parse(recoveryBundle(draft)).field.text).toBe('  invalid value  ');
  expect(discardRecovery(draft.ref).kind).toBe('discarded');
  expect(unresolvedOpenPages()).toEqual([]);
});
it('does not commit an export after a child changes while its native picker waits', async () => {
  const owner = retainDocumentOwner(key, 'before', async () => {
    throw new Error('missing');
  });
  owner.edit('body');
  owner.setChildDrafts('sheets', 'old cell');
  let choose!: (value: { kind: 'chosen'; token: string }) => void;
  const picker = new Promise<{ kind: 'chosen'; token: string }>((resolve) => {
    choose = resolve;
  });
  const commit = vi.fn();
  const cancel = vi.fn(async () => undefined);
  const work = saveRecoveryAs(recoveryDrafts(key)[0].ref, { kind: 'bundle' }, () => true, {
    choose: async () => picker,
    commit,
    cancel,
    create: vi.fn(),
    refresh: vi.fn(),
    record: vi.fn(),
  });
  owner.setChildDrafts('sheets', 'newer exact cell');
  choose({ kind: 'chosen', token: 'native-token' });
  expect(await work).toEqual({ kind: 'blocked', reason: 'changed' });
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith('native-token');
  expect(recoveryDrafts(key)[0].payload.children.sheets).toBe('newer exact cell');
});
it('releases a clean unmounted field registration while a dirty field remains recoverable', async () => {
  const write = vi.fn(async () => true);
  const field = new FieldSaveParticipant(
    fieldKey(key.vaultId, key.path, 'title'),
    'before',
    (text) => ({ ok: true, value: text }),
    write,
  );
  const stop = registerSaveParticipant(field);
  field.edit('kept');
  stop();
  expect(recoveryDrafts(key)).toHaveLength(1);
  await field.flush();
  expect(recoveryDrafts(key)).toEqual([]);
  expect(write).toHaveBeenCalledOnce();
});
it('creates an exact body-only new page without acknowledging or discarding the original even if refresh fails', async () => {
  const owner = retainDocumentOwner(key, 'before', vi.fn());
  owner.edit('\r\n<div>exact 😀</div>\r\n', 'source');
  const create = vi.fn(async () => ({
    path: 'notes/recovered.md',
    contentHash: 'authoritative',
    batch: { files: [] } as never,
  }));
  const record = vi.fn();
  const doors = {
    choose: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
    create,
    record,
    refresh: vi.fn(async () => {
      throw Error('offline');
    }),
  };
  const ref = recoveryDrafts(key)[0].ref;
  expect(await saveRecoveryAs(ref, { kind: 'page', path: key.path }, () => true, doors)).toEqual({
    kind: 'blocked',
    reason: 'unavailable',
  });
  expect(create).not.toHaveBeenCalled();
  expect(
    await saveRecoveryAs(ref, { kind: 'page', path: 'notes/recovered.md' }, () => true, doors),
  ).toEqual({
    kind: 'created',
    path: 'notes/recovered.md',
    contentHash: 'authoritative',
    refreshFailed: true,
  });
  expect(create).toHaveBeenCalledWith(
    key.vaultId,
    key.path,
    'notes/recovered.md',
    '\r\n<div>exact 😀</div>\r\n',
  );
  expect(record).toHaveBeenCalledOnce();
  expect(owner.snapshot().acknowledgedGeneration).toBe(0);
  expect(recoveryDrafts(key)).toHaveLength(1);
});
it('exports a complete raw diagram verbatim but refuses plain export when a child is pending', async () => {
  const rawKey = { ...key, path: 'diagrams/gone.mmd' };
  const owner = retainDocumentOwner(rawKey, 'before', vi.fn());
  owner.edit('\ufeff---\r\nconfig: keep\r\n---\r\ngraph TD\r\n  A-->B\r\n');
  const choose = vi.fn(async () => ({ kind: 'chosen' as const, token: 'frozen' }));
  const commit = vi.fn(async () => ({
    kind: 'exported' as const,
    destination: 'outside/gone.mmd',
  }));
  const doors = {
    choose,
    commit,
    cancel: vi.fn(),
    create: vi.fn(),
    record: vi.fn(),
    refresh: vi.fn(),
  };
  expect(
    await saveRecoveryAs(recoveryDrafts(rawKey)[0].ref, { kind: 'raw' }, () => true, doors),
  ).toEqual({ kind: 'exported', destination: 'outside/gone.mmd' });
  expect(choose).toHaveBeenCalledWith(
    key.vaultId,
    rawKey.path,
    'gone.mmd',
    'mmd',
    expect.any(String),
  );
  expect(commit).toHaveBeenCalledWith(key.vaultId, 'frozen', owner.snapshot().latestDraft);
  owner.setChildDrafts('diagram-code', 'uncommitted');
  expect(
    await saveRecoveryAs(recoveryDrafts(rawKey)[0].ref, { kind: 'raw' }, () => true, doors),
  ).toEqual({ kind: 'blocked', reason: 'unavailable' });
  expect(commit).toHaveBeenCalledOnce();
  expect(recoveryDrafts(rawKey)).toHaveLength(1);
});
it('keeps a pending explicit clipboard operation from racing local discard', async () => {
  const owner = retainDocumentOwner(key, 'before', vi.fn());
  owner.edit('exact');
  let finish!: () => void;
  const ref = recoveryDrafts(key)[0].ref;
  const copy = copyRecovery(
    ref,
    false,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    () => true,
  );
  expect(discardRecovery(ref)).toEqual({ kind: 'blocked', reason: 'in_flight' });
  finish();
  await copy;
  expect(discardRecovery(recoveryDrafts(key)[0].ref)).toEqual({ kind: 'discarded' });
});
it.each(['', ' \r\n\t '])(
  'creates whitespace-only body %j exactly without filename adoption',
  async (body) => {
    const owner = retainDocumentOwner(key, 'before', vi.fn());
    owner.edit(body, 'source');
    const create = vi.fn(async () => ({
      path: 'notes/empty-recovered.md',
      contentHash: 'native',
      batch: { files: [] } as never,
    }));
    const doors = {
      choose: vi.fn(),
      commit: vi.fn(),
      cancel: vi.fn(),
      create,
      record: vi.fn(),
      refresh: vi.fn(),
    };
    expect(
      (
        await saveRecoveryAs(
          recoveryDrafts(key)[0].ref,
          { kind: 'page', path: 'notes/empty-recovered.md' },
          () => true,
          doors,
        )
      ).kind,
    ).toBe('created');
    expect(create).toHaveBeenCalledWith(key.vaultId, key.path, 'notes/empty-recovered.md', body);
    expect(owner.snapshot().acknowledgedGeneration).toBe(0);
  },
);
it.each(['governed', 'children', 'frontmatter'] as const)(
  'refuses new-page projection for %s and keeps exact data',
  async (kind) => {
    const target = { ...key, path: kind === 'governed' ? 'knowledge/gone.md' : key.path };
    const owner = retainDocumentOwner(target, 'before', vi.fn());
    owner.edit(kind === 'frontmatter' ? '---\r\ntype: Agent\r\n---\r\nbody' : 'exact', 'source');
    if (kind === 'children') owner.setChildDrafts('unknown', '{invalid exact}');
    const create = vi.fn();
    const doors = {
      choose: vi.fn(),
      commit: vi.fn(),
      cancel: vi.fn(),
      create,
      record: vi.fn(),
      refresh: vi.fn(),
    };
    expect(
      await saveRecoveryAs(
        recoveryDrafts(target)[0].ref,
        { kind: 'page', path: 'notes/ordinary.md' },
        () => true,
        doors,
      ),
    ).toEqual({ kind: 'blocked', reason: 'unavailable' });
    expect(create).not.toHaveBeenCalled();
    expect(recoveryDrafts(target)).toHaveLength(1);
  },
);

function restoredOwner() {
  const owner = retainDocumentOwner(key, 'before', vi.fn());
  owner.edit('exact retained draft', 'source');
  holdRecovery(recoveryDrafts(key)[0].ref);
  return owner;
}
it('a failed fresh admission read keeps the exact recovery owner and actions unresolved', async () => {
  const owner = restoredOwner();
  const ref = recoveryDrafts(key)[0].ref;
  const result = await resumeRecovery(
    ref,
    () => true,
    async () => {
      throw Error('unavailable');
    },
  );
  expect(result.kind).toBe('failed');
  expect(owner.requiresRecovery()).toBe(true);
  expect(recoveryDrafts(key)[0].ref.instanceId).toBe(ref.instanceId);
  expect(owner.snapshot().latestDraft).toBe('exact retained draft');
});
it.each(['edit', 'replacement', 'origin'] as const)(
  'a pending admission read cannot release a changed %s',
  async (change) => {
    const owner = restoredOwner();
    const ref = recoveryDrafts(key)[0].ref;
    let finish!: () => void;
    let current = true;
    const reading = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = resumeRecovery(
      ref,
      () => current,
      () => reading,
    );
    expect(owner.requiresRecovery()).toBe(true);
    if (change === 'edit') owner.edit('newer exact draft', 'source');
    if (change === 'replacement') {
      __resetOpenPages();
      restoredOwner();
    }
    if (change === 'origin') current = false;
    finish();
    expect((await result).kind).not.toBe('resumed');
    expect(recoveryDrafts(key)[0].requiresRecovery).toBe(true);
    expect(recoveryDrafts(key)[0].payload.body?.text).toBe(
      change === 'edit' ? 'newer exact draft' : 'exact retained draft',
    );
  },
);
it('admission reading leases discard until completion without consuming opaque child data', async () => {
  const owner = restoredOwner();
  owner.setChildDrafts('unknown', 'exact invalid child');
  const ref = recoveryDrafts(key)[0].ref;
  let finish!: () => void;
  const reading = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = resumeRecovery(
    ref,
    () => true,
    () => reading,
  );
  expect(discardRecovery(ref)).toEqual({ kind: 'blocked', reason: 'in_flight' });
  finish();
  expect((await result).kind).toBe('resumed');
  expect(owner.snapshot().childDrafts?.unknown).toBe('exact invalid child');
  expect(owner.snapshot().reconcileRequired).toBe(true);
});
it('a preparation that starts during the admission read still blocks release', async () => {
  const owner = restoredOwner();
  const ref = recoveryDrafts(key)[0].ref;
  let finish!: () => void;
  const reading = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = resumeRecovery(
    ref,
    () => true,
    () => reading,
  );
  const end = owner.beginPreparation();
  finish();
  expect(await result).toEqual({ kind: 'blocked', reason: 'in_flight' });
  expect(owner.requiresRecovery()).toBe(true);
  end();
});
