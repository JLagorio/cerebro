import { describe, expect, it } from 'vitest';
import {
  chipOf,
  listUnavailable,
  statusOf,
  type CardBook,
  type CardRef,
  type ThreadFacts,
  type ThreadStatus,
} from './threadStatus';

const read = (...cards: CardRef[]): CardBook => ({ state: 'read', cards });
const UNREAD: CardBook = { state: 'unread' };
const UNAVAILABLE: CardBook = { state: 'unavailable' };

/** A thread out of view that left run `run-7` going in session `s1`. */
const left = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  sessionId: 's1',
  liveRun: 'run-7',
  ...over,
});

describe('statusOf', () => {
  it.each<[string, ThreadFacts, CardBook, ThreadStatus]>([
    // The open thread's own flags outrank every other source.
    [
      'the open thread waits on a card',
      left({ active: { streaming: true, waiting: true } }),
      read(),
      'needs_you',
    ],
    [
      'the open thread streams, whatever the book says',
      left({ active: { streaming: true, waiting: false }, runState: 'unavailable' }),
      UNAVAILABLE,
      'working',
    ],
    [
      'the open thread is idle though a card names its session and its run still runs',
      left({ active: { streaming: false, waiting: false }, runState: 'running' }),
      read({ sessionId: 's1' }),
      'idle',
    ],
    // Then a card asked in its session, or by the run it left going.
    [
      'a card asked in its session',
      left({ liveRun: null }),
      read({ sessionId: 's1' }),
      'needs_you',
    ],
    [
      'a card asked by its run before the thread held a session',
      left({ sessionId: null, runState: 'running' }),
      read({ sessionId: 's9', run: 'run-7' }),
      'needs_you',
    ],
    [
      'a card outranks the run it held, which ended on it',
      left({ runState: 'done' }),
      read({ sessionId: 's1' }),
      'needs_you',
    ],
    [
      'a card outranks a run still going (a live ask)',
      left({ runState: 'running' }),
      read({ sessionId: 's1', run: 'run-7' }),
      'needs_you',
    ],
    [
      'another session’s card, by another run',
      left({ runState: 'done' }),
      read({ sessionId: 's2', run: 'run-8' }),
      'idle',
    ],
    // Then that run, as the journal answers for it.
    ['its run still going', left({ runState: 'running' }), read(), 'working'],
    ['its run done', left({ runState: 'done' }), read(), 'idle'],
    [
      'its run unknown to the journal, as after a restart',
      left({ runState: 'unknown' }),
      read(),
      'unknown',
    ],
    ['its run not asked about yet', left(), read(), 'unknown'],
    ['its run’s read failed', left({ runState: 'unavailable' }), read(), 'unavailable'],
    ['a session and no run left going', left({ liveRun: null }), read(), 'idle'],
    // A source that could not be read speaks for every source under it.
    [
      'the book unavailable, though its run is going',
      left({ runState: 'running' }),
      UNAVAILABLE,
      'unavailable',
    ],
    [
      'the book unavailable, a session and no run',
      left({ liveRun: null }),
      UNAVAILABLE,
      'unavailable',
    ],
    ['the book not read yet', left({ runState: 'running' }), UNREAD, 'unknown'],
    // A thread with no session and no run can hold no card.
    ['no session and no run', left({ sessionId: null, liveRun: null }), UNAVAILABLE, 'idle'],
    ['no session and no run, unread', left({ sessionId: null, liveRun: null }), UNREAD, 'idle'],
  ])('%s', (_, thread, book, status) => {
    expect(statusOf(thread, book)).toBe(status);
  });

  it('never infers Working from a run the journal does not hold', () => {
    for (const runState of ['unknown', 'unavailable', undefined] as const) {
      expect(statusOf(left({ runState }), read())).not.toBe('working');
    }
  });

  it('matches no card on an empty session or run', () => {
    const blank = read({ sessionId: '', run: '' });
    expect(statusOf(left({ sessionId: '', liveRun: '' }), blank)).toBe('idle');
    expect(statusOf(left({ sessionId: '', runState: 'done' }), blank)).toBe('idle');
    expect(statusOf(left({ liveRun: '' }), read({ sessionId: 's2', run: '' }))).toBe('idle');
  });

  it('matches a card that names no run by its session alone', () => {
    expect(statusOf(left({ sessionId: 's2' }), read({ sessionId: 's1' }))).toBe('unknown');
    expect(statusOf(left({ sessionId: 's2', runState: 'done' }), read({ sessionId: 's1' }))).toBe(
      'idle',
    );
  });
});

describe('chipOf', () => {
  it.each<[ThreadStatus, string | null]>([
    ['working', 'working'],
    ['needs_you', 'needs_you'],
    ['idle', null],
    ['unknown', null],
    ['unavailable', null],
  ])('%s draws %s', (status, chip) => {
    expect(chipOf(status)).toBe(chip);
  });
});

describe('listUnavailable', () => {
  it('says so once any status could not be read', () => {
    expect(listUnavailable(['working', 'unavailable', 'idle'], read())).toBe(true);
    expect(listUnavailable(['working', 'needs_you', 'unknown', 'idle'], read())).toBe(false);
  });

  it('says so when the card book could not be read, even where every thread reads idle', () => {
    expect(listUnavailable(['idle', 'idle'], UNAVAILABLE)).toBe(true);
    expect(listUnavailable([], UNAVAILABLE)).toBe(true);
  });

  it('is quiet while the book is still unread: that is unknown, not a failure', () => {
    expect(listUnavailable(['unknown', 'idle'], UNREAD)).toBe(false);
  });
});
