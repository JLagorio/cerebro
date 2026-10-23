import { describe, expect, it } from 'vitest';
import { branchPoints, branchTurn, type BranchState } from '@/agent/elements/panelCheckpoints';
import type { ChatMessage } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';

/**
 * Where the panel offers "Branch from here" (M91.12c): after a reply with an
 * anchor, in a thread that can continue, whose transcript reads, with a
 * later message to leave behind. Each condition, false, hides it.
 */

const SESSION = '00000000-0000-4000-8000-000000000001';
const line = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const asked = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, tools: [] });
const replied = (id: string, text: string, uuid: string | null): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  tools: [],
  ...(uuid === null ? {} : { anchor: { sessionId: SESSION, uuid } }),
});

const THREAD: ChatMessage[] = [
  asked('u-1', 'What is at risk?'),
  replied('a-1', 'The scanner delivery.', line(11)),
  asked('u-2', 'And if it slips?'),
  replied('a-2', 'The rollout moves a week.', line(22)),
  asked('u-3', 'Who decides?'),
  replied('a-3', 'The steering group.', line(33)),
];

const OPEN: BranchState = { blocked: null, transcript: { state: 'idle' } };

describe('branchPoints', () => {
  it('offers a branch after every anchored reply that a later message follows', () => {
    expect([...branchPoints(THREAD, OPEN)]).toEqual([
      ['a-1', 'your message “What is at risk?”'],
      ['a-2', 'your message “And if it slips?”'],
    ]);
  });

  it('offers none after a reply whose turn named no line', () => {
    const thread = THREAD.map((m) => (m.id === 'a-1' ? replied('a-1', m.text, null) : m));
    expect([...branchPoints(thread, OPEN).keys()]).toEqual(['a-2']);
    const blank = THREAD.map((m) =>
      m.id === 'a-2' ? { ...m, anchor: { sessionId: SESSION, uuid: '' } } : m,
    );
    expect([...branchPoints(blank, OPEN).keys()]).toEqual(['a-1']);
  });

  it('offers none after the last message: the thread itself is that branch', () => {
    expect(branchPoints(THREAD.slice(0, 2), OPEN).size).toBe(0);
    // A question sent after it is a later message, its reply streaming or not.
    expect([...branchPoints(THREAD.slice(0, 3), OPEN).keys()]).toEqual(['a-1']);
  });

  it.each(['cleared', 'expired', 'elsewhere'] as const)('offers none in a %s thread', (blocked) => {
    expect(branchPoints(THREAD, { ...OPEN, blocked }).size).toBe(0);
  });

  it('offers none while the transcript is being read, or when it could not be', () => {
    const unread: TranscriptStatus[] = [
      { state: 'reading' },
      { state: 'unavailable', reason: 'unreadable', retentionDays: 30 },
      { state: 'unavailable', reason: 'not_recorded', retentionDays: null },
      { state: 'unavailable', reason: 'expired', retentionDays: 30 },
    ];
    for (const transcript of unread) {
      expect(branchPoints(THREAD, { blocked: null, transcript }).size, transcript.state).toBe(0);
    }
  });

  it('offers them once the transcript is read, rebuilt or healed', () => {
    for (const state of ['idle', 'rebuilt', 'healed'] as const) {
      expect(branchPoints(THREAD, { blocked: null, transcript: { state } }).size, state).toBe(2);
    }
  });
});

describe('branchTurn', () => {
  it('names the person’s message the reply answered, on one line, cut long', () => {
    const long = asked('u-9', `Plan the launch\n\nwith ${'every detail '.repeat(10)}`);
    const words = branchTurn(long, THREAD[1]);
    expect(words.startsWith('your message “Plan the launch with every detail')).toBe(true);
    expect(words.endsWith('…”')).toBe(true);
    // The quote is at most sixty characters, its ellipsis one of them.
    expect(words.length).toBe('your message “”'.length + 60);
  });

  it('cuts a long quote between characters, never inside one', () => {
    const words = branchTurn(asked('u-8', `${'a'.repeat(58)}😀😀 and on`), THREAD[1]);
    expect(words).toBe(`your message “${'a'.repeat(58)}😀…”`);
  });

  it('names the reply itself where no message came before it, and says so when it is blank', () => {
    expect(branchTurn(null, THREAD[1])).toBe('the reply “The scanner delivery.”');
    expect(branchTurn(null, replied('a-0', '  ', line(1)))).toBe('this reply');
    expect(branchTurn(asked('u-0', ' '), THREAD[1])).toBe('your message');
  });

  it('names the turn of a reply that follows another reply by the message both answer', () => {
    const thread = [THREAD[0], THREAD[1], replied('a-1b', 'And one more thing.', line(12))];
    expect(branchPoints(thread, OPEN).get('a-1')).toBe('your message “What is at risk?”');
  });
});
