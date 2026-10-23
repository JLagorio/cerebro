import { inputField } from '@/agent/elements/turnTitles';
import { findCall } from '@/agent/transcript';
import type { ChatMessage, ToolCall } from '@/agent/types';
import type { WaitingCard } from '@/agent/useAgentChat';

/**
 * The call the conversation waits on (M92.4, §2), as the rail's Waiting card
 * draws it: the card the thread shows (`chat.interaction`, one per thread,
 * live, or brought back after a reload by `waitOnCard`'s read of the book),
 * what it asks, and, when the asking call is a subagent's own (its `parent`
 * names the Agent call that started it, M91.4), that subagent. Pure.
 *
 * Kept per card, and by the asking reply's `tools` array, which a streamed
 * word leaves as it was: the rail draws nothing again until the card changes
 * or that reply's calls name another asker.
 */

export interface RailWaiting {
  /** The book's id for the card. */
  id: string;
  /** The tool the held call would run, for its icon. */
  toolName: string;
  /** What it asks, as the book words it: the tool's title and its target. */
  summary: string;
  /**
   * The subagent whose own call asks: its type and task, each '' where
   * nothing recorded it. Null for the turn's own call, and for a call the
   * reply does not hold, which names no one.
   */
  asker: { type: string; description: string } | null;
  /** An answer is on its way. */
  answering: boolean;
  /** Rust's words for an answer that came too late: the card no longer
   *  waits. */
  stale: string | null;
}

/** The transcript row a waiting card is drawn in: what its jump goes to. */
export function waitingRowId(cardId: string): string {
  return `waiting:${cardId}`;
}

/** Who asked, among the reply's calls: the Agent call `asking.parent`
 *  names, as its run says, else as its input does; one the reply does not
 *  hold recorded nothing of itself. */
function askerOf(tools: readonly ToolCall[], toolId: string): RailWaiting['asker'] {
  const asking = findCall(tools, toolId);
  if (asking?.parent === undefined) return null;
  const agent = findCall(tools, asking.parent);
  if (agent === null) return { type: '', description: '' };
  const run = agent.subagent;
  return run === undefined
    ? {
        type: inputField(agent, 'subagent_type') ?? '',
        description: inputField(agent, 'description') ?? '',
      }
    : { type: run.type, description: run.description };
}

function sameAsker(a: RailWaiting['asker'], b: RailWaiting['asker']): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.description === b.description;
}

const kept = new WeakMap<WaitingCard, { tools: readonly ToolCall[] | null; view: RailWaiting }>();

/** The thread's waiting card as the rail draws it, or null with none. */
export function railWaiting(
  interaction: WaitingCard | null,
  messages: readonly ChatMessage[],
): RailWaiting | null {
  if (interaction === null) return null;
  const tools = messages.find((m) => m.id === interaction.messageId)?.tools ?? null;
  const held = kept.get(interaction);
  if (held !== undefined && held.tools === tools) return held.view;
  const { card } = interaction;
  const asker = tools === null ? null : askerOf(tools, card.tool_id);
  // Another step in the reply (a subagent still working beside the one that
  // asks) makes new calls, and names the same asker.
  const view: RailWaiting =
    held !== undefined && sameAsker(held.view.asker, asker)
      ? held.view
      : {
          id: card.id,
          toolName: card.tool_name,
          summary: card.summary,
          asker,
          answering: interaction.answering,
          stale: interaction.stale,
        };
  kept.set(interaction, { tools, view });
  return view;
}
