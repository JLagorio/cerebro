import type { ChatMessage, SubagentRun, ToolCall } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import { mergeSources, type CitedSource } from '@/engine/ai/sources';
import type { SourceRef } from '@/engine/ai/types';
import { cliTool } from '@/lib/policy/tools';
import { turnSources } from './turnSources';

/**
 * The rail's Sources card (M92.6, Q15): what the conversation drew on, each
 * finished reply's own list (`turnSources`, the Sources line under it)
 * merged by `mergeSources`, the latest reply's first, each source with the
 * reply its row jumps to. A reply still streaming adds nothing, as its own
 * line lists nothing until it is done: links half-typed mid-stream are no
 * sources. What a subagent found counts where its Agent call stands. Pure.
 *
 * A thread does not keep all a reply drew on: a call's structured result and
 * a subagent's steps are memory only, and come back from Claude Code's
 * session file (`healFromTranscript`). So the list may be short when that
 * file could not be read back, when a subagent that ran and used tools holds
 * none of its steps (a branch's copy, or a `subagents/` transcript gone), or
 * when a finished web call still holds no result, and says why rather than
 * reading short as whole (CV-05): partial over the lines it has; with none,
 * unavailable when the file could not be read, and not recorded when it read
 * and a reply lost what it drew on, never "None". While the file is still
 * being read, what it will put back is not missing yet.
 */

/** The card's state (CV-44): a list; nothing to list; nothing listed though
 *  a reply is known to have lost what it drew on; a list that may be short;
 *  or nothing listed with the session file unread, so nothing can tell. */
export type RailSourcesState = 'ready' | 'empty' | 'not-recorded' | 'partial' | 'unavailable';

/** Why the list may be short. */
export type RailSourcesMissing =
  /** The session file could not be read back, so the results and the
   *  subagents' steps the thread does not keep are gone with it. */
  | 'transcript'
  /** A subagent ran and used tools, and none of its steps are in hand, so
   *  nothing it drew on can be listed. */
  | 'steps'
  /** A finished web call holds no result: the thread did not keep it, and
   *  the session file did not give it back. */
  | 'results';

export interface RailSources {
  state: RailSourcesState;
  /** Every source, the latest reply's first, each under the latest reply
   *  that drew on it. */
  cited: readonly CitedSource[];
  /** Why the list may be short; null when nothing is known to be missing. */
  missing: RailSourcesMissing | null;
}

/** The manifest's family for the CLI's web tools (tool-approval's own
 *  column, `cliTool`), whose finds a call's result alone holds. */
const WEB_FAMILY = 'web';

/** A finished reply's part of the list. */
interface ReplySources {
  turn: string;
  sources: readonly SourceRef[];
  /** What it may be short of: a subagent's steps, or a finished web call's
   *  result; null when nothing is known to be missing. */
  lost: 'steps' | 'results' | null;
}

/** A subagent that ran and used tools, none of whose steps are in hand: the
 *  test its line in the transcript makes before it says "Steps not
 *  recorded". Its own failure says why it has none. */
function stepsLost(run: SubagentRun): boolean {
  const ran = run.status === 'done' || run.status === 'failed' || run.status === 'interrupted';
  return (
    ran &&
    (run.error?.trim() ?? '') === '' &&
    run.toolUses !== 0 &&
    run.parts.length === 0 &&
    run.tools.length === 0
  );
}

/** A finished web call that holds no result, at any depth. A call that
 *  failed or that Claude Code refused found nothing to lose. */
function lostResult(tool: ToolCall): boolean {
  return (
    tool.done &&
    !tool.failed &&
    tool.denied === undefined &&
    tool.result === undefined &&
    cliTool(tool.name)?.family === WEB_FAMILY
  );
}

/** What `tools` may be short of, at any depth: a subagent's steps first,
 *  since they hold every result of theirs. */
function lostIn(tools: readonly ToolCall[]): 'steps' | 'results' | null {
  let lost: 'results' | null = null;
  for (const tool of tools) {
    const run = tool.subagent;
    if (run !== undefined && tool.denied === undefined) {
      if (stepsLost(run)) return 'steps';
      const inner = lostIn(run.tools);
      if (inner === 'steps') return inner;
      lost ??= inner;
    }
    if (lostResult(tool)) lost = 'results';
  }
  return lost;
}

/** Each finished reply's part, by its message: a turn's stream replaces its
 *  own reply alone, so every other reply's part is read from here. */
const parts = new WeakMap<ChatMessage, ReplySources>();

function replySources(message: ChatMessage): ReplySources {
  let part = parts.get(message);
  if (part === undefined) {
    part = { turn: message.id, sources: turnSources(message), lost: lostIn(message.tools) };
    parts.set(message, part);
  }
  return part;
}

/** The card's state, from how many lines it lists and why the list may be
 *  short: a list known to be short is partial; nothing listed is unavailable
 *  when the session file could not be read, not recorded when a reply lost
 *  what it drew on, and empty only when nothing is known to be missing. */
function stateOf(lines: number, missing: RailSourcesMissing | null): RailSourcesState {
  if (lines > 0) return missing === null ? 'ready' : 'partial';
  if (missing === null) return 'empty';
  return missing === 'transcript' ? 'unavailable' : 'not-recorded';
}

/** The last list made, with the parts it was made from and why it may be
 *  short. */
let last: {
  from: readonly ReplySources[];
  missing: RailSourcesMissing | null;
  list: RailSources;
} | null = null;

/**
 * The conversation's sources, as the card lists them. The same list comes
 * back while its finished replies are the same ones and the same is
 * missing, so a turn's stream, which changes neither, never hands the card a
 * new one.
 */
export function railSources(
  messages: readonly ChatMessage[],
  transcript: TranscriptStatus,
): RailSources {
  const from = messages
    .filter((message) => message.role === 'assistant' && message.streaming !== true)
    .map(replySources);
  const missing: RailSourcesMissing | null =
    transcript.state === 'unavailable'
      ? 'transcript'
      : transcript.state === 'reading'
        ? null
        : from.some((part) => part.lost === 'steps')
          ? 'steps'
          : from.some((part) => part.lost === 'results')
            ? 'results'
            : null;
  if (
    last !== null &&
    last.missing === missing &&
    last.from.length === from.length &&
    last.from.every((part, at) => part === from[at])
  ) {
    return last.list;
  }
  const cited = mergeSources(from);
  const list: RailSources = { state: stateOf(cited.length, missing), cited, missing };
  last = { from, missing, list };
  return list;
}
