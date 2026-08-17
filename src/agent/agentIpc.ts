import { runMockAgent, type MockRun } from './mockAgent';
import type { AgentEvent, AgentStatus, CliWorkspace, McpInfo, UiAction } from './types';
import { refuseIfAgentPaused } from '@/lib/mockIpc';

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

/** What the CLI has stored about this vault outside it (M17.14). */
export function agentWorkspace(vault: string): Promise<CliWorkspace> {
  return inTauri()
    ? invokeTauri<{
        path: string;
        exists: boolean;
        sessions: number;
        bytes: number;
        memory_files: number;
      }>('agent_workspace', { vault }).then((w) => ({
        path: w.path,
        exists: w.exists,
        sessions: w.sessions,
        bytes: w.bytes,
        memoryFiles: w.memory_files,
      }))
    : // Browser mode spawns no CLI, so there is nothing outside the vault to
      // report. Saying "0 files" would be a claim about a real directory.
      Promise.resolve({ path: '', exists: false, sessions: 0, bytes: 0, memoryFiles: 0 });
}

export function purgeAgentWorkspace(vault: string): Promise<number> {
  return inTauri() ? invokeTauri<number>('purge_agent_workspace', { vault }) : Promise.resolve(0);
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
  /** Whether a person is watching this run. Only an attended run may fall
   * back to the user's global MCP config when the vault has no
   * connectors.json (PR #5 security review) — a background job executing
   * vault-authored content unattended never inherits it; for that job the
   * absent file is the absence of a vault-scoped opt-in, not a grant. */
  attended: boolean;
  /** Attribute this run's writes to a process identity (M13.4) —
   * `process:<slug>` for an agent record's run; omitted = the default. */
  actor?: string | null;
  /** Fingerprints of the vault's stdio connectors approved to run on this
   * machine (PR #5 security review) — engine/connectors.stdioFingerprint.
   * Absent reads as none approved: a missing field must never widen access. */
  approvedStdio?: string[];
  /** A NARROWING of this run's tools, declared by the vault file that started
   * it (M17.8). Intersected with the policy in Rust, never unioned — a vault
   * file may subtract from what Settings granted and can never add to it.
   * Absent means "do not narrow"; [] means "narrow to nothing". */
  allowedTools?: string[] | null;
  /** Connectors this run may reach, when the record named some (M18.4). The
   * same narrowing contract as allowedTools: absent means "whatever the vault
   * enabled", [] means none, and a name the vault has not enabled is dropped
   * rather than conjured. Enforced in connectors.rs. */
  connectorNames?: string[] | null;
  /** Vault-relative folders this run may WRITE inside (M17.13). Absent is
   * unrestricted. Enforced in Rust against the bearer the child presents, so
   * an agent cannot talk its way out of it. */
  scope?: string[] | null;
  mcp: McpInfo | null;
}

/** Live mock runs by id (M17.3) — a Map for the same reason AgentState is one:
 * three module singletons could only ever describe a single child, so the mock
 * could not reproduce the concurrency the real backend now has. */
const mockRuns = new Map<number, MockRun>();
let mockRunSeq = 0;

/**
 * What starting a run hands back (M33.7).
 *
 * `run` is the process-local tag every event of this run carries and the id
 * `stopAgent` takes — unchanged. `durableId` is the id the `runs` row is
 * keyed by, so a finished run in the status bar can open its own fleet
 * detail.
 *
 * `durableId` is NULL in the browser, and that is the honest answer rather
 * than a placeholder: there is no runtime database there, so no row exists to
 * point at. It is the same "this device only" state a log entry written
 * before M33.7 is in.
 */
export interface RunHandle {
  run: number;
  durableId: string | null;
}

/** Start a run. Resolves to the process tag and, where one exists, the
 * durable id of the row this run will be recorded in. */
export async function runAgent(vault: string, options: RunOptions): Promise<RunHandle> {
  if (!inTauri()) {
    // M33b.5 — the browser mirrors the Rust guard rather than skipping it. In
    // Tauri the refusal lives in `run_agent`, ahead of the token and the
    // child; here there is no backend to reach, so a paused agent would run
    // in dev and in every browser-mode test unless this stands. AGENTS.md
    // makes that parity a rule, and spec §6 makes this particular one the
    // point of the phase.
    refuseIfAgentPaused(vault, options.actor);
    const run = ++mockRunSeq;
    // The mock drives the UI-action channel through the same fan-out the
    // Tauri listener uses, so browser mode exercises the real subscriber.
    // Tagging happens here for the same reason it happens in agent.rs: the
    // script only knows its own stream, the runtime knows which run it is.
    const mock = runMockAgent(
      options.message,
      (event) => {
        emitLocal({ ...event, run });
        // Reap at the terminal event, mirroring the reader thread's finish().
        if (event.kind === 'Done') mockRuns.delete(run);
      },
      { onUiAction: emitUiAction },
    );
    mockRuns.set(run, mock);
    // No runtime database in the browser, so no durable row and no id to
    // invent for it.
    return { run, durableId: null };
  }
  return invokeTauri<{ run: number; run_id: string }>('run_agent', {
    vault,
    request: {
      message: options.message,
      system_prompt: options.systemPrompt ?? null,
      session_id: options.sessionId ?? null,
      model: options.model ?? null,
      shell: options.shell,
      connectors: options.connectors,
      attended: options.attended,
      actor: options.actor ?? null,
      approved_stdio: options.approvedStdio ?? [],
      allowed_tools: options.allowedTools ?? null,
      connector_names: options.connectorNames ?? null,
      scope: options.scope ?? null,
      mcp_url: options.mcp?.url ?? null,
      mcp_token: options.mcp?.token ?? null,
    },
  }).then(({ run, run_id }) => ({ run, durableId: run_id }));
}

/**
 * Kill ONE run (M17.3). `false` means it had already finished — a race, not a
 * failure.
 *
 * This used to take no argument and kill whatever child existed, which was
 * only ever safe because there could be one. It is why closing the assistant
 * aborted a background distill, and why opening a stored conversation did too.
 */
export async function stopAgent(run: number): Promise<boolean> {
  if (!inTauri()) {
    const mock = mockRuns.get(run);
    if (mock === undefined) return false;
    mock.cancel();
    mockRuns.delete(run);
    return true;
  }
  return invokeTauri<boolean>('stop_agent', { run });
}

/** Kill everything. For shutdown and vault switches — never for "I am done
 * with this turn", which is what stopAgent(run) is for. */
export async function stopAllAgents(): Promise<number[]> {
  if (!inTauri()) {
    const dead = [...mockRuns.keys()];
    for (const mock of mockRuns.values()) mock.cancel();
    mockRuns.clear();
    return dead;
  }
  return invokeTauri<number[]>('stop_all_agents');
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
 *
 * With no `run`, every event is delivered and the subscriber self-filters —
 * how the whole app worked before M17.3, and still what the UI-action bridge
 * and any future task list want. Passing a run makes the subscription belong
 * to that run: the reason `deadRuns` had to exist was that a listener could
 * not say which stream was its own, so it had to recognise other runs'
 * terminal events and refuse them by hand.
 */
export function onAgentEvent(listener: Listener, run?: number): () => void {
  const scoped: Listener =
    run === undefined
      ? listener
      : (event) => {
          if (event.run === run) listener(event);
        };
  listeners.add(scoped);
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
  return () => listeners.delete(scoped);
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
