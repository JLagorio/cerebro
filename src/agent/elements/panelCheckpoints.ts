import type { ChatMessage } from '@/agent/types';
import type { ThreadBlock, TranscriptStatus } from '@/agent/useConversations';

/**
 * Branch from here, between turns (M91.12c, Q8): the replies the panel
 * offers a branch after, each with the turn its Checkpoint names. Pure.
 *
 * A branch's first send forks the reply's session at its anchor, and Rust
 * checks that anchor only then (M91.6), so a branch is offered only where it
 * can be taken: after a reply whose turn named the line it ended on (its
 * anchor), in a thread that can continue (not cleared, expired, or had in
 * another vault), whose transcript reads (not unavailable, and not still
 * being read), and with a later message to leave behind: after the last
 * reply, a branch would only be the thread itself.
 */

/** What the thread says about whether it can be branched now. */
export interface BranchState {
  /** Why the thread cannot continue, or null when it can. */
  blocked: ThreadBlock;
  /** What reading the thread's transcript found. */
  transcript: TranscriptStatus;
}

/** How much of a message a Checkpoint's name quotes. */
const QUOTE_MAX = 60;

/** A transcript that is read, rebuilt, healed, or has nothing to read yet. */
function readable(transcript: TranscriptStatus): boolean {
  return (
    transcript.state === 'idle' || transcript.state === 'rebuilt' || transcript.state === 'healed'
  );
}

/** The reply names a line to branch at, as `branchFrom` reads it. */
function anchored(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.anchor !== undefined &&
    message.anchor.sessionId !== '' &&
    message.anchor.uuid !== ''
  );
}

/** A message's words on one line, cut to `QUOTE_MAX` characters with an
 *  ellipsis. Counted by code point, so a cut never splits a surrogate pair
 *  into a name a screen reader spells as a replacement character. */
function quoted(text: string): string {
  const line = [...text.replace(/\s+/g, ' ').trim()];
  if (line.length <= QUOTE_MAX) return line.join('');
  const cut = line.slice(0, QUOTE_MAX - 1).join('');
  return `${cut.trimEnd()}…`;
}

/**
 * The turn a Checkpoint after `reply` names, its button's name ending
 * "after <turn>": the person's message the reply answered, or, with none
 * before it, the reply itself.
 */
export function branchTurn(asked: ChatMessage | null, reply: ChatMessage): string {
  if (asked !== null) {
    const words = quoted(asked.text);
    return words === '' ? 'your message' : `your message “${words}”`;
  }
  const words = quoted(reply.text);
  return words === '' ? 'this reply' : `the reply “${words}”`;
}

/** The replies a branch is offered after, by id, each with its turn's name. */
export function branchPoints(
  messages: readonly ChatMessage[],
  { blocked, transcript }: BranchState,
): ReadonlyMap<string, string> {
  const points = new Map<string, string>();
  if (blocked !== null || !readable(transcript)) return points;
  let asked: ChatMessage | null = null;
  messages.forEach((message, at) => {
    if (message.role === 'user') {
      asked = message;
      return;
    }
    if (at === messages.length - 1 || !anchored(message)) return;
    points.set(message.id, branchTurn(asked, message));
  });
  return points;
}
