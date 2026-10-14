import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerInteraction,
  cancelInteraction,
  listInteractions,
  onAgentEvent,
  runAgent,
  startedOrThrow,
  stopAgent,
} from './agentIpc';
import { newRunId } from './runs';
import { applyEvent, endLiveTurn } from './transcript';
import type { AgentEvent, ChatMessage, PendingInteraction, PersonAnswer, PrLink } from './types';
import { flushOpenPages } from '@/editor/openPages';
import { listAgents, narrowTools, readAddress } from '@/engine/agents';
import type { Place } from '@/engine/place';
import { grantedTools, type PromptGrant } from '@/engine/toolGrant';
import { isWriteTool } from '@/engine/tools';
import { readNote } from '@/lib/ipc';
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
 * A call the turn waits on (M57.1): Rust's card, the bubble it belongs to (the
 * resume goes on there), whether an answer is on its way, and, once an answer
 * came too late, Rust's words for that.
 */
export interface WaitingCard {
  card: PendingInteraction;
  messageId: string;
  answering: boolean;
  stale: string | null;
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
  ): void;
  stop(): void;
  reset(): void;
  /** M9.5: the CLI session behind this transcript, so a conversation can be
   * resumed after a reload rather than starting over. Minted before the first
   * event (M56.3), and the session file a lost thread is rebuilt from. */
  sessionId: string | null;
  /** The model Claude Code last reported answering (M56.3), or null. */
  model: string | null;
  /** Pull requests the conversation's session opened (M56.3). */
  prLinks: PrLink[];
  /** When the last turn ended (ISO), or null while none has this session. */
  turnEndedAt: string | null;
  /** Restore a persisted conversation into the hook, with what its
   * transcript says about it when it was read back (M56.3); without facts,
   * the model and the links clear. */
  restore(
    messages: ChatMessage[],
    sessionId: string | null,
    facts?: { model: string | null; prLinks: PrLink[] },
  ): void;
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
 */
export function useAgentChat(
  /** This turn's context — see TurnContext for why it is a getter. */
  getTurn: () => TurnContext,
  { shell, connectors }: { shell: boolean; connectors: boolean },
  /** Fires after a turn that wrote files, with a one-line summary (M9.5). */
  onWroteFiles?: (summary: string) => void,
): AgentChat {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  // M17.7: a turn REGISTERS itself rather than raising a shared flag. The
  // background runner still yields to an attended run as a courtesy — don't
  // start a distill while someone is waiting on an answer — but that is now
  // read off the registry rather than off a boolean anybody could set.
  const startRun = useUiStore((s) => s.startRun);
  const attachChild = useUiStore((s) => s.attachChild);
  const endRun = useUiStore((s) => s.endRun);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const [reportedModel, setReportedModel] = useState<string | null>(null);
  const [prLinks, setPrLinks] = useState<PrLink[]>([]);
  const [turnEndedAt, setTurnEndedAt] = useState<string | null>(null);
  // The prompt that started the in-flight turn, so a write checkpoint can say
  // what the agent was asked to do rather than just that it wrote.
  const lastPrompt = useRef<string>('');
  const onWrote = useRef(onWroteFiles);
  onWrote.current = onWroteFiles;
  // This turn's run and its subscription. Both are per-turn: the run id is
  // what stopAgent needs, and the unsubscribe is what guarantees a finished
  // turn stops listening.
  const runRef = useRef<number | null>(null);
  // This turn's entry in the run registry, which exists from the moment Send
  // is pressed — before the child does.
  const taskRef = useRef<string | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  // One turn at a time PER CONVERSATION (PR #5 review). Not a global lock any
  // more — other conversations and the background runner have their own runs.
  const turnInFlight = useRef(false);
  // Cancellation for send()'s async leg (PR #5 review). stop/reset/restore
  // end the TURN synchronously, but the send that started it may still be
  // parked on the open pages' saves, a skill expansion or an addressed
  // agent's record — and on resume it would spawn a child for a turn the user
  // already cancelled. Bumping the epoch makes that pending work quit at its
  // next checkpoint instead.
  const sendEpoch = useRef(0);
  // The agent writes straight to disk; a turn that touched files must end
  // with a rescan or the UI keeps showing the pre-agent vault.
  const touchedFiles = useRef(false);
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

  const patchMessage = useCallback((id: string, update: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  /** Drop this turn's subscription and clear its run. Idempotent. */
  const releaseRun = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    runRef.current = null;
  }, []);

  const endTurn = useCallback(() => {
    releaseRun();
    turnInFlight.current = false;
    setStreaming(false);
    if (taskRef.current !== null) {
      endRun(taskRef.current);
      taskRef.current = null;
    }
  }, [endRun, releaseRun]);

  /** Kill THIS conversation's run, if it has one. Fire-and-forget: callers
   * end the turn synchronously, and a run that already finished answers
   * false rather than erroring. */
  const killRun = useCallback(() => {
    const run = runRef.current;
    if (run === null) return;
    void stopAgent(run).catch(() => undefined);
  }, []);

  /**
   * One event of this turn's run. What the message shows is the reducer's
   * (`transcript.ts`, the same one a restored thread replays through); this
   * keeps only the side effects: the session, touched files, the model, the
   * links, and ending the turn.
   */
  /** The turn is over: it frees its run and its task, notes when it ended,
   * and a turn that wrote rescans and checkpoints. */
  const finishTurn = useCallback(() => {
    deferredIds.current.clear();
    endTurn();
    setTurnEndedAt(new Date().toISOString());
    if (touchedFiles.current) {
      touchedFiles.current = false;
      void rescan();
      // M9.5/M9.4: a turn that wrote files gets its own checkpoint, so
      // the assistant's work is revertible on its own rather than
      // tangled into the user's next one.
      onWrote.current?.(lastPrompt.current);
    }
  }, [endTurn, rescan]);

  const handleEvent = useCallback(
    (assistantId: string, event: AgentEvent) => {
      switch (event.kind) {
        case 'Init':
          sessionRef.current = event.session_id;
          setSessionId(event.session_id);
          return;
        case 'Interaction':
          // M57.1: this run's own gate holds a call for the person.
          showInteraction({
            card: event.interaction,
            messageId: assistantId,
            answering: false,
            stale: null,
          });
          return;
        case 'ToolDeferred':
          deferredIds.current.add(event.tool_id);
          break;
        case 'ToolDone':
          deferredIds.current.delete(event.tool_id);
          break;
        case 'ToolStart':
          if (isWriteTool(event.tool_name)) touchedFiles.current = true;
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
          return;
        case 'Result':
          if (event.session_id) {
            sessionRef.current = event.session_id;
            setSessionId(event.session_id);
          }
          break;
        case 'Done': {
          patchMessage(assistantId, endLiveTurn);
          // M57.1: a run that stopped on a call for the person has ended,
          // and its turn has not: it stays in flight, waiting, with no run,
          // until an answer resumes it or Stop cancels it.
          const waitingOn = interactionRef.current;
          if (waitingOn !== null && waitingOn.stale === null) {
            releaseRun();
            return;
          }
          if (deferredIds.current.size === 0) {
            finishTurn();
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
            finishTurn();
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
      patchMessage(assistantId, (m) => applyEvent(m, event, 'live'));
    },
    [finishTurn, patchMessage, releaseRun, showInteraction, vaultPath],
  );

  const send = useCallback(
    (text: string, message?: string | (() => Promise<string>), allowedTools?: string[] | null) => {
      const trimmed = text.trim();
      if (trimmed === '' || vaultPath === null) return;
      // Callers gate on `streaming`; this closes the same-tick window where
      // that render state is still stale. Dropped, not queued — the caller
      // that hit it kept its draft, so nothing is lost.
      if (turnInFlight.current) return;
      turnInFlight.current = true;
      // A card an answer came too late for goes with the next turn (M57.1).
      showInteraction(null);
      deferredIds.current.clear();
      // Frozen here, before anything can await: this turn's context is the
      // context the question was asked in.
      const turn = getTurn();
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
      lastPrompt.current = trimmed;
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
        // stop/reset/restore bumped the epoch while this send was parked on
        // an await: the turn is over, so quit without spawning a child. The
        // bubble was appended synchronously, so un-spin it here.
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
          // narrowing, the shell this turn is granted, which a read limit
          // withdraws in Rust (M53.5), and a person watching.
          const allowed = narrowTools(allowedTools ?? null, recipient?.allowedTools ?? null);
          const grant: PromptGrant = {
            tools: grantedTools(allowed),
            shell: shell && (recipient?.shell ?? true) && recipient?.readScope == null,
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
          const { run, sessionId: started } = startedOrThrow(
            await runAgent(vaultPath, {
              message: outgoing,
              systemPrompt: turn.systemPrompt(grant) + closing,
              sessionId: sessionRef.current,
              // M56.5 — the conversation's pick, else the addressed agent's
              // record, else Claude Code's default. Rust checks both.
              model: turn.model ?? recipient?.model ?? null,
              effort: turn.effort ?? recipient?.effort ?? null,
              // M33b.6 — the recipient's grant (addressed, or bound in
              // Settings since M56.6), and it can only ever
              // SUBTRACT. `shell` here is the Settings ceiling; a record that
              // declares `tools: shell` in a vault whose owner never switched
              // shell on still gets false, exactly as it does on a schedule
              // (useJobRunner). No record grants itself what Settings denies,
              // and addressing one must never become the way around that.
              shell: shell && (recipient?.shell ?? true),
              connectors,
              connectorNames: recipient?.connectors ?? null,
              // A person typed this turn and is watching it stream — the one
              // kind of run allowed to fall back to their global MCP config
              // when the vault has no connectors.json and the turn names no
              // connector, in the recipient's `connectors:` or in the tools
              // below (PR #5 security review, M54.9), and to reach connectors
              // a record does not name.
              attended: true,
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
          // Cancelled during the spawn itself: the child exists now, so it has
          // to be killed by id rather than abandoned.
          if (cancelled()) {
            void stopAgent(run).catch(() => undefined);
            endTurn();
            return;
          }
          // The subscription is scoped to THIS run, so no event from any other
          // conversation, background job or killed child can reach this turn.
          // The mock and the Rust reader both emit asynchronously, so the id
          // is always in hand before the first event.
          // M56.3: the session is known before the first event — minted or
          // resumed in Rust — so the thread stores it now, and a reload
          // mid-turn still knows which file to rebuild from.
          if (started !== undefined && started !== null) {
            sessionRef.current = started;
            setSessionId(started);
          }
          runRef.current = run;
          attachChild(taskId, run);
          unsubscribe.current = onAgentEvent((event) => handleEvent(assistantId, event), run);
        } catch (err) {
          const failure = err instanceof Error ? err.message : String(err);
          patchMessage(assistantId, (m) => ({ ...m, error: failure, streaming: false }));
          endTurn();
          toast(failure);
        }
      })();
    },
    [
      attachChild,
      connectors,
      endTurn,
      getTurn,
      handleEvent,
      nextId,
      patchMessage,
      shell,
      showInteraction,
      startRun,
      toast,
      vaultPath,
    ],
  );

  /**
   * Answer the waiting card (M57.1). Rust resumes the run on the same
   * session, and its events land in the card's bubble, under the same task.
   * A late answer is refused `no_longer_waiting`: handled here, without a
   * toast, because the card says it in Rust's words and the turn it waited
   * for is over (CV-03 written reason: a typed outcome, not a failure). Any
   * other failure is toasted and the card stays, to be answered again.
   */
  const answer = useCallback(
    (given: PersonAnswer) => {
      const current = interactionRef.current;
      if (current === null || current.answering || current.stale !== null || vaultPath === null) {
        return;
      }
      showInteraction({ ...current, answering: true });
      const epoch = sendEpoch.current;
      void (async () => {
        try {
          const result = await answerInteraction(vaultPath, current.card.id, given);
          if (sendEpoch.current !== epoch) return;
          if ('refused' in result) {
            showInteraction({ ...current, answering: false, stale: result.refused.message });
            finishTurn();
            return;
          }
          showInteraction(null);
          const { run, sessionId: resumed } = result.resumed;
          if (resumed !== undefined && resumed !== null) {
            sessionRef.current = resumed;
            setSessionId(resumed);
          }
          patchMessage(current.messageId, (m) => ({ ...m, streaming: true }));
          runRef.current = run;
          if (taskRef.current !== null) attachChild(taskRef.current, run);
          unsubscribe.current = onAgentEvent(
            (event) => handleEvent(current.messageId, event),
            run,
          );
        } catch (err) {
          if (sendEpoch.current !== epoch) return;
          showInteraction({ ...current, answering: false });
          toast(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [attachChild, finishTurn, handleEvent, patchMessage, showInteraction, toast, vaultPath],
  );

  /** Refuse the waiting card's call as stopped (M57.1): Stop and New
   * conversation do; a thread switch and closing the panel leave it waiting. */
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

  /**
   * Unmounting mid-turn ends the turn (M15). A turn waiting on a card has no
   * run to stop, and its card stays in Rust's book (M57.1): reopening the
   * panel lists it again.
   *
   * The panel is rendered conditionally, so closing the assistant while an
   * answer streams tears this hook down. Nothing here used to run on the way
   * out: the child kept going, and `agentBusy` stayed true for the rest of the
   * session — which made the background distiller's own guard bail forever.
   *
   * M17.2 removed the case that made this fire by accident: `open_note` no
   * longer closes the panel, so an unmount now means the user actually closed
   * the assistant. Written against the store directly rather than the bound
   * action, because this runs while React is unmounting the tree that owns it.
   */
  useEffect(() => {
    return () => {
      // Reaches a send still parked on the open pages' saves, a skill
      // expansion or an addressed agent's record, which killRun cannot: it
      // has no child to kill yet.
      sendEpoch.current += 1;
      if (!turnInFlight.current) return;
      killRun();
      releaseRun();
      turnInFlight.current = false;
      if (taskRef.current !== null) {
        useUiStore.getState().endRun(taskRef.current);
        taskRef.current = null;
      }
    };
  }, [killRun, releaseRun]);

  const stop = useCallback(() => {
    cancelWaiting();
    killRun();
    // The epoch bump is what reaches a send still parked on a skill expansion
    // — killRun can only kill a child that already exists.
    sendEpoch.current += 1;
    // Un-spin whatever is still streaming, and say it was stopped. Not just
    // the run's bubble: a send parked before its child exists has a spinning
    // message and no run at all.
    setMessages((prev) =>
      prev.map((m) => (m.streaming === true ? { ...m, streaming: false, interrupted: true } : m)),
    );
    endTurn();
  }, [cancelWaiting, endTurn, killRun]);

  const reset = useCallback(() => {
    cancelWaiting();
    killRun();
    sendEpoch.current += 1;
    sessionRef.current = null;
    setSessionId(null);
    setReportedModel(null);
    setPrLinks([]);
    setTurnEndedAt(null);
    endTurn();
    setMessages([]);
  }, [cancelWaiting, endTurn, killRun]);

  /** Load a stored conversation. Ends this conversation's turn first: the
   * events still in flight belong to the transcript being replaced. A card
   * the thread left is not cancelled (M57.1): it stays in Rust's book, and
   * the restored thread's own card, if it has one, is listed back. */
  const restore = useCallback(
    (
      restored: ChatMessage[],
      restoredSession: string | null,
      facts?: { model: string | null; prLinks: PrLink[] },
    ) => {
      killRun();
      sendEpoch.current += 1;
      showInteraction(null);
      deferredIds.current.clear();
      endTurn();
      sessionRef.current = restoredSession;
      setSessionId(restoredSession);
      setReportedModel(facts?.model ?? null);
      setPrLinks(facts?.prLinks ?? []);
      setTurnEndedAt(null);
      setMessages(restored);
      if (restoredSession === null || vaultPath === null) return;
      const epoch = sendEpoch.current;
      void listInteractions(vaultPath)
        .then((cards) => {
          if (sendEpoch.current !== epoch) return;
          const card = cards.find((c) => c.session_id === restoredSession);
          if (card === undefined) return;
          const assistants = restored.filter((m) => m.role === 'assistant');
          const bubble =
            assistants.find((m) => m.tools.some((t) => t.id === card.tool_id)) ??
            assistants[assistants.length - 1];
          if (bubble === undefined) return;
          // The thread waits again: held in flight, its row marked held.
          patchMessage(bubble.id, (m) =>
            applyEvent(
              m,
              { kind: 'ToolDeferred', tool_id: card.tool_id, tool_name: card.tool_name },
              'live',
            ),
          );
          showInteraction({ card, messageId: bubble.id, answering: false, stale: null });
          turnInFlight.current = true;
          setStreaming(true);
        })
        .catch(() => undefined);
    },
    [endTurn, killRun, patchMessage, showInteraction, vaultPath],
  );

  return {
    messages,
    streaming,
    interaction,
    waiting: interaction !== null && interaction.stale === null,
    answer,
    send,
    stop,
    reset,
    sessionId,
    model: reportedModel,
    prLinks,
    turnEndedAt,
    restore,
  };
}
