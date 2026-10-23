import { describe, expect, it } from 'vitest';
import { OWNER } from '@/engine/comments';
import { answeringText, commentFrom, commentMessage } from './writingComments';

/**
 * A comment as a Message (M91.14): the person speaks as the user, every
 * other author as the assistant, and a pending answer is working words in
 * its agent's name, never a body.
 */

describe('commentFrom', () => {
  it('places the person as the user and every agent author as the assistant', () => {
    expect(commentFrom(OWNER)).toBe('user');
    for (const author of ['claude-code', 'process:release-scout', 'agent:a1b2']) {
      expect(commentFrom(author)).toBe('assistant');
    }
  });
});

describe('commentMessage', () => {
  it('says a pending answer is under way, in its agent’s name', () => {
    expect(
      commentMessage({ author: 'process:release-scout', state: 'pending' }, 'Release scout'),
    ).toEqual({ from: 'assistant', answering: 'Release scout is answering…', failed: false });
    expect(answeringText('Assistant')).toBe('Assistant is answering…');
  });

  it('has no working words once the turn answered or failed, and marks a failure', () => {
    expect(commentMessage({ author: 'process:x', state: 'answered' }, 'X')).toEqual({
      from: 'assistant',
      answering: null,
      failed: false,
    });
    expect(commentMessage({ author: 'process:x', state: 'failed' }, 'X')).toMatchObject({
      answering: null,
      failed: true,
    });
    expect(commentMessage({ author: OWNER }, 'You')).toEqual({
      from: 'user',
      answering: null,
      failed: false,
    });
  });
});
