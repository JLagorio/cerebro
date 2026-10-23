import type { MessageFrom } from '@/components/ai/Message';
import { OWNER, type PageComment } from '@/engine/comments';

/**
 * A page comment as the Message element draws it (M91.14): the person's own
 * comment, or an agent's — a thread turn's answer to an `@handle` (M70.4), an
 * agent's reply, the panel's own turn. Pure: the row in CommentThread draws
 * it, and nothing here can start a turn (CV-36).
 */

/** The working words a pending answer shows, in its agent's name. */
export const answeringText = (who: string): string => `${who} is answering…`;

/** Who spoke. The person is the only human author (D1); every other author
 *  an agent's (`claude-code`, `process:<name>`, `agent:<id>`). */
export const commentFrom = (author: string): MessageFrom =>
  author === OWNER ? 'user' : 'assistant';

export interface CommentMessageView {
  from: MessageFrom;
  /** An agent's turn is under way: its placeholder shows these words, never
   *  a body. Null once it answered, or failed. */
  answering: string | null;
  /** The turn ended without an answer: its body says why, in a quieter ink. */
  failed: boolean;
}

export function commentMessage(
  comment: Pick<PageComment, 'author' | 'state'>,
  who: string,
): CommentMessageView {
  return {
    from: commentFrom(comment.author),
    answering: comment.state === 'pending' ? answeringText(who) : null,
    failed: comment.state === 'failed',
  };
}
