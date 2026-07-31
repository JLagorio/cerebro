import { runMockAgent, type MockRun } from './mockAgent';
import type { AgentEvent, AgentStatus, McpInfo, UiAction } from './types';

/**
 * Agent IPC facade (M6), same shape as lib/ipc.ts: inside Tauri these invoke
 * the Rust commands and subscribe to the event channel; in the browser they
 * drive the scripted mock so the panel is exercisable in dev and in tests.
 */

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function checkAgent(): Promise<AgentStatus> {
  return inTauri()
    ? invokeTauri('check_agent')
    : // The mock stands in for a working install so the panel is usable in
      // `pnpm dev`; the version string says plainly that it is not real.
      Promise.resolve({ installed: true, version: 'mock (browser)', path: null });
}

export function startMcp(vault: string): Promise<McpInfo> {
  return inTauri()
    ? invokeTauri('start_mcp', { vault })
    : Promise.resolve({ url: 'mock://cerebro', token: 'mock' });
}

export interface RunOptions {
  message: string;
  systemPrompt?: string;
  sessionId?: string | null;
  model?: string | null;
  /** The Settings ceiling — see AgentPolicy. */
  shell: boolean;
  /** Let the run reach the user's own MCP servers (M8.2). */
  connectors: boolean;
  /** Attribute this run's writes to a process identity (M13.4) —
   * `process:<slug>` for an agent record's run; omitted = the default. */
  actor?: string | null;
  mcp: McpInfo | null;
}

let mockRun: MockRun | null = null;

export async function runAgent(vault: string, options: RunOptions): Promise<void> {
  if (!inTauri()) {
    // The mock drives the UI-action channel through the same fan-out the
    // Tauri listener uses, so browser mode exercises the real subscriber.
    mockRun = runMockAgent(options.message, (event) => emitLocal(event), {
      onUiAction: emitUiAction,
    });
    return;
  }
  await invokeTauri('run_agent', {
    vault,
    request: {
      message: options.message,
      system_prompt: options.systemPrompt ?? null,
      session_id: options.sessionId ?? null,
      model: options.model ?? null,
      shell: options.shell,
      connectors: options.connectors,
      actor: options.actor ?? null,
      mcp_url: options.mcp?.url ?? null,
      mcp_token: options.mcp?.token ?? null,
    },
  });
}

export async function stopAgent(): Promise<void> {
  if (!inTauri()) {
    mockRun?.cancel();
    mockRun = null;
    return;
  }
  await invokeTauri('stop_agent');
}

// --- Event fan-out ---------------------------------------------------------

type Listener = (event: AgentEvent) => void;
const listeners = new Set<Listener>();
let bound = false;

function emitLocal(event: AgentEvent): void {
  for (const listener of [...listeners]) listener(event);
}

/**
 * Subscribe to the agent stream. The Tauri listener is bound once for the
 * app's lifetime and fanned out here — re-binding per subscriber would
 * deliver each event as many times as the panel had mounted.
 */
export function onAgentEvent(listener: Listener): () => void {
  listeners.add(listener);
  if (inTauri() && !bound) {
    bound = true;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<AgentEvent>('cerebro://agent', (event) => emitLocal(event.payload));
    })().catch(() => {
      // Failed bind must not latch, or the channel is dead for the session.
      bound = false;
    });
  }
  return () => listeners.delete(listener);
}

type UiListener = (action: UiAction) => void;
const uiListeners = new Set<UiListener>();
let uiBound = false;

/** UI actions the agent drives: open_note, navigate, propose_organize. */
export function onUiAction(listener: UiListener): () => void {
  uiListeners.add(listener);
  if (inTauri() && !uiBound) {
    uiBound = true;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      await listen<UiAction>('cerebro://ui-action', (event) => {
        for (const l of [...uiListeners]) l(event.payload);
      });
    })().catch(() => {
      uiBound = false;
    });
  }
  return () => uiListeners.delete(listener);
}

/** Browser-mode hook so the mock can drive UI actions in dev and tests. */
export function emitUiAction(action: UiAction): void {
  for (const listener of [...uiListeners]) listener(action);
}
