import type { StepState } from '@/components/ai/StepLine';
import { durationBetween } from '@/agent/transcript';
import type { ToolStatus } from '@/agent/transcriptRows';
import type { SubagentRun, ToolCall } from '@/agent/types';
import { toolDisplay, toolRenderer } from '@/engine/tools';
import { cliTool, toolFacts, type ToolFacts } from '@/lib/policy/tools';

/**
 * What a call's line says (M91.13): its title in its state's tense, the
 * thing it was aimed at, and what its detail holds. Pure: a call in, words
 * out, read off the tool manifest (CV-04), so no tool is named here.
 *
 * A row whose manifest names its status `phrases` says them: "Appending to a
 * note", "Appended to a note", "Failed to append to a note". Any other says
 * its name, as the card always did ("search notes", a connector's "get
 * thread"), and its state in words: "Failed: …" and "Denied: …" on the line
 * itself, "Running" before it for a screen reader, and the transcript's own
 * sentences under it for a call a stopped turn or a hook left (StepLine's
 * `STEP_STATUS_WORDS`, the one vocabulary).
 */

/** What the manifest says of a call: `toolFacts`, or a stand-in in tests. */
export type CallFactsOf = (name: string) => Pick<ToolFacts, 'phrases'> | null;

/** A whole payload's size, as the cut note names it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / 1024 / 1024, 'MB'];
  return `${Number(value.toFixed(1))} ${unit}`;
}

/** What a call's detail shows of one part: the whole when a payload carried
 * it, else the preview; and the note when the 256 KiB cap cut even the
 * whole. */
export function payloadPart(
  preview: string | null,
  whole: string | undefined,
  truncated: boolean | undefined,
  bytes: number | undefined,
): { text: string | null; cut: string | null } {
  if (whole === undefined) return { text: preview, cut: null };
  return {
    text: whole,
    cut:
      truncated === true && bytes !== undefined
        ? `Showing the first 256 KB of ${formatSize(bytes)}.`
        : null,
  };
}

/** The path a tool touched, for the collapsed line. */
export function toolPath(input: string | null): string | null {
  if (input === null || input.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'slug', 'to', 'folder', 'query', 'pattern']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return null;
  } catch {
    return null;
  }
}

/** A successful checked change can land beside a taken name. Its structured
 * reply is authoritative for Open; a failed or pending call has no landing. */
export function landedPath(tool: ToolCall): string | null {
  if (!tool.done || tool.failed || toolRenderer(tool.name) !== 'change') return null;
  try {
    const value: unknown = JSON.parse(tool.payload?.output ?? tool.output ?? 'null');
    if (
      typeof value === 'object' &&
      value !== null &&
      'path' in value &&
      typeof value.path === 'string' &&
      value.path !== ''
    )
      return value.path;
  } catch {
    /* Older text replies keep the input target. */
  }
  return null;
}

/** One string field of a call's input, the whole one first. */
export function inputField(tool: ToolCall, key: string): string | null {
  for (const text of [tool.payload?.input, tool.input]) {
    if (text == null) continue;
    try {
      const value = (JSON.parse(text) as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // A cut input is not JSON; the preview may still be.
    }
  }
  return null;
}

/** A call's output, the whole one first. */
export function outputOf(tool: ToolCall): string | null {
  return tool.payload?.output ?? tool.output;
}

/** A JSON object or array laid out, anything else as it came. */
export function laidOut(text: string): { text: string; json: boolean } {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null) {
      return { text: JSON.stringify(value, null, 2), json: true };
    }
  } catch {
    // Not JSON: a shell's output, a refusal's words.
  }
  return { text, json: false };
}

/**
 * What a call was aimed at, for its line: where a change landed, the path or
 * query its input names, else the input field the manifest names it by (a
 * command, a URL, a subagent's task).
 */
export function callSubject(tool: ToolCall): string | null {
  const landed = landedPath(tool) ?? toolPath(tool.input);
  if (landed !== null) return landed;
  const field = cliTool(tool.name)?.subject ?? null;
  return field === null ? null : inputField(tool, field);
}

/** A call Claude Code refused by its own rules reads denied, whatever its
 * ToolDone said (M91.3a): it never ran. */
export function stepStateOf(tool: ToolCall, status: ToolStatus): StepState {
  return tool.denied !== undefined ? 'denied' : status;
}

/** A call's line, as StepLine's head takes it: its title, and its state's
 * words when the title does not already say them (`statusText`, left out
 * for the state's own). */
export interface CallWords {
  title: string;
  statusText?: string | null;
}

const capital = (phrase: string): string => phrase.charAt(0).toUpperCase() + phrase.slice(1);

export function callWords(
  tool: ToolCall,
  state: StepState,
  factsOf: CallFactsOf = toolFacts,
): CallWords {
  const { label } = toolDisplay(tool.name);
  const phrases = factsOf(tool.name)?.phrases ?? null;
  switch (state) {
    case 'running':
      // "Appending to a note" says it runs; a name needs the word before it.
      return phrases === null
        ? { title: label }
        : { title: capital(phrases.running), statusText: null };
    case 'done':
      return { title: phrases === null ? label : capital(phrases.done) };
    case 'failed':
      // Said on the line, not only in danger ink: "Failed to …", "Failed: …".
      return { title: phrases === null ? `Failed: ${label}` : capital(phrases.failed) };
    case 'denied':
      return { title: `Denied: ${label}` };
    default:
      // A call that never finished keeps its name; its sentence says why.
      return { title: label };
  }
}

/** How long a call took, from the two times Claude Code stamped (M91.4),
 * or nothing when either is missing (CV-05). */
export function callDuration(tool: ToolCall): number | undefined {
  return durationBetween(tool.startedAt, tool.endedAt);
}

/** A call that runs a command: its result is a shell's, or the manifest's
 * family for it is the shell (tool-approval's own column). */
export function isShellCall(tool: ToolCall): boolean {
  return tool.result?.type === 'shell' || cliTool(tool.name)?.family === 'shell';
}

/** The command a shell call ran, as the manifest names its input. */
export function shellCommand(tool: ToolCall): string | null {
  const field = cliTool(tool.name)?.subject ?? null;
  return field === null ? null : inputField(tool, field);
}

/** The run a hand-off started, as `hand_to` reports it ("Started … (run
 * <id>) …", mcp.rs), or null when its words name none. */
export function handoffRunId(output: string | null): string | null {
  if (output === null) return null;
  return /\(run ([A-Za-z0-9_-]+)\)/.exec(output)?.[1] ?? null;
}

/**
 * A subagent's line when Claude Code refused its Agent call (M91.3a): the
 * reducer reads such a run failed, and its line says "Denied …", never
 * "Failed …". Nothing to say of one that was not refused: the element words
 * it. A task nobody named is never printed as "".
 */
export function subagentWords(run: SubagentRun, denied: boolean): CallWords | null {
  if (!denied) return null;
  const task = run.description.trim();
  return { title: task === '' ? 'Denied a subagent' : `Denied: ${task}`, statusText: null };
}
