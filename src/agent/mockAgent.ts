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

function scriptFor(message: string): Script {
  const prompt = message.toLowerCase();

  // Checked before the Inbox branch: a distillation names the note it is
  // reading, and most of those paths start with `inbox/` — matching on that
  // would answer "learn from this capture" with a filing proposal.
  if (prompt.startsWith('learn from the note at')) {
    return {
      tools: [
        { name: 'get_note', input: '{}' },
        { name: 'write_concept', input: '{"path":"knowledge/systems/x.md"}' },
      ],
      text: 'Kept one thing: the drain window, anchored to the project and citing this note. Skipped the scheduling talk.',
    };
  }
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
  if (prompt.includes('knowledge') || prompt.includes('concept') || prompt.includes('document')) {
    return {
      tools: [{ name: 'write_concept', input: '{"path":"knowledge/playbooks/x.md"}' }],
      text: 'Written to the knowledge bundle as a draft. It is unverified until you review it — open **Knowledge** and check it against the sources I listed.',
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
  }: { delayMs?: number; onUiAction?: (action: UiAction) => void } = {},
): MockRun {
  const script = scriptFor(message);
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
