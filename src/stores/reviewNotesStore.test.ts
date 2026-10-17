// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpNextEntry } from '@/agent/upNextQueue';
import { MAX_NOTE_CHARS, MAX_QUEUED_NOTES, MAX_SENT_NOTES } from '@/engine/reviewNotes';
import { REVIEW_NOTES_KEY, statusOf, useReviewNotesStore, type NewNote } from './reviewNotesStore';
import { useUpNextStore } from './upNextStore';

const fresh = (over: Partial<NewNote> = {}): NewNote => ({
  vault: '/vault',
  conversationId: 'c-1',
  runId: 'run-1',
  commit: 'c'.repeat(40),
  path: 'records/a.md',
  side: 'new',
  start: 2,
  end: 2,
  excerpt: 'A line',
  text: 'Say it plainer.',
  ...over,
});

const entry = (id: string): UpNextEntry => ({
  id,
  text: 'notes',
  notes: { ids: [] },
  skill: null,
  narrowing: {},
  turn: { systemPrompt: () => '', place: null, conversationId: 'c-1' },
  vault: '/vault',
  queuedAt: 0,
});

const store = () => useReviewNotesStore.getState();
const stored = () =>
  JSON.parse(localStorage.getItem(REVIEW_NOTES_KEY) ?? 'null') as {
    v: number;
    notes: { id: string; conversationId: string; vault: string }[];
  } | null;
const added = (over: Partial<NewNote> = {}) => {
  const note = store().add(fresh(over));
  if (note === null) throw new Error('refused');
  return note;
};
const find = (id: string) => store().notes.find((n) => n.id === id);
const must = (id: string) => {
  const note = find(id);
  if (note === undefined) throw new Error(`no note ${id}`);
  return note;
};

describe('review notes, per viewer (M58.5)', () => {
  beforeEach(() => {
    localStorage.clear();
    useReviewNotesStore.setState({ notes: [] });
    useUpNextStore.setState({ queues: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adds, updates and removes a queued note', () => {
    const note = added({ text: '  trimmed  ' });
    expect(note.text).toBe('trimmed');
    expect(statusOf(note)).toBe('queued');
    expect(store().update(note.id, 'Changed.')).toBe(true);
    expect(find(note.id)?.text).toBe('Changed.');
    expect(store().update(note.id, 'x'.repeat(MAX_NOTE_CHARS + 1))).toBe(false);
    store().remove(note.id);
    expect(store().notes).toEqual([]);
  });

  it('refuses an empty note and one over 2,000 characters', () => {
    expect(store().add(fresh({ text: '   ' }))).toBeNull();
    expect(store().add(fresh({ text: 'x'.repeat(MAX_NOTE_CHARS + 1) }))).toBeNull();
  });

  it('refuses the 31st queued note in a conversation, not in another', () => {
    for (let i = 0; i < MAX_QUEUED_NOTES; i += 1) added({ text: `note ${i}` });
    expect(store().add(fresh())).toBeNull();
    expect(store().add(fresh({ conversationId: 'c-2' }))).not.toBeNull();
  });

  it('holds, then stamps sentAt only when marked sent at dispatch', () => {
    const note = added();
    useUpNextStore.getState().enqueue('c-1', entry('up-1'));
    store().hold([note.id], 'up-1');
    expect(find(note.id)?.sentAt).toBeUndefined();
    expect(statusOf(must(note.id))).toBe('waiting');
    // Neither edited nor removed while it waits.
    expect(store().update(note.id, 'no')).toBe(false);
    store().remove(note.id);
    expect(find(note.id)).toBeDefined();
    store().markSent([note.id], 1234);
    expect(find(note.id)?.sentAt).toBe(1234);
    expect(find(note.id)?.heldBy).toBeUndefined();
    expect(statusOf(must(note.id))).toBe('sent');
  });

  it('reads a held note queued once its entry is gone', () => {
    const note = added();
    useUpNextStore.getState().enqueue('c-1', entry('up-2'));
    store().hold([note.id], 'up-2');
    useUpNextStore.getState().remove('c-1', 'up-2');
    expect(statusOf(must(note.id))).toBe('queued');
  });

  it('persists under cerebro.reviewNotes, keyed by vault and conversation', () => {
    added({ vault: '/one', conversationId: 'c-1' });
    added({ vault: '/two', conversationId: 'c-9' });
    const saved = stored();
    expect(saved?.v).toBe(1);
    expect(saved?.notes.map((n) => [n.vault, n.conversationId])).toEqual([
      ['/one', 'c-1'],
      ['/two', 'c-9'],
    ]);
    useReviewNotesStore.setState({ notes: [] });
    store().rehydrate();
    expect(store().notes).toHaveLength(2);
  });

  it('a reload returns a waiting note to queued', () => {
    const note = added();
    useUpNextStore.getState().enqueue('c-1', entry('up-3'));
    store().hold([note.id], 'up-3');
    useUpNextStore.setState({ queues: {} });
    store().rehydrate();
    expect(find(note.id)?.heldBy).toBeUndefined();
    expect(statusOf(must(note.id))).toBe('queued');
  });

  it('keeps working in memory when storage throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    const note = added();
    expect(find(note.id)).toBeDefined();
    store().markSent([note.id], 5);
    expect(find(note.id)?.sentAt).toBe(5);
    store().rehydrate();
    expect(find(note.id)?.sentAt).toBe(5);
  });

  it('prunes a deleted conversation’s notes', () => {
    added({ conversationId: 'c-1' });
    added({ conversationId: 'c-2' });
    store().prune('c-1');
    expect(store().notes.map((n) => n.conversationId)).toEqual(['c-2']);
    expect(stored()?.notes.map((n) => n.conversationId)).toEqual(['c-2']);
  });

  it('keeps the last 100 sent notes, dropping the oldest first', () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_SENT_NOTES + 2; i += 1) {
      const note = added({ text: `n${i}` });
      store().markSent([note.id], 1000 + i);
      ids.push(note.id);
    }
    const sent = store().notes.filter((n) => n.sentAt !== undefined);
    expect(sent).toHaveLength(MAX_SENT_NOTES);
    expect(sent.some((n) => n.id === ids[0] || n.id === ids[1])).toBe(false);
    expect(sent.some((n) => n.id === ids[MAX_SENT_NOTES + 1])).toBe(true);
  });
});
