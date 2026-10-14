import { runMockAgent, type MockRun } from './mockAgent';
import type { AgentEvent, AgentStatus, CliWorkspace, UiAction } from './types';
import type { RunCauseRequest } from '@/engine/jobs';
import { agentAppend, agentEdit, refuseIfAgentPaused } from '@/lib/mockIpc';

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

export interface RunOptions {
  message: string;
  systemPrompt?: string;
  sessionId?: string | null;
  model?: string | null;
  /** The Settings ceiling — see AgentPolicy. */
  shell: boolean;
  /** Let the run reach the user's own MCP servers (M8.2). */
  connectors: boolean;
  /** Whether a person is watching this run. Only an attended run that names
   * no connector, in its record's `connectors:` or in its declared tools
   * (M54.9), may fall back to the user's global MCP config when the vault has
   * no connectors.json (PR #5 security review) — a background
   * job executing vault-authored content unattended never inherits it; for
   * that job the absent file is the absence of a vault-scoped opt-in, not a
   * grant. And only an attended run reaches connectors its record does not
   * name (M54.9). */
  attended: boolean;
  /** Attribute this run's writes to a process identity (M13.4) —
   * `process:<slug>` for an agent record's run; omitted = the default. */
  actor?: string | null;
  /** Approval keys of the vault's connectors approved on this machine: the
   * digests of stdio fingerprints (PR #5 security review) and of http ones
   * (M54.9) — engine/connectors.approvalKey. Absent reads as none approved:
   * a missing field must never widen access. */
  approvedStdio?: string[];
  /** A NARROWING of this run's tools, declared by the vault file that started
   * it (M17.8). Intersected with the policy in Rust, never unioned — a vault
   * file may subtract from what Settings granted and can never add to it.
   * Absent means "do not narrow"; [] means "narrow to nothing". An entry that
   * names one of the run's connectors narrows its grant too (M54.9), and
   * with no connectors.json, one that names any connector keeps the run off
   * the user's global MCP config. */
  allowedTools?: string[] | null;
  /** Connector tools this run may never call, from the record's
   * `disallowed-tools:` (M54.9). Only entries that name one of the run's
   * connectors count, and they can only subtract; with no connectors.json,
   * one that names any connector keeps the run off the user's global MCP
   * config, which no deny could bind. Enforced in Rust. */
  disallowedTools?: string[] | null;
  /** Connectors this run may reach, when the record named some (M18.4). The
   * same narrowing contract as allowedTools: absent means every enabled,
   * approved one for an attended run and none for an unattended one (M54.9),
   * [] means none, and a name the vault has not enabled is dropped rather
   * than conjured, then named in the run's prompt with why (M54.11).
   * Enforced in connectors.rs. */
  connectorNames?: string[] | null;
  /** Vault-relative folders this run may WRITE inside (M17.13). Absent is
   * unrestricted. Enforced in Rust against the bearer the child presents, so
   * an agent cannot talk its way out of it. */
  scope?: string[] | null;
  /** Vault-relative folders this run may READ inside (M34.4). Same Option
   * semantics as scope; its own axis, enforced in Rust on the same bearer. */
  readScope?: string[] | null;
  /** Which budget lane an UNATTENDED run bills to (M34.2.4) — the job
   * runner names its job's kind. Present, the run claims a dispatcher lease
   * and faces the ambient gate; the answer can be `{ deferred }` and the
   * caller must read it. Absent keeps the legacy attended booking. */
  lane?: string;
  /** Why an UNATTENDED run started (M56.7), as `causeOfJob` names it. Rust
   * admits it or refuses the run, records it on the run's row, and opens the
   * message with it quoted as data. Absent records NULL, "why not recorded";
   * an attended run is always recorded as attended, whatever this says. */
  cause?: RunCauseRequest | null;
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

/**
 * What starting a run answers (M34.2.4): a handle, or a typed deferral.
 *
 * `deferred` is the ambient gate saying "not now" — over a ceiling, paused,
 * accounting unknown — and only an unattended run that named a `lane` can
 * receive it. It is a RESULT the caller must read, not an error to toast
 * away: the runner logs one honest row and surrenders the fire key so the
 * run happens when the window resets.
 */
export type RunStart = RunHandle | { deferred: string[] };

/** Narrow a RunStart to its handle. Attended callers — every call without a
 * `lane` — are never gated and never deferred, so reaching a deferral there
 * is a contract break: thrown loudly rather than rendered as a silent
 * no-run. Unattended callers must NOT use this — they read the deferral. */
export function startedOrThrow(start: RunStart): RunHandle {
  if ('deferred' in start) {
    throw new Error(`run deferred by the budget gate: ${start.deferred.join(', ')}`);
  }
  return start;
}

/** Start a run. Resolves to the process tag and, where one exists, the
 * durable id of the row this run will be recorded in — or to a typed
 * deferral when the ambient gate refused an unattended, laned run. */
export async function runAgent(vault: string, options: RunOptions): Promise<RunStart> {
  if (!inTauri()) {
    // M33b.5 — the browser mirrors the Rust guard rather than skipping it. In
    // Tauri the refusal lives in `run_agent`, ahead of the token and the
    // child; here there is no backend to reach, so a paused agent would run
    // in dev and in every browser-mode test unless this stands. AGENTS.md
    // makes that parity a rule, and spec §6 makes this particular one the
    // point of the phase.
    refuseIfAgentPaused(vault, options.actor);
    // No cause check here (M56.7), unlike the pause: the vocabulary and its
    // refusals live once, in src-tauri/src/runtime/cause.rs, and a second
    // copy of the kinds on this side is the twin list that rule forbids. The
    // browser records no runs, so there is no row a bad kind could reach.
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
      // The system prompt rides along (M52.3) so a scripted answer about
      // Knowledge can read the snapshot the real agent would. The write
      // scripts land on the mock disk through the same refusals as Rust's:
      // the append as tool_append's (M53.6), the edit as tool_edit_note's
      // (M55.5).
      {
        onUiAction: emitUiAction,
        onAppend: (path, content) => agentAppend(vault, path, content),
        onEdit: (path, edits) => agentEdit(vault, path, edits),
        systemPrompt: options.systemPrompt,
      },
    );
    mockRuns.set(run, mock);
    // No runtime database in the browser, so no durable row and no id to
    // invent for it.
    return { run, durableId: null };
  }
  return invokeTauri<{ run: number; run_id: string } | { deferred: string[] }>('run_agent', {
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
      disallowed_tools: options.disallowedTools ?? null,
      read_scope: options.readScope ?? null,
      connector_names: options.connectorNames ?? null,
      scope: options.scope ?? null,
      lane: options.lane ?? null,
      cause: options.cause ?? null,
    },
  }).then((result) =>
    'deferred' in result ? result : { run: result.run, durableId: result.run_id },
  );
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

/** Stop everything: the manual door. Rust already stops every run on quit
 * and the old vault's runs on a vault switch (M53.10), so neither needs this
 * — and "I am done with this turn" is what stopAgent(run) is for. */
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

/** UI actions the agent drives: open_note, navigate, propose_organize, and
 *  vault_changed, which its write tools announce (M53.6). */
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
