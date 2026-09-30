import type { AgentStreamEvent, UiAction } from './types';

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
  tools?: { name: string; input: string }[];
  /**
   * A UI action the run drives, fired after its tools report done. The mock
   * has to actually DO what its reply claims — a script that says "I have
   * proposed a filing" without emitting the proposal makes the panel's own
   * transcript the least trustworthy thing on screen, and leaves the real
   * propose-and-review path with no test running through it.
   */
  uiAction?: UiAction;
  text: string;
}

/** A capture that exists in the demo vault, so the proposal has a real target. */
const DEMO_CAPTURE = 'inbox/warehouse-cutover-thought.md';

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
 * write: the mock writes nothing, and a transcript that says "written to the
 * knowledge bundle" over a bundle that did not change is the panel lying —
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
  const prompt = message.toLowerCase();

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
    text: 'This vault tracks work as typed markdown: objectives and key results as records, work items inside project folders, and a knowledge bundle I maintain for you to verify. Ask me to find something, file an Inbox capture, or write up what I have learned.',
  };
}

const SESSION = 'mock-session';

/** Split into small chunks so the UI genuinely streams rather than snapping. */
function chunk(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

export interface MockRun {
  cancel: () => void;
}

/**
 * Replay a scripted run. Returns a handle whose `cancel` stops emission —
 * the mock equivalent of killing the child process.
 */
export function runMockAgent(
  message: string,
  emit: (event: AgentStreamEvent) => void,
  {
    delayMs = 12,
    onUiAction,
    systemPrompt,
  }: {
    delayMs?: number;
    onUiAction?: (action: UiAction) => void;
    /** The turn's system prompt, whose context snapshot says what the page
     * in front of the user holds (M52.3) — the mock reads Knowledge there. */
    systemPrompt?: string;
  } = {},
): MockRun {
  const script = scriptFor(message, systemPrompt);
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const steps: (() => void)[] = [];
  steps.push(() => emit({ kind: 'Init', session_id: SESSION }));
  if (script.thinking !== undefined) {
    steps.push(() => emit({ kind: 'ThinkingDelta', text: script.thinking as string }));
  }
  (script.tools ?? []).forEach(({ name, input }, i) => {
    const id = `t-${i + 1}`;
    steps.push(() => emit({ kind: 'ToolStart', tool_name: name, tool_id: id, input }));
    steps.push(() => emit({ kind: 'ToolDone', tool_id: id }));
  });
  if (script.uiAction !== undefined) {
    const action = script.uiAction;
    steps.push(() => onUiAction?.(action));
  }
  for (const piece of chunk(script.text)) {
    steps.push(() => emit({ kind: 'TextDelta', text: piece }));
  }
  steps.push(() => emit({ kind: 'Result', text: script.text, session_id: SESSION }));
  steps.push(() => emit({ kind: 'Done' }));

  steps.forEach((step, i) => {
    timers.push(
      setTimeout(() => {
        if (!cancelled) step();
      }, i * delayMs),
    );
  });

  return {
    cancel: () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      emit({ kind: 'Done' });
    },
  };
}
