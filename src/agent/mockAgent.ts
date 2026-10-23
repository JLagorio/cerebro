import { answeredText, declinedText, markMockQuestion, mockQuestions } from './mockInteractions';
import type {
  AgentStreamEvent,
  FailureNotice,
  PendingInteraction,
  PersonAnswer,
  RunReach,
  TodoStatus,
  ToolResultData,
  UiAction,
} from './types';
import type { QuoteEdit } from '@/engine/quote';
import {
  APPROVAL_MESSAGES,
  familyCard,
  hostAnswer,
  subjectIsCut,
  writeDeclined,
  type Decision,
  type RunApproval,
} from '@/lib/policy/toolApproval';
import { answersFor, type QuestionAnswer } from '@/engine/questionForm';
import { changedKeys } from '@/engine/writeDraft';
import { TOOLS, isConfirmable, toolFacts } from '@/lib/policy/tools';
import { slugify } from '@/lib/slug';
import { grantedTools, mentionedTools } from '@/engine/toolGrant';
import { parseSuggestionResult } from '@/engine/viewSuggestion';

/**
 * Scripted agent for browser dev, vitest, and Playwright (M6).
 *
 * The real agent is a local process reached through Tauri, which does not
 * exist in a browser. Rather than leave the panel untestable outside the
 * packaged app, the mock replays a realistic stream — text, a tool call, a
 * result — so the transcript, tool chips, streaming state, and stop button
 * all exercise the same code path they will in production.
 *
 * It is deliberately keyword-driven rather than random: a test that asserts
 * on the reply needs the reply to be a function of the prompt.
 * `edit sheet in <path>.md: <json>` carries its checked batch through
 * onEditSheet and the same write gate as the other page writers (M67.2b).
 * `edit canvas <path>.canvas: <json ops>` uses onEditCanvas and that gate
 * for an atomic whiteboard change (M68.7b).
 * `create canvas <slug> in <folder>: <json ops>` uses onCreateCanvas;
 * the optional operations fill the new board in its single create (M68.7c).
 * `research … with subagents`, `think it through`, `make a todo list`, `run
 * the tests`, `fail with a stack trace` and `search the web` play what Rust's
 * fold sends for subagents, reasoning, todos, shell and web results, with
 * the CLI's times and a branch anchor (M91.4), and their result's count of
 * how long the run worked (M92.2). A run handed its plan says what it
 * reaches right after its init (M92.8), as Rust's init gate does.
 */

/** One call a script makes, and what it returns when the script says (a
 * write's report comes from its own step). */
interface ScriptCall {
  name: string;
  input: string;
  output?: string;
  /** Its result is an error (M91.4), as a command that exits non-zero. */
  failed?: true;
  /** What its result's structure says (M91.4), sent after its ToolDone as
   * Rust's fold sends it. */
  result?: ToolResultData;
  /** The reasoning the model streams before it makes the call (M91.4). */
  thinking?: string;
  /** How long it takes on the run's clock (M91.4), in ms. */
  ms?: number;
  /** The subagent an Agent call starts (M91.4): its steps run between the
   * call's start and its report. */
  subagent?: MockSubagent;
}

/** A subagent a script's Agent call starts (M91.4): a cerebro-researcher
 * that thinks, reads with its own calls and reports. */
interface MockSubagent {
  type: string;
  description: string;
  thinking: string;
  steps: { name: string; input: string; output: string; progress: string; ms: number }[];
  report: string;
}

interface Script {
  thinking?: string;
  /** Each call it makes. */
  tools?: ScriptCall[];
  /** The reasoning streamed before the reply (M91.4). */
  answerThinking?: string;
  /** Its events carry the CLI's times and its end the line uuid a branch
   * starts from (M91.4), as Rust's do. */
  stamped?: true;
  /**
   * A UI action the run drives, fired after its tools report done. The mock
   * has to actually DO what its reply claims — a script that says "I have
   * proposed a filing" without emitting the proposal makes the panel's own
   * transcript the least trustworthy thing on screen, and leaves the real
   * propose-and-review path with no test running through it.
   */
  uiAction?: UiAction;
  /**
   * What its `append_to_note` calls write (M53.6), in call order — one of the
   * scripts that change the vault, so a page open on the file has a real
   * write to hear mid-turn. Two or more when the message chains appends with
   * " then " (M58.3), so a turn writes two files.
   */
  appends?: { path: string; content: string }[];
  /** What its `edit_note` call replaces (M55.5) — another. */
  edit?: { path: string; edits: QuoteEdit[] };
  sheetEdit?: { path: string; json: string };
  canvasEdit?: { path: string; ops: unknown };
  canvasCreate?: { slug: string; folder: string; ops?: unknown };
  notionImport?: { page: string; folder: string };
  /** What its `set_fields` call sets (M60.4) — another: one field, to one
   * value, checked against the record's database. */
  fields?: SetFieldsCall;
  /** A checked suggestion answers with a card payload and emits no UI event. */
  suggestion?: string;
  followup?: { at: string; note: string };
  /** Its comment tool's call (M70.3): it posts beside a page and changes no
   * file the vault lists, so a run of it announces the page's comments. */
  comment?: CommentCall;
  /** What its `create_note` call writes (M57.4): the page an ask-first
   * agent's card asks about. */
  create?: CreateArgs;
  /** Its first call waits, once started, until `releaseHeldMockRuns` (M57.5):
   * a turn that stays mid-tool for as long as a spec needs. */
  held?: true;
  text: string;
}

/** The set script's call (M60.4): the record, the field and its value. */
export interface SetFieldsCall {
  path: string;
  field: string;
  value: string;
}

/** A comment script's call (M70.3): which comment tool, and its arguments. */
export interface CommentCall {
  tool: CommentTool;
  args: Record<string, unknown>;
}

export type CommentTool = 'comment_on_note' | 'reply_to_comment' | 'resolve_comment';

/** `create_note`'s arguments as the create script sends them; `if new`
 * sends `if_exists: 'refuse'` (M61.6b). */
export interface CreateArgs {
  folder: string;
  slug: string;
  body: string;
  if_exists?: 'suffix' | 'refuse';
}

/** What the model reads after a write the person edited before allowing it
 * (M57.4b), as mcp.rs's `edited_sentence` words it. */
export function editedText(keys: string[]): string {
  return `The person changed your draft before allowing it (${keys.join(', ')}); what landed is their version.`;
}

/** `create "<title>" in <folder>` (M57.4), on the message's last line, a
 * leading `@handle ` stripped: the page write an ask-first agent asks about.
 * A trailing `if new` (M61.6b) asks create_note to refuse a taken name.
 * Matched right after APPEND and before the keyword branches, because the
 * risk branch would catch `records/risks`. */
const CREATE =
  /(?:^|\n)(?:@[A-Za-z0-9][A-Za-z0-9_-]*\s+)?create "([^"]+)" in ([^\s"]+)(?:[ \t]+(if new))?[ \t]*$/;

/** `append "<content>" to <note>.md`, as typed: a write script (M53.6).
 * Several, joined by " then ", append in turn (M58.3). */
const APPEND = /^append "([^"]+)" to (\S+\.md)$/;
const THEN = / then (?=append ")/;

/** `edit "<old>" to "<new>" in <note>.md`, as typed: a write script
 * (M55.5). Inside the quotes `\n` is a line break, and `<new>` may be empty,
 * which deletes the passage. */
const EDIT = /^edit "([^"]+)" to "([^"]*)" in (\S+\.md)$/;

/** `set <field> to "<value>" on <note>.md`, as typed: a write script
 * (M60.4) that calls set_fields with `{path, set: {field: value}}`. */
const SET_FIELDS = /^set (\S+) to "([^"]*)" on (\S+\.md)$/;

/** The comment scripts (M70.3), as typed: `comment "<quote>" #<k> on
 * <note>.md: <text>` (the `#<k>` an occurrence, and optional), `comment on
 * <note>.md: <text>` for the whole page, `reply to <thread> on <note>.md:
 * <text>` and `resolve <thread> on <note>.md`, with an optional `: <text>`
 * closing reply. Each calls its comment tool, which posts beside the page. */
const COMMENT_QUOTED = /^comment "([^"]+)"(?: #(\d+))? on (\S+\.md): (.+)$/;
const COMMENT_PAGE = /^comment on (\S+\.md): (.+)$/;
const REPLY = /^reply to (\S+) on (\S+\.md): (.+)$/;
const RESOLVE = /^resolve (\S+) on (\S+\.md)(?:: (.+))?$/;

/** The comment script `message` asks for, or null. */
function commentScript(message: string): Script | null {
  const quoted = COMMENT_QUOTED.exec(message);
  const page = COMMENT_PAGE.exec(message);
  const reply = REPLY.exec(message);
  const resolve = RESOLVE.exec(message);
  let call: CommentCall;
  let text: string;
  if (quoted !== null) {
    const [, quote, k, path, body] = quoted;
    const args: Record<string, unknown> = { path, quote, text: body };
    if (k !== undefined) args.occurrence = Number(k);
    call = { tool: 'comment_on_note', args };
    text = `I commented on ${path}.`;
  } else if (page !== null) {
    const [, path, body] = page;
    call = { tool: 'comment_on_note', args: { path, text: body } };
    text = `I commented on ${path}.`;
  } else if (reply !== null) {
    const [, thread, path, body] = reply;
    call = { tool: 'reply_to_comment', args: { path, thread, text: body } };
    text = `I replied in ${thread} on ${path}.`;
  } else if (resolve !== null) {
    const [, thread, path, body] = resolve;
    const args: Record<string, unknown> = { path, thread };
    if (body !== undefined) args.text = body;
    call = { tool: 'resolve_comment', args };
    text = `I resolved ${thread} on ${path}.`;
  } else {
    return null;
  }
  return { tools: [{ name: call.tool, input: JSON.stringify(call.args) }], comment: call, text };
}

/** `run "<command>"` and `ask me "<question>"` (M57.2): a call to the CLI's
 * own Bash or AskUserQuestion, on a line of its own, in the message or in a
 * job's standing instructions. Each decides through the run's tool-approval
 * plan, so the mock asks, runs and refuses as the table says. */
const RUN = /(?:^|\n)run "([^"]+)"[ \t]*(?=\n|$)/;
const ASK_ME = /(?:^|\n)ask me "([^"]+)"[ \t]*(?=\n|$)/;

/** `fetch "<url>"` (M57.7): a call to the CLI's own WebFetch, on a line of
 * its own. The plan decides it like any CLI tool: under Web access On it
 * fetches a canned page, and Off denies it in argv, so the run reads that it
 * is not available. */
const FETCH = /(?:^|\n)fetch "([^"]+)"[ \t]*(?=\n|$)/;

/** `ask me which format` (M57.3): AskUserQuestion with two questions, one
 * single-select and one multi-select, as a card shows them. `ask me
 * "<question>"` above offers no options, so it is a set no card can show. */
const ASK_FORMAT = /(?:^|\n)ask me which format[ \t]*(?=\n|$)/;

/** The questions `ask me which format` asks. */
export const FORMAT_QUESTIONS = {
  questions: [
    {
      question: 'Which format?',
      header: 'Format',
      multiSelect: false,
      options: [
        { label: 'Markdown', description: 'Headings, lists and links' },
        { label: 'Plain text', description: 'No markup at all' },
      ],
    },
    {
      question: 'Which sections?',
      header: 'Sections',
      multiSelect: true,
      options: [
        { label: 'Summary', description: 'What happened' },
        { label: 'Risks', description: 'What could go wrong' },
        { label: 'Next steps', description: 'Who does what next' },
      ],
    },
  ],
};

/** Where a job's standing instructions start in its system prompt
 * (useJobRunner's block). */
const STANDING = 'Your standing instructions, from ';

/** A quoted script argument, its `\n`s made line breaks. */
const unquote = (text: string): string => text.replace(/\\n/g, '\n');

/** What the read script reads (M56.8): five demo-vault notes, one get_note
 * each, so the panel folds them into one row. */
const READ_FIVE = /\bread five notes\b/;
const FIVE_NOTES = [
  'records/risks/risk-console-splits-the-team.md',
  'records/risks/risk-messaging-unvalidated.md',
  'records/risks/risk-rollback-unrehearsed.md',
  'records/risks/risk-scanner-delivery.md',
  'records/risks/risk-single-pilot-customer.md',
];

/** A capture that exists in the demo vault, so the proposal has a real target. */
const DEMO_CAPTURE = 'inbox/warehouse-cutover-thought.md';

/** The meeting filing ask (M64.7, `organizePrompt` with a meeting): its path
 * and its JSON-quoted title. */
const MEETING = /^File the meeting transcript at (\S+) \("([^"]*)"\)/;
/** A matched speaker's line in that ask: the quoted label, then its link. */
const MATCHED_SPEAKER = /^- "(?:[^"\\]|\\.)*" is (\[\[[^\]]+\]\])$/gm;
/** The one summary the meeting script proposes. */
export const MOCK_MEETING_SUMMARY =
  'The team agreed the rollback has to be rehearsed before cutover, and planned around a forty-minute queue drain.';

/**
 * The meeting script (M64.7): one get_note, then one propose_organize for the
 * ask's path, filed as the demo vault's meeting type with a fixed summary and
 * the attendees the ask linked. The type's name is the demo's word, here in
 * the mock only; product code never names it.
 */
function meetingScript(message: string): Script | null {
  const meeting = MEETING.exec(message.trim());
  if (meeting === null) return null;
  const [, path, title] = meeting;
  const attendees = [...message.matchAll(MATCHED_SPEAKER)].map((m) => m[1]);
  const properties: Record<string, unknown> = { summary: MOCK_MEETING_SUMMARY };
  if (attendees.length > 0) properties.attendees = attendees;
  return {
    tools: [
      { name: 'get_note', input: JSON.stringify({ path }) },
      { name: 'propose_organize', input: JSON.stringify({ path }) },
    ],
    uiAction: {
      action: 'propose_organize',
      path,
      type: 'Meeting',
      title: `Meeting: ${title}`,
      properties,
      reasoning: 'It is a meeting transcript, so it reads as a meeting record with its attendees.',
    },
    text: `I read "${title}" and proposed filing it as a meeting with a summary and ${attendees.length} ${attendees.length === 1 ? 'attendee' : 'attendees'}. Nothing is written until you apply the card.`,
  };
}

/**
 * What the default script says the vault is (M54.8), in the model the app has
 * today. src/lib/productBrief.test.ts holds it to no retired term. One line,
 * and it keeps its first words: e2e/ai-block.spec.ts and
 * src/editor/MarkdownEditor.test.tsx find an AI block's answer by them.
 */
export const VAULT_OVERVIEW_REPLY =
  'This vault tracks work as typed markdown: every note is a page, typed notes are records in their databases, and a knowledge bundle I maintain waits for you to verify. Ask me to find something, file an Inbox capture, or write up what I have learned.';

/** `wait for me …` (M57.5): a turn that starts get_vault_context and holds
 * there until `releaseHeldMockRuns`, so a spec can type, queue and steer
 * while a run is mid-tool. */
const WAIT_FOR_ME = /^wait for me\b/i;

/** The gate every held run waits on, and its release; null while no run
 * waits. One gate, so one release frees every held run. */
let heldGate: { promise: Promise<void>; release: () => void } | null = null;

function heldRuns(): Promise<void> {
  if (heldGate === null) {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    heldGate = { promise, release };
  }
  return heldGate.promise;
}

/** Let every held `wait for me` run go on (M57.5). A run stopped while held
 * has already said Cancelled and Done, and says nothing more. */
export function releaseHeldMockRuns(): void {
  const gate = heldGate;
  heldGate = null;
  gate?.release();
}

// Browser mode only: the spec's handle on the gate, beside the scripts.
if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
  (window as { __cerebroReleaseMockRuns?: () => void }).__cerebroReleaseMockRuns =
    releaseHeldMockRuns;
}

/** `<path> ("<title>")` — how every surface prompt names its subject
 * (src/lib/prompts.ts). Null when the message does not name one. */
function subjectOf(message: string): { path: string; title: string } | null {
  const match = /(\S+) \("([^"]+)"\)/.exec(message);
  return match === null ? null : { path: match[1], title: match[2] };
}

/** One entry of the snapshot's `knowledge` list — the fields a reply cites. */
interface SnapshotNote {
  path: string;
  title: string;
  claim?: string;
  about?: string;
  relation?: string;
  review?: string;
  reviewedBy?: string | null;
  stale?: boolean;
  supersededBy?: string;
  contradictedBy?: string[];
}

/** Whether a note can be leaned on as it stands: not replaced, not due a
 * recheck, and not contradicted by another concept. */
const settled = (note: SnapshotNote): boolean =>
  note.supersededBy === undefined && note.stale !== true && note.contradictedBy === undefined;

/**
 * What the turn's context snapshot says Knowledge holds (M52.3): the ```json
 * block under `## Context snapshot` that `renderSnapshot` appends to the
 * system prompt. Null when there is no snapshot to read — a turn with no
 * system prompt, or one this could not parse — which is not the same as a
 * snapshot that carries no knowledge (an empty list).
 */
function snapshotKnowledge(systemPrompt: string | undefined): SnapshotNote[] | null {
  if (systemPrompt === undefined) return null;
  const at = systemPrompt.indexOf('## Context snapshot');
  if (at === -1) return null;
  const block = /```json\n([\s\S]*?)\n```/.exec(systemPrompt.slice(at));
  if (block === null) return null;
  try {
    const snapshot = JSON.parse(block[1]) as { knowledge?: unknown };
    return Array.isArray(snapshot.knowledge) ? (snapshot.knowledge as SnapshotNote[]) : [];
  } catch {
    return null;
  }
}

/** `knowledge/systems/pick-queue-drain.md` → `pick-queue-drain`, the
 * wikilink the panel resolves to that concept's page. */
const stemOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/, '');

/** One cited concept — its page, under its title, then its claim — with
 * what a reader must know before leaning on it. */
function citeLine(note: SnapshotNote): string {
  const caveats = [
    ...(note.relation === 'learned from' ? ['learned from this page'] : []),
    ...(note.supersededBy !== undefined ? ['replaced — not current'] : []),
    ...(note.stale === true ? ['due a recheck'] : []),
    ...(note.review === 'current' && note.reviewedBy === 'human'
      ? []
      : ['no person has verified it']),
  ];
  const claim = note.claim === undefined || note.claim === '' ? '' : ` — ${note.claim}`;
  const said = caveats.length === 0 ? '' : ` (${caveats.join('; ')})`;
  return `- [[${stemOf(note.path)}|${note.title}]]${claim}${said}`;
}

/**
 * The mock's answers to the questions the app's own surfaces ask about
 * Knowledge (M52.3). Every reply names the subject it read and claims no
 * write: none of these scripts writes, and a transcript that says "written to
 * the knowledge bundle" over a bundle that did not change is the panel lying —
 * the catch-all that did exactly that for any prompt mentioning a concept is
 * gone.
 */
function knowledgeScript(prompt: string, message: string, systemPrompt?: string): Script | null {
  const subject = subjectOf(message);
  if (prompt.startsWith('what does the knowledge base know that bears on')) {
    const target = subject?.path ?? '';
    const title = subject?.title ?? 'this page';
    const held = snapshotKnowledge(systemPrompt);
    const tools = [{ name: 'knowledge_about', input: JSON.stringify({ target }) }];
    if (held === null) {
      return {
        tools,
        text: `I could not read what Knowledge holds on "${title}" from here, so I cannot say what it believes.`,
      };
    }
    const notes = held.filter((note) => note.about === undefined || note.about === target);
    if (notes.length === 0) {
      return { tools, text: `Knowledge holds nothing on "${title}" yet.` };
    }
    // M52.4 — what stands apart from what does not. A replaced concept under
    // "Held" read as a belief the base still holds, caveat or no caveat.
    const standing = notes.filter(settled);
    const unsettled = notes.filter((note) => !settled(note));
    const count = (n: number) => (n === 1 ? 'one concept' : `${n} concepts`);
    return {
      tools,
      text: [
        ...(standing.length === 0
          ? []
          : [
              `**Held** — ${count(standing.length)} ${standing.length === 1 ? 'bears' : 'bear'} on "${title}":`,
              '',
              ...standing.map(citeLine),
              '',
            ]),
        ...(unsettled.length === 0
          ? []
          : [
              `**Unsettled** — ${count(unsettled.length)} on it ${unsettled.length === 1 ? 'is' : 'are'} replaced, contradicted or due a recheck:`,
              '',
              ...unsettled.map(citeLine),
              '',
            ]),
        'I have not written or revised anything — this was a question.',
      ].join('\n'),
    };
  }
  const revise = prompt.startsWith('revise the knowledge concept at');
  if (revise || prompt.startsWith('recheck the knowledge concept at')) {
    const path = subject?.path ?? '';
    const title = subject?.title ?? 'this concept';
    return {
      tools: [
        { name: 'get_note', input: JSON.stringify({ path }) },
        { name: 'knowledge_about', input: JSON.stringify({ target: path }) },
      ],
      text: revise
        ? `I read "${title}" and what Knowledge holds about it. Verdict: **still true as written** — nothing newer in the vault changes it, so there is nothing to revise. I have not changed the concept.`
        : `I read "${title}" and what Knowledge holds about it. Verdict: **still true** — nothing newer in the vault contradicts it. I have not changed the concept or its recheck date.`,
    };
  }
  if (prompt.startsWith('i am writing')) {
    const title = subject?.title ?? 'this page';
    const held = snapshotKnowledge(systemPrompt);
    const notes = (held ?? []).filter(
      (note) => note.about === undefined || note.about === subject?.path,
    );
    return {
      tools: [
        { name: 'get_note', input: JSON.stringify({ path: subject?.path ?? '' }) },
        { name: 'knowledge_about', input: JSON.stringify({ target: subject?.path ?? '' }) },
      ],
      text: [
        held === null
          ? `**Established** — I could not read what Knowledge holds on "${title}" from here.`
          : notes.length === 0
            ? `**Established** — Knowledge holds nothing on "${title}" yet.`
            : `**Established** — what Knowledge holds that "${title}" can rely on:`,
        ...(notes.length === 0 ? [] : ['', ...notes.map(citeLine), '']),
        '**Missing** — nothing I can name from here.',
        '**Contradicts** — nothing I found.',
        '',
        'I have not edited the document.',
      ].join('\n'),
    };
  }
  // A distillation names the note it is reading, and most of those paths
  // start with `inbox/` — so this is checked before the Inbox branch too.
  if (prompt.startsWith('learn from the note at')) {
    const title = subject?.title ?? 'the note';
    return {
      tools: [
        { name: 'get_note', input: JSON.stringify({ path: subject?.path ?? '' }) },
        { name: 'knowledge_about', input: JSON.stringify({ target: subject?.path ?? '' }) },
      ],
      text: `I read "${title}" and what Knowledge already holds on its subjects. I have not written a concept from it.`,
    };
  }
  return null;
}

/** The CLI-tool scripts (M57.2, and M57.7's fetch), read off the message,
 * then off a job's standing instructions. */
function cliScript(message: string, systemPrompt?: string): Script | null {
  const at = systemPrompt?.indexOf(STANDING) ?? -1;
  const standing = systemPrompt !== undefined && at >= 0 ? systemPrompt.slice(at) : '';
  for (const text of [message.trim(), standing]) {
    const fetched = FETCH.exec(text);
    if (fetched !== null) {
      const url = fetched[1];
      return {
        tools: [
          {
            name: 'WebFetch',
            input: JSON.stringify({ url, prompt: 'Summarize the page' }),
            output: `(mock) The page at ${url} says hello.`,
          },
        ],
        text: `I fetched ${url}.`,
      };
    }
    const run = RUN.exec(text);
    if (run !== null) {
      const command = run[1];
      return {
        tools: [
          {
            name: 'Bash',
            input: JSON.stringify({ command, description: `Run ${command}` }),
            output: `$ ${command}\n(mock) done`,
          },
        ],
        text: `I ran ${command}.`,
      };
    }
    if (ASK_FORMAT.test(text)) {
      return {
        tools: [{ name: 'AskUserQuestion', input: JSON.stringify(FORMAT_QUESTIONS) }],
        // What the reply says when the person does not answer; their answers
        // rewrite it (`runMockAgent`'s resume).
        text: 'You chose not to answer, so I went ahead with Markdown and every section.',
      };
    }
    const ask = ASK_ME.exec(text);
    if (ask !== null) {
      const question = ask[1];
      return {
        tools: [
          {
            name: 'AskUserQuestion',
            input: JSON.stringify({ questions: [{ question, options: [] }] }),
          },
        ],
        text: `I meant to ask you: ${question}`,
      };
    }
  }
  return null;
}

/** What review notes open with (M58.5, `engine/reviewNotes.ts` notesPrompt). */
const REVIEW_NOTES = 'I reviewed your changes and left';

/** The inline code span `line` opens with, unpadded, or null. */
function leadingSpan(line: string): string | null {
  const span = /^(`+)(.*?)\1(?!`)/.exec(line);
  if (span === null) return null;
  const inner = span[2];
  return inner.startsWith(' ') && inner.endsWith(' ') && inner.length > 1
    ? inner.slice(1, -1)
    : inner;
}

/**
 * The review-notes script (M58.5): a notes prompt gets a tool-free reply
 * naming how many notes it holds (its numbered items, or one when it has
 * none) and their paths, the item code spans in order. Checked first: a
 * note's text and excerpts are free, and may name a script's keyword.
 */
function reviewNotesScript(message: string): Script | null {
  const text = message.trim();
  if (!text.startsWith(REVIEW_NOTES)) return null;
  const items = text
    .split('\n')
    .map((line) => /^\d+\. (.*)$/.exec(line))
    .filter((m) => m !== null);
  const paths =
    items.length > 0
      ? items.map((m) => leadingSpan(m[1]))
      : [leadingSpan(text.split('\n')[0].slice(`${REVIEW_NOTES} a note on `.length))];
  const count = Math.max(items.length, 1);
  const named = paths.filter((p) => p !== null);
  return {
    text: `I have ${count} review ${count === 1 ? 'note' : 'notes'} to work through, on ${named.join(', ')}.`,
  };
}

// --- The M91 scripts (M91.4) -------------------------------------------------
//
// Each emits only what Rust's fold emits, in its order and with its fields:
// the CLI's times on every line (`at`), a line uuid at the turn's end, a
// subagent's steps under its Agent call, structured results after their
// ToolDone. They read the demo vault's own pages.

const RESEARCH = /\bresearch\b[\s\S]*\bwith subagents\b/i;
const THINK_IT_THROUGH = /\bthink it through\b/i;
const TODO_LIST = /\bmake a todo list\b/i;
const RUN_THE_TESTS = /\brun the tests\b/i;
const STACK_TRACE = /\bfail with a stack trace\b/i;
const SEARCH_THE_WEB = /\bsearch the web\b/i;

/** The risk the M91 scripts read, a demo-vault page. */
const SCANNER_RISK = 'records/risks/risk-scanner-delivery.md';
/** The project the research script's second researcher reads. */
const PHOENIX = 'records/projects/phoenix-warehouse-rollout.md';

/** What Claude Code tells the model after a TodoWrite. */
const TODOS_WRITTEN =
  'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable';

/** The todo script's list, each item at the status given, as TodoWrite's
 * input and as its result's `newTodos`. */
const TODO_ITEMS = [
  ['List the open risks', 'Listing the open risks'],
  ['Read the dated risks', 'Reading the dated risks'],
  ['Name the risk to escalate', 'Naming the risk to escalate'],
] as const;

function todoCall(statuses: TodoStatus[]): ScriptCall {
  const items = TODO_ITEMS.map(([content, activeForm], at) => ({
    content,
    status: statuses[at],
    activeForm,
  }));
  return {
    name: 'TodoWrite',
    input: JSON.stringify({ todos: items }),
    output: TODOS_WRITTEN,
    result: {
      type: 'todos',
      todos: items.map(({ content, status, activeForm }) => ({
        content,
        status,
        active_form: activeForm,
      })),
    },
    ms: 60,
  };
}

/** A vitest run of the vault's scripts with one failure, as vitest 3.2
 * prints it: the files and the summary to stdout, the failure to stderr. */
export const MOCK_TEST_STDOUT = ` RUN  v3.2.4 /vault

 ✓ scripts/dates.test.mjs (6 tests) 4ms
 ✓ scripts/links.test.mjs (9 tests) 7ms
 ❯ scripts/risks.test.mjs (4 tests | 1 failed) 9ms
   ✓ risks > reads every open risk 2ms
   ✓ risks > sorts by due date 1ms
   × risks > flags a risk with no mitigation 4ms
     → expected [] to have a length of 1 but got +0
   ✓ risks > ignores closed risks 1ms

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 18 passed (19)
   Start at  09:12:40
   Duration  412ms (transform 61ms, setup 0ms, collect 88ms, tests 20ms, environment 0ms, prepare 151ms)
`;

export const MOCK_TEST_STDERR = `
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  scripts/risks.test.mjs > risks > flags a risk with no mitigation
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ scripts/risks.test.mjs:27:21
     25|   it('flags a risk with no mitigation', () => {
     26|     const flagged = unmitigated(readRisks('records/risks'));
     27|     expect(flagged).toHaveLength(1);
       |                     ^
     28|   });

${'⎯'.repeat(24)}[1/1]⎯
`;

/** A render script that dies inside a vault page, as Node 22 prints it: the
 * page's own frames are vault-relative, the script's are file URLs. */
export const MOCK_STACK = `${SCANNER_RISK}:6
Owner: {owner}
        ^

ReferenceError: owner is not defined
    at _createMdxContent (${SCANNER_RISK}:6:9)
    at MDXContent (${SCANNER_RISK}:14:8)
    at renderNote (file:///vault/scripts/render-notes.mjs:21:11)
    at async Promise.all (index 3)
    at async main (file:///vault/scripts/render-notes.mjs:34:3)

Node.js v22.12.0
`;

/**
 * The M91 scripts (M91.4): research with subagents, reasoning, a todo list,
 * a test run, a stack trace and a web search, each a phrase in the message.
 * Null for any other message.
 */
function m91Script(message: string): Script | null {
  if (RESEARCH.test(message)) {
    const researcher = (description: string, prompt: string, subagent: MockSubagent) => ({
      name: 'Agent',
      input: JSON.stringify({ description, subagent_type: 'cerebro-researcher', prompt }),
      ms: 120,
      subagent,
    });
    return {
      stamped: true,
      tools: [
        {
          ...researcher(
            'Read the open risks',
            'Read the open risks under records/risks and say which one threatens the launch most.',
            {
              type: 'cerebro-researcher',
              description: 'Read the open risks',
              thinking: 'I should find the risks first, then read the one with a date.',
              steps: [
                {
                  name: 'mcp__cerebro__search_notes',
                  input: JSON.stringify({ query: 'risk' }),
                  output: `Five open risks under records/risks, among them ${SCANNER_RISK}.`,
                  progress: 'Searching for open risks',
                  ms: 420,
                },
                {
                  name: 'mcp__cerebro__get_note',
                  input: JSON.stringify({ path: SCANNER_RISK }),
                  output:
                    '# Scanner delivery\n\nThe scanners ship late, and no mitigation is recorded.',
                  progress: 'Reading risk-scanner-delivery.md',
                  ms: 260,
                },
              ],
              report:
                'Scanner delivery threatens the launch most: it has a date and no recorded mitigation.',
            },
          ),
          thinking:
            'Two questions: which risk matters most, and what the rollout depends on. Each can go to a researcher.',
        },
        researcher(
          'Read the rollout plan',
          `Read ${PHOENIX} and say what its cutover depends on.`,
          {
            type: 'cerebro-researcher',
            description: 'Read the rollout plan',
            thinking: 'The project page should name what the cutover waits for.',
            steps: [
              {
                name: 'mcp__cerebro__get_note',
                input: JSON.stringify({ path: PHOENIX }),
                output: '# Phoenix warehouse rollout\n\nCutover waits on the new scanners.',
                progress: 'Reading phoenix-warehouse-rollout.md',
                ms: 310,
              },
            ],
            report: 'The rollout’s cutover waits on the new scanners arriving.',
          },
        ),
      ],
      answerThinking: 'Both researchers are back, and their answers meet at the scanners.',
      text: 'Two researchers looked. **Scanner delivery** is the risk that threatens the launch most: it has a date and no recorded mitigation, and the rollout’s cutover waits on those scanners. [[risk-scanner-delivery]]',
    };
  }
  if (THINK_IT_THROUGH.test(message)) {
    return {
      stamped: true,
      tools: [
        {
          name: 'mcp__cerebro__get_note',
          input: JSON.stringify({ path: SCANNER_RISK }),
          output: '# Scanner delivery\n\nThe scanners ship late, and no mitigation is recorded.',
          thinking:
            'The person wants a judgement, not a summary. I should read the risk before I weigh it against the launch.',
          ms: 240,
        },
      ],
      answerThinking:
        'It has a date, nothing mitigates it, and the launch depends on it. That makes it the one to escalate, ahead of the undated risks.',
      text: 'Having thought it through: escalate [[risk-scanner-delivery]] first. It is the only open risk with a date, nothing in the vault mitigates it, and the launch depends on it.',
    };
  }
  if (TODO_LIST.test(message)) {
    return {
      stamped: true,
      tools: [
        {
          ...todoCall(['in_progress', 'pending', 'pending']),
          thinking: 'Three steps. A list keeps them in view.',
        },
        {
          name: 'mcp__cerebro__search_notes',
          input: JSON.stringify({ query: 'risk' }),
          output: 'Five open risks under records/risks.',
          ms: 380,
        },
        todoCall(['completed', 'in_progress', 'pending']),
        {
          name: 'mcp__cerebro__get_note',
          input: JSON.stringify({ path: SCANNER_RISK }),
          output: '# Scanner delivery\n\nThe scanners ship late, and no mitigation is recorded.',
          ms: 220,
        },
        todoCall(['completed', 'completed', 'in_progress']),
        todoCall(['completed', 'completed', 'completed']),
      ],
      text: 'All three done: five risks are open, one of them dated, and [[risk-scanner-delivery]] is the one to escalate.',
    };
  }
  if (RUN_THE_TESTS.test(message)) {
    return {
      stamped: true,
      tools: [
        {
          name: 'Bash',
          input: JSON.stringify({
            command: 'pnpm vitest run scripts',
            description: 'Run the vault scripts’ tests',
          }),
          output: `Exit code 1\n${MOCK_TEST_STDOUT}`,
          failed: true,
          result: {
            type: 'shell',
            stdout: MOCK_TEST_STDOUT,
            stderr: MOCK_TEST_STDERR,
            interrupted: false,
            truncated: false,
          },
          thinking: 'The scripts have a vitest suite; running it is the quickest check.',
          ms: 1900,
        },
      ],
      text: 'The tests ran: 18 passed and 1 failed. `risks > flags a risk with no mitigation` expects one unmitigated risk and finds none.',
    };
  }
  if (STACK_TRACE.test(message)) {
    return {
      stamped: true,
      tools: [
        {
          name: 'Bash',
          input: JSON.stringify({
            command: 'node scripts/render-notes.mjs',
            description: 'Render the notes',
          }),
          output: `Exit code 1\n${MOCK_STACK}`,
          failed: true,
          result: {
            type: 'shell',
            stdout: '',
            stderr: MOCK_STACK,
            interrupted: false,
            truncated: false,
          },
          ms: 650,
        },
      ],
      text: `The render failed: \`owner\` is not defined on line 6 of ${SCANNER_RISK}.`,
    };
  }
  if (SEARCH_THE_WEB.test(message)) {
    const query = 'warehouse scanner lead times';
    const results = [
      {
        title: 'Scanner lead times - Example Logistics',
        url: 'https://example.com/scanners/lead-times',
      },
      { title: 'Planning a warehouse cutover', url: 'https://example.org/guides/cutover' },
    ];
    const page = results[0].url;
    return {
      stamped: true,
      tools: [
        {
          name: 'WebSearch',
          input: JSON.stringify({ query }),
          output: `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(results)}`,
          result: { type: 'web_search', query, results },
          thinking: 'Lead times are outside the vault; a search should find a current figure.',
          ms: 2300,
        },
        {
          name: 'WebFetch',
          input: JSON.stringify({ url: page, prompt: 'What lead time does it give for scanners?' }),
          output: 'Handheld scanners currently ship in 10 to 14 weeks.',
          result: { type: 'web_fetch', url: page, code: 200, bytes: 48213, duration_ms: 1840 },
          ms: 1900,
        },
      ],
      text: `Scanners currently ship in 10 to 14 weeks ([Example Logistics](${page})), so a late order puts the cutover at risk. See also [Planning a warehouse cutover](${results[1].url}).`,
    };
  }
  return null;
}

function scriptFor(message: string, systemPrompt?: string): Script {
  const later =
    /(?:^|\n)(?:@[\w-]+\s+)?follow up "([^"\n]*)" in (\d+) (minutes?|hours?|days?)$/i.exec(
      message.trim(),
    );
  if (later !== null) {
    const multiplier = later[3].toLowerCase().startsWith('minute')
      ? 60_000
      : later[3].toLowerCase().startsWith('hour')
        ? 3_600_000
        : 86_400_000;
    const followup = {
      at: new Date(Date.now() + Number(later[2]) * multiplier).toISOString(),
      note: later[1],
    };
    return {
      tools: [{ name: 'schedule_followup', input: JSON.stringify(followup) }],
      followup,
      text: '',
    };
  }
  const suggestion = /^suggest view ([\s\S]+)$/.exec(message.trim());
  if (suggestion !== null)
    return {
      tools: [{ name: 'suggest_view', input: suggestion[1] }],
      suggestion: suggestion[1],
      text: 'I suggested a view; it is on the card above.',
    };
  const notes = reviewNotesScript(message);
  if (notes !== null) return notes;
  const cli = cliScript(message, systemPrompt);
  if (cli !== null) return cli;
  if (WAIT_FOR_ME.test(message.trim())) {
    return {
      tools: [{ name: 'get_vault_context', input: '{}', output: 'Read the vault context.' }],
      held: true,
      text: 'Done waiting.',
    };
  }
  // First, and on the raw message: the content is quoted as typed, and a
  // note path may name an inbox or a risk without this being about either.
  const notion = /^import notion (\S+) to (.*)$/.exec(message.trim());
  if (notion !== null) {
    const args = { page: notion[1], folder: notion[2] };
    return {
      tools: [{ name: 'import_notion_page', input: JSON.stringify(args) }],
      notionImport: args,
      text: '',
    };
  }
  const canvasCreate = /^create canvas (\S+) in ([^:]*?)(?::\s*([\s\S]+))?$/.exec(message.trim());
  if (canvasCreate !== null) {
    const [, slug, folder, json] = canvasCreate;
    let ops: unknown;
    if (json !== undefined) {
      try {
        ops = JSON.parse(json);
      } catch {
        ops = null;
      }
    }
    const args = { slug, folder: folder.trim(), ...(json === undefined ? {} : { ops }) };
    return {
      tools: [{ name: 'create_canvas', input: JSON.stringify(args) }],
      canvasCreate: args,
      text: '',
    };
  }
  const canvasEdit = /^edit canvas (\S+\.canvas):\s*([\s\S]+)$/.exec(message.trim());
  if (canvasEdit !== null) {
    const [, path, json] = canvasEdit;
    let ops: unknown = null;
    try {
      ops = JSON.parse(json);
    } catch {
      /* The checked door supplies the shape refusal. */
    }
    return {
      tools: [{ name: 'edit_canvas', input: JSON.stringify({ path, ops }) }],
      canvasEdit: { path, ops },
      text: `I edited the whiteboard ${path}.`,
    };
  }
  const sheetEdit = /^edit sheet in (\S+\.md):\s*([\s\S]+)$/.exec(message.trim());
  if (sheetEdit !== null) {
    const [, path, json] = sheetEdit;
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
    } catch {
      /* The mock door reports malformed ops after the gate. */
    }
    return {
      tools: [{ name: 'edit_sheet', input: JSON.stringify({ ...args, path }) }],
      sheetEdit: { path, json },
      text: `I edited the sheets on ${path}.`,
    };
  }
  const edit = EDIT.exec(message.trim());
  if (edit !== null) {
    const [, old, replacement, path] = edit;
    const edits = [{ old: unquote(old), new: unquote(replacement) }];
    return {
      tools: [{ name: 'edit_note', input: JSON.stringify({ path, edits }) }],
      edit: { path, edits },
      text: `I edited ${path}.`,
    };
  }
  // The set script, on the raw message too (M60.4): a value may name
  // anything.
  const fields = SET_FIELDS.exec(message.trim());
  if (fields !== null) {
    const [, field, value, path] = fields;
    return {
      tools: [{ name: 'set_fields', input: JSON.stringify({ path, set: { [field]: value } }) }],
      fields: { path, field, value },
      text: `I set ${field} on ${path}.`,
    };
  }
  // The comment scripts, on the raw message too (M70.3): a comment's text is
  // free, and may name an inbox or a risk.
  const comment = commentScript(message.trim());
  if (comment !== null) return comment;
  const steps = message
    .trim()
    .split(THEN)
    .map((step) => APPEND.exec(step));
  if (steps.every((step) => step !== null)) {
    const appends = steps.map((step) => {
      const [, content, path] = step as RegExpExecArray;
      return { path, content };
    });
    return {
      tools: appends.map((target) => ({
        name: 'append_to_note',
        input: JSON.stringify(target),
      })),
      appends,
      text: `I appended that to ${appends.map((a) => a.path).join(' and ')}.`,
    };
  }
  // A skill's prose may name the Inbox; it is an invocation, never a filing request.
  const skill = /^The user invoked the skill "([^"]+)"/.exec(message);
  if (skill?.[1] === 'Draft reply') {
    // This is a deterministic connector transcript, not a mail client. It
    // exercises the attended recipe and never invokes a vault write callback.
    const request = /^The user's input for this run: (.*)$/m.exec(message)?.[1]?.trim();
    if (!request)
      return { text: 'Which Gmail thread should I reply to? Share its link, id or page.' };
    const thread = request.split(/\s+/)[0];
    const threadId = thread.includes('#') ? thread.split('/').at(-1)! : thread;
    const signature = /## Signature\b[\s\S]*?```text\n([\s\S]*?)\n```/.exec(message)?.[1] ?? '';
    const signed = signature.trim() !== '' && !signature.includes('YOUR SIGNATURE HERE');
    const body = `Thanks for the update. I'll follow up on the next steps.${signed ? `\n\n${signature}` : ''}`;
    return {
      tools: [
        {
          name: 'mcp__gmail__get_thread',
          input: JSON.stringify({ threadId, messageFormat: 'PLAIN_TEXT' }),
          output: JSON.stringify({
            messages: [
              {
                id: 'mock-newest-incoming',
                from: 'teammate@example.com',
                to: ['owner@example.com'],
                subject: 'Next steps',
              },
            ],
          }),
        },
        {
          name: 'mcp__gmail__create_draft',
          input: JSON.stringify({
            to: ['teammate@example.com'],
            subject: 'Re: Next steps',
            body,
            replyToMessageId: 'mock-newest-incoming',
          }),
          output: JSON.stringify({
            id: 'mock-draft',
            viewUrl: 'https://mail.google.com/mail/u/0/#drafts/mock-draft',
          }),
        },
      ],
      text: `The [draft is in Gmail](https://mail.google.com/mail/u/0/#drafts/mock-draft). To: teammate@example.com. Subject: Re: Next steps. Nothing was sent.${signed ? '' : ' The draft has no signature because the Signature block still needs your text.'}`,
    };
  }
  if (skill) {
    const named = new Set(mentionedTools(message));
    return {
      tools: TOOLS.tools
        .filter((row) => row.kind === 'read_only' && named.has(row.name))
        .map((row) => ({ name: row.name, input: '{}', output: `Read for ${skill[1]}.` })),
      text: `${skill[1]}: I read its sources. This recipe writes nothing.`,
    };
  }
  const create = CREATE.exec(message.trim());
  if (create !== null) {
    const [, title, folder, ifNew] = create;
    const args: CreateArgs = { folder, slug: slugify(title), body: `# ${title}\n` };
    if (ifNew !== undefined) args.if_exists = 'refuse';
    return {
      tools: [{ name: 'create_note', input: JSON.stringify(args) }],
      create: args,
      text: `I created "${title}" in ${folder}.`,
    };
  }
  // M91.4: before the keyword branches, which would take "risks" or "inbox".
  const m91 = m91Script(message);
  if (m91 !== null) return m91;
  const prompt = message.toLowerCase();

  // Five reads in a row (M56.8): the panel's folded row has a browser path.
  if (READ_FIVE.test(prompt)) {
    return {
      tools: FIVE_NOTES.map((path) => ({
        name: 'get_note',
        input: JSON.stringify({ path }),
        output: `Read ${path}.`,
      })),
      text: 'I read the five open risks.',
    };
  }

  // The meeting ask names an `inbox/` path too, and wants its own filing.
  const meeting = meetingScript(message);
  if (meeting !== null) return meeting;
  // Checked before the Inbox branch: these prompts name the note they are
  // about, and a path containing `inbox/` would otherwise answer a question
  // about Knowledge with a filing proposal.
  const knowledge = knowledgeScript(prompt, message, systemPrompt);
  if (knowledge !== null) return knowledge;
  if (prompt.includes('inbox') || prompt.includes('organize') || prompt.includes('organise')) {
    return {
      tools: [
        { name: 'list_inbox', input: '{}' },
        { name: 'propose_organize', input: JSON.stringify({ path: DEMO_CAPTURE }) },
      ],
      uiAction: {
        action: 'propose_organize',
        path: DEMO_CAPTURE,
        type: 'Work item',
        properties: { status: 'todo', priority: 'high' },
        reasoning: 'It names an action and an owner, so it reads as a task-like record.',
      },
      text: 'There are captures waiting. The one about the warehouse cutover reads like a **Work item** record — it names an owner and an action, and that type declares a status. I have proposed a filing for it; accept or reject it in the Inbox.',
    };
  }
  if (prompt.includes('risk') || prompt.includes('at risk')) {
    return {
      tools: [{ name: 'search_notes', input: '{"query":"risk"}' }],
      text: 'Two risks are open. [[risk-scanner-delivery]] is the one with a date attached, and nothing in the vault records a mitigation for it yet.',
    };
  }
  return {
    thinking: 'Reading the vault context first.',
    tools: [{ name: 'get_vault_context', input: '{}' }],
    text: VAULT_OVERVIEW_REPLY,
  };
}

/**
 * The failure scripts (M56.4): a message of exactly `fail: <name>` fails the
 * way Claude Code does, so the panel's failure card has a browser path. Each
 * notice is the one Rust's classifier gives the matching fixture, copied
 * from conformance/failure/notices.json; mockAgent.test holds them equal.
 * `fail: unknown` is a failure Rust cannot type, so it carries none.
 */
export const MOCK_FAILURES: Readonly<
  Record<string, { message: string; code: string | null; notice: FailureNotice | null }>
> = {
  'fail: not-signed-in': {
    message: 'Not logged in · Please run /login',
    code: 'authentication_failed',
    notice: {
      kind: 'not_signed_in',
      title: "Claude Code isn't signed in",
      body: 'Cerebro runs your own Claude Code, and it has no sign-in on this Mac. Open Terminal, run claude, and type /login. Then try again.',
      action: 'open_settings',
      resets_at: null,
      window: null,
      cli_version: '2.1.250',
    },
  },
  'fail: usage-limit': {
    message: "You've hit your weekly limit · resets Thu, Jan 1, 12am (UTC)",
    code: 'rate_limit',
    notice: {
      kind: 'usage_limit',
      title: "You've reached your Claude usage limit",
      body: 'Claude Code stopped because your weekly limit is used up. Background work waits until then.',
      action: null,
      resets_at: '2026-01-01T00:00:00Z',
      window: 'weekly',
      cli_version: '2.1.250',
    },
  },
  'fail: unknown': {
    message: 'API Error: 400 the request was not one Claude could take',
    code: 'invalid_request',
    notice: null,
  },
};

/** Play a failure script: the init (and with it what the run reaches, when
 * it has a plan, M92.8), the error (with its notice when Rust types one), the
 * turn's end and Done, as the fold reads a failed run whose init was
 * admitted. */
function runFailure(
  failure: (typeof MOCK_FAILURES)[string],
  emit: (event: AgentStreamEvent) => void,
  sessionId: string,
  delayMs: number,
  reach: RunReach | null,
): MockRun {
  let cancelled = false;
  const error: AgentStreamEvent = {
    kind: 'Error',
    message: failure.message,
    ...(failure.code === null ? {} : { code: failure.code }),
    ...(failure.notice === null ? {} : { notice: failure.notice }),
  };
  const opening: AgentStreamEvent[] = [{ kind: 'Init', session_id: sessionId }];
  if (reach !== null) opening.push({ kind: 'Reach', reach });
  const steps: AgentStreamEvent[][] = [
    opening,
    [error],
    [{ kind: 'TurnEnded', stop_reason: 'stop_sequence' }],
    [{ kind: 'Done' }],
  ];
  const timers = steps.map((events, at) =>
    setTimeout(() => {
      if (!cancelled) for (const event of events) emit(event);
    }, at * delayMs),
  );
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      emit({ kind: 'Cancelled' });
      emit({ kind: 'Done' });
    },
  };
}

/** What a mock run reports answering (M56.5): the model it was asked for,
 * marked as the mock's. */
export function mockModel(model: string | null | undefined): string {
  const asked = model?.trim() ?? '';
  return `mock-${asked === '' ? 'default' : asked}`;
}

/** The session a mock run reports when its caller named none: a UUID, as
 * every session id is (M56.3). `agentIpc.runAgent` always names one. */
const UNNAMED_SESSION = '00000000-0000-4000-8000-000000000000';

/**
 * A browser-mode test seam (M55.6): while `globalThis.__cerebroAgentWriteGate`
 * holds a promise, every write step waits for it before writing, so a spec can
 * type into the open page between the agent's ask and its write and then let
 * the write land inside the page's debounce. Unset, writes go at once.
 */
async function writeGate(): Promise<void> {
  const gate = (globalThis as { __cerebroAgentWriteGate?: unknown }).__cerebroAgentWriteGate;
  if (gate instanceof Promise) await gate;
}

let agentIds = 0;

/** A subagent's id as Claude Code mints one (M91.4): `a` and 16 hex digits. */
function mockAgentId(): string {
  agentIds += 1;
  return `a${agentIds.toString(16).padStart(16, '0')}`;
}

/**
 * What a mock run says it reaches (M92.8), as Rust's init gate says it once
 * the run's first init is admitted: from the plan its calls decide through,
 * each family's decisions once, in the manifest's order. The mock loads no
 * connector, so it holds none, misses none and inherits none of the
 * person's own. Its declared tools say whether it holds Cerebro's: absent,
 * they narrow nothing.
 */
function mockReach(
  approval: RunApproval,
  allowedTools: readonly string[] | null | undefined,
): RunReach {
  const families: Record<string, Decision[]> = {};
  for (const row of approval.decisions) {
    const decided = (families[row.family] ??= []);
    if (!decided.includes(row.decision)) decided.push(row.decision);
  }
  return {
    connectors: [],
    missing: [],
    missing_more: 0,
    inherits: false,
    permission_mode: approval.permission_mode,
    cerebro: allowedTools == null || grantedTools(allowedTools).size > 0,
    families,
  };
}

/** Split into small chunks so the UI genuinely streams rather than snapping. */
function chunk(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

export interface MockRun {
  cancel: () => void;
}

/** A call the mock's gate holds for the person (M57.1). A table ask names
 * its family and exact subject (M57.2). */
export interface MockDeferral {
  toolId: string;
  toolName: string;
  input: string;
  family?: string;
  subject?: string;
  /** A page write an ask-first agent asks about (M57.4): its manifest title
   * and target, for a write card. */
  write?: { title: string; target: string | null };
}

/** This conversation, per mock session (M57.2): the exact (family, subject)
 * pairs the person allowed, kept in memory as Rust's book keeps them. Only a
 * resumed run's answer writes it, and never for a cut subject
 * (`subjectIsCut`), which names only a prefix of the call. */
const conversationGrants = new Map<string, Set<string>>();

const grantKey = (family: string, subject: string) => `${family}\u0000${subject}`;

/** Test seam: forget every conversation's grants. */
export function resetMockGrants(): void {
  conversationGrants.clear();
}

/** The note or folder a page write aims at, by its manifest row's target
 * argument, or null when the input does not name one. */
function writeTarget(name: string, input: unknown): string | null {
  const arg = toolFacts(name)?.target?.arg ?? null;
  if (arg === null || typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[arg];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Is this the CLI's own tool, which the tool-approval table decides? */
function isCliTool(approval: RunApproval, name: string): boolean {
  return approval.decisions.some((row) => row.tool === name);
}

/**
 * Replay a scripted run. Returns a handle whose `cancel` stops emission —
 * the mock equivalent of killing the child process — then reports Cancelled
 * and Done, as Rust's reader closes a run stopped on purpose (M57.5).
 *
 * Steps run in order, one `delayMs` apart, and a step that writes is awaited
 * before the next starts: the reply streams after the tool result, as it does
 * from a real child.
 */
export function runMockAgent(
  message: string,
  emit: (event: AgentStreamEvent) => void,
  {
    delayMs = 12,
    onUiAction,
    onAppend,
    onEdit,
    onEditSheet,
    onEditCanvas,
    onCreateCanvas,
    onImportNotion,
    onSetFields,
    onSuggestView,
    onScheduleFollowup,
    onCreate,
    onComment,
    onReply,
    onResolve,
    onQueue,
    systemPrompt,
    sessionId = UNNAMED_SESSION,
    model = null,
    asks,
    approval,
    allowedTools,
    onDefer,
    resume,
  }: {
    delayMs?: number;
    onUiAction?: (action: UiAction) => void;
    /** Carries out the write script's `append_to_note` (M53.6): the mock
     * backend's `agentAppend` in browser mode. Absent, the tool refuses. */
    onAppend?: (path: string, content: string) => Promise<void>;
    /** Carries out the edit script's `edit_note` (M55.5): the mock backend's
     * `agentEdit`, which answers with the tool's report. Absent, the tool
     * refuses. */
    onEdit?: (path: string, edits: QuoteEdit[]) => Promise<string>;
    onEditSheet?: (path: string, args: Record<string, unknown>) => Promise<string>;
    onEditCanvas?: (path: string, args: Record<string, unknown>) => Promise<string>;
    onCreateCanvas?: (args: Record<string, unknown>) => Promise<{ path: string; reply: string }>;
    onImportNotion?: (args: {
      page: string;
      folder: string;
    }) => Promise<{ path: string; reply: string; wrote: boolean }>;
    /** Carries out the set script's `set_fields` (M60.4): the mock backend's
     * `agentSetFields`, which answers with the tool's report. Absent, the
     * tool refuses. */
    onSetFields?: (path: string, args: Record<string, unknown>) => Promise<string>;
    onSuggestView?: (args: unknown) => Promise<string>;
    onScheduleFollowup?: (args: { at: string; note: string }) => Promise<string>;
    /** Carries out the create script's `create_note` (M57.4): the mock
     * backend's `agentCreate`, which answers with the path it landed and
     * the tool's report (M61.6b). Absent, the tool refuses. */
    onCreate?: (args: CreateArgs) => Promise<{ path: string; reply: string }>;
    /** Carry out the comment scripts' comment_on_note, reply_to_comment and
     * resolve_comment (M70.3): the mock backend's `agentComment`,
     * `agentReply` and `agentResolve`, which answer with the tool's report.
     * Absent, the tool refuses. */
    onComment?: (args: Record<string, unknown>) => Promise<string>;
    onReply?: (args: Record<string, unknown>) => Promise<string>;
    onResolve?: (args: Record<string, unknown>) => Promise<string>;
    /** Queues an unattended ask-first page write for Review (M57.4c): the
     * mock backend's `queueAgentWrite`, which answers what the model reads
     * and throws its refusal. Absent, the write is refused as unqueueable. */
    onQueue?: (tool: string, input: Record<string, unknown>) => Promise<string>;
    /** The turn's system prompt, whose context snapshot says what the page
     * in front of the user holds (M52.3) — the mock reads Knowledge there. */
    systemPrompt?: string;
    /** The Claude Code session the run goes to (M56.3), minted or resumed by
     * the caller; echoed in Init and Result as the real CLI does. */
    sessionId?: string;
    /** The model the run asked for (M56.5). The mock answers as
     * `mock-<model>`, or `mock-default` when none was asked for, so a spec
     * can see which one the footer names. */
    model?: string | null;
    /** Does the gate ask for this tool (M57.1, `mockInteractions.mockAsks`)?
     * A call it asks for is held: its card, its deferral and Done, and the
     * turn stops there. */
    asks?: (toolName: string) => boolean;
    /** The run's tool-approval plan (M57.2): a call to one of the CLI's own
     * tools runs, is refused or asks as the table says, and so does an
     * ask-first agent's page write (M57.4), which the plan reads by its
     * `askFirst` and run kind. Absent, every call runs. */
    approval?: RunApproval;
    /** The run's declared tools (M92.8), for whether the reach it says
     * holds Cerebro's own. Absent narrows nothing. */
    allowedTools?: readonly string[] | null;
    /** Registers a held call with the book and gives its card, or null for
     * a deferral the book did not register. The caller resumes the turn
     * with `resume` below once the person answers. */
    onDefer?: (call: MockDeferral) => PendingInteraction | null;
    /** This run resumes a held call with the person's answer: it starts
     * after that call, which runs on allow and is refused on deny. */
    resume?: { toolId: string; answer: PersonAnswer };
  } = {},
): MockRun {
  // M92.8: only a run handed its plan can say what it reaches.
  const reach = approval === undefined ? null : mockReach(approval, allowedTools);
  // Matched first, on the message as typed (M56.4).
  const failure = MOCK_FAILURES[message.trim()];
  if (failure !== undefined) return runFailure(failure, emit, sessionId, delayMs, reach);
  const script = scriptFor(message, systemPrompt);
  let cancelled = false;
  // Held on a call (M57.1): the turn stops at its Done, mid-script.
  let suspended = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  // What the run says once its tools are done; a refused write rewrites it,
  // so the transcript never claims a write that did not happen.
  let reply = script.text;

  type Step = () => void | Promise<void>;

  // M91.4: a stamped script's events carry the CLI's line times, on the
  // run's own clock: each step this many ms after the one before it. A
  // pinned page clock stands still, and these durations still read the same.
  const startedAt = Date.now();
  let elapsed = 0;
  const at = (ms: number): { at?: string } => {
    if (script.stamped !== true) return {};
    elapsed += ms;
    return { at: new Date(startedAt + elapsed).toISOString() };
  };
  let messageCount = 0;
  /** A fresh assistant message id, as the CLI gives each message one. */
  const messageId = () => {
    messageCount += 1;
    return `msg_mock_${messageCount}`;
  };
  /** A reasoning block, as Rust folds one: its words streamed, then the
   * block whole, which settles them (M91.4). */
  const think = (text: string, id: string): Step[] => [
    ...chunk(text).map(
      (piece): Step =>
        () =>
          emit({ kind: 'ThinkingDelta', text: piece }),
    ),
    () => emit({ kind: 'Thinking', message_id: id, text, ...at(900) }),
  ];
  /** When each Agent call started on the run's clock: its subagent's time so
   * far is measured from it. */
  const began = new Map<string, number>();
  const since = (id: string) => elapsed - (began.get(id) ?? elapsed);

  /**
   * A subagent's life between its Agent call's start and its report (M91.4),
   * as Rust folds Claude Code's task notes and forwarded lines: it starts,
   * thinks, takes each step under its call, reports in its own words, and
   * ends. Never its tokens.
   */
  const subagentSteps = (id: string, sub: MockSubagent, agentId: string): Step[] => {
    const thought = messageId();
    const reported = messageId();
    return [
      () =>
        emit({
          kind: 'SubagentStarted',
          tool_id: id,
          agent_id: agentId,
          subagent_type: sub.type,
          description: sub.description,
          background: false,
          depth: 1,
        }),
      () =>
        emit({ kind: 'Thinking', message_id: thought, text: sub.thinking, parent: id, ...at(800) }),
      ...sub.steps.flatMap((step, k): Step[] => {
        const stepId = `${id}-${k + 1}`;
        return [
          () =>
            emit({
              kind: 'SubagentProgress',
              tool_id: id,
              description: step.progress,
              last_tool: step.name,
              tool_uses: k + 1,
              duration_ms: since(id),
            }),
          () =>
            emit({
              kind: 'ToolStart',
              tool_name: step.name,
              tool_id: stepId,
              input: step.input,
              parent: id,
              ...at(120),
            }),
          () =>
            emit({
              kind: 'ToolDone',
              tool_id: stepId,
              output: step.output,
              is_error: false,
              parent: id,
              ...at(step.ms),
            }),
        ];
      }),
      () => emit({ kind: 'Text', message_id: reported, text: sub.report, parent: id, ...at(600) }),
      () =>
        emit({
          kind: 'SubagentDone',
          tool_id: id,
          status: 'completed',
          tool_uses: sub.steps.length,
          duration_ms: since(id),
        }),
    ];
  };

  /** A call that ran (M91.4): its result, then what its structure says, an
   * Agent call's its subagent's report. */
  const finish = (id: string, call: ScriptCall, agentId: string | null) => {
    const failed = call.failed === true;
    const output = call.output ?? call.subagent?.report;
    emit({
      kind: 'ToolDone',
      tool_id: id,
      ...(output === undefined ? {} : { output }),
      ...(script.stamped === true ? { is_error: failed } : failed ? { is_error: true } : {}),
      ...at(call.ms ?? 0),
    });
    const data: ToolResultData | undefined =
      call.subagent !== undefined && agentId !== null
        ? {
            type: 'agent',
            agent_id: agentId,
            agent_type: call.subagent.type,
            status: 'completed',
            tool_uses: call.subagent.steps.length,
            duration_ms: since(id),
            model: mockModel(model),
            summary: call.subagent.report,
          }
        : call.result;
    if (data !== undefined) emit({ kind: 'ToolResult', tool_id: id, data });
  };

  /** A write script's tool call: `write` it, then report as the server
   * does. A refusal rewrites the reply as `failed` words it. */
  const writeStep = async (
    id: string,
    path: string,
    write: () => Promise<string>,
    failed: (refusal: string) => string,
  ) => {
    await writeGate();
    // Stopped while held: the write never happens, so nothing is announced.
    if (cancelled) return;
    let output: string;
    try {
      output = await write();
    } catch (err) {
      const refusal = err instanceof Error ? err.message : String(err);
      reply = failed(refusal);
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
      return;
    }
    // The write landed, so it is announced whether or not the run was
    // stopped meanwhile — as mcp.rs does, before the tool result goes back.
    onUiAction?.({ action: 'vault_changed', paths: [path] });
    if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output });
  };

  const append = (id: string, target: { path: string; content: string }) =>
    writeStep(
      id,
      target.path,
      async () => {
        if (onAppend === undefined) throw new Error('append_to_note is not available here');
        await onAppend(target.path, target.content);
        return `Appended to ${target.path}`;
      },
      (refusal) => `I could not append to ${target.path}: ${refusal}`,
    );

  /** The create script's call: its report names the file it landed in,
   * which is the one announced. `edited` names the keys the person changed
   * before allowing it (M57.4b): the report says so, as mcp.rs's does, and
   * so does the reply. */
  const create = async (id: string, args: CreateArgs, edited: string[] = []) => {
    await writeGate();
    if (cancelled) return;
    let landed: { path: string; reply: string };
    // `if new` (M61.6b) replies with the tool's own text, landed or refused.
    const ifNew = args.if_exists === 'refuse';
    try {
      if (onCreate === undefined) throw new Error('create_note is not available here');
      landed = await onCreate(args);
    } catch (err) {
      const refusal = err instanceof Error ? err.message : String(err);
      reply = ifNew ? refusal : `I could not create that in ${args.folder}: ${refusal}`;
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
      return;
    }
    let output = landed.reply;
    const path = landed.path;
    onUiAction?.({ action: 'vault_changed', paths: [path] });
    if (ifNew) reply = output;
    if (edited.length > 0) {
      output = `${output}\n${editedText(edited)}`;
      reply = `I created ${path} with your changes to ${edited.join(', ')}.`;
    }
    if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output });
  };

  const edit = (id: string, target: { path: string; edits: QuoteEdit[] }) =>
    writeStep(
      id,
      target.path,
      async () => {
        if (onEdit === undefined) throw new Error('edit_note is not available here');
        return onEdit(target.path, target.edits);
      },
      (refusal) => `I could not edit ${target.path}: ${refusal}`,
    );

  const importNotion = async (id: string, args: { page: string; folder: string }) => {
    await writeGate();
    if (cancelled) return;
    try {
      if (onImportNotion === undefined) throw new Error('import_notion_page is not available here');
      const result = await onImportNotion(args);
      reply = result.reply;
      if (!cancelled) {
        if (result.wrote) onUiAction?.({ action: 'vault_changed', paths: [result.path] });
        emit({ kind: 'ToolDone', tool_id: id, output: result.reply });
      }
    } catch (error) {
      reply = error instanceof Error ? error.message : String(error);
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: reply, is_error: true });
    }
  };

  const createCanvas = async (id: string, args: Record<string, unknown>) => {
    await writeGate();
    if (cancelled) return;
    try {
      if (onCreateCanvas === undefined) throw new Error('create_canvas is not available here');
      const landed = await onCreateCanvas(args);
      onUiAction?.({ action: 'vault_changed', paths: [landed.path] });
      reply = `I created ${landed.path}.`;
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: landed.reply });
    } catch (error) {
      const refusal = error instanceof Error ? error.message : String(error);
      reply = `I could not create the whiteboard: ${refusal.split('\n')[0]}`;
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
    }
  };
  const editCanvas = (id: string, target: { path: string; ops: unknown }) =>
    writeStep(
      id,
      target.path,
      async () => {
        if (onEditCanvas === undefined) throw new Error('edit_canvas is not available here');
        return onEditCanvas(target.path, { ops: target.ops });
      },
      (refusal) => `I could not edit the whiteboard ${target.path}: ${refusal.split('\n')[0]}`,
    );

  const editSheet = (id: string, target: { path: string; json: string }) =>
    writeStep(
      id,
      target.path,
      async () => {
        if (onEditSheet === undefined) throw new Error('edit_sheet is not available here');
        let args: unknown;
        try {
          args = JSON.parse(target.json);
        } catch {
          throw new Error('edit_sheet needs `ops`, a list of operations');
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args))
          throw new Error('edit_sheet needs `ops`, a list of operations');
        return onEditSheet(target.path, args as Record<string, unknown>);
      },
      (refusal) => `I could not edit the sheets on ${target.path}: ${refusal.split('\n')[0]}`,
    );

  /** The set script's call (M60.4): its report comes from the tool, and a
   * landed write announces the vault with no paths, as Rust's rescan branch
   * does for the frontmatter writers. A refusal rewrites the reply. */
  const setFields = async (id: string, call: SetFieldsCall) => {
    await writeGate();
    if (cancelled) return;
    let output: string;
    try {
      if (onSetFields === undefined) throw new Error('set_fields is not available here');
      output = await onSetFields(call.path, { set: { [call.field]: call.value } });
    } catch (err) {
      const refusal = err instanceof Error ? err.message : String(err);
      reply = `I could not set ${call.field} on ${call.path}: ${refusal}`;
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
      return;
    }
    onUiAction?.({ action: 'vault_changed' });
    if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output });
  };

  const scheduleFollowup = async (id: string, args: { at: string; note: string }) => {
    try {
      if (onScheduleFollowup === undefined)
        throw new Error('schedule_followup is not available here');
      reply = await onScheduleFollowup(args);
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: reply });
    } catch (error) {
      const refusal = error instanceof Error ? error.message : String(error);
      reply = `I could not book that follow-up: ${refusal}`;
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
    }
  };

  const suggestView = async (id: string, input: string) => {
    let output: string;
    try {
      if (onSuggestView === undefined) throw new Error('suggest_view is not available here');
      let args: unknown;
      try {
        args = JSON.parse(input);
      } catch {
        throw new Error('suggest_view needs an object');
      }
      output = await onSuggestView(args);
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }
    const failed = parseSuggestionResult(output) === null;
    if (failed)
      reply = `I could not suggest that view: ${
        output
          .split('\n')
          .find((line) => line.startsWith('- '))
          ?.replace(/^- [^:]+: /, '') ?? output
      }`;
    if (!cancelled)
      emit({ kind: 'ToolDone', tool_id: id, output, ...(failed ? { is_error: true } : {}) });
  };

  /** A comment script's call (M70.3): the report comes from the tool, and a
   * post announces the page's comments, never the vault. A refusal rewrites
   * the reply as the script's words for it. */
  const comment = async (id: string, call: CommentCall) => {
    await writeGate();
    if (cancelled) return;
    const path = String(call.args.path);
    const thread = String(call.args.thread ?? '');
    const handlers = {
      comment_on_note: onComment,
      reply_to_comment: onReply,
      resolve_comment: onResolve,
    };
    let output: string;
    try {
      const handler = handlers[call.tool];
      if (handler === undefined) throw new Error(`${call.tool} is not available here`);
      output = await handler(call.args);
    } catch (err) {
      const refusal = err instanceof Error ? err.message : String(err);
      reply =
        call.tool === 'comment_on_note'
          ? `I could not comment on ${path}: ${refusal}`
          : call.tool === 'reply_to_comment'
            ? `I could not reply in ${thread} on ${path}: ${refusal}`
            : `I could not resolve ${thread} on ${path}: ${refusal}`;
      if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
      return;
    }
    onUiAction?.({ action: 'comments_changed', path });
    if (call.tool === 'comment_on_note') {
      const posted = /as thread ([0-9a-f]+)/.exec(output)?.[1] ?? '';
      reply = `I commented on ${path} as thread ${posted}.`;
    }
    if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output });
  };

  const acting: Step[] = [];
  // M92.8: what the run reaches comes with its init, as Rust's gate says it.
  acting.push(() => {
    emit({ kind: 'Init', session_id: sessionId });
    if (reach !== null) emit({ kind: 'Reach', reach });
  });
  // The model answering, as the fold reports it once per turn (M56.3).
  acting.push(() => emit({ kind: 'ModelChanged', model: mockModel(model) }));
  if (script.thinking !== undefined && resume === undefined) {
    acting.push(...think(script.thinking, messageId()));
  }
  const tools = script.tools ?? [];
  // A resume starts after the held call, so its earlier calls are not run again.
  const resumeAt =
    resume === undefined ? -1 : tools.findIndex((_, i) => `t-${i + 1}` === resume.toolId);
  // Each append_to_note call takes the next of the script's appends.
  let appendAt = 0;
  tools.forEach((call, i) => {
    const { name, input } = call;
    const id = `t-${i + 1}`;
    // M91.4: the subagent an Agent call starts, named as Claude Code names
    // one, and its steps before the call's report.
    const agentId = call.subagent === undefined ? null : mockAgentId();
    const appended = name === 'append_to_note' ? script.appends?.[appendAt++] : undefined;
    if (i < resumeAt) return;
    const edited = name === 'edit_note' ? script.edit : undefined;
    const sheetEdited = name === 'edit_sheet' ? script.sheetEdit : undefined;
    const canvasEdited = name === 'edit_canvas' ? script.canvasEdit : undefined;
    const canvasCreated = name === 'create_canvas' ? script.canvasCreate : undefined;
    const notionImported = name === 'import_notion_page' ? script.notionImport : undefined;
    const fielded = name === 'set_fields' ? script.fields : undefined;
    const suggested = name === 'suggest_view' ? script.suggestion : undefined;
    const later = name === 'schedule_followup' ? script.followup : undefined;
    const created = name === 'create_note' ? script.create : undefined;
    const commented = name === script.comment?.tool ? script.comment : undefined;
    const completion: Step =
      canvasCreated !== undefined
        ? () => createCanvas(id, canvasCreated)
        : canvasEdited !== undefined
          ? () => editCanvas(id, canvasEdited)
          : notionImported !== undefined
            ? () => importNotion(id, notionImported)
            : sheetEdited !== undefined
              ? () => editSheet(id, sheetEdited)
              : later !== undefined
                ? () => scheduleFollowup(id, later)
                : suggested !== undefined
                  ? () => suggestView(id, suggested)
                  : appended !== undefined
                    ? () => append(id, appended)
                    : edited !== undefined
                      ? () => edit(id, edited)
                      : fielded !== undefined
                        ? () => setFields(id, fielded)
                        : created !== undefined
                          ? () => create(id, created)
                          : commented !== undefined
                            ? () => comment(id, commented)
                            : () => finish(id, call, agentId);
    const running: Step[] = [
      ...(call.subagent !== undefined && agentId !== null
        ? subagentSteps(id, call.subagent, agentId)
        : []),
      completion,
    ];
    // M57.2: a CLI tool's call decides through the run's plan. Argv denies
    // what the plan disallows; the host answers the rest.
    const table = approval !== undefined && isCliTool(approval, name);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(input);
    } catch {
      // Not JSON: the call is named by its text.
    }
    // M57.4: an ask-first agent's page write decides through the same
    // plan, by its full name, as Rust's gate and dispatch do.
    const confirmable = approval !== undefined && isConfirmable(name);
    const planned = confirmable ? `mcp__cerebro__${name}` : name;
    const host =
      approval !== undefined && (table || confirmable)
        ? hostAnswer(
            approval,
            (family, subject) =>
              conversationGrants.get(sessionId)?.has(grantKey(family, subject)) ?? false,
            planned,
            parsed,
          )
        : null;
    // M57.3: a question the table asks draws a question card, once its
    // questions parse; a set no card can show is refused as Rust's gate
    // refuses it.
    const asked =
      host?.kind === 'ask' && familyCard(host.family)?.kind === 'question'
        ? mockQuestions(parsed)
        : null;
    if (i === resumeAt && resume !== undefined) {
      // The held call, answered: allow runs it, and This conversation keeps
      // its exact subject for the rest of the session; deny refuses it in
      // Rust's words, and the reply says so rather than claim the work.
      const answer = resume.answer;
      if (
        answer.kind === 'allow' &&
        answer.remember === 'conversation' &&
        host?.kind === 'ask' &&
        !subjectIsCut(host.subject)
      ) {
        const held = conversationGrants.get(sessionId) ?? new Set<string>();
        held.add(grantKey(host.family, host.subject));
        conversationGrants.set(sessionId, held);
      }
      if (answer.kind === 'answers') {
        // The answers return as the call's input, and Claude Code reads them
        // back to the model as its tool result.
        const answers: QuestionAnswer[] = answer.answers;
        acting.push(() => {
          const checked =
            asked !== null && 'questions' in asked ? answersFor(asked.questions, answers) : null;
          const map = checked !== null && 'ok' in checked ? checked.ok : {};
          reply = `Got it: ${Object.values(map).join('; ')}.`;
          emit({ kind: 'ToolDone', tool_id: id, output: answeredText(map) });
        });
        return;
      }
      // M57.4b: an Allow with the person's edit runs their version, as
      // Rust's dispatch runs the approved input.
      const approved =
        answer.kind === 'allow' && answer.updatedInput !== undefined && created !== undefined
          ? (answer.updatedInput as unknown as CreateArgs)
          : null;
      acting.push(
        ...(approved !== null && created !== undefined
          ? [
              () =>
                create(
                  id,
                  approved,
                  changedKeys(
                    created as unknown as Record<string, unknown>,
                    approved as unknown as Record<string, unknown>,
                  ),
                ),
            ]
          : answer.kind === 'allow'
            ? running
            : [
                () => {
                  const said = answer.message?.trim() ?? '';
                  if (asked !== null) {
                    // Don't answer: the agent decides itself, and its reply says
                    // what it went ahead with.
                    const declined = APPROVAL_MESSAGES.question_declined;
                    const refusal = said === '' ? declined : `${declined} They said: ${said}`;
                    emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
                    return;
                  }
                  // A write card's Deny (M57.4) is the table's ask on a page
                  // writer; the debug seam's ask on one is M57.1's.
                  const writeCard = confirmable && host?.kind === 'ask';
                  const refusal = writeCard
                    ? writeDeclined(said)
                    : host?.kind === 'ask'
                      ? `${APPROVAL_MESSAGES.person_denied}${said === '' ? '' : ` They said: ${said}`}`
                      : declinedText(answer);
                  reply = writeCard
                    ? `I did not write it: ${refusal}`
                    : `I did not run ${name}: you declined it.`;
                  emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
                },
              ]),
      );
      return;
    }
    if (call.thinking !== undefined) acting.push(...think(call.thinking, messageId()));
    acting.push(() => {
      emit({ kind: 'ToolStart', tool_name: name, tool_id: id, input, ...at(80) });
      began.set(id, elapsed);
    });
    // M57.5: a held script's first call waits here, mid-tool, for the release.
    if (script.held === true && i === 0) acting.push(() => heldRuns());
    // M57.4c: an unattended ask-first page write waits in Review, as Rust's
    // dispatch queues it: the model reads that it waits, and nothing lands.
    const queues =
      confirmable && approval?.decisions.find((row) => row.tool === planned)?.decision === 'queue';
    if (queues) {
      const draft =
        created !== undefined
          ? (created as unknown as Record<string, unknown>)
          : typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
      acting.push(async () => {
        let output: string;
        try {
          if (onQueue === undefined) throw new Error(APPROVAL_MESSAGES.queue_unavailable);
          output = await onQueue(name, draft);
        } catch (err) {
          const refusal = err instanceof Error ? err.message : String(err);
          reply = refusal;
          if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
          return;
        }
        reply = output;
        if (!cancelled) emit({ kind: 'ToolDone', tool_id: id, output });
      });
      return;
    }
    if (approval !== undefined && table && approval.disallowed.includes(name)) {
      // Denied in argv: the CLI never offers the tool.
      acting.push(() => {
        reply = `${name} is not available in this run.`;
        emit({ kind: 'ToolDone', tool_id: id, output: reply, is_error: true });
      });
      return;
    }
    if (host?.kind === 'deny') {
      // A page write the table denies is refused at dispatch, in the
      // ask-first words when its agent asks first (M57.4); an unattended
      // ask-first write queues above instead (M57.4c).
      const refusal = confirmable ? APPROVAL_MESSAGES.ask_first_unattended : host.message;
      acting.push(() => {
        reply = refusal;
        emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
      });
      return;
    }
    if (asked !== null && 'deny' in asked) {
      acting.push(() => {
        reply = asked.deny;
        emit({ kind: 'ToolDone', tool_id: id, output: asked.deny, is_error: true });
      });
      return;
    }
    const tableAsk = host?.kind === 'ask' ? host : null;
    if (asks?.(name) === true || tableAsk !== null) {
      acting.push(() => {
        const card =
          onDefer?.({
            toolId: id,
            toolName: name,
            input,
            ...(tableAsk !== null ? { family: tableAsk.family, subject: tableAsk.subject } : {}),
            ...(confirmable && tableAsk !== null
              ? {
                  write: {
                    title: toolFacts(name)?.title ?? name,
                    target: writeTarget(name, parsed),
                  },
                }
              : {}),
          }) ?? null;
        if (card !== null && asked !== null && 'questions' in asked) {
          markMockQuestion(card, asked.questions);
        }
        if (card !== null) emit({ kind: 'Interaction', interaction: card });
        emit({ kind: 'ToolDeferred', tool_id: id, tool_name: name });
        suspended = true;
        emit({ kind: 'Done' });
      });
    }
    acting.push(...running);
  });
  if (script.uiAction !== undefined) {
    const action = script.uiAction;
    acting.push(() => onUiAction?.(action));
  }

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, ms));
    });
  let first = true;
  /** Play `steps` in order; false once the run has been cancelled. */
  const play = async (steps: Step[]): Promise<boolean> => {
    for (const step of steps) {
      await pause(first ? 0 : delayMs);
      first = false;
      if (cancelled) return false;
      await step();
      if (suspended) return false;
    }
    return true;
  };
  void (async () => {
    if (!(await play(acting))) return;
    // Chunked as it streams rather than when scripted: a refused write has
    // rewritten the reply by now.
    // M91.4: a stamped script ends as Rust's fold ends a turn, its result
    // before its end, which names the line a branch starts from; its result
    // counts how long the run worked on the run's own clock (M92.2).
    const result: Step = () =>
      emit({
        kind: 'Result',
        text: reply,
        session_id: sessionId,
        ...(script.stamped === true ? { duration_ms: elapsed } : {}),
      });
    const ended: Step = () =>
      emit({
        kind: 'TurnEnded',
        stop_reason: 'end_turn',
        ...(script.stamped === true ? { last_uuid: crypto.randomUUID() } : {}),
      });
    await play([
      ...(script.answerThinking === undefined ? [] : think(script.answerThinking, 'msg_mock')),
      ...chunk(reply).map(
        (piece): Step =>
          () =>
            emit({ kind: 'TextDelta', text: piece }),
      ),
      // The whole message and the turn's end, as the fold reads them off the
      // CLI's assistant line and result (M56.3).
      () => emit({ kind: 'Text', message_id: 'msg_mock', text: reply, ...at(500) }),
      ...(script.stamped === true ? [result, ended] : [ended, result]),
      () => emit({ kind: 'Done' }),
    ]);
  })();

  return {
    cancel: () => {
      // A run suspended on a call already sent its Done.
      if (cancelled || suspended) return;
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      emit({ kind: 'Cancelled' });
      emit({ kind: 'Done' });
    },
  };
}
