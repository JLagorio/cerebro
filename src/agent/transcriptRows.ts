import type { ToolCall } from './types';
import { bareToolName, toolFacts, type FoldPhrases, type ToolFacts } from '@/lib/policy/tools';

/**
 * A message's tool calls as transcript rows (M56.8): pure, no DOM.
 *
 * Five get_note calls in a row are one row, "Read 5 notes", because what the
 * person wants from a run of reads is that it happened, not five cards. The
 * manifest says which tools fold and in what words (`fold {one, many}` on a
 * read row, tools.v1.json), so no tool is named here (CV-04). Only reads fold:
 * a write keeps its path in view, and the rows a cerebro tool owns (a concept,
 * a handoff, a commit) stand alone. A failed or interrupted read is never
 * folded out of sight (Q20): it stands on its own row and breaks the run.
 *
 * Whether a call is unfinished is decided once per message, from its
 * streaming flag: a call that is not done while its message streams is
 * running; once the turn has stopped (a stop, a cut-off, a reload) it is
 * interrupted, and it may have completed. A call a hook deferred (M57.1) is
 * neither: it is waiting while its card is open, cancelled once the person
 * stopped the turn, paused when a hook outside Cerebro held it, and not run
 * otherwise. None of those four ever folds.
 */

export type ToolStatus =
  'running' | 'done' | 'failed' | 'interrupted' | 'waiting' | 'cancelled' | 'not_run' | 'paused';

/** One call, drawn by its own renderer. */
export interface ToolRow {
  kind: 'tool';
  key: string;
  tool: ToolCall;
  status: ToolStatus;
}

/** Two or more consecutive reads, folded into one row. */
export interface ToolGroupRow {
  kind: 'group';
  key: string;
  /** "Read 5 notes", from the manifest's phrases. */
  label: string;
  /** "Reading 5 notes": the same row in its running words (M91.1's
   * `fold.running`), or null where a member's row names none. */
  runningLabel: string | null;
  members: ToolRow[];
  /** A member is still running. */
  running: boolean;
}

export type TranscriptRow = ToolRow | ToolGroupRow;

/** What the manifest says about a call: `toolFacts`, or a stand-in in tests. */
export type FactsOf = (name: string) => Pick<ToolFacts, 'fold'> | null;

/** A call's status, given whether its message is still streaming and which
 * call, if any, a card is waiting on (M57.1). */
export function toolStatus(
  tool: ToolCall,
  streaming: boolean,
  waitingToolId: string | null = null,
): ToolStatus {
  if (tool.done) return tool.failed ? 'failed' : 'done';
  if (tool.cancelled === true) return 'cancelled';
  if (tool.deferred === true) {
    if (tool.id === waitingToolId) return 'waiting';
    return tool.paused === true ? 'paused' : 'not_run';
  }
  return streaming ? 'running' : 'interrupted';
}

/** `parts` joined as a list is read: "a and b", "a, b, and c". */
function joinParts(parts: string[]): string {
  if (parts.length <= 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * A group's label: each tool counted, in the order first seen, a count of one
 * in its `one` phrase and more in its `many` with the count for `{n}`, joined
 * as a list and capitalized. Five get_note calls read "Read 5 notes".
 */
export function groupLabel(tools: ToolCall[], factsOf: FactsOf = toolFacts): string {
  return labelOf(tools, factsOf, (fold) => fold) ?? '';
}

/**
 * The same label in its running words (M91.1's `fold.running`): "Reading 5
 * notes". Null when a tool's fold names no running words, so the row keeps
 * its label and says it runs in words of its own.
 */
export function runningGroupLabel(tools: ToolCall[], factsOf: FactsOf = toolFacts): string | null {
  return labelOf(tools, factsOf, (fold) => fold.running ?? null);
}

/** Each tool counted in the phrases `pick` takes from its fold, or null when
 * one of them has none. */
function labelOf(
  tools: ToolCall[],
  factsOf: FactsOf,
  pick: (fold: FoldPhrases) => { one: string; many: string } | null,
): string | null {
  const counts = new Map<string, { name: string; count: number }>();
  for (const tool of tools) {
    const key = bareToolName(tool.name);
    const seen = counts.get(key);
    if (seen === undefined) counts.set(key, { name: tool.name, count: 1 });
    else seen.count += 1;
  }
  const parts: string[] = [];
  for (const { name, count } of counts.values()) {
    const fold = factsOf(name)?.fold;
    if (fold == null) continue;
    const phrases = pick(fold);
    if (phrases === null) return null;
    parts.push(count === 1 ? phrases.one : phrases.many.replace('{n}', String(count)));
  }
  const label = joinParts(parts);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * A message's calls as rows, in order. A run of two or more consecutive calls
 * that fold and are done or running becomes one group; a single one stays a
 * call row, and so does every other call. `waitingToolId` is the call a card
 * waits on (M57.1), if any.
 */
export function transcriptRows(
  tools: ToolCall[],
  streaming: boolean,
  factsOf: FactsOf = toolFacts,
  waitingToolId: string | null = null,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let run: ToolRow[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const members = run;
      const tools = members.map((m) => m.tool);
      rows.push({
        kind: 'group',
        key: `group-${members[0].key}`,
        label: groupLabel(tools, factsOf),
        runningLabel: runningGroupLabel(tools, factsOf),
        members,
        running: members.some((m) => m.status === 'running'),
      });
    } else {
      rows.push(...run);
    }
    run = [];
  };
  for (const tool of tools) {
    const row: ToolRow = {
      kind: 'tool',
      key: tool.id,
      tool,
      status: toolStatus(tool, streaming, waitingToolId),
    };
    const folds =
      factsOf(tool.name)?.fold != null && (row.status === 'done' || row.status === 'running');
    if (folds) {
      run.push(row);
      continue;
    }
    flush();
    rows.push(row);
  }
  flush();
  return rows;
}
