import { declinedText } from './mockInteractions';
import type {
  AgentStreamEvent,
  FailureNotice,
  PendingInteraction,
  PersonAnswer,
  UiAction,
} from './types';
import type { QuoteEdit } from '@/engine/quote';

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
 */

interface Script {
  thinking?: string;
  /** Each call, and what it returns when the script says (a write's report
   * comes from its own step). */
  tools?: { name: string; input: string; output?: string }[];
  /**
   * A UI action the run drives, fired after its tools report done. The mock
   * has to actually DO what its reply claims — a script that says "I have
   * proposed a filing" without emitting the proposal makes the panel's own
   * transcript the least trustworthy thing on screen, and leaves the real
   * propose-and-review path with no test running through it.
   */
  uiAction?: UiAction;
  /**
   * What its `append_to_note` call writes (M53.6) — one of the two scripts
   * that change the vault, so a page open on the file has a real write to
   * hear mid-turn.
   */
  append?: { path: string; content: string };
  /** What its `edit_note` call replaces (M55.5) — the other one. */
  edit?: { path: string; edits: QuoteEdit[] };
  text: string;
}

/** `append "<content>" to <note>.md`, as typed: a write script (M53.6). */
const APPEND = /^append "([^"]+)" to (\S+\.md)$/;

/** `edit "<old>" to "<new>" in <note>.md`, as typed: the other write script
 * (M55.5). Inside the quotes `\n` is a line break, and `<new>` may be empty,
 * which deletes the passage. */
const EDIT = /^edit "([^"]+)" to "([^"]*)" in (\S+\.md)$/;

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

/**
 * What the default script says the vault is (M54.8), in the model the app has
 * today. src/lib/productBrief.test.ts holds it to no retired term. One line,
 * and it keeps its first words: e2e/ai-block.spec.ts and
 * src/editor/MarkdownEditor.test.tsx find an AI block's answer by them.
 */
export const VAULT_OVERVIEW_REPLY =
  'This vault tracks work as typed markdown: every note is a page, typed notes are records in their databases, and a knowledge bundle I maintain waits for you to verify. Ask me to find something, file an Inbox capture, or write up what I have learned.';

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

function scriptFor(message: string, systemPrompt?: string): Script {
  // First, and on the raw message: the content is quoted as typed, and a
  // note path may name an inbox or a risk without this being about either.
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
  const append = APPEND.exec(message.trim());
  if (append !== null) {
    const [, content, path] = append;
    return {
      tools: [{ name: 'append_to_note', input: JSON.stringify({ path, content }) }],
      append: { path, content },
      text: `I appended that to ${path}.`,
    };
  }
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

/** Play a failure script: the init, the error (with its notice when Rust
 * types one), the turn's end and Done, as the fold reads a failed run. */
function runFailure(
  failure: (typeof MOCK_FAILURES)[string],
  emit: (event: AgentStreamEvent) => void,
  sessionId: string,
  delayMs: number,
): MockRun {
  let cancelled = false;
  const error: AgentStreamEvent = {
    kind: 'Error',
    message: failure.message,
    ...(failure.code === null ? {} : { code: failure.code }),
    ...(failure.notice === null ? {} : { notice: failure.notice }),
  };
  const steps: AgentStreamEvent[] = [
    { kind: 'Init', session_id: sessionId },
    error,
    { kind: 'TurnEnded', stop_reason: 'stop_sequence' },
    { kind: 'Done' },
  ];
  const timers = steps.map((event, at) =>
    setTimeout(() => {
      if (!cancelled) emit(event);
    }, at * delayMs),
  );
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
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

/** Split into small chunks so the UI genuinely streams rather than snapping. */
function chunk(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

export interface MockRun {
  cancel: () => void;
}

/** A call the mock's gate holds for the person (M57.1). */
export interface MockDeferral {
  toolId: string;
  toolName: string;
  input: string;
}

/**
 * Replay a scripted run. Returns a handle whose `cancel` stops emission —
 * the mock equivalent of killing the child process.
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
    systemPrompt,
    sessionId = UNNAMED_SESSION,
    model = null,
    asks,
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
    /** Registers a held call with the book and gives its card, or null for
     * a deferral the book did not register. The caller resumes the turn
     * with `resume` below once the person answers. */
    onDefer?: (call: MockDeferral) => PendingInteraction | null;
    /** This run resumes a held call with the person's answer: it starts
     * after that call, which runs on allow and is refused on deny. */
    resume?: { toolId: string; answer: PersonAnswer };
  } = {},
): MockRun {
  // Matched first, on the message as typed (M56.4).
  const failure = MOCK_FAILURES[message.trim()];
  if (failure !== undefined) return runFailure(failure, emit, sessionId, delayMs);
  const script = scriptFor(message, systemPrompt);
  let cancelled = false;
  // Held on a call (M57.1): the turn stops at its Done, mid-script.
  let suspended = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  // What the run says once its tools are done; a refused write rewrites it,
  // so the transcript never claims a write that did not happen.
  let reply = script.text;

  type Step = () => void | Promise<void>;

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

  const acting: Step[] = [];
  acting.push(() => emit({ kind: 'Init', session_id: sessionId }));
  // The model answering, as the fold reports it once per turn (M56.3).
  acting.push(() => emit({ kind: 'ModelChanged', model: mockModel(model) }));
  if (script.thinking !== undefined && resume === undefined) {
    acting.push(() => emit({ kind: 'ThinkingDelta', text: script.thinking as string }));
  }
  const tools = script.tools ?? [];
  // A resume starts after the held call, so its earlier calls are not run again.
  const resumeAt = resume === undefined ? -1 : tools.findIndex((_, i) => `t-${i + 1}` === resume.toolId);
  tools.forEach(({ name, input, output }, i) => {
    const id = `t-${i + 1}`;
    if (i < resumeAt) return;
    const appended = name === 'append_to_note' ? script.append : undefined;
    const edited = name === 'edit_note' ? script.edit : undefined;
    const completion: Step =
      appended !== undefined
        ? () => append(id, appended)
        : edited !== undefined
          ? () => edit(id, edited)
          : () =>
              emit(
                output === undefined
                  ? { kind: 'ToolDone', tool_id: id }
                  : { kind: 'ToolDone', tool_id: id, output },
              );
    if (i === resumeAt && resume !== undefined) {
      // The held call, answered: allow runs it; deny refuses it in Rust's
      // words, and the reply says so rather than claim the write.
      acting.push(
        resume.answer.kind === 'allow'
          ? completion
          : () => {
              const refusal = declinedText(resume.answer);
              reply = `I did not run ${name}: you declined it.`;
              emit({ kind: 'ToolDone', tool_id: id, output: refusal, is_error: true });
            },
      );
      return;
    }
    acting.push(() => emit({ kind: 'ToolStart', tool_name: name, tool_id: id, input }));
    if (asks?.(name) === true) {
      acting.push(() => {
        const card = onDefer?.({ toolId: id, toolName: name, input }) ?? null;
        if (card !== null) emit({ kind: 'Interaction', interaction: card });
        emit({ kind: 'ToolDeferred', tool_id: id, tool_name: name });
        suspended = true;
        emit({ kind: 'Done' });
      });
    }
    acting.push(completion);
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
    await play([
      ...chunk(reply).map(
        (piece): Step =>
          () =>
            emit({ kind: 'TextDelta', text: piece }),
      ),
      // The whole message and the turn's end, as the fold reads them off the
      // CLI's assistant line and result (M56.3), before the result itself.
      () => emit({ kind: 'Text', message_id: 'msg_mock', text: reply }),
      () => emit({ kind: 'TurnEnded', stop_reason: 'end_turn' }),
      () => emit({ kind: 'Result', text: reply, session_id: sessionId }),
      () => emit({ kind: 'Done' }),
    ]);
  })();

  return {
    cancel: () => {
      // A held run already sent its Done.
      if (cancelled || suspended) return;
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      emit({ kind: 'Done' });
    },
  };
}
