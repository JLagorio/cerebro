import { runMockAgent, type MockRun } from './mockAgent';
import {
  abortMockAnswer,
  answerMockInteraction,
  cancelMockInteraction,
  confirmMockInteraction,
  finishMockAnswer,
  listMockInteractions,
  mockAsks,
  registerMockInteraction,
  settleMockSession,
} from './mockInteractions';
import type {
  AgentEvent,
  AgentStatus,
  AgentStreamEvent,
  ClaudeUserSettings,
  CliWorkspace,
  ForkPoint,
  LiveTurn,
  PendingInteraction,
  PersonAnswer,
  TranscriptRead,
  UiAction,
} from './types';
import type { RunState } from '@/engine/ai/threadStatus';
import { ASSISTANT_ACTOR } from '@/engine/authors';
import type { RunCauseRequest } from '@/engine/jobs';
import { runOptionsRefusal } from '@/engine/runOptions';
import { namesTool } from '@/engine/toolGrant';
import { conditionRun, withheldRun } from '@/lib/demoOperational';
import { faulted } from '@/lib/mockFaults';
import { settleMockRun } from '@/lib/mockGit';
import {
  agentAppend,
  agentComment,
  agentCreate,
  agentEdit,
  agentEditSheet,
  agentEditCanvas,
  agentCreateCanvas,
  agentImportNotion,
  beginMockNotionRun,
  endMockNotionRun,
  agentReply,
  agentResolve,
  agentSetFields,
  agentSuggestView,
  agentScheduleFollowup,
  unfireMockFollowup,
  beginMockRun,
  bookMockRun,
  claimMockWake,
  checkMockWake,
  endMockRun,
  finishMockRun,
  finishMockWake,
  readyMockFollowup,
  fireMockFollowup,
  postThreadPlaceholder,
  queueAgentWrite,
  readMockCliTranscript,
  recordMockCliTranscript,
  refuseIfAgentPaused,
  refuseIfAgentRunning,
  settleThreadPlaceholder,
  settleWords,
  threadTurnRefusal,
  type ThreadTurnEnd,
  type ThreadTurnRequest,
  type WriteStamp,
} from '@/lib/mockIpc';
import {
  APPROVAL_MESSAGES,
  plan as planApproval,
  subjectIsCut,
  type DelegateCeiling,
  type RunApproval,
  type ShellCeiling,
} from '@/lib/policy/toolApproval';

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
        session_files: number;
        bytes: number;
        memory_files: number;
        unreadable: number;
        shared: boolean;
      }>('agent_workspace', { vault }).then((w) => ({
        path: w.path,
        exists: w.exists,
        sessions: w.sessions,
        sessionFiles: w.session_files,
        bytes: w.bytes,
        memoryFiles: w.memory_files,
        unreadable: w.unreadable,
        shared: w.shared,
      }))
    : // Browser mode spawns no CLI, so there is nothing outside the vault to
      // report. Saying "0 files" would be a claim about a real directory.
      Promise.resolve({
        path: '',
        exists: false,
        sessions: 0,
        sessionFiles: 0,
        bytes: 0,
        memoryFiles: 0,
        unreadable: 0,
        shared: false,
      });
}

export function purgeAgentWorkspace(vault: string): Promise<number> {
  return inTauri() ? invokeTauri<number>('purge_agent_workspace', { vault }) : Promise.resolve(0);
}

/**
 * A conversation's transcript, read back from Claude Code's own session file
 * for `vault` and folded in Rust (M56.3). `lastActiveAt` is when its last
 * turn ended, which tells Claude Code's sweep from a clear. Never rejects: a
 * read that fails reads as unavailable, `unreadable`, in its own words.
 */
export async function readCliTranscript(
  vault: string,
  sessionId: string | null,
  lastActiveAt: string | null,
): Promise<TranscriptRead> {
  try {
    if (!inTauri()) {
      return await faulted('read_cli_transcript', () =>
        Promise.resolve(readMockCliTranscript(sessionId)),
      );
    }
    return await invokeTauri<TranscriptRead>('read_cli_transcript', {
      vault,
      sessionId,
      lastActiveAt,
    });
  } catch (err) {
    return {
      state: 'unavailable',
      reason: 'unreadable',
      retention_days: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface RunOptions {
  message: string;
  systemPrompt?: string;
  sessionId?: string | null;
  /** The turn a branch starts from (M91.6), sent only while its thread has
   * no session of its own: Rust mints the branch's session, forks it from
   * `from` at `at` once it finds `at` where a turn of `from` ended, and
   * refuses in its words otherwise, or when `sessionId` names a session too.
   * Absent is no branch. */
  fork?: ForkPoint | null;
  /** The model and effort to ask Claude Code for (M56.5): the conversation's
   * pick, else the addressed or scheduled agent's record. Absent or blank is
   * Claude Code's default; Rust refuses anything outside run-options.v1.json
   * before the run starts. */
  model?: string | null;
  effort?: string | null;
  /** The shell ceiling this run may hold (M57.2): the Settings ceiling,
   * less what an agent's record leaves out (`effectiveCeiling`). Rust plans
   * it by the tool-approval table, and reads anything but "ask" and "on" as
   * off. */
  shell: ShellCeiling;
  /** The web ceiling this run may hold (M57.7): Web access in Settings, less
   * what an agent's record leaves out. Absent reads off, as Rust reads a
   * missing `web`, so a caller that never names it never widens a run. */
  web?: boolean;
  /** The Subagents switch this run may hold (M91.2a). Absent reads as Rust's
   * `DelegateCeiling::of` reads a missing `delegate`: on for an attended run
   * and off for any other; anything but "on" reads off. The panel's turns
   * send Settings' switch as it stands (M91.2d); no run nobody watches sends
   * one, since none could hold the tool. */
  delegate?: DelegateCeiling;
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
  /** Does the run's agent ask before its page writes (M57.4)? The agent
   * record's `ask-first:`, false for the plain panel. Rust reads the record
   * of a `process:` actor again, so this can only tighten the run. */
  askFirst?: boolean;
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
  /** The durable wake a woken run claims, and the pending wakes of the same
   * trigger it takes with it (M63.1). Sent as `run_agent`'s top-level
   * `wake`: Rust claims it inside the dispatch transaction and records the
   * wake's own cause, so a woken run is unattended, on lane `agent`, and
   * names no `cause`. The answer can be `{ settled: 'gone' }`. */
  followup?: string | null;
  wake?: { claim: string; coalesce: string[] } | null;
}

/** The kinds a mock run records for its session's replay (M56.3): what the
 * fold reads off a session file, less the prompt, which is recorded first.
 * A subagent's steps are among them, as its own transcript is (M91.4); what
 * only the live stream says (deltas, the Subagent* notes, a denial, the
 * result) never is. */
const REPLAYED = new Set<AgentStreamEvent['kind']>([
  'Text',
  'Thinking',
  'ModelChanged',
  'ToolStart',
  'ToolDone',
  'ToolPayload',
  'ToolResult',
  'ToolDeferred',
  'Error',
  'TurnEnded',
]);

/** Live mock runs by id (M17.3) — a Map for the same reason AgentState is one:
 * three module singletons could only ever describe a single child, so the mock
 * could not reproduce the concurrency the real backend now has. */
const mockRuns = new Map<number, MockRun>();
const mockRunOwners = new Map<number, { vault: string; actor: string | null }>();
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
 *
 * `sessionId` is the Claude Code session the run goes to (M56.3), minted or
 * resumed before the child starts, so a conversation stores it before the
 * first event. Optional because older test doubles do not name one.
 *
 * `attach` is what a panel re-attaches to the run by (M57.6, `attachRun`):
 * the durable run id in Tauri, and `mock-<page>-<run>` in the browser, whose
 * page nonce keeps a key from an earlier load from naming a run of this one.
 * Optional for the same older test doubles.
 */
export interface RunHandle {
  run: number;
  durableId: string | null;
  sessionId?: string | null;
  attach?: string;
}

/**
 * What starting a run answers: a handle, a typed deferral (M34.2.4), or a
 * woken run settled without starting (M63.1).
 *
 * `deferred` is the ambient gate saying "not now" — over a ceiling, paused,
 * accounting unknown — with parallel `words` for the human sentence. Only
 * an unattended run that named a `lane` can
 * receive it. It is a RESULT the caller must read, not an error to toast
 * away: the runner logs one honest row and surrenders the fire key so the
 * run happens when the window resets; a woken run's wake waits pending.
 * `settled` answers only a woken run: `gone` when its wake was no longer
 * pending, expired, or was cancelled by its agent's pause, so nothing
 * started and nothing is owed; `skipped` is held for a later part's check.
 */
export type RunStart =
  RunHandle | { deferred: string[]; words?: string[] } | { settled: 'gone' | 'skipped' };

/** The bounded pre-run check answers only the pending wakes it found. */
export type WakeCheck =
  | { state: 'met' | 'not_met' | 'gone'; wakes: string[] }
  | { state: 'unavailable'; wakes: string[]; retry_at: string | null; skipped: boolean }
  | { state: 'deferred'; wakes: string[]; reasons: string[]; words: string[] };
export function checkWake(
  vault: string,
  actor: string,
  wakes: string[],
  question: string,
): Promise<WakeCheck> {
  return inTauri()
    ? invokeTauri('check_wake', { vault, actor, wakes, question })
    : checkMockWake(vault, actor, wakes, question);
}

/** Narrow a RunStart to its handle. Attended callers — every call without a
 * `lane` or a `wake` — are never gated, deferred or settled, so reaching
 * either there is a contract break: thrown loudly rather than rendered as a
 * silent no-run. Unattended callers must NOT use this — they read both. */
export function startedOrThrow(start: RunStart): RunHandle {
  if ('deferred' in start) {
    throw new Error(`run deferred by the budget gate: ${start.deferred.join(', ')}`);
  }
  if ('settled' in start) {
    throw new Error(`run settled without starting: ${start.settled}`);
  }
  return start;
}

/** Start a run. Resolves to the process tag and, where one exists, the
 * durable id of the row this run will be recorded in — or to a typed
 * deferral with codes and human words when the ambient gate refused an unattended, laned run. */
export async function runAgent(vault: string, options: RunOptions): Promise<RunStart> {
  if (!inTauri()) {
    // M33b.5 — the browser mirrors the Rust guard rather than skipping it. In
    // Tauri the refusal lives in `run_agent`, ahead of the token and the
    // child; here there is no backend to reach, so a paused agent would run
    // in dev and in every browser-mode test unless this stands. AGENTS.md
    // makes that parity a rule, and spec §6 makes this particular one the
    // point of the phase.
    refuseIfAgentPaused(vault, options.actor);
    if (options.cause?.kind === 'manual')
      refuseIfAgentRunning(vault, options.actor, [...mockRunOwners.values()]);
    // M56.5: the same refusal Rust's run_options gives, in its words, from
    // the same artifact, before anything starts.
    const refused = runOptionsRefusal({ model: options.model, effort: options.effort });
    if (refused !== null) throw new Error(refused);
    // M63.1: the same refusal Rust's `wakes::refuse_request` gives a woken
    // request that is attended, off lane agent, not an agent's, or names a
    // cause of its own, in its words.
    if (
      options.followup != null &&
      (options.attended ||
        options.lane !== 'agent' ||
        !options.actor?.startsWith('process:') ||
        options.actor.length <= 8 ||
        options.wake != null)
    )
      throw new Error(
        'A follow-up starts only its own agent, unattended on lane agent, without a wake.',
      );
    const wokenRefused = options.wake == null ? null : wokenRunRefusal(options);
    if (wokenRefused !== null) throw new Error(wokenRefused);
    // No cause check here (M56.7), unlike the pause: the vocabulary and its
    // refusals live once, in src-tauri/src/runtime/cause.rs, and a second
    // copy of the kinds on this side is the twin list that rule forbids. The
    // browser records no runs, so there is no row a bad kind could reach.
    // M56.3: the session is minted here for a new run and reused for a
    // resumed one, as Rust's CliSession does, and the run's replay events are
    // recorded under it, so a thread whose messages are lost rebuilds in the
    // browser too. The mock takes the id it is handed; Rust validates the
    // shape, and nothing here reaches a path. A branch's session is minted
    // the way Rust mints it (M91.6, `branchMockSession`).
    const sessionId =
      options.fork != null
        ? branchMockSession(options.sessionId, options.fork)
        : (options.sessionId ?? crypto.randomUUID());
    // M57.1: a call this session left waiting, or one its card cancelled, is
    // refused as Rust's settle refuses it, and the new text runs.
    settleMockSession(sessionId);
    // M57.2: the run's plan, by the same table Rust plans it with, and the
    // row a run that withheld tools books, as Rust's meter does.
    // M63.1: a woken run claims its wake in the mock store first, as Rust
    // claims it inside the dispatch transaction, under the run's attach id
    // (M58.1's stamp id), which is minted here so the claim can name it.
    const run = ++mockRunSeq;
    if (options.wake != null) {
      const woken = claimMockWake(vault, options.actor ?? '', options.wake, mockAttach(run));
      if (woken === 'gone') return { settled: 'gone' };
      if ('deferred' in woken)
        return {
          deferred: woken.deferred,
          words: woken.deferred.map((reason) =>
            reason === 'agent_running' ? 'this agent is already running' : reason,
          ),
        };
    }
    if (options.followup != null) {
      const later = readyMockFollowup(vault, options.actor!, options.followup);
      if (later === null) return { settled: 'gone' };
      options = {
        ...options,
        cause: { kind: 'followup', subject: later.note, due_at: later.dueAt },
      };
      if (!fireMockFollowup(vault, options.actor!, later.followupId, mockAttach(run)))
        return { settled: 'gone' };
    } else if (options.cause?.kind === 'followup')
      throw new Error(
        'cause "followup" is refused: a followup run is started by the runtime, never named by the renderer. Nothing was started.',
      );
    const approval = mockApproval(options);
    let booked = bookWithheld(
      options,
      approval,
      sessionId,
      options.followup == null ? undefined : { vault, id: mockAttach(run) },
    );
    if (options.followup != null && booked === null) {
      const id = mockAttach(run);
      const detail = conditionRun({
        runId: id,
        vault,
        actor: options.actor!,
        at: new Date().toISOString(),
        parent: null,
        cause: {
          kind: 'followup',
          why: 'a follow-up it asked for came due',
          subject: options.cause!.subject ?? null,
          detail: null,
          due_at: options.cause!.due_at ?? null,
        },
      });
      detail.run.ended_at = null;
      detail.run.outcome = 'running';
      if (bookMockRun(detail)) booked = id;
    }
    try {
      startMockRun(
        vault,
        options,
        sessionId,
        [{ kind: 'UserPrompt', text: options.message }],
        undefined,
        booked,
        run,
      );
    } catch (error) {
      if (options.followup != null) unfireMockFollowup(vault, options.followup, mockAttach(run));
      throw error;
    }
    // The browser keeps no runtime database: a run that withheld tools or was a follow-up
    // books a row (the mock fleet's), and every other has no id to name.
    return announced({ run, durableId: booked, sessionId, attach: mockAttach(run) });
  }
  return invokeTauri<
    | { run: number; run_id: string; session_id: string }
    | { deferred: string[]; words?: string[] }
    | { settled: 'gone' | 'skipped' }
  >('run_agent', {
    vault,
    request: {
      message: options.message,
      system_prompt: options.systemPrompt ?? null,
      session_id: options.sessionId ?? null,
      fork: options.fork == null ? null : { from: options.fork.from, at: options.fork.at },
      model: options.model ?? null,
      effort: options.effort ?? null,
      shell: options.shell,
      web: options.web ?? false,
      delegate: options.delegate ?? null,
      connectors: options.connectors,
      attended: options.attended,
      ask_first: options.askFirst ?? false,
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
    wake: options.wake ?? null,
    followup: options.followup ?? null,
  }).then((result) =>
    'deferred' in result || 'settled' in result
      ? result
      : announced({
          run: result.run,
          durableId: result.run_id,
          sessionId: result.session_id,
          attach: result.run_id,
        }),
  );
}

/** What is wrong with a woken request, in `wakes::refuse_request`'s words,
 * or null (M63.1). */
function wokenRunRefusal(options: RunOptions): string | null {
  if (options.attended) {
    return 'a woken run is unattended: a change woke it, and nobody is watching. Nothing was started.';
  }
  if (options.lane !== 'agent') {
    const lane = options.lane === undefined ? 'None' : `Some(${JSON.stringify(options.lane)})`;
    return `a woken run bills to lane "agent", not ${lane}. Nothing was started.`;
  }
  if (!(options.actor ?? '').startsWith('process:')) {
    return "a woken run is an agent's run, so it needs a process: actor. Nothing was started.";
  }
  if (options.cause != null) {
    return (
      "a woken run's cause is its wake's, stored when the change was admitted, so the request " +
      'may not name another. Nothing was started.'
    );
  }
  return null;
}

/** Why Rust refuses a branch (M91.6), in `transcript::ForkRefused`'s words,
 * which the browser's mock gives as they are. */
export const FORK_REFUSED = {
  alsoResumes:
    'A branch starts a Claude Code session of its own, and this one also names a session to continue, so nothing was started.',
  malformed:
    'The turn this branch starts from is not named by a Claude Code session and line, so nothing was started.',
  noSource:
    'Claude Code no longer has the conversation this branch starts from, so nothing was started.',
  unreadable:
    "Claude Code's record of the conversation this branch starts from could not be read, so nothing was started.",
  notAnAnchor:
    "Claude Code's record of that conversation has no turn ending where this branch starts, so nothing was started.",
} as const;

/** A session id as Rust's `parse_session_id` reads one: a lowercase UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The session a branch runs in, in the browser (M91.6), as Rust's
 * `CliSession::for_request` and `check_fork` make it: no session beside the
 * branch, its source and anchor shaped as session ids, and the anchor where
 * one of the source's turns ended in its replay. The id is minted here, and
 * the source's replay up to that turn is recorded under it, as Claude Code
 * copies the source's lines into the branch's file, so the branch rebuilds
 * in the browser too. A refusal throws Rust's words and records nothing.
 */
function branchMockSession(sessionId: string | null | undefined, fork: ForkPoint): string {
  if (sessionId != null && sessionId.trim() !== '') throw new Error(FORK_REFUSED.alsoResumes);
  if (!SESSION_ID.test(fork.from) || !SESSION_ID.test(fork.at)) {
    throw new Error(FORK_REFUSED.malformed);
  }
  const source = readMockCliTranscript(fork.from);
  if (source.state !== 'read') {
    throw new Error(
      source.reason === 'unreadable' ? FORK_REFUSED.unreadable : FORK_REFUSED.noSource,
    );
  }
  const end = source.events.findIndex(
    (event) => event.kind === 'TurnEnded' && event.last_uuid === fork.at,
  );
  if (end === -1) throw new Error(FORK_REFUSED.notAnAnchor);
  const minted = crypto.randomUUID();
  recordMockCliTranscript(minted, source.events.slice(0, end + 1));
  return minted;
}

/**
 * A mock run's tool-approval plan (M57.2), as `plan_for` makes Rust's: the
 * mock's gate is always there for an attended run, so only an attended run
 * can ask.
 */
function mockApproval(options: RunOptions): RunApproval {
  const narrowing = options.allowedTools ?? null;
  return planApproval({
    kind: options.attended ? 'attended' : 'unattended',
    shell: options.shell,
    web: options.web === true ? 'on' : 'off',
    delegate: options.delegate,
    askFirst: options.askFirst ?? false,
    readScoped: options.readScope != null,
    narrowing:
      narrowing === null ? null : (tool) => narrowing.some((entry) => namesTool(entry, tool)),
  });
}

let mockRowSeq = 0;

/**
 * A run that went without the tools its ceiling would have asked for books
 * its row (M57.2): one `capability_unavailable` refusal under `agent.ask`,
 * in the mock fleet and on `window.__cerebroMockRefusals`. Returns the row's
 * id, or null when nothing was withheld or the fleet is unavailable.
 */
function bookWithheld(
  options: RunOptions,
  approval: RunApproval,
  sessionId: string,
  followup?: { vault: string; id: string },
): string | null {
  if (approval.withheld.length === 0) return null;
  mockRowSeq += 1;
  const runId = followup?.id ?? `mock-run-${String(mockRowSeq).padStart(4, '0')}`;
  const detail = `${APPROVAL_MESSAGES.withheld} ${approval.withheld.join(', ')}`;
  const holder = window as unknown as { __cerebroMockRefusals?: unknown[] };
  holder.__cerebroMockRefusals ??= [];
  holder.__cerebroMockRefusals.push({
    run: runId,
    code: 'capability_unavailable',
    surface: 'agent.ask',
    detail,
  });
  const row = withheldRun({
    runId,
    actor: options.actor ?? null,
    mode: options.lane === undefined ? 'attended' : 'ambient',
    lane: options.lane ?? 'agent',
    sessionId,
    at: new Date().toISOString(),
    detail,
  });
  if (followup !== undefined) {
    row.run.vault_id = followup.vault;
    row.run.cause = {
      kind: 'followup',
      why: 'a follow-up it asked for came due',
      subject: options.cause?.subject ?? null,
      detail: null,
      due_at: options.cause?.due_at ?? null,
    };
  }
  const booked = bookMockRun(row);
  return booked ? runId : null;
}

/**
 * Start one mock run (browser mode) and tag its events, as Rust's reader
 * does, recording its replay under `sessionId`. `resume` makes it the turn
 * that goes on after a held call's answer (M57.1); `booked` is the fleet row
 * it closes when it ends (M57.2).
 */
function startMockRun(
  vault: string,
  options: RunOptions,
  sessionId: string,
  replay: AgentStreamEvent[],
  resume?: { toolId: string; answer: PersonAnswer },
  booked: string | null = null,
  run: number = ++mockRunSeq,
): number {
  mockJournal.open(run);
  mockRunOwners.set(run, { vault, actor: options.actor ?? null });
  // M58.1: every write the run makes is stamped with its actor (blank reads
  // as the assistant, as Rust's normalize_actor reads it) and its run, the
  // attach id every mock run has, so none is logged as an IPC write's (the
  // person's, with no run).
  const actor = options.actor?.trim() ? options.actor : ASSISTANT_ACTOR;
  const stamp: WriteStamp = { actor, runId: mockAttach(run) };
  beginMockNotionRun(
    stamp.runId!,
    options.allowedTools == null ||
      options.allowedTools.some((tool) => namesTool(tool, 'import_notion_page')),
  );
  // M58.3: the run's paths are its own from here until its commit lands, as
  // Rust's claim holds them; the commit comes before its closing events.
  beginMockRun(stamp.runId, actor);
  // M63.1: how the run ended, for the wake it claimed — stopped on purpose
  // is interrupted, an Error of its own before Done failed, and anything else
  // succeeded. A subagent's Error (one with a `parent`, M91.3b) failed only
  // its own Agent call, which the main thread reads and goes on from.
  let stopped = false;
  let errored = false;
  let settled = false;
  // M91.5: the model the run reports answering, once it reached one.
  let answering: string | null = null;
  const settle = () => {
    if (settled) return;
    settled = true;
    const changeset = settleMockRun(stamp.runId, actor, options.attended ? options.message : null);
    endMockRun(stamp.runId);
    const event: AgentStreamEvent = { kind: 'Changeset', changeset };
    emitLocal({ ...event, run, seq: mockJournal.append(run, event) });
  };
  // The mock drives the UI-action channel through the same fan-out the
  // Tauri listener uses, so browser mode exercises the real subscriber.
  // Tagging happens here for the same reason it happens in agent.rs: the
  // script only knows its own stream, the runtime knows which run it is.
  const mock = runMockAgent(
    options.message,
    (event) => {
      if (REPLAYED.has(event.kind)) replay.push(event);
      if (event.kind === 'ModelChanged') answering = event.model;
      if (event.kind === 'Cancelled') stopped = true;
      if (event.kind === 'Error' && event.parent === undefined) errored = true;
      if (event.kind === 'Done') {
        finishMockWake(stamp.runId, stopped ? 'cancelled' : errored ? 'failed' : 'succeeded');
        // A turn held on a call is suspended, not stopped (M57.1).
        const held = replay.some((e) => e.kind === 'ToolDeferred');
        if (!held && !replay.some((e) => e.kind === 'TurnEnded')) {
          replay.push({ kind: 'TurnInterrupted', reason: 'stopped' });
        }
        // M91.5: filed before Done, as Rust's reader files it, so a panel
        // that pulls at the turn's end reads this run's.
        if (options.attended && answering !== null) {
          fillMockContext(sessionId, answering, replay, options.systemPrompt);
        }
        recordMockCliTranscript(sessionId, replay.splice(0));
        if (booked !== null)
          finishMockRun(booked, stopped ? 'cancelled' : errored ? 'failed' : 'succeeded');
      }
      // M58.3: the run's Changeset, once, before Cancelled or Done.
      if (event.kind === 'Cancelled' || event.kind === 'Done') settle();
      // M57.6: numbered and held as Rust's reader numbers and journals them.
      const seq = mockJournal.append(run, event);
      emitLocal({ ...event, run, seq });
      // Reap at the terminal event, mirroring the reader thread's finish().
      if (event.kind === 'Done') {
        endMockNotionRun(stamp.runId!);
        mockRuns.delete(run);
        mockRunOwners.delete(run);
        mockJournal.finish(run);
      }
    },
    // The system prompt rides along (M52.3) so a scripted answer about
    // Knowledge can read the snapshot the real agent would. The write
    // scripts land on the mock disk through the same refusals as Rust's:
    // the append as tool_append's (M53.6), the edit as tool_edit_note's
    // (M55.5), sheet and canvas edits as their checked batch doors', the set as
    // set_fields_write's (M60.4), and the comment
    // scripts in the page's sidecar as comment_tools.rs's (M70.3).
    {
      onUiAction: emitUiAction,
      onAppend: (path, content) => agentAppend(vault, path, content, undefined, stamp),
      onEdit: (path, edits) => agentEdit(vault, path, edits, undefined, stamp),
      onEditCanvas: (path, args) => {
        if (
          options.allowedTools != null &&
          !options.allowedTools.some((tool) => namesTool(tool, 'edit_canvas'))
        )
          return Promise.reject(new Error('edit_canvas is not available here'));
        return agentEditCanvas(vault, path, args, stamp, {
          readScope: options.readScope,
          writeScope: options.scope,
        });
      },
      onCreateCanvas: (args) => {
        if (
          options.allowedTools != null &&
          !options.allowedTools.some((tool) => namesTool(tool, 'create_canvas'))
        )
          return Promise.reject(new Error('create_canvas is not available here'));
        return agentCreateCanvas(vault, args, stamp, {
          readScope: options.readScope,
          writeScope: options.scope,
        });
      },
      onEditSheet: (path, args) =>
        agentEditSheet(vault, path, args, stamp, { alive: () => !stopped && !settled }),
      onImportNotion: (args) => {
        if (
          options.allowedTools != null &&
          !options.allowedTools.some((tool) => namesTool(tool, 'import_notion_page'))
        )
          return Promise.reject(new Error('import_notion_page is not available here'));
        return agentImportNotion(vault, args, stamp, {
          write: options.scope,
          read: options.readScope,
        });
      },
      onSetFields: (path, args) => agentSetFields(vault, path, args, stamp),
      onSuggestView: (args) => agentSuggestView(vault, args),
      onScheduleFollowup: (args) => {
        if (
          options.allowedTools != null &&
          !options.allowedTools.some((tool) => namesTool(tool, 'schedule_followup'))
        )
          return Promise.reject(new Error('schedule_followup is not available here'));
        return agentScheduleFollowup(vault, args, stamp);
      },
      // M57.4: the create script's create_note, through tool_create_note's
      // refusals, and its if_exists (M61.6b).
      onCreate: (args) => agentCreate(vault, args, stamp, args.if_exists ?? null),
      onComment: (args) => agentComment(vault, args, stamp),
      onReply: (args) => agentReply(vault, args, stamp),
      onResolve: (args) => agentResolve(vault, args, stamp),
      // M57.4c: an unattended ask-first page write waits in the mock's
      // Review queue, as Rust's dispatch queues it.
      onQueue: (tool, input) =>
        queueAgentWrite(vault, {
          actor: options.actor ?? '',
          runId: booked ?? sessionId,
          tool,
          input,
        }),
      systemPrompt: options.systemPrompt,
      sessionId,
      model: options.model ?? null,
      // M57.1: the mock gate. Only an attended run can ask; a run nobody
      // watches has no card to show, as Rust's has no seat.
      asks: options.attended ? mockAsks : undefined,
      // M57.2: the CLI's own tools decide through the run's plan.
      approval: mockApproval(options),
      onDefer: (call) => {
        const card = confirmMockInteraction(
          registerMockInteraction(
            vault,
            sessionId,
            call.toolId,
            call.toolName,
            call.input,
            (answer) => {
              startMockRun(vault, options, sessionId, [], { toolId: call.toolId, answer });
            },
          ),
        );
        // A table ask names its family and exact subject, as Rust's card
        // does; the book holds the same card, so a re-list shows them too.
        // A page write's card is a write card, titled by the manifest and
        // naming who asks and where (M57.4).
        if (card !== null && call.family !== undefined) {
          Object.assign(card, { family: call.family, subject: call.subject ?? null });
        }
        if (card !== null && call.write !== undefined) {
          Object.assign(card, {
            kind: 'write',
            title: call.write.title,
            target: call.write.target,
            actor: options.actor ?? null,
          });
        }
        return card;
      },
      resume,
    },
  );
  mockRuns.set(run, mock);
  return run;
}

/**
 * A browser-only test seam (M57.4c): start an unattended run of `actor` in
 * the mock, as a schedule would, so a spec can watch an ask-first agent's
 * page write wait in Review. Resolves once the run is done. Never registered
 * in Tauri, where only the job runner starts unattended runs.
 */
async function runUnattended(
  vault: string,
  run: { message: string; actor: string; scope?: string[] | null; askFirst?: boolean },
): Promise<RunStart> {
  const start = await runAgent(vault, {
    message: run.message,
    shell: 'off',
    connectors: false,
    attended: false,
    askFirst: run.askFirst ?? false,
    actor: run.actor,
    scope: run.scope ?? null,
  });
  if ('deferred' in start || 'settled' in start) return start;
  await new Promise<void>((resolve) => {
    const off = onAgentEvent((event) => {
      if (event.kind !== 'Done') return;
      off();
      resolve();
    }, start.run);
  });
  return start;
}

if (typeof window !== 'undefined' && !inTauri()) {
  (window as unknown as { __cerebroRunUnattended: typeof runUnattended }).__cerebroRunUnattended =
    runUnattended;
}

/** A thread turn under way (M70.4): the run's durable id (the mock's own in
 * the browser) and the placeholder bound to it. */
export interface ThreadTurnStarted {
  runId: string;
  placeholder: string;
}

let mockThreadSeq = 0;

/** The person's text with the leading `@handle` it asked by taken off, so
 * the mock runs what they asked ("@release-scout wait for me" runs
 * "wait for me"). */
function withoutMention(text: string, handle: string): string {
  const trimmed = text.trim();
  const mention = `@${handle}`;
  return trimmed.toLowerCase().startsWith(mention.toLowerCase())
    ? trimmed.slice(mention.length).trim()
    : trimmed;
}

/**
 * Run one turn of the agent a person's comment names (M70.4): Rust's
 * `start_thread_turn`, which checks the turn, posts a pending placeholder in
 * the thread, runs the agent on its own record and posts the answer in the
 * placeholder's place. The request names only the page, the thread, the
 * comment and the handle. A refusal rejects, in Rust's words.
 *
 * In the browser the mock does the same: `threadTurnRefusal` (Rust's checks,
 * from thread-turns.json), the placeholder, then the mock agent on the
 * person's text, whose end settles the placeholder (`settleWords`). A
 * deleted placeholder drops the answer.
 */
export async function startThreadTurn(
  vault: string,
  request: ThreadTurnRequest,
): Promise<ThreadTurnStarted> {
  if (inTauri()) {
    const started = await invokeTauri<{ run_id: string; placeholder: string }>(
      'start_thread_turn',
      {
        vault,
        request: {
          page: request.page,
          thread: request.thread,
          message: request.message,
          handle: request.handle,
        },
      },
    );
    return { runId: started.run_id, placeholder: started.placeholder };
  }
  const plan = await threadTurnRefusal(vault, request);
  refuseIfAgentPaused(vault, plan.actor);
  mockThreadSeq += 1;
  const runId = `mock-thread-${mockThreadSeq}`;
  const placeholder = postThreadPlaceholder(request, plan, runId);
  emitUiAction({ action: 'comments_changed', path: request.page });
  const binding = {
    page: request.page,
    thread: request.thread,
    placeholder,
    actor: plan.actor,
  };
  // As Rust builds it: the record's limits, no shell, web or connectors,
  // and nobody seated to answer a card.
  const options: RunOptions = {
    message: withoutMention(plan.text, request.handle),
    shell: 'off',
    connectors: false,
    connectorNames: [],
    approvedStdio: [],
    attended: false,
    askFirst: plan.askFirst,
    actor: plan.actor,
    scope: plan.scope,
    readScope: plan.readScope,
    allowedTools: plan.allowedTools,
    model: plan.model,
    effort: plan.effort,
  };
  const run = startMockRun(vault, options, crypto.randomUUID(), [
    { kind: 'UserPrompt', text: options.message },
  ]);
  let answer: string | null = null;
  let failure: string | null = null;
  let cancelled = false;
  const off = onAgentEvent((event) => {
    if (event.kind === 'Result' && event.text.trim() !== '') answer = event.text;
    else if (event.kind === 'Error') failure = event.notice?.title ?? event.message.slice(0, 300);
    else if (event.kind === 'Cancelled') cancelled = true;
    else if (event.kind === 'Done') {
      off();
      const end: ThreadTurnEnd = {
        outcome: cancelled ? 'cancelled' : failure !== null ? 'failed' : 'succeeded',
        answer,
        failure,
      };
      const { text, state } = settleWords(plan.title, end);
      try {
        if (settleThreadPlaceholder(binding, runId, text, state) === 'written') {
          emitUiAction({ action: 'comments_changed', path: request.page });
        }
      } catch {
        // The page or its sidecar went away mid-turn: Rust logs this and
        // writes nothing, and so does the mock.
      }
    }
  }, run);
  return { runId, placeholder };
}

/**
 * What answering a waiting call says (M57.1): the resumed run's handle, or a
 * typed refusal, `no_longer_waiting` when the request had already ended. A
 * refusal is an answer to read, not an error (CV-03's proposal-channel rule):
 * the card says it in its own words.
 */
export type AnswerResult = { resumed: RunHandle } | { refused: { code: string; message: string } };

/**
 * Answer a waiting call (M57.1): the one way an answer reaches the book. In
 * Tauri, `answer_interaction` takes it only while the card waits in this
 * vault, then resumes the run on the same session; the browser's book does
 * the same, and its resume is a mock run. An Allow's edited draft (M57.4b)
 * travels as its own `updatedInput` key, which Rust checks against the
 * tool's schema and the run's grant before it takes the answer; a refusal
 * is typed like any other.
 */
export async function answerInteraction(
  vault: string,
  id: string,
  answer: PersonAnswer,
): Promise<AnswerResult> {
  if (!inTauri()) {
    // M57.2: This conversation only for a card the table asked about, on a
    // subject that was not cut, as Rust's book refuses it otherwise.
    if (answer.kind === 'allow' && answer.remember === 'conversation') {
      const card = listMockInteractions(vault).find((pending) => pending.id === id);
      if (card !== undefined && card.family == null) {
        return { refused: { code: 'malformed_arguments', message: NOT_REMEMBERED } };
      }
      if (card?.subject != null && subjectIsCut(card.subject)) {
        return { refused: { code: 'malformed_arguments', message: NOT_REMEMBERED_CUT } };
      }
    }
    // M57.3: the book checks the answer fits its card, a question's
    // answers by the shared rules, as Rust's does.
    const taken = answerMockInteraction(vault, id, answer);
    if ('refused' in taken) return { refused: taken.refused };
    const before = mockRunSeq;
    try {
      taken.resume(answer);
    } catch (err) {
      abortMockAnswer(id);
      throw err;
    }
    finishMockAnswer(id);
    // The resume took the next run id as it started.
    const run = mockRunSeq > before ? mockRunSeq : before;
    return {
      resumed: announced({
        run,
        durableId: null,
        sessionId: taken.card.session_id,
        attach: mockAttach(run),
      }),
    };
  }
  const result = await invokeTauri<
    | { run: number; run_id: string; session_id: string }
    | { refused: { code: string; message: string } }
  >('answer_interaction', {
    vault,
    id,
    answer: answer.kind === 'allow' ? { kind: 'allow', remember: answer.remember } : answer,
    updatedInput: answer.kind === 'allow' ? (answer.updatedInput ?? null) : null,
  });
  return 'refused' in result
    ? { refused: result.refused }
    : {
        resumed: announced({
          run: result.run,
          durableId: result.run_id,
          sessionId: result.session_id,
          attach: result.run_id,
        }),
      };
}

/** What the book says to This conversation on a call no ceiling asks about
 * (Rust's `interaction::NOT_REMEMBERED`). */
export const NOT_REMEMBERED =
  'This conversation is offered only for a command or file change the shell ceiling asks about.';

/** What the book says to This conversation on a call whose subject was cut
 * (Rust's `interaction::NOT_REMEMBERED_CUT`). */
export const NOT_REMEMBERED_CUT =
  'This conversation is not offered for a command too long to show in full. Allow it once instead.';

/**
 * The person's own Claude Code settings, counted (M57.2): allow, ask and
 * deny rules and hook events, never a rule's text. In the browser there is
 * none to read, so it says so, unless a test seeds one through
 * `window.__cerebroSeedClaudeSettings`.
 */
export async function claudeUserSettings(vault: string | null): Promise<ClaudeUserSettings> {
  if (!inTauri()) {
    const seeded = (globalThis as { __cerebroSeedClaudeSettings?: ClaudeUserSettings })
      .__cerebroSeedClaudeSettings;
    return seeded ?? { state: 'browser' };
  }
  return invokeTauri<ClaudeUserSettings>('claude_user_settings', { vault });
}

/** Cancel a waiting call (M57.1): Stop or New conversation with its card
 * open. False when it was no longer waiting, which is not an error. */
export async function cancelInteraction(id: string): Promise<boolean> {
  if (!inTauri()) return cancelMockInteraction(id);
  return invokeTauri<boolean>('cancel_interaction', { id });
}

/** The calls waiting for the person in `vault`, oldest first (M57.1).
 * Rejects when the book cannot be read, which a reader shows as
 * unavailable, never as nothing waiting (CV-05). */
export async function listInteractions(vault: string): Promise<PendingInteraction[]> {
  if (!inTauri()) {
    return faulted('list_interactions', () => Promise.resolve(listMockInteractions(vault)));
  }
  return invokeTauri<PendingInteraction[]>('list_interactions', { vault });
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

// --- Re-attach (M57.6) -------------------------------------------------------

/**
 * What a run said after a cursor, as Rust's `journal::EventsSince` answers
 * it: every event after it (`held`), what is left after the cap dropped some
 * (`gap`, the journal starting at `first`), or nothing held for that run
 * under that key (`unknown`). `done` once the run said its last event.
 */
export type EventsSince =
  | { state: 'held'; events: AgentEvent[]; done: boolean }
  | { state: 'gap'; first: number; events: AgentEvent[]; done: boolean }
  | { state: 'unknown' };

/** This page load's nonce, in every mock attach key: a key saved by an
 * earlier load names a run number this load may reuse for another run. */
const MOCK_PAGE = Math.random().toString(36).slice(2, 10) || 'page';

function mockAttach(run: number): string {
  return `mock-${MOCK_PAGE}-${run}`;
}

/** What the mock journal holds a run, and how many finished runs it keeps:
 * smaller than Rust's caps, the same answers. */
export const MOCK_JOURNAL_EVENTS = 2_000;
export const MOCK_JOURNAL_FINISHED = 16;

/**
 * The browser's journal (M57.6), standing in for Rust's: every mock event is
 * numbered from 1 per run and held, the oldest dropped past the cap, and
 * finished runs kept, the oldest dropped past their count. Memory only.
 * Exported for the adapter's tests, which fill a run past its cap.
 */
export const mockJournal = (() => {
  const runs = new Map<number, { events: AgentEvent[]; first: number; done: boolean }>();
  const finished: number[] = [];
  return {
    /** Open `run`'s journal; the attach key it answers under. */
    open(run: number): string {
      runs.set(run, { events: [], first: 1, done: false });
      return mockAttach(run);
    },
    /** Number one event of `run` and hold it; the seq it took. */
    append(run: number, event: AgentStreamEvent): number {
      const journal = runs.get(run);
      if (journal === undefined) return 0;
      const seq = journal.first + journal.events.length;
      journal.events.push({ ...event, run, seq });
      while (journal.events.length > MOCK_JOURNAL_EVENTS) {
        journal.events.shift();
        journal.first += 1;
      }
      return seq;
    },
    finish(run: number): void {
      const journal = runs.get(run);
      if (journal === undefined) return;
      journal.done = true;
      finished.push(run);
      while (finished.length > MOCK_JOURNAL_FINISHED) {
        const dropped = finished.shift();
        if (dropped !== undefined) runs.delete(dropped);
      }
    },
    since(run: number, attach: string, after: number): EventsSince {
      const journal = runs.get(run);
      if (journal === undefined || attach !== mockAttach(run)) return { state: 'unknown' };
      const events = journal.events.filter((e) => e.seq > after);
      return after + 1 < journal.first
        ? { state: 'gap', first: journal.first, events, done: journal.done }
        : { state: 'held', events, done: journal.done };
    },
  };
})();

/** What attaching answers: the journal's state and whether the run had
 * already ended, with the way to let go; or `unknown`, with nothing held. */
export type Attached =
  { state: 'held' | 'gap'; done: boolean; detach: () => void } | { state: 'unknown' };

/**
 * Attach to a run (M57.6): every event after `after`, each once and in
 * order, then the live ones. It subscribes first and holds what arrives,
 * reads the journal from the cursor, delivers that, then what it held, and
 * drops anything at or under the cursor, so nothing emitted before the
 * subscription is lost (the spawn race included) and nothing shows twice.
 * `onState` hears the journal's answer before any of its events, so a
 * caller knows a gap before the first event after it. `unknown` lets go at
 * once. A handle with no attach key (an older test double) is followed
 * live, from now. In Tauri the journal is read by `agent_events_since`,
 * whose `runId` is the durable run id it checks the run number against.
 */
export async function attachRun(
  handle: Pick<RunHandle, 'run' | 'attach'>,
  after: number,
  deliver: (event: AgentEvent) => void,
  onState?: (state: 'held' | 'gap' | 'unknown', done: boolean) => void,
): Promise<Attached> {
  let cursor = after;
  let held: AgentEvent[] | null = [];
  const take = (event: AgentEvent) => {
    if (typeof event.seq === 'number') {
      if (event.seq <= cursor) return;
      cursor = event.seq;
    }
    deliver(event);
  };
  const detach = onAgentEvent((event) => {
    if (held !== null) held.push(event);
    else take(event);
  }, handle.run);
  if (handle.attach === undefined) {
    const buffered = held;
    held = null;
    onState?.('held', false);
    for (const event of buffered) take(event);
    return { state: 'held', done: false, detach };
  }
  let answer: EventsSince;
  try {
    if (inTauri()) {
      answer = await invokeTauri<EventsSince>('agent_events_since', {
        run: handle.run,
        runId: handle.attach,
        after,
      });
    } else {
      answer = mockJournal.since(handle.run, handle.attach, after);
    }
  } catch {
    answer = { state: 'unknown' };
  }
  if (answer.state === 'unknown') {
    detach();
    held = null;
    onState?.('unknown', false);
    return { state: 'unknown' };
  }
  const buffered = held;
  held = null;
  onState?.(answer.state, answer.done);
  for (const event of answer.events) take(event);
  for (const event of buffered) take(event);
  return { state: answer.state, done: answer.done, detach };
}

/**
 * Whether the run a thread left going still goes (M92.7), as Rust's journal
 * answers `agent_events_since` after the last seq a run could reach, so it
 * copies no event: `running` until the run said its last, `done` after it,
 * `unknown` when nothing is held for the run under its key (as after a
 * restart), and `unavailable` when the read failed. Never rejects, and never
 * reads a failure as unknown (CV-05).
 */
export async function runState(turn: Pick<LiveTurn, 'run' | 'attach'>): Promise<RunState> {
  const after = Number.MAX_SAFE_INTEGER;
  try {
    const answer = inTauri()
      ? await invokeTauri<EventsSince>('agent_events_since', {
          run: turn.run,
          runId: turn.attach,
          after,
        })
      : await faulted('agent_events_since', () =>
          Promise.resolve(mockJournal.since(turn.run, turn.attach, after)),
        );
    if (answer.state === 'unknown') return 'unknown';
    return answer.done ? 'done' : 'running';
  } catch {
    return 'unavailable';
  }
}

// --- Context use (M91.5) -----------------------------------------------------

/**
 * A session's latest context reading, as Rust's `meter::ContextUse` crosses
 * the wire: the tokens its latest turn's request sent, the model's window
 * and the model when Claude Code reported them (absent, never 0, when it
 * did not), and when it was read (RFC 3339).
 */
export interface ContextUseRecorded {
  state: 'recorded';
  used: number;
  window?: number;
  model?: string;
  at: string;
}

/** What `agent_context_usage` answers (M91.5): a reading, or `not_recorded`
 * when none was filed for the session since Cerebro started, never 0
 * (CV-05). */
export type ContextUseAnswer = ContextUseRecorded | { state: 'not_recorded' };

/**
 * How much of its model's context window the Claude Code session
 * `sessionId` has used (M91.5). Pulled, never pushed: no event carries a
 * token count, and nothing stores the answer (Q7). Rejects when the read
 * fails, which `useContextUse` shows as unavailable, never as not recorded
 * (CV-05). In the browser the mock's book answers, through the lab's fault
 * seam.
 */
export function agentContextUsage(sessionId: string): Promise<ContextUseAnswer> {
  return inTauri()
    ? invokeTauri<ContextUseAnswer>('agent_context_usage', { sessionId })
    : faulted('agent_context_usage', () => Promise.resolve(mockContextBook.read(sessionId)));
}

/** The most sessions the mock's book holds, as Rust's `CONTEXT_SESSIONS`;
 * past it, the one recorded longest ago goes. */
export const MOCK_CONTEXT_SESSIONS = 64;

/**
 * The browser's context book (M91.5), standing in for Rust's: each
 * attended mock run that reached its model files a reading for its session
 * before its Done (`fillMockContext`), the newest last. Memory only.
 * Exported for the adapter's and the hook's tests, which seed it.
 */
export const mockContextBook = (() => {
  const sessions = new Map<string, ContextUseRecorded>();
  return {
    record(sessionId: string, reading: ContextUseRecorded): void {
      sessions.delete(sessionId);
      sessions.set(sessionId, { ...reading });
      for (const oldest of sessions.keys()) {
        if (sessions.size <= MOCK_CONTEXT_SESSIONS) break;
        sessions.delete(oldest);
      }
    },
    read(sessionId: string): ContextUseAnswer {
      const reading = sessions.get(sessionId);
      return reading === undefined ? { state: 'not_recorded' } : { ...reading };
    },
  };
})();

/** What Claude Code's own system prompt and tool definitions take before a
 * word of the conversation: where a mock session's first reading starts. */
const MOCK_CONTEXT_FLOOR = 14_000;

/**
 * File a plausible reading for a mock run of `sessionId` (M91.5): the
 * session's last reading, or the floor and the run's system prompt for a
 * new one, grown by what the run said, at about four characters a token.
 * The window is the one Claude Code reports for its models, a million for
 * a `[1m]` pick.
 */
function fillMockContext(
  sessionId: string,
  model: string,
  said: readonly AgentStreamEvent[],
  systemPrompt: string | undefined,
): void {
  const last = mockContextBook.read(sessionId);
  const before =
    last.state === 'recorded'
      ? last.used
      : MOCK_CONTEXT_FLOOR + Math.ceil((systemPrompt?.length ?? 0) / 4);
  const chars = said.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
  mockContextBook.record(sessionId, {
    state: 'recorded',
    used: before + Math.ceil(chars / 4),
    window: model.endsWith('[1m]') ? 1_000_000 : 200_000,
    model,
    at: new Date().toISOString(),
  });
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

type StartListener = (turn: Pick<LiveTurn, 'run' | 'attach'>) => void;
const startListeners = new Set<StartListener>();

/** `handle`, once every start listener has heard the run it names. */
function announced(handle: RunHandle): RunHandle {
  const { run, attach } = handle;
  if (attach !== undefined) for (const listener of [...startListeners]) listener({ run, attach });
  return handle;
}

/**
 * Hear every run this window starts (M92.7), as `runAgent` or an answer's
 * resume hands its handle back: its process tag and its attach key. No event
 * carries the key, and a tag names a run only until the next launch numbers
 * its runs again, so the conversation list keys a run's card and its Done by
 * the pair it heard here.
 */
export function onRunStarted(listener: StartListener): () => void {
  startListeners.add(listener);
  return () => startListeners.delete(listener);
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
