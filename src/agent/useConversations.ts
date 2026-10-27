import { expireArchivedMessages, nextArchiveExpiry } from './archiveExpiry';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  anchor,
  loadActiveId,
  loadConversations,
  newConversation,
  ordered,
  retitle,
  saveActiveId,
  saveConversations,
  forgetArchivedConversation,
  onArchivedConversationDeleted,
  onImportedCacheReadback,
  withSession,
} from '@/agent/conversations';
import {
  cancelInteraction,
  listInteractions,
  readCliTranscript,
  stopAgent,
} from '@/agent/agentIpc';
import { healFromTranscript, replayTranscript } from '@/agent/transcript';
import { placeLabel, samePlace, type Place } from '@/engine/place';
import type { AgentChat } from '@/agent/useAgentChat';
import type { ChatMessage, Conversation } from '@/agent/types';
import type { RunChoice } from '@/engine/runOptions';
import { useReviewNotesStore } from '@/stores/reviewNotesStore';
import {
  archiveConversation,
  archiveService,
  healRetainedArchive,
  projectArchiveThread,
  projectArchiveMessage,
  sameArchiveContext,
} from './conversationArchive';
import { getVaultOpening, useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';

/**
 * Where the active thread's transcript stands (M56.3): not asked for
 * (`idle`, also a cache the file had nothing to add to), being read, rebuilt
 * from Claude Code's session file, its cache healed from it, or unavailable
 * with Rust's typed reason.
 */
export type TranscriptStatus =
  | { state: 'idle' | 'reading' | 'rebuilt' | 'healed' }
  | { state: 'unavailable'; reason: string; retentionDays: number | null; detail?: string };

/** Why the active thread cannot take another turn (Q7): Claude Code no longer
 * has its session (`cleared`, `expired`), or it was had in another vault. */
export type ThreadBlock = 'cleared' | 'expired' | 'elsewhere' | null;

export interface ConversationState {
  conversations: Conversation[];
  activeId: string;
  active: Conversation | null;
  /** Where the user is standing right now (M17.5) — what an unanchored thread
   * will be stamped with, and what "here" means in the switcher. */
  here: Place;
  hereLabel: string;
  /**
   * Where the active thread STARTED, when that is somewhere else.
   *
   * Not a prompt to do anything about it — the panel briefly asked the user to
   * start a new conversation when they walked away, which was the app making
   * its own bookkeeping their problem. It is a fact the agent is told (see
   * `startedIn` in the snapshot), and a label in the switcher. Nothing else.
   */
  startedElsewhere: string | null;
  /** Stamp the active thread with the current place if it has none. Called at
   * SEND, never after: a turn navigates, so anchoring when it ends would
   * record wherever the agent left you. */
  anchorNow(): void;
  start(): void;
  select(id: string): void;
  rename(id: string, title: string): void;
  remove(id: string): void;
  /** Set a conversation's model and effort (M56.5). They persist with it
   * and ride every turn sent in it; null is Claude Code's default. */
  setRunOptions(id: string, choice: RunChoice): void;
  /** Branch the conversation `threadId` from its reply `messageId` (M91.6):
   * a new thread holding its messages up to and including that reply, named
   * as its source is, and opened. Its first turn forks the session the
   * reply's anchor names at that anchor; the vault's files stay as they are
   * (Q8). The new thread's id, or null with a toast (CV-03) when the reply
   * has no anchor to branch from. */
  branchFrom(threadId: string, messageId: string): string | null;
  /** What reading the active thread's transcript found (M56.3). */
  transcript: TranscriptStatus;
  /** Why the active thread cannot continue, or null when it can. */
  blocked: ThreadBlock;
  /** The stored active thread has been handed to the chat hook. Before its
   * first restore the hook holds an empty start, not that thread, and a new
   * conversation started then would save the thread it leaves as empty. */
  ready: boolean;
}

/** What `placeLabel` resolves names against — the vault, when the caller has it. */
export type PlaceLookup = Parameters<typeof placeLabel>[1];

/** What a branch says when the reply it was asked from is not in its
 * thread (M91.6). */
export const NO_SUCH_REPLY =
  'That reply is no longer in the conversation, so nothing was branched.';

/** What a branch says when the reply's turn never named the line it ended
 * on, so there is nowhere to fork it (M91.6). */
export const NO_BRANCH_POINT =
  "Claude Code didn't say where that turn ended, so the conversation can't branch from it.";

/** A message as a branch copies it (M91.6): what it said and did, without
 * the live turn it may have been part of, or what its run reached (M92.8):
 * a branch's reach is not recorded until its own first run says it. */
function copied({
  streaming: _streaming,
  live: _live,
  seq: _seq,
  gap: _gap,
  reach: _reach,
  ...message
}: ChatMessage): ChatMessage {
  return message;
}

/**
 * Many named conversations instead of one ephemeral thread (M9.5).
 *
 * The live transcript stays in `useAgentChat` — this owns the LIST and
 * mirrors the active transcript into it. Splitting them that way is what
 * lets switching conversations be a `restore` call rather than a rebuild of
 * the streaming machinery.
 *
 * The list holds a cached copy of each thread; the transcript is Claude
 * Code's session file (M56.3). Opening a thread restores the copy at once,
 * then reads the file: a thread with no copy is rebuilt from it, a copy is
 * healed from it (Q6: unfinished tool rows and, M56.8, the whole payloads
 * the copy never keeps, and, M91.4, its reasoning, its calls' structured
 * results and its subagents' steps at any depth; the wording kept), and a
 * file Claude Code no longer has blocks the thread rather than letting a send
 * fail with the CLI's own error (Q7). A thread a full store trimmed to no
 * copy (M91.4) is rebuilt the same way.
 *
 * A turn outlives its panel (M57.6). Switching threads, starting a new one
 * and closing the panel detach a running turn, and every save of the active
 * thread carries the turn's `live` with its messages (`saveActive`), so the
 * thread re-attaches when it opens again. Native-bound/archive-backed Delete
 * asks the original native owner and refuses while work remains. Old unbound
 * browser-only deletion retains its historical Stop/card cancellation.
 *
 * A branch (M91.6) is a thread of its own, holding a reply and the turns
 * before it, whose sends fork the reply's session at its anchor until the
 * thread has a session of its own (`branchFrom`, `withSession`).
 */
const subscribeArchiveOpening = (changed: () => void) => useVaultStore.subscribe(changed);

export function useConversations(
  chat: AgentChat,
  /** Where the panel is standing. Threads are stamped with it at their first
   * turn (M17.5) so a thread can be found again by what it was about. */
  here: Place = { kind: 'home' },
  lookup?: PlaceLookup,
  /** The open vault, whose Claude Code folder a thread's transcript is read
   * from, and which a thread is stamped with at its first turn (M56.3). */
  vault: string | null = null,
): ConversationState {
  const opening = useSyncExternalStore(subscribeArchiveOpening, getVaultOpening, getVaultOpening);
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const stored = loadConversations();
    return stored.length > 0 ? stored : [newConversation()];
  });
  // Seeded from the remembered choice, and from `conversations` — NOT from a
  // second loadConversations() call, which on a first run minted a whole
  // second conversation whose id matched nothing in the list, so the mirror
  // effect below had no record to write the transcript into (M15).
  // A thread the run list asked for (M57.6) beats the remembered one, and is
  // taken once.
  const [activeId, setActiveId] = useState<string>(() => {
    const requested = useUiStore.getState().panelConversation;
    if (requested !== null && conversations.some((c) => c.id === requested)) {
      useUiStore.getState().takePanelConversation();
      return requested;
    }
    const remembered = loadActiveId();
    return remembered !== null && conversations.some((c) => c.id === remembered)
      ? remembered
      : conversations[0].id;
  });

  const activeThreadRef = useRef({
    id: activeId,
    vault: conversations.find((thread) => thread.id === activeId)?.vault,
  });

  // One writer for every path that changes the active conversation — start,
  // select, remove and the initial seed all end up here.
  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  // Opening a thread (M56.3): the cached copy at once, then its transcript.
  // The epoch is bumped by every restore and every send, so a read that
  // lands after either changes nothing; so does one that lands mid-turn.
  const restore = chat.restore;
  const streamingRef = useRef(chat.streaming);
  streamingRef.current = chat.streaming;
  const restoreEpoch = useRef(0);
  const archiveReadEpoch = useRef(0);
  const [transcript, setTranscript] = useState<TranscriptStatus>({ state: 'idle' });
  const [readBlock, setReadBlock] = useState<'cleared' | 'expired' | null>(null);
  const restoreThread = useCallback(
    (c: Conversation) => {
      activeThreadRef.current = { id: c.id, vault: c.vault };
      restoreEpoch.current += 1;
      const epoch = restoreEpoch.current;
      restore(
        expireArchivedMessages(c.messages, Date.now()),
        c.sessionId,
        undefined,
        c.live ?? null,
        c.fork ?? null,
      );
      setReadBlock(null);
      const session = c.sessionId;
      // A thread with a turn still running re-attaches to it (M57.6), and
      // the run's own events, or its rebuild at the end, say what the file
      // would: a heal read now would race the re-attach.
      const partial: TranscriptStatus = {
        state: 'unavailable',
        reason: 'cache_trimmed',
        retentionDays: null,
      };
      if (vault === null || c.live != null || (session === null && c.archiveBacked !== true)) {
        setTranscript(c.cacheTrimmed === true ? partial : { state: 'idle' });
        return;
      }
      const originalOpening = getVaultOpening();
      const current = () =>
        restoreEpoch.current === epoch &&
        !streamingRef.current &&
        originalOpening === getVaultOpening();
      setTranscript({ state: 'reading' });
      void (async () => {
        let cached = c.messages;
        let incomplete = c.cacheTrimmed === true;
        if (c.archiveBacked === true) {
          if (c.vault !== vault) {
            setTranscript({
              state: 'unavailable',
              reason: 'archive_elsewhere',
              retentionDays: null,
            });
            return;
          }
          try {
            const context = await archiveService.context();
            const page = await archiveService.messages(context, c.id);
            if (!current()) return;
            if (!sameArchiveContext(context, page.context) || page.threadId !== c.id)
              throw new Error('archive scope');
            cached = [...page.items].reverse().flatMap(projectArchiveMessage);
            incomplete =
              page.nextCursor !== null ||
              page.items.some(
                (item) => item.content === null || item.content.answer.availability !== 'complete',
              );
            restore(cached, session);
            setTranscript(
              incomplete
                ? { state: 'unavailable', reason: 'archive_partial', retentionDays: null }
                : { state: 'healed' },
            );
          } catch {
            if (current())
              setTranscript({
                state: 'unavailable',
                reason: 'archive_unavailable',
                retentionDays: null,
              });
            return;
          }
        }
        if (session === null) return;
        const read = await readCliTranscript(c.vault ?? vault, session, c.updatedAt ?? c.createdAt);
        if (!current()) return;
        if (read.state === 'unavailable') {
          if (c.archiveBacked !== true)
            setTranscript({
              state: 'unavailable',
              reason: incomplete ? 'cache_trimmed' : read.reason,
              retentionDays: read.retention_days,
              ...(read.detail === undefined ? {} : { detail: read.detail }),
            });
          if (read.reason === 'cleared' || read.reason === 'expired')
            setReadBlock(read.reason === 'cleared' ? 'cleared' : 'expired');
          return;
        }
        const replayed = replayTranscript(read.events, session);
        const facts = { model: replayed.model, prLinks: replayed.prLinks };
        // Archive expiry and absence stay authoritative for the archive view.
        // The independent CLI file may heal only the retained messages shown.
        if (c.archiveBacked === true) {
          const healed = healRetainedArchive(cached, replayed.messages);
          restore(healed, session, facts);
          if (
            incomplete ||
            healed.some((message) => message.archiveRecord?.persistence !== 'retained')
          )
            setTranscript({ state: 'unavailable', reason: 'archive_partial', retentionDays: null });
          return;
        }
        if (cached.length === 0) {
          restore(replayed.messages, session, facts);
          if (c.cacheTrimmed === true)
            setConversations((prev) =>
              prev.map((thread) => {
                if (thread.id !== c.id) return thread;
                const { cacheTrimmed: _rebuilt, ...rest } = thread;
                return rest;
              }),
            );
          setTranscript({ state: 'rebuilt' });
          return;
        }
        const healed = healFromTranscript(cached, replayed.messages);
        restore(healed, session, facts);
        setTranscript(incomplete ? partial : { state: healed === cached ? 'idle' : 'healed' });
      })().catch(() => {
        if (current())
          setTranscript({ state: 'unavailable', reason: 'unreadable', retentionDays: null });
      });
    },
    [restore, vault],
  );

  // First render restores the stored thread into the chat hook once, and
  // reads its transcript. `ready` turns true in the same update as the
  // restore, so a render that reads it true holds the thread.
  const hydrated = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const first = conversations.find((c) => c.id === activeId);
    if (first !== undefined) restoreThread(first);
    setReady(true);
  }, [activeId, conversations, restoreThread]);

  const messages = chat.messages;
  const sessionId = chat.sessionId;
  const streaming = chat.streaming;
  const turnEndedAt = chat.turnEndedAt;
  const live = chat.live;

  /**
   * Write the active thread as the chat hook holds it (M57.6): its messages,
   * its session and the turn it has running, read when this is called, never
   * later, so a save before a thread switch writes the thread being left.
   * The one writer every save of the active thread goes through, so `live`
   * and the reply's cursor never disagree with the messages they belong to.
   */
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const saveActive = useCallback((id: string, extra: Partial<Conversation> = {}) => {
    const { messages: held, sessionId: session, live: turn } = chatRef.current;
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.id === id
          ? retitle({ ...withSession(c, session), messages: held, live: turn, ...extra })
          : c,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  // Mirror the transcript into the active record, and auto-title from the
  // first user message. Skipped while streaming: the turn's skeleton was
  // saved with its `live` when the run started (below), and the turn's end
  // saves it whole.
  useEffect(() => {
    if (!hydrated.current || streaming) return;
    saveActive(activeId, turnEndedAt === null ? {} : { updatedAt: turnEndedAt });
  }, [messages, sessionId, streaming, activeId, turnEndedAt, saveActive]);

  // A turn that just got its run (M57.6): the skeleton, the question and its
  // empty reply, is saved with `live`, so a reload mid-turn re-attaches.
  useEffect(() => {
    if (!hydrated.current || live === null) return;
    saveActive(activeId);
  }, [live, activeId, saveActive]);

  // …except the session id, which is stored the moment the run names it,
  // streaming or not (M56.3): a reload mid-turn must still know which session
  // file the thread rebuilds from. A branch's fork goes with it (M91.6).
  useEffect(() => {
    if (!hydrated.current || sessionId === null) return;
    setConversations((prev) => {
      const current = prev.find((c) => c.id === activeId);
      if (current === undefined || current.sessionId === sessionId) return prev;
      const next = prev.map((c) => (c.id === activeId ? withSession(c, sessionId) : c));
      saveConversations(next);
      return next;
    });
  }, [sessionId, activeId]);

  // …and once more as the panel closes, streaming or not (M15): the turn
  // detaches and keeps running (M57.6), so the thread is saved with its
  // `live` and its reply's cursor, and reopening re-attaches from there. A
  // reply streaming with no live turn was a send still parked before its
  // child, which the close cancels: it reopens saying it was cut off.
  const snapshot = useRef({ conversations, activeId, messages, sessionId, live });
  snapshot.current = { conversations, activeId, messages, sessionId, live };
  useEffect(() => {
    return () => {
      const s = snapshot.current;
      if (!hydrated.current || s.messages.length === 0) return;
      const kept =
        s.live !== null
          ? s.messages
          : s.messages.map((m) =>
              m.streaming === true ? { ...m, streaming: false, interrupted: true } : m,
            );
      saveConversations(
        s.conversations.map((c) =>
          c.id === s.activeId
            ? retitle({ ...withSession(c, s.sessionId), messages: kept, live: s.live })
            : c,
        ),
      );
    };
  }, []);

  // Closed over directly rather than read through a latest-value ref. The refs
  // were there to guard against a send queued a render earlier stamping a
  // stale place — but `here` and `lookup` are this hook's own arguments, so
  // every caller of `anchorNow` is recreated when they change and there is no
  // stale version to call. A render-phase ref write also defeats the compiler
  // (react-hooks/preserve-manual-memoization) for a guarantee already held.
  const anchorNow = useCallback(() => {
    // A send: a transcript read still in flight answers a thread that has
    // moved on (M56.3).
    restoreEpoch.current += 1;
    setConversations((prev) => {
      const current = prev.find((c) => c.id === activeId);
      if (current === undefined) return prev;
      // Already anchored: where a thread STARTED is a fact about the thread,
      // and walking somewhere else mid-conversation does not change it. The
      // vault it was had in is stamped the same way, once (M56.3).
      const stampVault = current.vault === undefined && vault !== null;
      if (current.place != null && !stampVault) return prev;
      const next = prev.map((c) => {
        if (c.id !== activeId) return c;
        const anchored = anchor(c, here, lookup);
        return stampVault && vault !== null ? { ...anchored, vault } : anchored;
      });
      saveConversations(next);
      return next;
    });
  }, [activeId, here, lookup, vault]);

  const start = useCallback(() => {
    const created = newConversation();
    activeThreadRef.current = { id: created.id, vault: created.vault };
    // The thread being left keeps its turn running (M57.6): saved with it.
    setConversations((prev) => [created, ...prev]);
    saveActive(activeId);
    setActiveId(created.id);
    restoreEpoch.current += 1;
    setTranscript({ state: 'idle' });
    setReadBlock(null);
    chat.reset();
  }, [activeId, chat, saveActive]);

  const select = useCallback(
    (id: string) => {
      if (id === activeId) return;
      const target = conversations.find((c) => c.id === id);
      if (target === undefined) {
        if (vault === null) return;
        const token = ++restoreEpoch.current;
        const originalOpening = getVaultOpening();
        void (async () => {
          const context = await archiveService.context();
          let after: string | null = null;
          const seen = new Set<string>();
          for (let pageNumber = 0; pageNumber < 256; pageNumber += 1) {
            const page = await archiveService.threads(context, '', after);
            if (
              restoreEpoch.current !== token ||
              streamingRef.current ||
              getVaultOpening() !== originalOpening
            )
              return;
            if (!sameArchiveContext(context, page.context)) throw new Error('archive scope');
            const found = page.items.find((thread) => thread.id === id);
            if (found !== undefined) {
              const loaded = archiveConversation(found, vault);
              saveActive(activeId);
              setConversations((previous) =>
                previous.some((item) => item.id === id) ? previous : [loaded, ...previous],
              );
              setActiveId(id);
              restoreThread(loaded);
              return;
            }
            if (page.nextCursor === null) break;
            if (seen.has(page.nextCursor)) throw new Error('archive cursor');
            seen.add(page.nextCursor);
            after = page.nextCursor;
          }
          throw new Error('Conversation could not be found in this archive.');
        })().catch(() => {
          if (restoreEpoch.current === token && getVaultOpening() === originalOpening)
            useUiStore
              .getState()
              .toast('Conversation archive is unavailable. Refresh its history and try again.');
        });
        return;
      }
      // The thread being left keeps its turn running (M57.6): saved with it.
      saveActive(activeId);
      setActiveId(id);
      restoreThread(target);
    },
    [activeId, conversations, restoreThread, saveActive, vault],
  );

  // A thread the run list asks for while the panel is open (M57.6).
  const requested = useUiStore((s) => s.panelConversation);
  useEffect(() => {
    if (requested === null) return;
    const id = useUiStore.getState().takePanelConversation();
    if (id !== null) select(id);
  }, [requested, select]);

  const rename = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    setConversations((prev) => {
      // usesDefaultTitle flips false so auto-titling never overwrites a name
      // the user chose.
      const next = prev.map((c) =>
        c.id === id
          ? (() => {
              const { archiveTitle: _sourceTitle, ...rest } = c;
              return { ...rest, title: trimmed, usesDefaultTitle: false };
            })()
          : c,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  const setRunOptions = useCallback((id: string, choice: RunChoice) => {
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.id === id ? { ...c, model: choice.model, effort: choice.effort } : c,
      );
      saveConversations(next);
      return next;
    });
  }, []);

  // M91.6: the anchor a reply's turn ended on names the session that line
  // was written in, which a copied reply keeps, so a branch of a branch
  // forks the session that holds its line. The open thread's messages are
  // the chat hook's, which hold what the stored copy never keeps (M91.4):
  // reasoning, structured results and subagents' steps.
  const branchFrom = useCallback(
    (threadId: string, messageId: string): string | null => {
      const source = conversations.find((c) => c.id === threadId);
      const held = threadId === activeId ? chatRef.current.messages : (source?.messages ?? []);
      const at = held.findIndex((m) => m.id === messageId);
      const anchor = held[at]?.role === 'assistant' ? held[at].anchor : undefined;
      if (source === undefined || at === -1) {
        useUiStore.getState().toast(NO_SUCH_REPLY);
        return null;
      }
      if (anchor === undefined || anchor.sessionId === '' || anchor.uuid === '') {
        useUiStore.getState().toast(NO_BRANCH_POINT);
        return null;
      }
      const branch: Conversation = {
        ...newConversation(),
        title: source.title,
        usesDefaultTitle: source.usesDefaultTitle,
        ...(source.archiveTitle === true
          ? {
              archiveTitle: true as const,
              archiveTitleExpiresAt: source.archiveTitleExpiresAt ?? null,
            }
          : {}),
        messages: held.slice(0, at + 1).map(copied),
        place: source.place ?? null,
        ...(source.placeLabel === undefined ? {} : { placeLabel: source.placeLabel }),
        ...(source.vault === undefined ? {} : { vault: source.vault }),
        model: source.model ?? null,
        effort: source.effort ?? null,
        fork: { from: anchor.sessionId, at: anchor.uuid },
        ...(source.archiveBacked === true
          ? { archiveAncestry: { parentThreadId: threadId, branchMessageId: messageId } }
          : {}),
      };
      // The thread being left keeps its turn running and its card waiting
      // (M57.6): saved with it.
      setConversations((prev) => [branch, ...prev]);
      saveActive(activeId);
      setActiveId(branch.id);
      restoreThread(branch);
      return branch.id;
    },
    [activeId, conversations, restoreThread, saveActive],
  );

  const remove = useCallback(
    (id: string) => {
      // Deleting a thread ends its turn (M57.6), active or not: its run is
      // stopped and the card it waits on cancelled, since nothing could
      // answer either once the thread is gone.
      const doomed = conversations.find((c) => c.id === id);
      if (
        doomed !== undefined &&
        (doomed.archiveBacked === true ||
          doomed.messages.some((message) => message.generationRequestKey !== undefined) ||
          (id === activeId &&
            chatRef.current.messages.some(
              (message) =>
                message.generationRequestKey !== undefined ||
                message.nativeRecoveryRoot !== undefined,
            )))
      ) {
        if (id === activeId && (chatRef.current.streaming || chatRef.current.live !== null)) {
          useUiStore
            .getState()
            .toast(
              'This conversation still has work. Stop or resolve it explicitly before retrying Delete.',
            );
          return;
        }
        if (vault === null || doomed.vault !== vault) {
          useUiStore.getState().toast('Open the conversation’s original vault before deleting it.');
          return;
        }
        const originalOpening = getVaultOpening();
        void (async () => {
          const context = await archiveService.context();
          const result = await archiveService.remove(context, id);
          if (getVaultOpening() !== originalOpening) return;
          if (result.state === 'blocked_active') {
            useUiStore
              .getState()
              .toast(
                'This conversation has running work or an approval. Stop or resolve it explicitly, then retry Delete.',
              );
            return;
          }
          forgetArchivedConversation(vault, id);
        })().catch(() =>
          useUiStore
            .getState()
            .toast('Conversation deletion is unavailable. Its work and cached copy were kept.'),
        );
        return;
      }
      const turn = id === activeId ? chat.live : (doomed?.live ?? null);
      const session = id === activeId ? chat.sessionId : (doomed?.sessionId ?? null);
      if (turn != null) void stopAgent(turn.run).catch(() => undefined);
      if (session !== null && vault !== null) {
        void listInteractions(vault)
          .then((cards) => {
            for (const card of cards) {
              if (card.session_id === session) void cancelInteraction(card.id);
            }
          })
          .catch(() => undefined);
      }
      // Its review notes go with it (M58.5): nothing could send them now.
      useReviewNotesStore.getState().prune(id);
      setConversations((prev) => {
        const remaining = prev.filter((c) => c.id !== id);
        const next = remaining.length > 0 ? remaining : [newConversation()];
        saveConversations(next);
        if (id === activeId) {
          const fallback = next[0];
          setActiveId(fallback.id);
          restoreThread(fallback);
        }
        return next;
      });
    },
    [activeId, chat.live, chat.sessionId, conversations, restoreThread, vault],
  );

  useEffect(
    () =>
      onImportedCacheReadback((sourceVault, thread, marks) => {
        const records = new Map(marks.map((mark) => [mark.messageId, mark.record]));
        setConversations((previous) =>
          previous.map((item) =>
            item.id !== thread || item.vault !== sourceVault
              ? item
              : {
                  ...item,
                  archiveBacked: true as const,
                  messages: item.messages.map((message) => {
                    const record = records.get(message.id);
                    return record === undefined ? message : { ...message, archiveRecord: record };
                  }),
                },
          ),
        );
        if (
          activeThreadRef.current.id === thread &&
          activeThreadRef.current.vault === sourceVault &&
          sourceVault === vault
        )
          chatRef.current.applyArchiveReadback?.(marks);
      }),
    [vault],
  );

  useEffect(
    () =>
      onArchivedConversationDeleted((deletedVault, id) => {
        archiveReadEpoch.current += 1;
        useReviewNotesStore.getState().prune(id);
        setConversations((previous) => {
          const next = previous.filter(
            (thread) => thread.id !== id || thread.vault !== deletedVault,
          );
          if (next.length === previous.length) return previous;
          const kept = next.length === 0 ? [newConversation()] : next;
          if (id === activeId) {
            setActiveId(kept[0].id);
            restoreThread(kept[0]);
          }
          return kept;
        });
      }),
    [activeId, restoreThread],
  );

  useEffect(() => {
    const now = Date.now();
    const expiries = conversations.flatMap((thread) => {
      const next = nextArchiveExpiry(thread.messages, now);
      const title =
        thread.archiveTitle === true &&
        thread.title !== 'Conversation' &&
        typeof thread.archiveTitleExpiresAt === 'string'
          ? Date.parse(thread.archiveTitleExpiresAt)
          : NaN;
      return [
        ...(next === null ? [] : [next]),
        ...(Number.isFinite(title) ? [Math.max(now, title)] : []),
      ];
    });
    if (expiries.length === 0) return;
    const timer = window.setTimeout(
      () =>
        setConversations((previous) => {
          const next = previous.map((thread) => {
            const kept = expireArchivedMessages(thread.messages, Date.now());
            const titleExpired =
              thread.archiveTitle === true &&
              typeof thread.archiveTitleExpiresAt === 'string' &&
              Date.parse(thread.archiveTitleExpiresAt) <= Date.now();
            return kept === thread.messages && !titleExpired
              ? thread
              : { ...thread, ...(titleExpired ? { title: 'Conversation' } : {}), messages: kept };
          });
          saveConversations(next);
          return next;
        }),
      Math.min(2_147_483_647, Math.max(1, Math.min(...expiries) - now)),
    );
    return () => window.clearTimeout(timer);
  }, [conversations]);

  // Metadata discovery and actual content readback, never a legacy import.
  // A successful native body read is required before removing a browser body.
  useEffect(() => {
    if (vault === null) return;
    let retired = false;
    const originalOpening = getVaultOpening();
    const discovery = archiveReadEpoch.current;
    void (async () => {
      const context = await archiveService.context();
      const page = await archiveService.threads(context, '');
      if (
        retired ||
        archiveReadEpoch.current !== discovery ||
        getVaultOpening() !== originalOpening
      )
        return;
      if (!sameArchiveContext(context, page.context)) throw new Error('archive scope');
      setConversations((previous) => {
        if (retired || archiveReadEpoch.current !== discovery) return previous;
        const known = new Set(previous.map((thread) => thread.id));
        return [
          ...previous.map((thread) => {
            const stored = page.items.find((item) => item.id === thread.id);
            return stored === undefined || thread.vault !== vault
              ? thread
              : {
                  ...thread,
                  archiveBacked: true as const,
                  ...(thread.usesDefaultTitle || thread.archiveTitle === true
                    ? {
                        archiveTitle: true as const,
                        archiveTitleExpiresAt:
                          'titleExpiresAt' in stored && typeof stored.titleExpiresAt === 'string'
                            ? stored.titleExpiresAt
                            : null,
                        title: projectArchiveThread(stored).title ?? 'Conversation',
                      }
                    : {}),
                };
          }),
          ...page.items
            .filter((thread) => !known.has(thread.id))
            .map((thread) => archiveConversation(thread, vault)),
        ];
      });
      const active = page.items.find((thread) => thread.id === activeId);
      if (active === undefined || streamingRef.current || chatRef.current.live !== null) return;
      const epoch = restoreEpoch.current;
      const read = await archiveService.messages(context, activeId);
      if (
        retired ||
        archiveReadEpoch.current !== discovery ||
        originalOpening !== getVaultOpening() ||
        streamingRef.current ||
        restoreEpoch.current !== epoch
      )
        return;
      if (!sameArchiveContext(context, read.context) || read.threadId !== activeId)
        throw new Error('archive scope');
      const markers = new Map(
        read.items
          .filter((item) => item.content !== null && item.persistence === 'retained')
          .flatMap((item) => {
            const marker = {
              attemptId: item.attemptId,
              expiresAt: item.expiresAt,
              persistence: item.persistence,
            };
            return [
              [item.userMessageId, marker],
              [item.assistantMessageId, marker],
            ] as const;
          }),
      );
      const held = chatRef.current.messages;
      const marked = held.map((message) => {
        const marker = markers.get(message.id);
        return marker === undefined ? message : { ...message, archiveRecord: marker };
      });
      if (marked.some((message, index) => message !== held[index]))
        restore(marked, chatRef.current.sessionId);
    })().catch(() => {
      /* Background discovery failure never presents an empty successful archive. Explicit reads show their own failure. */
    });
    return () => {
      retired = true;
    };
  }, [vault, opening, turnEndedAt, activeId, restore]);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  return {
    conversations: ordered(conversations),
    activeId,
    active,
    here,
    hereLabel: placeLabel(here, lookup),
    // Null for an unanchored thread: it has not started anywhere yet, so
    // there is nothing to say about where it started.
    startedElsewhere:
      active?.place != null && !samePlace(active.place, here)
        ? (active.placeLabel ?? placeLabel(active.place, lookup))
        : null,
    anchorNow,
    start,
    select,
    rename,
    remove,
    setRunOptions,
    branchFrom,
    transcript,
    // Another vault's thread keys its session under that vault, so it
    // cannot resume here, whatever the file says.
    blocked:
      active?.vault !== undefined && vault !== null && active.vault !== vault
        ? 'elsewhere'
        : readBlock,
    ready,
  };
}
