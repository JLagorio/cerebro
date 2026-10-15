import { beforeEach, describe, expect, it } from 'vitest';
import type { UpNextEntry } from '@/agent/upNextQueue';
import { useUpNextStore } from './upNextStore';

const entry = (id: string, vault = '/vault'): UpNextEntry => ({
  id,
  text: `message ${id}`,
  skill: null,
  allowedTools: null,
  turn: { systemPrompt: () => '', place: null, conversationId: null },
  vault,
  queuedAt: 0,
});

const store = () => useUpNextStore.getState();
const ids = (conversation: string) =>
  (store().queues[conversation]?.entries ?? []).map((e) => e.id);

describe('Up next per conversation (M57.5)', () => {
  beforeEach(() => useUpNextStore.setState({ queues: {} }));

  it('keeps one queue per conversation', () => {
    expect(store().enqueue('c-1', entry('a'))).toBe('queued');
    expect(store().enqueue('c-2', entry('b'))).toBe('queued');
    store().enqueue('c-1', entry('c'));
    expect(ids('c-1')).toEqual(['a', 'c']);
    expect(ids('c-2')).toEqual(['b']);
    expect(store().claim('c-1')?.id).toBe('a');
    expect(ids('c-1')).toEqual(['c']);
    expect(store().claimById('c-1', 'zz')).toBeNull();
    expect(store().claimById('c-1', 'c')?.id).toBe('c');
    expect(store().claim('c-1')).toBeNull();
  });

  it('answers full at the cap and keeps nothing more', () => {
    for (let i = 0; i < 10; i += 1) store().enqueue('c-1', entry(`e${i}`));
    expect(store().enqueue('c-1', entry('extra'))).toBe('full');
    expect(ids('c-1')).toHaveLength(10);
  });

  it('prunes the queues of removed threads', () => {
    store().enqueue('c-1', entry('a'));
    store().enqueue('c-2', entry('b'));
    store().prune(['c-2']);
    expect(store().queues['c-1']).toBeUndefined();
    expect(ids('c-2')).toEqual(['b']);
  });

  it('keeps held, steering and editing per conversation', () => {
    store().enqueue('c-1', entry('a'));
    store().enqueue('c-1', entry('b'));
    store().enqueue('c-2', entry('x'));
    store().setHeld('c-1', true);
    store().markSteer('c-1', 'b');
    store().setEditing('c-2', 'x');
    expect(store().queues['c-1']).toMatchObject({ held: true, steering: 'b', editing: null });
    expect(store().queues['c-2']).toMatchObject({ held: false, steering: null, editing: 'x' });
    // Steer moved its entry first.
    expect(ids('c-1')).toEqual(['b', 'a']);
  });

  it('holds only while entries wait', () => {
    store().setHeld('c-1', true);
    expect(store().queues['c-1']?.held ?? false).toBe(false);
    store().enqueue('c-1', entry('a'));
    store().setHeld('c-1', true);
    store().remove('c-1', 'a');
    expect(store().queues['c-1']?.held).toBe(false);
  });

  it('drops the entries queued in another vault', () => {
    store().enqueue('c-1', entry('a', '/vault'));
    store().enqueue('c-1', entry('b', '/other'));
    store().enqueue('c-2', entry('c', '/other'));
    store().keepVault('/vault');
    expect(ids('c-1')).toEqual(['a']);
    expect(ids('c-2')).toEqual([]);
  });

  it('clears a steer when its entry is removed', () => {
    store().enqueue('c-1', entry('a'));
    store().enqueue('c-1', entry('b'));
    store().markSteer('c-1', 'b');
    store().remove('c-1', 'b');
    expect(store().queues['c-1']?.steering).toBeNull();
    // And a claimed steer is spent with its entry.
    store().markSteer('c-1', 'a');
    store().claimById('c-1', 'a');
    expect(store().queues['c-1']?.steering).toBeNull();
  });

  it('edits a typed entry and refuses a handoff’s', () => {
    store().enqueue('c-1', entry('a'));
    store().enqueue('c-1', { ...entry('h'), prompt: 'the long prompt' });
    const none = { skill: null, allowedTools: null };
    expect(store().edit('c-1', 'a', 'new words', none)).toBe(true);
    expect(store().queues['c-1']?.entries[0].text).toBe('new words');
    expect(store().edit('c-1', 'h', 'new words', none)).toBe(false);
  });

  it('says whether any conversation still holds an entry (M58.5)', () => {
    store().enqueue('c-1', entry('a'));
    store().enqueue('c-2', entry('b'));
    expect(store().has('a')).toBe(true);
    expect(store().has('b')).toBe(true);
    expect(store().has('zz')).toBe(false);
    store().claim('c-1');
    expect(store().has('a')).toBe(false);
    store().remove('c-2', 'b');
    expect(store().has('b')).toBe(false);
  });
});
