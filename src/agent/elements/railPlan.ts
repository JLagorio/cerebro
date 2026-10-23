import type { LivePlan } from '@/agent/elements/panelPlan';
import type { ChatMessage, ToolCall, TranscriptUnavailable } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import type { RailSectionState } from '@/components/ai/Rail';
import { latestTodos, type TodoList } from '@/engine/ai/todos';
import type { TodoItem } from '@/engine/ai/types';
import { toolRenderer } from '@/engine/tools';

/**
 * The conversation's plan, as the rail's Plan card shows it (M92.17, §0
 * Q11): the latest todo list any of its replies left that can be read, live
 * while a turn writes it and kept once the turn is done, where the dock's
 * plan (`livePlan`) shows the turn at work's alone. Pure.
 *
 * A reply's lists are read as the dock reads them: the manifest's `todo`
 * renderer names the calls (CV-04), `latestTodos` reads each one (its result
 * before its input, the whole input before its preview), a subagent's calls
 * are its own, and a call that failed or that Claude Code refused wrote
 * nothing. They are read once per reply's calls, and each call once: a
 * streamed word replaces the reply but keeps its calls, and an event about
 * one call keeps every other, so a turn's stream hands the card the same
 * plan until a list call changes.
 *
 * A thread keeps a call's input as its preview, each long string cut, and
 * the whole in memory only, until Claude Code's session file heals it back
 * (conversations.ts). A list read from a preview that cut it is not the list
 * the agent wrote, so the plan reads not recorded rather than passing for it
 * (CV-05). A latest write that reads as no list leaves the list before it
 * showing, as an earlier one. With no list to show, what reading the session
 * file back found decides: still reading, the card waits; a read that
 * failed, unavailable; a file that is gone, not recorded.
 */

/** What the card says of the plan (CV-44), or `reading` while the session
 *  file that could hold it is still being read: a claim made then could be
 *  wrong a moment later, so the card makes none. */
export type RailPlanState = RailSectionState | 'reading';

/** A list as the card draws it: `latestTodos`' list and counts, split as
 *  the dock splits it. */
export type RailPlanList = TodoList & LivePlan;

export interface RailPlan {
  state: RailPlanState;
  /** The list shown: the latest that reads, or an earlier one when the
   *  latest does not (`partial`). An empty one when the agent wrote one
   *  (`empty`); null when there is none to show. */
  list: RailPlanList | null;
  /** The list is the turn at work's own: the conversation's latest reply
   *  wrote it, so its step under way is under way while that turn works. */
  current: boolean;
}

/**
 * How many characters of an input string a call's preview keeps before it
 * cuts the string and marks the cut with an ellipsis: fold.rs's
 * `INPUT_PREVIEW_CHARS`, which the long-payload golden holds this to.
 */
export const INPUT_PREVIEW_CHARS = 160;

/** The ellipsis the fold ends a cut string on. */
const CUT = '…';

/**
 * Did a call's preview cut `text`? A string the preview kept whole runs at
 * most `INPUT_PREVIEW_CHARS` characters, counted as Rust counts them (by code
 * point); one it cut runs exactly one more, the ellipsis that marks the cut.
 * An ellipsis the agent wrote itself ends a string kept whole, so it never
 * reads as a cut.
 */
export function cutByPreview(text: string): boolean {
  return (
    text.length > INPUT_PREVIEW_CHARS &&
    text.endsWith(CUT) &&
    Array.from(text).length === INPUT_PREVIEW_CHARS + 1
  );
}

/** One todo call that wrote: the list it left, whether that list was read
 *  from a preview that cut it, and whether the call was still running. */
interface Write {
  list: TodoList | null;
  cut: boolean;
  running: boolean;
}

const cutItem = (todo: TodoItem): boolean =>
  cutByPreview(todo.content) ||
  cutByPreview(todo.status) ||
  (todo.activeForm !== undefined && cutByPreview(todo.activeForm));

/** Each call's write, by the call: the reducer replaces only the call an
 *  event is about, so a reply's other calls keep theirs. */
const writesByCall = new WeakMap<ToolCall, Write>();

function writeOf(tool: ToolCall): Write {
  let write = writesByCall.get(tool);
  if (write === undefined) {
    const list = latestTodos([
      { input: tool.payload?.input ?? tool.input, result: tool.result ?? null },
    ]);
    const fromPreview = tool.result?.type !== 'todos' && tool.payload?.input === undefined;
    write = {
      list,
      cut: list !== null && fromPreview && list.todos.some(cutItem),
      running: !tool.done,
    };
    writesByCall.set(tool, write);
  }
  return write;
}

const NO_WRITES: readonly Write[] = [];

/** Each reply's writes, in order, by its calls. */
const writesByCalls = new WeakMap<readonly ToolCall[], readonly Write[]>();

function writesOf(tools: readonly ToolCall[]): readonly Write[] {
  let writes = writesByCalls.get(tools);
  if (writes === undefined) {
    const found = tools
      .filter(
        (tool) => toolRenderer(tool.name) === 'todo' && !tool.failed && tool.denied === undefined,
      )
      .map(writeOf);
    writes = found.length === 0 ? NO_WRITES : found;
    writesByCalls.set(tools, writes);
  }
  return writes;
}

/** How a list shows: as the latest reply's, as an earlier reply's latest,
 *  or in place of a latest write that reads as none. */
type Shown = 'current' | 'kept' | 'earlier';

/** The plan each list makes, by the write that left it and how it shows. */
const plans = new WeakMap<Write, Partial<Record<Shown, RailPlan>>>();

function listed(write: Write, list: TodoList, shown: Shown): RailPlan {
  let made = plans.get(write);
  if (made === undefined) {
    made = {};
    plans.set(write, made);
  }
  return (made[shown] ??= {
    state: shown === 'earlier' ? 'partial' : list.todos.length === 0 ? 'empty' : 'ready',
    list: {
      ...list,
      todo: list.todos.filter((todo) => todo.status !== 'completed'),
      done: list.todos.filter((todo) => todo.status === 'completed'),
    },
    current: shown === 'current',
  });
}

const settled = (state: RailPlanState): RailPlan => ({ state, list: null, current: false });
const NONE = settled('empty');
const NOT_RECORDED = settled('not-recorded');
const UNAVAILABLE = settled('unavailable');
const READING = settled('reading');

/** Reasons a session file has nothing to give: Claude Code cleared it, or
 *  none was recorded. Any other reason is a read that failed. */
const GONE: ReadonlySet<string> = new Set<TranscriptUnavailable>([
  'cleared',
  'expired',
  'not_recorded',
]);

/**
 * The plan when no list can be shown: `lost`, the conversation holds a list
 * that does not read whole, or `nothing`, it holds no reply at all. Its
 * session file may yet put either back, or say why it cannot.
 */
function unshown(kind: 'lost' | 'nothing', transcript: TranscriptStatus): RailPlan {
  if (transcript.state === 'reading') return READING;
  if (transcript.state === 'unavailable') {
    return GONE.has(transcript.reason) ? NOT_RECORDED : UNAVAILABLE;
  }
  return kind === 'lost' ? NOT_RECORDED : NONE;
}

const IDLE: TranscriptStatus = { state: 'idle' };

/**
 * The conversation's plan. The same plan comes back while the write it
 * shows is the same one and shows the same way, so a turn's stream, which
 * changes neither, never hands the card a new one.
 *
 * Its replies are what the thread holds, every call each one made among
 * them, so a reply that wrote no list wrote none whatever the session file
 * says; only a thread holding no reply, or a list that does not read whole,
 * waits on `transcript`.
 */
export function railPlan(
  messages: readonly ChatMessage[],
  transcript: TranscriptStatus = IDLE,
): RailPlan {
  let replies = false;
  // The latest write read as no list.
  let unread = false;
  // Until a person's message, the first reply met is the latest.
  let latest = true;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message.role !== 'assistant') {
      latest = false;
      continue;
    }
    replies = true;
    const own = latest;
    latest = false;
    const writes = writesOf(message.tools);
    for (let w = writes.length - 1; w >= 0; w -= 1) {
      const write = writes[w];
      if (write.list === null) {
        unread = true;
        continue;
      }
      // A call still running in the reply that streams takes its whole input
      // next: the fold sends it straight after the start whenever the preview
      // cut a string. One a stopped or saved reply left running never will.
      if (write.cut && !(write.running && message.streaming === true)) {
        return unshown('lost', transcript);
      }
      return listed(write, write.list, unread ? 'earlier' : own ? 'current' : 'kept');
    }
  }
  if (unread) return unshown('lost', transcript);
  return replies ? NONE : unshown('nothing', transcript);
}
