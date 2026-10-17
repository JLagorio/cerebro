import { useCallback, useEffect, useRef } from 'react';
import type { SkillNarrowing } from '@/engine/skills';
import type { AgentChat, TurnContext } from './useAgentChat';
import { UP_NEXT_CAP, type ResolvedText, type UpNextEntry } from './upNextQueue';
import { useReviewNotesStore } from '@/stores/reviewNotesStore';
import { EMPTY_QUEUE, useUpNextStore } from '@/stores/upNextStore';
import { useUiStore } from '@/stores/uiStore';

/** The words a page ask that Up next could not hold gets (M57.5). */
export const HANDOFF_FULL = 'Up next is full — remove a message to add this one.';

/** What a send is: typed text, or a page's ask handed over (a handoff). */
export interface UpNextInput {
  /** What the bubble says. */
  text: string;
  /** What the agent is sent, when it is not `text`: a labelled ask. */
  prompt?: string;
  /** A page ask, not the composer: never read as a skill, and a full queue
   * answers it with one toast, since no draft keeps it. */
  handoff?: true;
  /** Review notes the text was built from (M58.5): sent as written, never
   * read as a skill, and never editable in Up next. */
  notes?: { ids: readonly string[] };
}

/** What a skill resolves to before it is sent or queued: its expansion is a
 * read, started at once for a queued entry and inside the turn for a send. */
export interface SkillResolution {
  /** The text as sent: the composer's literal opt-out (a leading space)
   * resolves to the trimmed words. */
  text: string;
  skill: { path: string } | null;
  expand: (() => Promise<string>) | null;
  narrowing: SkillNarrowing;
}

export type SendNow = (
  text: string,
  message?: string | (() => Promise<string>),
  narrowing?: SkillNarrowing,
  turn?: TurnContext,
) => void;

let entrySeq = 0;

/**
 * Up next's dispatcher (M57.5): what one conversation's composer, its page
 * asks and its Up next rows do, against the chat hook.
 *
 * Sending while the conversation is busy (a turn in flight, stopping, or
 * waiting on a card) queues, freezing the context it was sent in; so does
 * sending while entries wait their turn. Otherwise it sends now. When a turn
 * ends: the steered entry starts, if Steer moved one first; a turn a person
 * stopped, or one that failed or was cut off, holds Up next until Resume
 * (M57 Q23); any other end starts the head. Nothing starts while an entry's
 * editor is open on the head, or while a card waits.
 *
 * Steer moves an entry first and stops the running turn, and the entry starts
 * only once the stopped run's Done has come (`useAgentChat.stop`), so one
 * session never has two Claude Code processes. With a card open there is no
 * child: the card is refused and the entry starts at once.
 */
export function useUpNext({
  chat,
  conversationId,
  vault,
  getTurn,
  resolve,
  sendNow,
}: {
  chat: AgentChat;
  conversationId: string | null;
  vault: string | null;
  getTurn: () => TurnContext;
  resolve: (text: string) => SkillResolution;
  sendNow: SendNow;
}) {
  const queue = useUpNextStore((s) =>
    conversationId === null ? EMPTY_QUEUE : (s.queues[conversationId] ?? EMPTY_QUEUE),
  );
  const toast = useUiStore((s) => s.toast);
  const store = useUpNextStore.getState;
  const busyNow = chat.streaming || chat.stopping || chat.waiting;
  const { busy, stop } = chat;

  // The one place an entry becomes a turn: the head's claim, Run now, and
  // Steer's start after the stopped run's Done all come here, so a notes
  // entry's notes are stamped sent here and nowhere else (M58.5, Q13).
  const dispatch = useCallback(
    (entry: UpNextEntry) => {
      sendNow(
        entry.text,
        entry.prompt ?? (() => entry.expansion ?? Promise.resolve(entry.text)),
        entry.narrowing,
        entry.turn,
      );
      if (entry.notes !== undefined) {
        useReviewNotesStore.getState().markSent(entry.notes.ids, Date.now());
      }
    },
    [sendNow],
  );

  /** The entry for `input`, its context frozen now and a skill's expansion
   * started now; a read that fails sends the text as typed. */
  const entryFor = useCallback(
    (input: UpNextInput, at: string): UpNextEntry => {
      const resolved: SkillResolution =
        input.handoff === true || input.prompt !== undefined || input.notes !== undefined
          ? { text: input.text.trim(), skill: null, expand: null, narrowing: {} }
          : resolve(input.text);
      entrySeq += 1;
      return {
        id: `up-${entrySeq}`,
        text: resolved.text,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.notes === undefined ? {} : { notes: { ids: [...input.notes.ids] } }),
        skill: resolved.skill,
        ...(resolved.expand === null
          ? {}
          : { expansion: resolved.expand().catch(() => resolved.text) }),
        narrowing: structuredClone(resolved.narrowing),
        turn: getTurn(),
        vault: at,
        queuedAt: Date.now(),
      };
    },
    [getTurn, resolve],
  );

  /**
   * Send `input` now, or queue it behind the turn: 'sent', 'queued', 'full'
   * (Up next kept nothing) or 'refused' (blank). Review notes are stamped
   * sent only when their prompt is dispatched, now or when their entry
   * starts; queued, they are held by the entry, and read waiting while it
   * lasts (M58.5).
   */
  const submit = useCallback(
    (input: UpNextInput): 'sent' | 'queued' | 'full' | 'refused' => {
      if (input.text.trim() === '') return 'refused';
      const current = conversationId === null ? EMPTY_QUEUE : store().queues[conversationId];
      const waiting = (current?.entries.length ?? 0) > 0 && current?.held !== true;
      if (conversationId !== null && vault !== null && (busy() || waiting)) {
        const entry = entryFor(input, vault);
        const answer = store().enqueue(conversationId, entry);
        if (answer === 'full' && input.handoff === true) toast(HANDOFF_FULL);
        if (answer === 'queued' && input.notes !== undefined) {
          useReviewNotesStore.getState().hold(input.notes.ids, entry.id);
        }
        return answer;
      }
      if (input.notes !== undefined) {
        sendNow(input.text.trim());
        useReviewNotesStore.getState().markSent(input.notes.ids, Date.now());
        return 'sent';
      }
      if (input.prompt !== undefined) {
        sendNow(input.text, input.prompt);
        return 'sent';
      }
      if (input.handoff === true) {
        sendNow(input.text);
        return 'sent';
      }
      const resolved = resolve(input.text);
      sendNow(resolved.text, resolved.expand ?? undefined, resolved.narrowing);
      return 'sent';
    },
    [busy, conversationId, entryFor, resolve, sendNow, store, toast, vault],
  );

  /** Take `id` (or the head) and send it, unless the conversation is busy. */
  const start = useCallback(
    (id: string | null) => {
      if (conversationId === null || busy()) return;
      const entry =
        id === null ? store().claim(conversationId) : store().claimById(conversationId, id);
      if (entry !== null) dispatch(entry);
    },
    [busy, conversationId, dispatch, store],
  );

  // The turn's end, and an idle conversation with entries that can start.
  // A thread left mid-turn holds its Up next: its turn goes on detached
  // (M57.6), and nothing new starts there until the person is back and
  // says Resume.
  const wasBusy = useRef(busyNow);
  const shown = useRef(conversationId);
  const last = chat.messages.length === 0 ? null : chat.messages[chat.messages.length - 1];
  useEffect(() => {
    if (shown.current !== conversationId) {
      if (shown.current !== null && wasBusy.current) store().setHeld(shown.current, true);
      shown.current = conversationId;
      wasBusy.current = busyNow;
      return;
    }
    const ended = wasBusy.current && !busyNow;
    wasBusy.current = busyNow;
    if (busyNow || conversationId === null) return;
    if (ended && queue.steering !== null) {
      start(queue.steering);
      return;
    }
    if (ended) {
      const stopped =
        last !== null &&
        last.role === 'assistant' &&
        (last.cancelled === true || last.error !== undefined || last.interrupted === true);
      if (stopped) {
        store().setHeld(conversationId, true);
        return;
      }
    }
    const head = queue.entries[0];
    if (head === undefined || queue.held || queue.editing === head.id) return;
    start(null);
  }, [busyNow, conversationId, last, queue, start, store]);

  const steer = useCallback(
    (id: string) => {
      if (conversationId === null || store().queues[conversationId]?.steering != null) return;
      store().markSteer(conversationId, id);
      if (busy()) stop();
      else start(id);
    },
    [busy, conversationId, start, stop, store],
  );

  const resume = useCallback(() => {
    if (conversationId === null) return;
    store().setHeld(conversationId, false);
    start(null);
  }, [conversationId, start, store]);

  /** The panel Stop's half: what waits stays until Resume. */
  const hold = useCallback(() => {
    if (conversationId !== null) store().setHeld(conversationId, true);
  }, [conversationId, store]);

  const edit = useCallback(
    (id: string, text: string): boolean => {
      if (conversationId === null) return false;
      const resolved = resolve(text);
      const given: ResolvedText = {
        skill: resolved.skill,
        narrowing: structuredClone(resolved.narrowing),
        ...(resolved.expand === null
          ? {}
          : { expansion: resolved.expand().catch(() => resolved.text) }),
      };
      return store().edit(conversationId, id, resolved.text, given);
    },
    [conversationId, resolve, store],
  );

  const remove = useCallback(
    (id: string) => {
      if (conversationId !== null) store().remove(conversationId, id);
    },
    [conversationId, store],
  );
  const beginEdit = useCallback(
    (id: string) => {
      if (conversationId !== null) store().setEditing(conversationId, id);
    },
    [conversationId, store],
  );
  const endEdit = useCallback(() => {
    if (conversationId !== null) store().setEditing(conversationId, null);
  }, [conversationId, store]);

  return {
    entries: queue.entries,
    held: queue.held,
    steering: queue.steering,
    editing: queue.editing,
    full: queue.entries.length >= UP_NEXT_CAP,
    busy: busyNow,
    submit,
    edit,
    beginEdit,
    endEdit,
    remove,
    steer,
    resume,
    hold,
  };
}

export type UpNext = ReturnType<typeof useUpNext>;
