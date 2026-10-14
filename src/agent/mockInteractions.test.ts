import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortMockAnswer,
  answerMockInteraction,
  cancelMockInteraction,
  confirmMockInteraction,
  DECLINED,
  declinedText,
  finishMockAnswer,
  listMockInteractions,
  mockAsks,
  NO_LONGER_WAITING,
  registerMockInteraction,
  resetMockInteractions,
  settleMockSession,
  STALE,
} from '@/agent/mockInteractions';

/**
 * The browser's ask seam (M57.1) mirrors Rust's book: these are the rules
 * `src-tauri/src/agent/interaction.rs` tests, in the mock's terms, and its
 * words are Rust's own.
 */

const RUST = readFileSync(join(__dirname, '../../src-tauri/src/agent/interaction.rs'), 'utf8');

const seam = globalThis as { __cerebroMockAsk?: unknown };

beforeEach(() => resetMockInteractions());
afterEach(() => {
  delete seam.__cerebroMockAsk;
});

/** A registered, confirmed card in `vault`. */
function waiting(vault = '/v', session = 's-1', tool = 't-1', resume = vi.fn()) {
  const id = registerMockInteraction(
    vault,
    session,
    tool,
    'append_to_note',
    JSON.stringify({ path: 'notes/inbox.md', content: 'x' }),
    resume,
  );
  const card = confirmMockInteraction(id);
  if (card === null) throw new Error('a confirmed card');
  return card;
}

describe('the mock ask seam', () => {
  it('asks only for the tools the seam names', () => {
    expect(mockAsks('append_to_note')).toBe(false);
    seam.__cerebroMockAsk = ['append_to_note'];
    expect(mockAsks('append_to_note')).toBe(true);
    expect(mockAsks('mcp__cerebro__append_to_note')).toBe(true);
    expect(mockAsks('edit_note')).toBe(false);
    seam.__cerebroMockAsk = ['mcp__cerebro__edit_note'];
    expect(mockAsks('edit_note')).toBe(true);
    seam.__cerebroMockAsk = 'append_to_note';
    expect(mockAsks('append_to_note')).toBe(false);
  });

  it('draws a confirmed call as a card, once', () => {
    const card = waiting();
    expect(card).toMatchObject({
      kind: 'permission',
      tool_name: 'append_to_note',
      tool_id: 't-1',
      session_id: 's-1',
      summary: 'append to note · notes/inbox.md',
    });
    expect(card.id).toMatch(/^[0-9a-f]{32}$/);
    expect(card.input).toContain('"path": "notes/inbox.md"');
    expect(confirmMockInteraction(card.id)).toBeNull();
  });

  it('takes one answer at a time', () => {
    const resume = vi.fn();
    const card = waiting('/v', 's-1', 't-1', resume);
    const first = answerMockInteraction('/v', card.id);
    expect('resume' in first && first.resume).toBe(resume);
    expect(answerMockInteraction('/v', card.id)).toEqual({
      refused: { code: NO_LONGER_WAITING, message: STALE },
    });
    // A resume that could not start puts the card back.
    abortMockAnswer(card.id);
    expect(listMockInteractions('/v')).toEqual([card]);
    expect('resume' in answerMockInteraction('/v', card.id)).toBe(true);
    finishMockAnswer(card.id);
    expect(listMockInteractions('/v')).toEqual([]);
  });

  it('refuses a stale answer no_longer_waiting, in Rust’s words', () => {
    expect(RUST).toContain(`pub const NO_LONGER_WAITING: &str = "${NO_LONGER_WAITING}";`);
    expect(RUST).toContain(`pub const STALE: &str = "${STALE}";`);
    expect(RUST).toContain(`const DECLINED: &str = "${DECLINED}";`);
    const card = waiting();
    expect(answerMockInteraction('/elsewhere', card.id)).toEqual({
      refused: { code: NO_LONGER_WAITING, message: STALE },
    });
    expect(answerMockInteraction('/v', 'no-such-card')).toHaveProperty('refused');
    cancelMockInteraction(card.id);
    expect(answerMockInteraction('/v', card.id)).toHaveProperty('refused');
  });

  it('cancels idempotently', () => {
    const card = waiting();
    expect(cancelMockInteraction(card.id)).toBe(true);
    expect(cancelMockInteraction(card.id)).toBe(false);
    expect(cancelMockInteraction('no-such-card')).toBe(false);
    expect(listMockInteractions('/v')).toEqual([]);
  });

  it('lists the waiting cards of one vault, oldest first', () => {
    const first = waiting('/v', 's-1', 't-1');
    const elsewhere = waiting('/w', 's-2', 't-1');
    const second = waiting('/v', 's-3', 't-1');
    // Registered but never confirmed is no card.
    registerMockInteraction('/v', 's-4', 't-1', 'edit_note', '{}', vi.fn());
    expect(listMockInteractions('/v')).toEqual([first, second]);
    expect(listMockInteractions('/w')).toEqual([elsewhere]);
  });

  it('refuses an unanswered call when its thread sends again', () => {
    const left = waiting('/v', 's-1', 't-1');
    const stopped = waiting('/v', 's-1', 't-2');
    cancelMockInteraction(stopped.id);
    const other = waiting('/v', 's-2', 't-1');
    expect(settleMockSession('s-1').sort()).toEqual(['t-1', 't-2']);
    expect(listMockInteractions('/v')).toEqual([other]);
    expect(answerMockInteraction('/v', left.id)).toHaveProperty('refused');
    expect(settleMockSession('s-1')).toEqual([]);
  });

  it('words a deny as Rust does, the person’s reason after', () => {
    expect(declinedText({ kind: 'deny' })).toBe(DECLINED);
    expect(declinedText({ kind: 'deny', message: '  not today  ' })).toBe(
      `${DECLINED} They said: not today`,
    );
    expect(RUST).toContain('format!("{DECLINED} They said: {said}")');
  });
});
