import { describe, expect, it } from 'vitest';
import type { VaultEvent } from './events';
import { makeEntry } from './testHelpers';
import type { Trigger } from './triggers';
import {
  triggerDigest,
  triggerWords,
  wakeKeyOf,
  wakeOffers,
  wakeVerdicts,
  type PendingWake,
} from './wakes';

const note = (path: string, hash: string | null) => makeEntry({ path, title: path, hash });

const changed = (path: string, before: string | null, after: string | null): VaultEvent => ({
  kind: 'changed',
  path,
  entry: note(path, after),
  before: note(path, before),
  fields: [],
});

const agent = (
  when: unknown,
  over: Record<string, unknown> = {},
  path = 'records/agents/scout.md',
) =>
  makeEntry({
    path,
    title: 'Scout',
    type: 'Agent',
    snippet: 'instructions',
    properties: { when, ...over },
  });

describe('wakeKeyOf (M63.1)', () => {
  it('is stable, and differs by kind, previous hash and old path', () => {
    const key = wakeKeyOf(changed('inbox/a.md', 'h1', 'h2'));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(wakeKeyOf(changed('inbox/a.md', 'h1', 'h2'))).toBe(key);
    expect(wakeKeyOf(changed('inbox/a.md', 'h0', 'h2'))).not.toBe(key);
    const created: VaultEvent = {
      kind: 'created',
      path: 'inbox/a.md',
      entry: note('inbox/a.md', 'h2'),
    };
    expect(wakeKeyOf(created)).not.toBe(key);
    const moved = (from: string): VaultEvent => ({
      kind: 'moved',
      path: 'inbox/a.md',
      from,
      entry: note('inbox/a.md', 'h2'),
    });
    expect(wakeKeyOf(moved('old/a.md'))).not.toBe(wakeKeyOf(moved('older/a.md')));
  });

  it('is null while the new version has no hash', () => {
    expect(wakeKeyOf(changed('inbox/a.md', 'h1', null))).toBeNull();
  });
});

describe('triggerDigest and triggerWords (M63.1)', () => {
  it('ignores key order and differs per trigger', () => {
    const a: Trigger = { event: 'changed', in: 'inbox' };
    const b: Trigger = { in: 'inbox', event: 'changed' };
    expect(triggerDigest(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(triggerDigest(b)).toBe(triggerDigest(a));
    expect(triggerDigest({ event: 'created', in: 'inbox' })).not.toBe(triggerDigest(a));
    expect(triggerDigest({ ...a, ask: 'is it late?' })).not.toBe(triggerDigest(a));
  });

  it("reads the trigger's sentence without its opening and full stop", () => {
    expect(triggerWords({ event: 'changed', in: 'records/risks' })).toBe(
      'a record changes in records/risks',
    );
  });
});

describe('wakeOffers (M63.1)', () => {
  const inbox: Trigger = { event: 'changed', in: 'inbox' };

  it('offers every matching event of every unpaused agent, with the first trigger that fires', () => {
    const scout = agent([{ event: 'changed', in: 'inbox', do: 'file it' }, { event: 'changed' }]);
    const paused = agent([inbox], { paused: true }, 'records/agents/paused.md');
    const a = changed('inbox/a.md', 'h1', 'h2');
    const b = changed('inbox/b.md', 'h3', 'h4');
    const offers = wakeOffers([scout, paused, a.entry, b.entry], [a, b]);
    expect(offers).toEqual([
      {
        agent: 'process:scout',
        path: 'inbox/a.md',
        hash: 'h2',
        event: 'changed',
        wakeKey: wakeKeyOf(a),
        trigger: triggerDigest({ event: 'changed', in: 'inbox', do: 'file it' }),
        cause: {
          kind: 'event',
          subject: 'inbox/a.md',
          detail: 'a record changes in inbox — then: file it',
        },
      },
      expect.objectContaining({
        wakeKey: wakeKeyOf(b),
        cause: expect.objectContaining({ subject: 'inbox/b.md' }),
      }),
    ]);
  });

  it('never wakes an agent on its own record, and offers nothing for an unhashed change', () => {
    const scout = agent([{ event: 'changed' }]);
    const own = changed(scout.path, 'h1', 'h2');
    const unhashed = changed('inbox/a.md', 'h1', null);
    expect(wakeOffers([scout], [own, unhashed])).toEqual([]);
    expect(wakeOffers([scout], [])).toEqual([]);
  });
});

describe('wakeVerdicts (M63.1)', () => {
  const inbox: Trigger = { event: 'changed', in: 'inbox' };
  const pending = (over: Partial<PendingWake> = {}): PendingWake => ({
    wakeId: 'w1',
    agent: 'process:scout',
    wakeKey: 'a'.repeat(64),
    trigger: triggerDigest(inbox),
    cause: { kind: 'event', subject: 'inbox/a.md' },
    admittedAt: '2026-07-31T09:00:00.000Z',
    notBefore: null,
    deferred: null,
    ...over,
  });
  const page = note('inbox/a.md', 'h1');

  it('names each why, the first that applies, in order', () => {
    const scout = agent([inbox]);
    expect(wakeVerdicts([scout, page], [pending()])).toEqual([]);
    expect(wakeVerdicts([page], [pending()])).toEqual([{ wakeId: 'w1', why: 'agent_gone' }]);
    expect(wakeVerdicts([agent([inbox], { paused: true }), page], [pending()])).toEqual([
      { wakeId: 'w1', why: 'paused' },
    ]);
    expect(wakeVerdicts([agent([{ event: 'created' }]), page], [pending()])).toEqual([
      { wakeId: 'w1', why: 'trigger_changed' },
    ]);
    expect(wakeVerdicts([scout], [pending()])).toEqual([{ wakeId: 'w1', why: 'page_gone' }]);
    // Paused and its trigger gone: paused is named first.
    expect(wakeVerdicts([agent([{ event: 'created' }], { paused: true })], [pending()])).toEqual([
      { wakeId: 'w1', why: 'paused' },
    ]);
  });
});
