import { chainOpens, turnItems, turnLines, type TurnLine } from '@/agent/elements/turn';
import type { ChatMessage } from '@/agent/types';

/**
 * A replayed turn in a run's detail (M91.14), drawn as the conversation
 * draws a reply (elements/turn.ts): its reasoning and folded reads in one
 * chain of thought, every other call a line of its own, and each message's
 * words where they came, the last its answer. Pure: what `replayTranscript`
 * rebuilt in, the view out. It is a record, so nothing in it offers to act:
 * the rows are drawn read-only by their caller.
 */

export interface ReplayedTurn {
  lines: TurnLine[];
  /** Whether its chain of thought starts open: the run's latest turn's
   *  does, and so does one still at work or holding a failure. */
  chainOpen: boolean;
  /** How the turn failed: Rust's title for a failure it typed (M56.4), else
   *  Claude Code's own words. Null for a turn that did not fail. */
  failure: { typed: boolean; text: string } | null;
  /** The file ends it unfinished and its run is over: it was cut off. A turn
   *  its running run is still writing is not. */
  interrupted: boolean;
}

export function replayedTurn(
  message: ChatMessage,
  { live, latest }: { live: boolean; latest: boolean },
): ReplayedTurn {
  const lines = turnLines(turnItems(message, { streaming: live }));
  const chain = lines.find((line) => line.kind === 'chain');
  return {
    lines,
    chainOpen: chain !== undefined && chainOpens(chain.summary, latest),
    failure:
      message.error === undefined
        ? null
        : message.notice !== undefined
          ? { typed: true, text: message.notice.title }
          : { typed: false, text: message.error },
    interrupted: message.interrupted === true && !live,
  };
}
