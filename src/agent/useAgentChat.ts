import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerInteraction,
  attachRun,
  cancelInteraction,
  listInteractions,
  readCliTranscript,
  runAgent,
  startedOrThrow,
  stopAgent,
  type AnswerResult,
  type RunHandle,
} from './agentIpc';
import { newRunId } from './runs';
import { applyEvent, endLiveTurn, replaceLastTurn, replayTranscript } from './transcript';
import type {
  AgentEvent,
  ChatMessage,
  LiveTurn,
  PendingInteraction,
  PersonAnswer,
  PrLink,
} from './types';
import { flushOpenPages } from '@/editor/openPages';
import { listAgents, narrowTools, readAddress } from '@/engine/agents';
import type { Place } from '@/engine/place';
import { grantedTools, holdsShell, holdsWeb, type PromptGrant } from '@/engine/toolGrant';
import { readNote } from '@/lib/ipc';
import { effectiveCeiling, type ShellCeiling } from '@/lib/policy/toolApproval';
import { addressedAgentPrompt, panelAgentPrompt, standingInstructionsBlock } from '@/lib/prompts';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Everything about a turn that comes from OUTSIDE this hook (M17.6, M17.7).
 *
 * Read once, synchronously, at the top of each send, and it has to be a getter
 * rather than values for two reasons. The panel builds the prompt from the
 * conversation's context chips, and the conversation list is built on top of
 * this hook — so none of this exists yet when the hook is called. And a send
 * parks on the open pages' saves, a skill expansion and an addressed agent's
 * record before it spawns, so reading afterwards would describe the context
 * the user drifted INTO.
 *
 * The system prompt is not a value either but a composer (M54.7): what a turn
 * holds is known only once its skill and its recipient have narrowed it, and
 * the prompt must name nothing else, so the hook calls it with the turn's
 * grant. The context it composes from is still the context frozen here.
 */
export interface TurnContext {
  /** The turn's system prompt, for the tools the turn holds. */
  systemPrompt: (grant: PromptGrant) => string;
  /** Where this turn is happening, for the run list. */
  place: Place | null;
  /** Which conversation, so the run list can open it. */
  conversationId: string | null;
  /**
   * The model and effort the conversation picked (M56.5). Null or absent is
   * unset: an addressed agent's record decides, else Claude Code's default.
   * The pick beats the record (Q11) because it is the person's choice for
   * this thread, made where they are typing.
   */
  model?: string | null;
  effort?: string | null;
  /**
   * The handle of the Agent record Settings binds this vault's panel to
   * (M56.6), or null for the plain assistant. A turn that names an agent
   * with `@` still goes to that agent; otherwise this one answers, and an
   * `@name` no record answers to goes to it too. A handle no record answers
   * to sends as the plain assistant, which the panel's header says.
   */
  boundAgent?: string | null;
}

/**
 * Message ids are unique per HOOK INSTANCE, not per sequence (M15).
 *
 * A module counter reset to 0 on every page load, while `conversations.ts`
 * persists every message WITH its id: after a reload the first send minted
 * `m-1`/`m-2`, ids the restored transcript already used, so `patchActive`
 * wrote one reply into two bubbles and React saw duplicate keys. The prefix
 * is drawn once per hook instance, so no id this instance mints can collide
 * with one from a previous load — or with one it minted before a reset.
 */
let hookInstances = 0;
function newIdPrefix(): string {
  hookInstances += 1;
  return `m${Date.now().toString(36)}${hookInstances.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * How long a stopped turn waits for its run's Done (M57.5) before it ends
 * anyway, with one toast. Rust's stop is TERM, a 2 s grace, then KILL, so a
 * Done this late is lost, not slow.
 */
export const STOP_CONFIRM_MS = 10_000;

/**
 * A call the turn waits on (M57.1): Rust's card, the bubble it belongs to (the
 * resume goes on there), whether an answer is on its way, and, once an answer
 * came too late, Rust's words for that.
 */
export interface WaitingCard {
  card: PendingInteraction;
  messageId: string;
  answering: boolean;
  stale: string | null;
  /** Rust's refusal of a write card's edited draft (M57.4b): the card still
   * waits, with the person's edits, to be answered again. */
  refused?: string | null;
}

export interface AgentChat {
  messages: ChatMessage[];
  /** A turn is in flight, a turn waiting on the person's answer included
   * (M57.1). */
  streaming: boolean;
  /** The card this conversation shows (M57.1): waiting, answering, or stale. */
  interaction: WaitingCard | null;
  /** A card waits for the person (M57.1): the turn is held, not running. */
  waiting: boolean;
  /** Answer the waiting card (M57.1): the run resumes in the same bubble. */
  answer(answer: PersonAnswer): void;
  /** `message` is what the agent runs when it differs from what the transcript
   * shows — a skill invocation displays as `/name` but sends the body (M13.1).
   * As a FUNCTION it is awaited inside the turn, so the transcript appends and
   * the busy flag rises synchronously on send — an async expansion must not
   * open a window where a second send can interleave. If it rejects, the turn
   * falls back to sending `text` as typed.
   *
   * `text` is also where a RECIPIENT comes from (M33b.6): `@agent-slug` in it
   * routes the turn to that agent. Read off the typed text rather than passed
   * as an argument, so every path that sends — the composer, a suggestion, a
   * retry, a handoff from elsewhere in the app — addresses the same way
   * without four call sites remembering to. */
  send(
    text: string,
    message?: string | (() => Promise<string>),
    /** Narrow THIS turn's tools — a skill's `allowed-tools:` (M17.8). Per
     * invocation rather than per conversation, because it belongs to the
     * thing being invoked, not to the thread it was invoked in. Intersected
     * with the addressed agent's own narrowing, if the turn named one. */
    allowedTools?: string[] | null,
    /** The context this turn was queued in (M57.5, Up next), frozen then; it
     * replaces `getTurn()`. The Settings ceilings and the panel's binding
     * are still read now, so a ceiling lowered since binds the turn. */
    turn?: TurnContext,
  ): void;
  /** Stop this conversation's turn (M57.5). With a run, Rust stops it and the
   * turn stays, `stopping`, until its Cancelled and Done arrive, so the next
   * turn never shares a session with a child still in its grace. Before the
   * child exists, or with a card waiting (which has no child), it ends at
   * once. With the card's answer already in flight (M57.1) it is stopping
   * until the answer settles, then stops the run it resumed, or cancels the
   * card if it still waits. Either way the reply reads cancelled. */
  stop(): void;
  /** A stop is on its way and the run's Done has not come (M57.5). */
  stopping: boolean;
  /** Is a turn in flight, stopping or waiting on a card (M57.5)? Stable, and
   * read off refs, so it is true in the same tick a send starts. */
  busy(): boolean;
  /** Start a new conversation in this hook (M57.6): a running turn is
   * detached, never stopped, and a waiting card keeps waiting. */
  reset(): void;
  /** The turn still running in this conversation, if any (M57.6): what the
   * thread saves so reopening it, or reloading, re-attaches. Set when the
   * child exists, moved to the resume when a card's answer resumes it, and
   * null once the turn has ended. */
  live: LiveTurn | null;
  /** M9.5: the CLI session behind this transcript, so a conversation can be
   * resumed after a reload rather than starting over, and the session file a
   * lost thread is rebuilt from (M56.3). A session Rust minted for this turn
   * shows here only once the run's stream names it: Claude Code writes the
   * file after its init, so a turn stopped before that leaves no file, and
   * the thread keeps the session it had (none, for a new one). */
  sessionId: string | null;
  /** The model Claude Code last reported answering (M56.3), or null. */
  model: string | null;
  /** Pull requests the conversation's session opened (M56.3). */
  prLinks: PrLink[];
  /** When the last turn ended (ISO), or null while none has this session. */
  turnEndedAt: string | null;
  /** Restore a persisted conversation into the hook, with what its
   * transcript says about it when it was read back (M56.3); without facts,
   * the model and the links clear. The turn this conversation was running
   * is detached first, never stopped (M57.6). Given the restored thread's
   * `live` turn, it re-attaches to it, from its reply's `seq`. */
  restore(
    messages: ChatMessage[],
    sessionId: string | null,
    facts?: { model: string | null; prLinks: PrLink[] },
    live?: LiveTurn | null,
  ): void;
}

/** The one-line label a turn's run is listed under: its question, the user
 * message just before `assistantId` in `messages`. */
function questionBefore(messages: ChatMessage[], assistantId: string): string {
  const at = messages.findIndex((m) => m.id === assistantId);
  const question = messages
    .slice(0, at === -1 ? messages.length : at)
    .reverse()
    .find((m) => m.role === 'user');
  return question?.text ?? 'Assistant turn';
}

/** `message` with its cursor at `event`'s seq, when the event carries one (a
 * test double's may not, and then the cursor stays where it was). */
function stamped(message: ChatMessage, event: AgentEvent): ChatMessage {
  return typeof event.seq === 'number' ? { ...message, seq: event.seq } : message;
}

/**
 * Drives one conversation with the local agent (M6).
 *
 * The transcript is assembled from a stream of small events, so the assistant
 * message is created up front and mutated in place as deltas arrive — that is
 * what makes the reply appear as it is written rather than in one jump at the
 * end.
 *
 * M17.3 deleted most of this hook's coordination machinery. `deadRuns`, the
 * preempt handoff, `streamReleased` and the `learningPath` event gate all
 * existed for one reason: the backend held ONE child, so a second run anywhere
 * in the app silently killed this one, and the only defence was to recognise
 * other runs' events and refuse them by hand. The backend now keys children by
 * run id, so a turn subscribes to ITS run and is structurally incapable of
 * seeing another's — including the terminal `Done` that used to freeze a
 * brand-new bubble the moment a question was asked.
 *
 * M57.6: a turn outlives the hook. Closing the panel, switching threads and
 * New conversation detach from the run and leave it running; the thread
 * saves `live`, and opening it again re-attaches through the run's journal
 * (`attachRun`), from the cursor its reply carries, so each event lands once.
 * What a finished turn does to the vault (end its run record, rescan)
 * belongs to ChatTurnsHost, which is mounted for the app's life, so a turn
 * that ends while detached is settled exactly once. Its commit is Rust's,
 * made before the run's Done (M58.3).
 */
export function useAgentChat(
  /** This turn's context — see TurnContext for why it is a getter. */
  getTurn: () => TurnContext,
  {
    shell,
    web = false,
    connectors,
  }: {
    shell: ShellCeiling;
    /** Web access in Settings (M57.7); absent is off. */
    web?: boolean;
    connectors: boolean;
  },
): AgentChat {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  // M17.7: a turn REGISTERS itself rather than raising a shared flag. The
  // background runner still yields to an attended run as a courtesy — don't
  // start a distill while someone is waiting on an answer — but that is now
  // read off the registry rather than off a boolean anybody could set.
  const startRun = useUiStore((s) => s.startRun);
  const attachChild = useUiStore((s) => s.attachChild);
  const endRun = useUiStore((s) => s.endRun);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // The latest messages, for a stop that names the reply it waits on.
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  const [streaming, setStreaming] = useState(false);
  const idPrefix = useRef<string>('');
  if (idPrefix.current === '') idPrefix.current = newIdPrefix();
  const idSeq = useRef(0);
  const nextId = useCallback(() => {
    idSeq.current += 1;
    return `${idPrefix.current}-${idSeq.current}`;
  }, []);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  // A session Rust minted for the in-flight turn that the stream has not
  // named yet, with the one it replaced. Until Init or Result names it no
  // session file exists, so a turn that ends first puts the old one back.
  const provisional = useRef<{ previous: string | null } | null>(null);
  const [reportedModel, setReportedModel] = useState<string | null>(null);
  const [prLinks, setPrLinks] = useState<PrLink[]>([]);
  const [turnEndedAt, setTurnEndedAt] = useState<string | null>(null);
  // This turn's run and its subscription. Both are per-turn: the run id is
  // what stopAgent needs, and the unsubscribe is what guarantees a finished
  // or detached turn stops listening.
  const runRef = useRef<number | null>(null);
  // This turn's entry in the run registry, which exists from the moment Send
  // is pressed — before the child does — and whether a host can settle it:
  // once its child is attached with a key, ChatTurnsHost ends it at Done
  // (M57.6), and this hook ends it only when no child ever came.
  const taskRef = useRef<string | null>(null);
  const taskSettledByHost = useRef(false);
  // Where the turn was asked, for a run record registered again on a resume.
  const turnPlace = useRef<{ place: Place | null; conversationId: string | null }>({
    place: null,
    conversationId: null,
  });
  const unsubscribe = useRef<(() => void) | null>(null);
  // Bumped by every attach and every detach, so an attach answered after the
  // turn moved on lets go of what it holds, and its events change nothing.
  const attachToken = useRef(0);
  // M57.6: the journal dropped events of this turn's run while nobody was
  // attached, so only Cancelled, Error and Done change the reply, and Done
  // rebuilds it from the session file.
  const gapRef = useRef(false);
  const [live, setLiveState] = useState<LiveTurn | null>(null);
  const liveRef = useRef<LiveTurn | null>(null);
  const setLive = useCallback((next: LiveTurn | null) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);
  // One turn at a time PER CONVERSATION (PR #5 review). Not a global lock any
  // more — other conversations and the background runner have their own runs.
  const turnInFlight = useRef(false);
  // Cancellation for send()'s async leg (PR #5 review). Reset, restore and
  // unmounting detach the turn synchronously (M57.6), and a stop before the
  // child exists ends it (M57.5), but the send that started it may still be
  // parked on the open pages' saves, a skill expansion or an addressed
  // agent's record — and on resume it would spawn a child for a turn nobody
  // is attached to. Bumping the epoch makes that pending work quit at its
  // next checkpoint instead.
  const sendEpoch = useRef(0);
  // M57.5: the reply whose send is inside runAgent, so a Stop in that window
  // waits for the child it is about to have.
  const spawning = useRef<string | null>(null);
  // M57.1: the card this conversation shows, mirrored in a ref so the event
  // handler reads it in the same dispatch that set it, and the calls this
  // turn's run deferred that have not come back.
  const [interaction, setInteraction] = useState<WaitingCard | null>(null);
  const interactionRef = useRef<WaitingCard | null>(null);
  const showInteraction = useCallback((next: WaitingCard | null) => {
    interactionRef.current = next;
    setInteraction(next);
  }, []);
  const deferredIds = useRef<Set<string>>(new Set());
  // M57.5: the reply a stop is waiting on (its bubble's id), mirrored in a
  // ref for `busy()`, and the timer that gives up on a lost Done.
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef<string | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStopping = useCallback(() => {
    if (stopTimer.current !== null) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    stoppingRef.current = null;
    setStopping(false);
  }, []);

  const patchMessage = useCallback((id: string, update: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  /** Let go of this turn's run: drop its subscription and clear it, leaving
   * the run itself alone. Idempotent. */
  const releaseRun = useCallback(() => {
    attachToken.current += 1;
    unsubscribe.current?.();
    unsubscribe.current = null;
    runRef.current = null;
  }, []);

  /** Give the turn's task its child, and the key the host settles it by. */
  const attachTask = useCallback(
    (taskId: string, handle: Pick<RunHandle, 'run' | 'attach'>) => {
      attachChild(taskId, handle.run, handle.attach);
      taskSettledByHost.current = handle.attach !== undefined;
    },
    [attachChild],
  );

  /** The turn's task, in the registry again if the host already ended it
   * (a run that stopped on a card, M57.1), holding `handle`'s child. */
  const ensureTask = useCallback(
    (handle: Pick<RunHandle, 'run' | 'attach'>, assistantId: string) => {
      const held = taskRef.current;
      if (held !== null && useUiStore.getState().runs.some((r) => r.id === held)) {
        attachTask(held, handle);
        return;
      }
      const taskId = newRunId();
      taskRef.current = taskId;
      startRun({
        id: taskId,
        owner: 'chat',
        label: questionBefore(messagesRef.current, assistantId),
        place: turnPlace.current.place,
        path: null,
        conversationId: turnPlace.current.conversationId,
        run: handle.run,
        ...(handle.attach === undefined ? {} : { attach: handle.attach }),
        startedAt: Date.now(),
      });
      taskSettledByHost.current = handle.attach !== undefined;
    },
    [attachTask, startRun],
  );

  /** Let go of the turn's task. One a host settles stays in the registry
   * for it; one no host can settle (no child ever came) ends here. */
  const releaseTask = useCallback(() => {
    if (taskRef.current !== null && !taskSettledByHost.current) endRun(taskRef.current);
    taskRef.current = null;
    taskSettledByHost.current = false;
  }, [endRun]);

  const endTurn = useCallback(() => {
    releaseRun();
    clearStopping();
    // A minted session the run never named has no file to resume: the next
    // send mints its own rather than `--resume` a session Claude Code never
    // wrote, which answers "No conversation found".
    if (provisional.current !== null) {
      sessionRef.current = provisional.current.previous;
      provisional.current = null;
    }
    turnInFlight.current = false;
    gapRef.current = false;
    setLive(null);
    setStreaming(false);
    releaseTask();
  }, [clearStopping, releaseRun, releaseTask, setLive]);

  /** Detach the turn (M57.6): unsubscribe and leave its run, its registry
   * record and its card alone. Reset, restore and unmounting do this; a
   * send still parked before its spawn is cancelled by the epoch the caller
   * bumps, and its task, which no child will settle, ends here. */
  const detachTurn = useCallback(() => {
    releaseRun();
    clearStopping();
    turnInFlight.current = false;
    gapRef.current = false;
    setStreaming(false);
    releaseTask();
  }, [clearStopping, releaseRun, releaseTask]);

  /** The turn is over: it frees its run, notes when it ended, and is no
   * longer live. What it did to the vault is ChatTurnsHost's to settle. */
  const finishTurn = useCallback(() => {
    deferredIds.current.clear();
    endTurn();
    setTurnEndedAt(new Date().toISOString());
  }, [endTurn]);

  /**
   * Put a reply back as the session file says its turn went (M57.6): after a
   * gap, at Done, or when the journal no longer knows the run. A file that
   * cannot be read keeps the cached reply, marked interrupted, so a cut
   * reply never reads as final.
   */
  const rebuildFromFile = useCallback(
    (assistantId: string) => {
      const session = sessionRef.current;
      const epoch = sendEpoch.current;
      const interrupted = () =>
        patchMessage(assistantId, (m) => {
          const { gap: _gap, ...rest } = m;
          return { ...rest, streaming: false, interrupted: true };
        });
      if (session === null || vaultPath === null) {
        interrupted();
        return;
      }
      void readCliTranscript(vaultPath, session, null).then((read) => {
        if (sendEpoch.current !== epoch) return;
        if (read.state !== 'read') {
          interrupted();
          return;
        }
        const replayed = replayTranscript(read.events, session);
        setMessages((prev) => replaceLastTurn(prev, assistantId, replayed.messages));
      });
    },
    [patchMessage, vaultPath],
  );

  /** The turn ended at its run's Done: after a gap, its reply rebuilds from
   * the session file first. */
  const settleTurn = useCallback(
    (assistantId: string) => {
      if (gapRef.current) rebuildFromFile(assistantId);
      finishTurn();
    },
    [finishTurn, rebuildFromFile],
  );

  /**
   * One event of this turn's run. What the message shows is the reducer's
   * (`transcript.ts`, the same one a restored thread replays through); this
   * keeps only the side effects: the session, the model, the links, the
   * card a held call raises (M57.1), the reply's cursor (M57.6), and ending
   * the turn, which a run's Done does unless the turn is waiting on that
   * card. After a gap only Cancelled, Error, Changeset and Done change the
   * reply: the session file a gap rebuilds from never holds the first three
   * (M58.3 for the Changeset).
   */
  const handleEvent = useCallback(
    (assistantId: string, event: AgentEvent) => {
      const touch = () => {
        if (typeof event.seq === 'number') patchMessage(assistantId, (m) => stamped(m, event));
      };
      switch (event.kind) {
        case 'Init':
          provisional.current = null;
          sessionRef.current = event.session_id;
          setSessionId(event.session_id);
          touch();
          return;
        case 'Interaction':
          // M57.1: this run's own gate holds a call for the person.
          showInteraction({
            card: event.interaction,
            messageId: assistantId,
            answering: false,
            stale: null,
          });
          touch();
          return;
        case 'ToolDeferred':
          deferredIds.current.add(event.tool_id);
          break;
        case 'ToolDone':
          deferredIds.current.delete(event.tool_id);
          break;
        case 'ModelChanged':
          setReportedModel(event.model);
          break;
        case 'PrLink':
          setPrLinks((prev) =>
            prev.some((link) => link.url === event.url)
              ? prev
              : [...prev, { number: event.number, url: event.url, repository: event.repository }],
          );
          touch();
          return;
        case 'Result':
          if (event.session_id) {
            provisional.current = null;
            sessionRef.current = event.session_id;
            setSessionId(event.session_id);
          }
          break;
        case 'Cancelled':
          // M57.5: Rust says the run was stopped on purpose, whoever stopped
          // it (this panel, the run list, a vault switch); the reducer marks
          // the reply, and Done ends the turn as usual.
          break;
        case 'Done': {
          patchMessage(assistantId, (m) => stamped(endLiveTurn(m), event));
          // M57.1: a run that stopped on a call for the person has ended,
          // and its turn has not: it stays in flight, waiting, with no run,
          // until an answer resumes it or Stop cancels it. It stays live
          // (M57.6), so a thread switch or a close keeps the card waiting.
          const waitingOn = interactionRef.current;
          if (waitingOn !== null && waitingOn.stale === null) {
            releaseRun();
            return;
          }
          if (deferredIds.current.size === 0) {
            settleTurn(assistantId);
            return;
          }
          // A deferral with no card: the book may hold one this event raced,
          // or a hook outside Cerebro held the call, which no card answers.
          const held = [...deferredIds.current];
          const session = sessionRef.current;
          const epoch = sendEpoch.current;
          releaseRun();
          const settle = (card: PendingInteraction | undefined) => {
            if (sendEpoch.current !== epoch) return;
            if (card !== undefined) {
              showInteraction({ card, messageId: assistantId, answering: false, stale: null });
              return;
            }
            patchMessage(assistantId, (m) => ({
              ...m,
              tools: m.tools.map((t) => (held.includes(t.id) ? { ...t, paused: true } : t)),
            }));
            settleTurn(assistantId);
          };
          if (vaultPath === null) {
            settle(undefined);
            return;
          }
          void listInteractions(vaultPath)
            .then((cards) =>
              settle(cards.find((c) => c.session_id === session && held.includes(c.tool_id))),
            )
            .catch(() => settle(undefined));
          return;
        }
      }
      if (
        gapRef.current &&
        event.kind !== 'Cancelled' &&
        event.kind !== 'Error' &&
        event.kind !== 'Changeset'
      ) {
        touch();
        return;
      }
      patchMessage(assistantId, (m) => stamped(applyEvent(m, event, 'live'), event));
    },
    [patchMessage, releaseRun, settleTurn, showInteraction, vaultPath],
  );

  /**
   * Follow a run (M57.6): every event after `after`, each once and in order,
   * through `attachRun`, which reads the run's journal from the cursor, so
   * nothing it said before this subscription is lost. `onState` hears the
   * journal's answer before any event; `unknown` means it holds nothing for
   * the run, and `onUnknown` decides what the turn does without it.
   */
  const follow = useCallback(
    (
      handle: Pick<RunHandle, 'run' | 'attach'>,
      after: number,
      assistantId: string,
      hooks: {
        onState?: (done: boolean) => void;
        onUnknown?: () => void;
        /** The journal said the run had ended and nothing after the cursor
         * ended the turn: the cursor already covered the run's Done. */
        onEndedBefore?: () => void;
      } = {},
    ) => {
      attachToken.current += 1;
      const token = attachToken.current;
      unsubscribe.current = null;
      void attachRun(
        handle,
        after,
        (event) => {
          if (attachToken.current === token) handleEvent(assistantId, event);
        },
        (state, done) => {
          if (attachToken.current !== token || state === 'unknown') return;
          if (state === 'gap') {
            gapRef.current = true;
            patchMessage(assistantId, (m) => ({ ...m, gap: true }));
          }
          hooks.onState?.(done);
        },
      )
        .then((attached) => {
          if (attached.state === 'unknown') {
            if (attachToken.current === token) hooks.onUnknown?.();
            return;
          }
          if (attachToken.current !== token) {
            attached.detach();
            return;
          }
          unsubscribe.current = attached.detach;
          if (attached.done) hooks.onEndedBefore?.();
        })
        .catch(() => undefined);
    },
    [handleEvent, patchMessage],
  );

  const send = useCallback(
    (
      text: string,
      message?: string | (() => Promise<string>),
      allowedTools?: string[] | null,
      frozen?: TurnContext,
    ) => {
      const trimmed = text.trim();
      if (trimmed === '' || vaultPath === null) return;
      // Mid-turn text goes to Up next (M57.5), which sends only when this
      // conversation is idle; this guard only stops a same-tick double
      // dispatch, while the render state callers read is still stale.
      if (turnInFlight.current || stoppingRef.current !== null) return;
      turnInFlight.current = true;
      // A card an answer came too late for goes with the next turn (M57.1).
      showInteraction(null);
      deferredIds.current.clear();
      gapRef.current = false;
      // Frozen here, before anything can await: this turn's context is the
      // context the question was asked in. A queued turn's was frozen when it
      // was queued (M57.5); only the panel's binding (M56.6) is read now.
      const current = getTurn();
      const turn = frozen === undefined ? current : { ...frozen, boundAgent: current.boundAgent };
      // M33b.6 — who this turn is addressed to, read from the text the person
      // actually composed. Off the store synchronously rather than through a
      // subscription: the recipient belongs to THIS message, and a chat hook
      // that re-rendered on every vault scan to keep an agent list current
      // would pay for that on every keystroke of every conversation.
      //
      // D8: this changes who the turn goes to and nothing else. No new
      // conversation, no per-agent thread list, and the anchor `anchorNow`
      // stamps is untouched — addressing someone is not going somewhere.
      const entries = useVaultStore.getState().entries;
      const address = readAddress(trimmed, entries);
      const addressedTo = address?.agent ?? null;
      // M56.6 — no `@` that routed, so the agent Settings binds the panel to
      // answers, if any record still answers to its handle.
      const bound =
        addressedTo === null && turn.boundAgent != null
          ? (listAgents(entries).find((a) => a.handle === turn.boundAgent) ?? null)
          : null;
      const recipient = addressedTo ?? bound;
      const assistantId = nextId();
      // A labelled ask's prompt rides on its bubble (ChatMessage.prompt), so a
      // retry can send it again. A skill's expansion is a function read inside
      // the turn, and is not kept.
      const prompt = typeof message === 'string' ? message.trim() : '';
      setMessages((prev) => [
        ...prev,
        {
          id: nextId(),
          role: 'user',
          text: trimmed,
          tools: [],
          ...(prompt !== '' && prompt !== trimmed ? { prompt } : {}),
          // Carried on the message rather than raised as a toast. A mention
          // that routed and one that did not are both facts about this turn,
          // they belong next to the turn, and neither is an interruption —
          // see ChatMessage.addressed.
          ...(address === null
            ? {}
            : {
                addressed: {
                  handle: address.handle,
                  title: addressedTo?.title ?? null,
                  ...(bound === null ? {} : { answeredBy: bound.title }),
                },
              }),
        },
        { id: assistantId, role: 'assistant', text: '', tools: [], streaming: true },
      ]);
      setStreaming(true);
      // The task exists from now, not from when the child does: a send waits
      // on the open pages' saves, any skill expansion and an addressed
      // agent's record before it has a run id, and a task list that showed
      // nothing for that window would be reporting "idle" while the user
      // waits.
      const taskId = newRunId();
      taskRef.current = taskId;
      taskSettledByHost.current = false;
      turnPlace.current = { place: turn.place, conversationId: turn.conversationId };
      startRun({
        id: taskId,
        owner: 'chat',
        label: trimmed,
        place: turn.place,
        path: null,
        conversationId: turn.conversationId,
        run: null,
        startedAt: Date.now(),
      });

      const epoch = sendEpoch.current;
      void (async () => {
        // stop/reset/restore/unmount bumped the epoch while this send was
        // parked on an await: the turn is over or detached, so quit without
        // spawning a child. The bubble was appended synchronously, so un-spin
        // it here.
        const cancelled = () => {
          if (sendEpoch.current === epoch) return false;
          patchMessage(assistantId, (m) => ({ ...m, streaming: false }));
          return true;
        };
        try {
          // M53.6 — every open page's pending save lands before the child
          // starts, so the agent reads, and writes over, what is on screen;
          // a save that lands after its write would put the old text back.
          await flushOpenPages();
          if (cancelled()) return;
          const expanded =
            typeof message === 'function' ? await message().catch(() => trimmed) : message?.trim();
          const composed = expanded === undefined || expanded === '' ? trimmed : expanded;
          // M53.5 — the recipient's standing instructions close this turn's
          // system prompt, where useJobRunner (M34.1.4) and hand_to put them;
          // a bound agent's close it inside panelAgentPrompt (M56.6).
          // The turn is not told to fetch its own record: a read-scoped
          // agent's one reader is get_note, which holds that record to its
          // read limit like any other note. This read is the app's, made for
          // the person who addressed or bound the agent, so no agent's limit
          // applies.
          let body = '';
          if (recipient !== null) {
            try {
              body = await readNote(vaultPath, recipient.path);
            } catch (err) {
              if (cancelled()) return;
              // Nothing spawns: a turn that answered as the agent without its
              // instructions would be the app guessing at them.
              const reason = err instanceof Error ? err.message : String(err);
              throw new Error(
                `Could not read ${recipient.title}'s instructions at ${recipient.path}, so the turn was not sent: ${reason}`,
                { cause: err },
              );
            }
          }
          // Two narrowings can meet on one turn — a skill's `allowed-tools:`
          // and the recipient's — so they intersect. Never union. What
          // the turn then holds is what its prompts may name (M54.7): the
          // narrowing, the shell its ceiling plans for it (M57.2), which a
          // read limit withdraws (M53.5), and a person watching.
          const allowed = narrowTools(allowedTools ?? null, recipient?.allowedTools ?? null);
          // M57.2 — the ceiling this turn may hold: the Settings ceiling, and
          // for an addressed or bound agent only when its record declares
          // `tools: shell`. A record can only SUBTRACT: none grants itself
          // what Settings denies, and addressing one is never the way around
          // that, exactly as on a schedule (useJobRunner).
          const ceiling = effectiveCeiling(shell, recipient === null ? null : recipient.shell);
          // M57.7 — the web the same way: Web access in Settings, and for an
          // addressed or bound agent only when its record declares
          // `tools: web`.
          const webCeiling = web && (recipient !== null ? recipient.web : true);
          const grant: PromptGrant = {
            tools: grantedTools(allowed),
            shell: holdsShell({
              shell: ceiling,
              attended: true,
              readScoped: recipient?.readScope != null,
              narrowing: allowed,
            }),
            web: holdsWeb({
              shell: ceiling,
              web: webCeiling ? 'on' : 'off',
              attended: true,
              readScoped: recipient?.readScope != null,
              narrowing: allowed,
            }),
            attended: true,
          };
          // An addressed recipient's block LEADS the message, like
          // useJobRunner's CURRENT STATE block and for the same reason. A
          // bound agent's goes in the system prompt instead and the message
          // goes as typed: the person named nobody, so who answers is standing
          // context, not something they just said. An unresolved mention with
          // no binding adds nothing: `@nobody` was only ever text, and a
          // preamble about an agent that does not exist would be the app
          // answering for it.
          const outgoing =
            addressedTo === null
              ? composed
              : `${addressedAgentPrompt(grant, addressedTo.path, addressedTo.title, addressedTo.actor, addressedTo.memory, addressedTo.scope, addressedTo.readScope)}\n\n${composed}`;
          const closing =
            bound !== null
              ? `\n\n${panelAgentPrompt(grant, bound, body)}`
              : recipient === null
                ? ''
                : standingInstructionsBlock(recipient.path, body);
          if (cancelled()) return;
          // Attended, no lane: never gated, so a deferral here would be a
          // contract break — startedOrThrow turns it into a visible error.
          spawning.current = assistantId;
          const handle = startedOrThrow(
            await runAgent(vaultPath, {
              message: outgoing,
              systemPrompt: turn.systemPrompt(grant) + closing,
              sessionId: sessionRef.current,
              // M56.5 — the conversation's pick, else the addressed agent's
              // record, else Claude Code's default. Rust checks both.
              model: turn.model ?? recipient?.model ?? null,
              effort: turn.effort ?? recipient?.effort ?? null,
              // M33b.6 — the recipient's grant (addressed, or bound in
              // Settings since M56.6), and it can only ever SUBTRACT: the
              // ceiling worked out above.
              shell: ceiling,
              web: webCeiling,
              connectors,
              connectorNames: recipient?.connectors ?? null,
              // A person typed this turn and is watching it stream — the one
              // kind of run allowed to fall back to their global MCP config
              // when the vault has no connectors.json and the turn names no
              // connector, in the recipient's `connectors:` or in the tools
              // below (PR #5 security review, M54.9), and to reach connectors
              // a record does not name.
              attended: true,
              // M57.4: the addressed or bound agent's `ask-first:`; false for
              // the plain panel, which no record answers for. Its page
              // writes then wait for the person's Allow in a card. A card's
              // answer resumes the run Rust froze, so the actor, the scopes,
              // the tools and this never re-derive from the resume.
              askFirst: recipient?.askFirst ?? false,
              approvedStdio: useUiStore.getState().stdioApprovals[vaultPath] ?? [],
              // The narrowing the grant above was read from, so the prompt and
              // the CLI's tools are the same set.
              allowedTools: allowed,
              // M54.9: the connector tools the recipient's record denies. A
              // skill names none, so an unaddressed turn denies nothing here.
              disallowedTools: recipient?.disallowedTools ?? null,
              // M17.13: enforced in Rust against the bearer the child presents,
              // so an addressed agent cannot talk its way out of its folders.
              scope: recipient?.scope ?? null,
              // M34.4: and the read axis, the same way — an addressed agent
              // reads what its record says it reads, not what the panel can.
              readScope: recipient?.readScope ?? null,
              // M13.4: attribution rides the bearer token, so what this turn
              // writes is stamped as the agent — and, free, the `runs` row it
              // books carries the actor the fleet reads.
              actor: recipient?.actor ?? null,
            }),
          );
          const { run, sessionId: started, attach } = handle;
          spawning.current = null;
          const goLive = () => {
            runRef.current = run;
            attachTask(taskId, handle);
            if (attach !== undefined) setLive({ run, attach, assistantId });
            follow(handle, 0, assistantId);
          };
          // Stopped during the spawn itself (M57.5): the child exists now, so
          // the turn takes it, stops it, and stays stopping until its Done.
          if (stoppingRef.current === assistantId) {
            goLive();
            void stopAgent(run).catch(() => undefined);
            return;
          }
          // Reset, restored or unmounted during the spawn: the send was
          // still parked, so it is cancelled as it always was — the child is
          // killed by id, never abandoned, and the turn is not ended again
          // (a newer one may hold it now).
          if (cancelled()) {
            void stopAgent(run).catch(() => undefined);
            return;
          }
          // M56.3: the session is known before the first event, minted or
          // resumed in Rust. A resumed one is the thread's already. A minted
          // one is held back from the thread until the stream names it (the
          // Init case above stores it): before Claude Code's init there is no
          // session file, so a thread that stored it then and was stopped,
          // closed or switched away from would `--resume` nothing.
          if (started !== undefined && started !== null && started !== sessionRef.current) {
            provisional.current = { previous: sessionRef.current };
            sessionRef.current = started;
          }
          // The subscription is scoped to THIS run, so no event from any other
          // conversation, background job or killed child can reach this turn;
          // and it reads the run's journal from the start (M57.6), so an
          // event the run sent before this line still lands, once.
          goLive();
        } catch (err) {
          spawning.current = null;
          const failure = err instanceof Error ? err.message : String(err);
          patchMessage(assistantId, (m) => ({ ...m, error: failure, streaming: false }));
          // A send a stop, reset or restore already ended keeps its error on
          // the bubble and leaves the turn (perhaps a newer one) alone.
          if (sendEpoch.current !== epoch && stoppingRef.current !== assistantId) return;
          endTurn();
          toast(failure);
        }
      })();
    },
    [
      attachTask,
      connectors,
      endTurn,
      follow,
      getTurn,
      nextId,
      patchMessage,
      setLive,
      shell,
      showInteraction,
      startRun,
      toast,
      vaultPath,
      web,
    ],
  );

  /** Refuse the waiting card's call as stopped (M57.1): Stop does; a thread
   * switch, New conversation and closing the panel leave it waiting
   * (M57.6). */
  const cancelWaiting = useCallback(() => {
    const current = interactionRef.current;
    if (current === null) return;
    if (current.stale === null) {
      void cancelInteraction(current.card.id).catch(() => undefined);
      patchMessage(current.messageId, (m) =>
        applyEvent(m, { kind: 'ToolCancelled', tool_id: current.card.tool_id }, 'live'),
      );
    }
    showInteraction(null);
  }, [patchMessage, showInteraction]);

  // The card whose answer was already with Rust when Stop was pressed. Rust
  // holds it Answering, so cancelling it would refuse, and the call would
  // run anyway: Stop waits for the answer instead, and stops the run it
  // resumed the moment it comes back (answer()).
  const stopOnAnswer = useRef<string | null>(null);

  /** The turn is stopping (M57.5): it stays until its run's Cancelled and
   * Done, and gives up on a Done that never comes. */
  const awaitStopped = useCallback(
    (replyId: string) => {
      stoppingRef.current = replyId;
      setStopping(true);
      stopTimer.current = setTimeout(() => {
        if (stoppingRef.current !== replyId) return;
        // CV-03: a stop is a human action, so a lost Done is a toast and
        // the turn ends anyway, never a throw. No host will see that Done
        // either, so its record ends here. The epoch moves, so an answer
        // still in flight is stopped when it comes back, never followed by
        // a turn that already ended.
        sendEpoch.current += 1;
        setMessages((prev) =>
          prev.map((m) =>
            m.streaming === true
              ? { ...m, streaming: false, interrupted: true, cancelled: true }
              : m,
          ),
        );
        if (taskRef.current !== null) endRun(taskRef.current);
        endTurn();
        toast('The stopped turn never said it ended, so Cerebro stopped waiting for it.');
      }, STOP_CONFIRM_MS);
    },
    [endRun, endTurn, toast],
  );

  const stop = useCallback(() => {
    if (!turnInFlight.current || stoppingRef.current !== null) return;
    const waitingOn = interactionRef.current;
    // An answer in flight (M57.1): Rust already took it, so the turn waits
    // for the run it resumes and stops that, or, if the card still waits
    // after all, cancels it then.
    if (waitingOn !== null && waitingOn.answering) {
      stopOnAnswer.current = waitingOn.card.id;
      awaitStopped(waitingOn.messageId);
      return;
    }
    // A waiting card has no child (its run already sent Done): its call is
    // refused, and its reply reads cancelled.
    if (waitingOn !== null && waitingOn.stale === null) {
      patchMessage(waitingOn.messageId, (m) => ({ ...m, cancelled: true }));
    }
    cancelWaiting();
    // The epoch bump is what reaches a send still parked on a skill expansion
    // or a record read: it quits at its next checkpoint without a child.
    sendEpoch.current += 1;
    const run = runRef.current;
    const reply = spawning.current;
    if (run !== null || reply !== null) {
      // M57.5: the child is stopped, and the turn stays until its run's
      // Cancelled and Done, so nothing starts on this session while it is
      // still in its grace. A send inside runAgent takes its child first.
      const replyId =
        reply ??
        [...messagesRef.current].reverse().find((m) => m.streaming === true)?.id ??
        'stopping';
      awaitStopped(replyId);
      if (run !== null) void stopAgent(run).catch(() => undefined);
      return;
    }
    // No child yet, or a card: the turn ends now, cancelled. A card's run
    // already said Done, so its record ends here too.
    setMessages((prev) =>
      prev.map((m) =>
        m.streaming === true ? { ...m, streaming: false, interrupted: true, cancelled: true } : m,
      ),
    );
    if (taskRef.current !== null) endRun(taskRef.current);
    endTurn();
  }, [awaitStopped, cancelWaiting, endRun, endTurn, patchMessage]);

  /**
   * Answer the waiting card (M57.1). Rust resumes the run on the same
   * session, and its events land in the card's bubble, under the same task,
   * registered again if the host ended it when the first run stopped; the
   * turn's `live` moves to the resume (M57.6), with a fresh cursor, since a
   * new run counts its events from 1. A late answer is refused
   * `no_longer_waiting`: handled here, without a toast, because the card
   * says it in Rust's words and the turn it waited for is over (CV-03
   * written reason: a typed outcome, not a failure). A write card's edited
   * draft Rust refused (M57.4b) keeps the card waiting, with the refusal on
   * it. Any other failure is toasted and the card stays, to be answered
   * again.
   *
   * A resume is never abandoned. Stop pressed while the answer was in
   * flight stops it as soon as it comes back (and cancels a card that still
   * waits); a New conversation, a thread switch or a close in that window
   * leaves it running, registered for ChatTurnsHost to settle, as a detach
   * leaves any run (M57.6).
   */
  const answer = useCallback(
    (given: PersonAnswer) => {
      const current = interactionRef.current;
      if (current === null || current.answering || current.stale !== null || vaultPath === null) {
        return;
      }
      showInteraction({ ...current, answering: true, refused: null });
      const epoch = sendEpoch.current;
      // Read now: a resume the turn no longer follows is registered with
      // the question it answers, after a New conversation emptied the thread.
      const label = questionBefore(messagesRef.current, current.messageId);
      const asked = turnPlace.current;
      const stopRequested = () => {
        const stopped = stopOnAnswer.current === current.card.id;
        if (stopped) stopOnAnswer.current = null;
        return stopped;
      };
      /** The resume came back to a turn that moved on: a Stop stops it, by
       * id, and a detach leaves it to ChatTurnsHost, which settles a run by
       * its key; one with no key nothing could settle, so it is stopped. */
      const disown = (handle: RunHandle, stopped: boolean) => {
        if (stopped || handle.attach === undefined) {
          void stopAgent(handle.run).catch(() => undefined);
          return;
        }
        useUiStore.getState().startRun({
          id: newRunId(),
          owner: 'chat',
          label,
          place: asked.place,
          path: null,
          conversationId: asked.conversationId,
          run: handle.run,
          attach: handle.attach,
          startedAt: Date.now(),
        });
      };
      void (async () => {
        let result: AnswerResult;
        try {
          result = await answerInteraction(vaultPath, current.card.id, given);
        } catch (err) {
          const stopped = stopRequested();
          if (sendEpoch.current !== epoch) return;
          showInteraction({ ...current, answering: false });
          toast(err instanceof Error ? err.message : String(err));
          // The card still waits, and Stop was pressed: it is cancelled now.
          if (stopped) {
            clearStopping();
            stop();
          }
          return;
        }
        const stopped = stopRequested();
        if (sendEpoch.current !== epoch) {
          if ('resumed' in result) disown(result.resumed, stopped);
          return;
        }
        // M57.4b: Rust refused a write card's edited draft and the card
        // still waits, so it stays, saying why (CV-03 written reason: a
        // typed outcome the card shows, not a failure to toast).
        if (
          'refused' in result &&
          current.card.kind === 'write' &&
          result.refused.code !== 'no_longer_waiting'
        ) {
          showInteraction({ ...current, answering: false, refused: result.refused.message });
          if (stopped) {
            clearStopping();
            stop();
          }
          return;
        }
        if ('refused' in result) {
          showInteraction({ ...current, answering: false, stale: result.refused.message });
          finishTurn();
          return;
        }
        showInteraction(null);
        // The answered call is the resume's now: its ToolDone, or a Stop's
        // Cancelled, settles it, and it is no hook's pause.
        deferredIds.current.delete(current.card.tool_id);
        const handle = result.resumed;
        const resumed = handle.sessionId;
        if (resumed !== undefined && resumed !== null) {
          sessionRef.current = resumed;
          setSessionId(resumed);
        }
        patchMessage(current.messageId, (m) => {
          const { seq: _cursor, ...rest } = m;
          return { ...rest, streaming: true };
        });
        runRef.current = handle.run;
        ensureTask(handle, current.messageId);
        if (handle.attach !== undefined) {
          setLive({ run: handle.run, attach: handle.attach, assistantId: current.messageId });
        }
        follow(handle, 0, current.messageId);
        // Stopped while the answer was in flight (M57.5): the turn follows
        // the resume, stops it, and stays stopping until its Done.
        if (stopped) void stopAgent(handle.run).catch(() => undefined);
      })();
    },
    [
      clearStopping,
      ensureTask,
      finishTurn,
      follow,
      patchMessage,
      setLive,
      showInteraction,
      stop,
      toast,
      vaultPath,
    ],
  );
  /**
   * Unmounting mid-turn detaches it (M57.6): closing the assistant leaves
   * the run running, its registry record standing and its card waiting, and
   * the thread saves `live` (useConversations), so reopening re-attaches.
   * ChatTurnsHost settles the run's Done whether or not the panel is open.
   * A send still parked before its spawn is cancelled by the epoch, as it
   * always was: no child exists to detach from, and its task ends here.
   * Written against refs only, because this runs while React is unmounting
   * the tree that owns it.
   *
   * The detach waits a tick, and a mount in that tick takes it back:
   * StrictMode unmounts and remounts every effect once on mount, and the
   * thread's restore (useConversations) has already re-attached by then and
   * does not run again. Detaching for that pretend unmount would leave a
   * re-attached turn deaf, and a card it looks up never shown.
   */
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (unmountTimer.current !== null) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }
    return () => {
      unmountTimer.current = setTimeout(() => {
        unmountTimer.current = null;
        // Reaches a send still parked on the open pages' saves, a skill
        // expansion or an addressed agent's record: it quits without a child.
        sendEpoch.current += 1;
        if (stopTimer.current !== null) clearTimeout(stopTimer.current);
        stoppingRef.current = null;
        attachToken.current += 1;
        unsubscribe.current?.();
        unsubscribe.current = null;
        if (!turnInFlight.current) return;
        turnInFlight.current = false;
        if (taskRef.current !== null && !taskSettledByHost.current) {
          useUiStore.getState().endRun(taskRef.current);
        }
        taskRef.current = null;
      }, 0);
    };
  }, []);

  const busy = useCallback(() => {
    const card = interactionRef.current;
    return (
      turnInFlight.current || stoppingRef.current !== null || (card !== null && card.stale === null)
    );
  }, []);

  const reset = useCallback(() => {
    detachTurn();
    sendEpoch.current += 1;
    showInteraction(null);
    deferredIds.current.clear();
    provisional.current = null;
    sessionRef.current = null;
    setSessionId(null);
    setReportedModel(null);
    setPrLinks([]);
    setTurnEndedAt(null);
    setLive(null);
    setMessages([]);
  }, [detachTurn, setLive, showInteraction]);

  /**
   * Bring back the card a restored thread's call waits on (M57.1), from
   * Rust's book: the thread waits again, held in flight, its row marked
   * held. `preferred` is the reply it belongs to, when the caller knows it.
   * `otherwise` runs when the book holds no card for the session.
   */
  const waitOnCard = useCallback(
    (
      restored: ChatMessage[],
      session: string,
      preferred: string | null,
      otherwise: () => void = () => undefined,
    ) => {
      if (vaultPath === null) {
        otherwise();
        return;
      }
      const epoch = sendEpoch.current;
      void listInteractions(vaultPath)
        .then((cards) => {
          if (sendEpoch.current !== epoch) return;
          const card = cards.find((c) => c.session_id === session);
          const assistants = restored.filter((m) => m.role === 'assistant');
          const bubble =
            card === undefined
              ? undefined
              : (assistants.find((m) => m.id === preferred) ??
                assistants.find((m) => m.tools.some((t) => t.id === card.tool_id)) ??
                assistants[assistants.length - 1]);
          if (card === undefined || bubble === undefined) {
            otherwise();
            return;
          }
          patchMessage(bubble.id, (m) =>
            applyEvent(
              { ...m, streaming: false },
              { kind: 'ToolDeferred', tool_id: card.tool_id, tool_name: card.tool_name },
              'live',
            ),
          );
          showInteraction({ card, messageId: bubble.id, answering: false, stale: null });
          turnInFlight.current = true;
          setStreaming(true);
        })
        .catch(() => otherwise());
    },
    [patchMessage, showInteraction, vaultPath],
  );

  /** Re-attach to the turn a restored thread left running (M57.6), from its
   * reply's cursor. A live run with no record in the registry, as after a
   * reload, is registered again, so ChatTurnsHost settles it. A run the
   * journal no longer knows rebuilds its reply from the session file. */
  const reattach = useCallback(
    (turn: LiveTurn, cursor: number) => {
      runRef.current = turn.run;
      turnPlace.current = { place: null, conversationId: getTurn().conversationId };
      const handle = { run: turn.run, attach: turn.attach };
      follow(handle, cursor, turn.assistantId, {
        onState: (done) => {
          const held = useUiStore
            .getState()
            .runs.find((r) => r.owner === 'chat' && r.run === turn.run && r.attach === turn.attach);
          if (held !== undefined) {
            taskRef.current = held.id;
            taskSettledByHost.current = true;
          } else if (!done) {
            taskRef.current = null;
            ensureTask(handle, turn.assistantId);
          }
        },
        onUnknown: () => {
          rebuildFromFile(turn.assistantId);
          finishTurn();
        },
        // The run's Done came before the thread was left, and the turn was
        // still live: it stopped on a card (M57.1), which waits in the book
        // unless something closed it since.
        onEndedBefore: () => {
          releaseRun();
          const session = sessionRef.current;
          const ended = () => {
            patchMessage(turn.assistantId, endLiveTurn);
            finishTurn();
          };
          if (session === null) ended();
          else waitOnCard(messagesRef.current, session, turn.assistantId, ended);
        },
      });
    },
    [
      ensureTask,
      finishTurn,
      follow,
      getTurn,
      patchMessage,
      rebuildFromFile,
      releaseRun,
      waitOnCard,
    ],
  );

  const restore = useCallback(
    (
      restored: ChatMessage[],
      restoredSession: string | null,
      facts?: { model: string | null; prLinks: PrLink[] },
      liveTurn?: LiveTurn | null,
    ) => {
      detachTurn();
      sendEpoch.current += 1;
      showInteraction(null);
      deferredIds.current.clear();
      provisional.current = null;
      sessionRef.current = restoredSession;
      setSessionId(restoredSession);
      setReportedModel(facts?.model ?? null);
      setPrLinks(facts?.prLinks ?? []);
      setTurnEndedAt(null);
      const turn =
        liveTurn != null && restored.some((m) => m.id === liveTurn.assistantId) ? liveTurn : null;
      setLive(turn);
      if (turn !== null) {
        // The turn is in flight again, its reply streaming, until its run's
        // events say otherwise.
        const marked = restored.map((m) =>
          m.id === turn.assistantId ? { ...m, streaming: true } : m,
        );
        messagesRef.current = marked;
        setMessages(marked);
        turnInFlight.current = true;
        setStreaming(true);
        const reply = marked.find((m) => m.id === turn.assistantId);
        reattach(turn, reply?.seq ?? 0);
        return;
      }
      setMessages(restored);
      if (restoredSession !== null) waitOnCard(restored, restoredSession, null);
    },
    [detachTurn, reattach, setLive, showInteraction, waitOnCard],
  );

  return {
    messages,
    streaming,
    interaction,
    waiting: interaction !== null && interaction.stale === null,
    answer,
    send,
    stop,
    stopping,
    busy,
    reset,
    live,
    sessionId,
    model: reportedModel,
    prLinks,
    turnEndedAt,
    restore,
  };
}
