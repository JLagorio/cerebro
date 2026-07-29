import type { AgentEvent } from './types';

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
  tool?: { name: string; input: string };
  text: string;
}

function scriptFor(message: string): Script {
  const prompt = message.toLowerCase();

  if (prompt.includes('inbox') || prompt.includes('organize') || prompt.includes('organise')) {
    return {
      tool: { name: 'list_inbox', input: '{}' },
      text: 'There are captures waiting. The one about the warehouse cutover reads like a **Work item** for Phoenix warehouse rollout — it names an owner and an action. I have proposed a filing for it; accept or reject it in the Inbox.',
    };
  }
  if (prompt.includes('risk') || prompt.includes('at risk')) {
    return {
      tool: { name: 'search_notes', input: '{"query":"risk"}' },
      text: 'Two risks are open. [[risk-scanner-delivery]] is the one with a date attached, and nothing in the vault records a mitigation for it yet.',
    };
  }
  if (prompt.includes('knowledge') || prompt.includes('concept') || prompt.includes('document')) {
    return {
      tool: { name: 'write_concept', input: '{"path":"knowledge/playbooks/x.md"}' },
      text: 'Written to the knowledge bundle as a draft. It is unverified until you review it — open **Knowledge** and check it against the sources I listed.',
    };
  }
  return {
    thinking: 'Reading the vault context first.',
    tool: { name: 'get_vault_context', input: '{}' },
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
  emit: (event: AgentEvent) => void,
  { delayMs = 12 }: { delayMs?: number } = {},
): MockRun {
  const script = scriptFor(message);
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const steps: (() => void)[] = [];
  steps.push(() => emit({ kind: 'Init', session_id: SESSION }));
  if (script.thinking !== undefined) {
    steps.push(() => emit({ kind: 'ThinkingDelta', text: script.thinking as string }));
  }
  if (script.tool !== undefined) {
    const { name, input } = script.tool;
    steps.push(() => emit({ kind: 'ToolStart', tool_name: name, tool_id: 't-1', input }));
    steps.push(() => emit({ kind: 'ToolDone', tool_id: 't-1' }));
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
