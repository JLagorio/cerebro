import { describe, expect, it } from 'vitest';
import {
  answerable,
  cardStatus,
  denyAnswer,
  familyTitle,
  writeAllow,
  writeAllowWaits,
} from '@/agent/elements/cards';
import type { WaitingCard } from '@/agent/useAgentChat';

/**
 * The waiting cards' view models (M91.12b): the state each card's
 * Confirmation is told, in the words its specs read, and what its answers
 * send.
 */

const waiting = (over: Partial<WaitingCard> = {}): WaitingCard => ({
  card: {
    id: 'c'.repeat(32),
    kind: 'write',
    tool_name: 'mcp__cerebro__create_note',
    tool_id: 't-1',
    session_id: 's-1',
    summary: 'Create a note · records/risks',
    input: '{}',
    asked_at: '2026-10-14T12:00:00.000Z',
  },
  messageId: 'm-2',
  answering: false,
  stale: null,
  ...over,
});

describe('cardStatus', () => {
  it('waits for the person, in the word the cards’ specs read', () => {
    expect(cardStatus(waiting())).toEqual({ state: 'pending', 'data-state': 'waiting' });
    expect(cardStatus(waiting({ refused: null }))).toEqual({
      state: 'pending',
      'data-state': 'waiting',
    });
  });

  it('is answering while an answer is on its way, and stale once it came too late', () => {
    expect(cardStatus(waiting({ answering: true }))).toEqual({
      state: 'answering',
      'data-state': 'answering',
    });
    expect(cardStatus(waiting({ stale: 'No longer waiting.' }))).toEqual({
      state: 'stale',
      'data-state': 'stale',
    });
  });

  it('waits still under a refusal, and too late outranks every other state', () => {
    expect(cardStatus(waiting({ refused: 'Out of scope.' })).state).toBe('refused');
    expect(cardStatus(waiting({ refused: 'Out of scope.' }))['data-state']).toBe('refused');
    expect(cardStatus(waiting({ answering: true, refused: 'Out of scope.' })).state).toBe(
      'answering',
    );
    expect(
      cardStatus(waiting({ answering: true, stale: 'Too late.', refused: 'Out of scope.' })).state,
    ).toBe('stale');
  });
});

describe('answerable', () => {
  it('takes an answer only while the card waits, a refused write included', () => {
    expect(answerable('pending')).toBe(true);
    expect(answerable('refused')).toBe(true);
    expect(answerable('answering')).toBe(false);
    expect(answerable('stale')).toBe(false);
    expect(answerable('answered')).toBe(false);
  });
});

describe('familyTitle', () => {
  it('titles a card by its family, else by its own words', () => {
    expect(familyTitle('shell', 'Waiting for your OK')).toBe('Run this command?');
    expect(familyTitle('file_write', 'Waiting for your OK')).toBe('Change this file?');
    expect(familyTitle('question', 'Asked')).toBe('A question for you');
    // A family whose card the table does not draw, or none at all.
    expect(familyTitle('file_read', 'Waiting for your OK')).toBe('Waiting for your OK');
    expect(familyTitle('teleport', 'Waiting for your OK')).toBe('Waiting for your OK');
    expect(familyTitle(null, 'Waiting for your OK')).toBe('Waiting for your OK');
    expect(familyTitle(undefined, 'Waiting for your OK')).toBe('Waiting for your OK');
  });
});

describe('answers', () => {
  it('denies with the person’s words, and with none when they gave none', () => {
    expect(denyAnswer(null)).toEqual({ kind: 'deny' });
    expect(denyAnswer('not this week')).toEqual({ kind: 'deny', message: 'not this week' });
  });

  it('allows a write once, carrying the edit only when there is one', () => {
    const input = { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' };
    expect(writeAllow(null)).toEqual({ kind: 'allow', remember: 'once' });
    expect(writeAllow({ input, valid: true, edited: false })).toEqual({
      kind: 'allow',
      remember: 'once',
    });
    expect(writeAllow({ input, valid: true, edited: true })).toEqual({
      kind: 'allow',
      remember: 'once',
      updatedInput: input,
    });
  });

  it('holds Allow only while an edit is invalid', () => {
    const input = { body: 'x' };
    expect(writeAllowWaits(null)).toBe(false);
    expect(writeAllowWaits({ input, valid: false, edited: false })).toBe(false);
    expect(writeAllowWaits({ input, valid: true, edited: true })).toBe(false);
    expect(writeAllowWaits({ input, valid: false, edited: true })).toBe(true);
  });
});
