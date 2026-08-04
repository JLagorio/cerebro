import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { checkAgent } from '@/agent/agentIpc';
import { AiActionCard } from '@/agent/AiActionCard';
import { ChatInput } from '@/agent/ChatInput';
import { buildSnapshot, extractReferences, renderSnapshot } from '@/agent/context';
import {
  chipId,
  placeChip,
  recordChip,
  resolveChips,
  type ContextChip,
} from '@/agent/contextChips';
import { ConversationSwitcher } from '@/agent/ConversationSwitcher';
import { useConversations } from '@/agent/useConversations';
import { useAgentChat } from '@/agent/useAgentChat';
import { type AgentStatus, type ChatMessage } from '@/agent/types';
import {
  listSkills,
  matchSkillInvocation,
  skillIndex,
  skillPrompt,
  type SkillRef,
} from '@/engine/skills';
import { placeOf, samePlace } from '@/engine/place';
import { resolveSurface } from '@/engine/surface';
import { resolveView } from '@/engine/views';
import { readNote } from '@/lib/ipc';
import { useAgentCheckpoint, useGit } from '@/git/useGit';
import { useSchema } from '@/stores/vaultStore';
import { parseIssuePrefixes, SOURCES_DIR } from '@/engine/ingest';
import { resolveTarget } from '@/engine/wikilink';
import { useOpenPath } from '@/app/useOpenPath';
import { useFocusRestore } from '@/hooks/useFocusRestore';
import { useNavStore } from '@/stores/navStore';
import { RIGHT_PANEL_MIN_WIDTH, useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The AI side panel (M6).
 *
 * A docked conversation with the local agent. Everything it can see or change
 * goes through cerebro's own MCP tools, so the panel shows the tool calls
 * inline: an agent that edits your vault should not do it invisibly.
 */

/** Renders assistant text with `[[wikilinks]]` and **bold** made real. */
export function MessageText({ text, onOpen }: { text: string; onOpen: (target: string) => void }) {
  const entries = useVaultStore((s) => s.entries);
  const parts = useMemo(() => text.split(/(\[\[[^\]]+\]\]|\*\*[^*]+\*\*)/g), [text]);
  return (
    <>
      {parts.map((part, i) => {
        const link = /^\[\[([^\]]+)\]\]$/.exec(part);
        if (link !== null) {
          const [target, alias] = link[1].split('|');
          const entry = resolveTarget(target, entries);
          return (
            <button
              key={i}
              type="button"
              onClick={() => onOpen(target)}
              className="cursor-pointer border-0 bg-transparent p-0 text-cortex-600 underline decoration-cortex-200 underline-offset-2 hover:decoration-cortex-500"
            >
              {alias ?? entry?.title ?? target}
            </button>
          );
        }
        const bold = /^\*\*([^*]+)\*\*$/.exec(part);
        if (bold !== null) return <strong key={i}>{bold[1]}</strong>;
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/** Past this, a prompt is a wall rather than a question, so it is collapsed
 * to a predictable slice of the transcript with a way to see the rest. */
const LONG_PROMPT = 400;

function UserMessage({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > LONG_PROMPT;
  return (
    <div className="flex flex-col items-end gap-0.5" data-testid="chat-message" data-role="user">
      <div
        // `whitespace-pre-wrap` (M15): a Shift+Enter multi-line question used
        // to come back as one run-on line in your own bubble.
        className={[
          'max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-xs bg-cortex-500 px-3 py-2 text-sm leading-[18px] text-n-0',
          long && !expanded ? 'max-h-[112px] overflow-hidden' : '',
        ].join(' ')}
      >
        {text}
      </div>
      {long && (
        <button
          type="button"
          data-testid="prompt-toggle"
          onClick={() => setExpanded(!expanded)}
          className="border-0 bg-transparent p-0 text-2xs text-n-500 hover:text-n-800"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function Message({
  message,
  onOpen,
  onOpenPath,
  onViewDiff,
  onRetry,
}: {
  message: ChatMessage;
  onOpen: (t: string) => void;
  onOpenPath: (p: string) => void;
  onViewDiff?: (p: string) => void;
  /** Re-send the question this answer belongs to (M15). */
  onRetry?: () => void;
}) {
  if (message.role === 'user') return <UserMessage text={message.text} />;
  return (
    <div className="flex flex-col gap-1.5" data-testid="chat-message" data-role="assistant">
      {message.tools.length > 0 && (
        <div className="flex flex-col gap-1">
          {message.tools.map((tool) => (
            <AiActionCard
              key={tool.id}
              tool={tool}
              onOpenPath={onOpenPath}
              onViewDiff={onViewDiff}
            />
          ))}
        </div>
      )}
      {/* M15: the text and the error are no longer mutually exclusive. A turn
          that wrote three paragraphs and then failed used to show only the red
          box, throwing away work that was still sitting in state. */}
      {message.text !== '' && (
        <div className="whitespace-pre-wrap break-words text-sm leading-[19px] text-n-800">
          <MessageText text={message.text} onOpen={onOpen} />
        </div>
      )}
      {message.error !== undefined && (
        <div className="flex flex-col items-start gap-1.5 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs leading-[17px] text-danger-700">
          <span>{message.error}</span>
          {onRetry !== undefined && (
            <button
              type="button"
              data-testid="retry-turn"
              onClick={onRetry}
              className="rounded-md border border-n-200 bg-n-0 px-1.5 py-0.5 text-2xs text-danger-700 hover:border-danger-500"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {message.streaming === true && message.text === '' && message.error === undefined && (
        <span className="text-sm text-n-400">Thinking…</span>
      )}
    </div>
  );
}

/**
 * The panel's own width (M15).
 *
 * Every other panel in the shell drags; this one was a fixed 380px you could
 * only toggle, which made tool-call JSON unreadable on a wide screen and made
 * the assistant impossible to give ground on a narrow one. Kept local and in
 * localStorage rather than in uiStore: nothing else in the app reads it, and
 * the floor is the store's own RIGHT_PANEL_MIN_WIDTH.
 */
const AI_WIDTH_KEY = 'cerebro.aiPanelWidth';
export const AI_WIDTH_DEFAULT = 380;
export const AI_WIDTH_MIN = RIGHT_PANEL_MIN_WIDTH;
export const AI_WIDTH_MAX = 720;

function loadAiWidth(): number {
  try {
    const raw = window.localStorage.getItem(AI_WIDTH_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(parsed)) return AI_WIDTH_DEFAULT;
    return Math.min(AI_WIDTH_MAX, Math.max(AI_WIDTH_MIN, Math.round(parsed)));
  } catch {
    return AI_WIDTH_DEFAULT;
  }
}

function saveAiWidth(width: number): void {
  try {
    window.localStorage.setItem(AI_WIDTH_KEY, String(width));
  } catch {
    // Storage unavailable (private mode): the width stays session-only.
  }
}

/** jsdom has no element scrolling, and a missing method must not take the
 * transcript down with it. */
function scrollToLatest(el: HTMLDivElement | null): void {
  if (el === null || typeof el.scrollTo !== 'function') return;
  el.scrollTo({ top: el.scrollHeight });
}

const SUGGESTIONS = [
  'What is at risk right now?',
  'Help me clear the Inbox',
  'What do you know about this vault?',
];

export function AiPanel() {
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const shell = useUiStore((s) => s.agentShellAccess);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);
  const pendingPrompt = useUiStore((s) => s.agentPendingPrompt);
  const setPendingPrompt = useUiStore((s) => s.setAgentPendingPrompt);
  const detailPath = useUiStore((s) => s.detailPath);
  const selection = useNavStore((s) => s.selection);
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const schema = useSchema();
  const openPath = useOpenPath();
  const openDiff = useUiStore((s) => s.openDiff);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  // M15: the panel is resizable like every other panel in the shell. The
  // width lives here rather than in uiStore because it is nobody else's
  // business, and it persists the same way the store's widths do.
  const [width, setWidth] = useState(loadAiWidth);
  // Auto-scroll is STICKY, not unconditional: `patchActive` mints a new
  // message array per streamed token, so the old effect yanked you back to
  // the bottom mid-token every time you tried to read anything above.
  const sticky = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // M9.4: an agent turn that wrote files becomes its own commit, so its work
  // is revertible independently of the user's.
  const { isRepo, refresh } = useGit();
  const checkpoint = useAgentCheckpoint(refresh);

  // M13.1: the skill catalog — names and descriptions only; a body loads when
  // one is invoked, so the vault can hold many skills at no per-turn cost.
  const skills = useMemo(() => listSkills(entries), [entries]);

  // The prompt is read through a ref at send (M17.6). It has to be built from
  // the CONVERSATION's chips, and the conversation list is built on top of the
  // chat hook — so it does not exist yet at this point in the render.
  const promptRef = useRef('');
  const getSystemPrompt = useCallback(() => promptRef.current, []);
  const chat = useAgentChat(
    getSystemPrompt,
    { shell, connectors },
    null,
    isRepo ? checkpoint : undefined,
  );
  // M17.5: the SUBJECT of the current selection, with its lenses stripped —
  // the board tab and the table tab of one List are one place. A thread is
  // stamped with it at its first turn, which is what lets a thread be found
  // again by what it was about instead of by when it happened.
  const place = useMemo(() => placeOf(selection), [selection]);
  const placeLookup = useMemo(
    () => ({ entries, views, collections }),
    [entries, views, collections],
  );
  const conversations = useConversations(chat, place, placeLookup);

  // --- Context chips (M17.6) ------------------------------------------------
  //
  // What the agent is being told about, as things on screen rather than as a
  // derivation nobody can see. `dismissed` and `added` are per-conversation:
  // switching threads must not carry one thread's attachments into another's.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [added, setAdded] = useState<ContextChip[]>([]);
  const activeId = conversations.activeId;
  useEffect(() => {
    setDismissed([]);
    setAdded([]);
  }, [activeId]);

  // The thread's own place, not wherever the user has since walked. This is
  // the "confuses the AI" half of the reported bug: a resumed conversation
  // used to be handed today's surface as what it was looking at.
  const threadPlace = conversations.active?.place ?? place;
  const autoChips = useMemo(() => {
    const list = [placeChip(threadPlace, placeLookup)];
    // The open record. Not part of the PLACE (see engine/place.ts) — the agent
    // opens records itself — but very much part of the context.
    const open = detailPath === null ? null : recordChip(detailPath, entries);
    if (open !== null) list.push(open);
    return list;
  }, [threadPlace, placeLookup, detailPath, entries]);

  const chips = useMemo(
    () => resolveChips(autoChips, dismissed, added),
    [autoChips, dismissed, added],
  );
  const removeChip = (chip: ContextChip) => {
    const id = chipId(chip);
    setAdded((prev) => prev.filter((c) => chipId(c) !== id));
    setDismissed((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  // At most one place chip, so "where this conversation is" stays singular and
  // everything downstream — the rows, the filters, the system prompt's one
  // "you are looking at" line — has a single answer. Removing it means the
  // agent is told nothing about where anyone is standing, which is a real and
  // useful thing to be able to say.
  const contextPlace = chips.find((c) => c.kind === 'place')?.place ?? null;
  // Standing in the place the chip names: use the live selection, so the open
  // view TAB's filters travel too. Otherwise the place alone, which resolves
  // to the List's first view — the best available answer for a surface the
  // user is not currently looking at.
  const contextSelection =
    contextPlace === null ? null : samePlace(contextPlace, place) ? selection : contextPlace;

  // M9.5: the rows the surface is showing. Asking "what is at risk" from the
  // At risk view should be answered from that view's records, not from the
  // agent re-deriving a query it will get subtly wrong.
  const collection = useMemo(
    () =>
      contextSelection === null ? null : resolveSurface(contextSelection, entries, schema, views),
    [contextSelection, entries, schema, views],
  );
  const activeView =
    contextSelection?.kind === 'list'
      ? // Matched on (collection, id), the way ListPage resolves it: ids are
        // unique per FOLDER, so `project === null` alone picked the wrong
        // List's filters whenever two Collections each held a "roadmap".
        (views.find(
          (v) =>
            v.id === contextSelection.id && v.collection === (contextSelection.collection ?? null),
        ) ?? null)
      : null;

  const recordChips = chips.filter((c) => c.kind === 'record');
  const activeChipPath = recordChips.some((c) => c.path === detailPath) ? detailPath : null;

  // Context is a system-prompt suffix, not a hidden first message: it must
  // travel with every turn, because a resumed session re-reads it.
  const systemPrompt = useMemo(() => {
    const base = buildSystemPrompt(contextSelection ?? { kind: 'none' }, {
      connectors,
      issuePrefixes,
      skills,
    });
    const snapshot = buildSnapshot({
      selection: contextSelection ?? undefined,
      entries,
      schema,
      activePath: activeChipPath,
      visible: collection?.entries,
      // M11: the open TAB's filters — what the person is actually looking at.
      filters:
        activeView === null || contextSelection === null
          ? null
          : resolveView(
              activeView.definition,
              contextSelection.kind === 'list' ? (contextSelection.view ?? null) : null,
            ).filters,
      references: extractReferences(draft),
      attached: recordChips.map((c) => c.path),
    });
    return `${base}${renderSnapshot(snapshot)}`;
    // `draft` is deliberately excluded: rebuilding the prompt on every
    // keystroke would thrash, and `send` reads the references it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectors,
    issuePrefixes,
    skills,
    contextSelection,
    entries,
    schema,
    activeChipPath,
    collection?.entries,
    activeView,
    recordChips,
  ]);
  // Handed to the chat hook through a ref rather than an argument — see
  // getSystemPrompt above. Assigned during render, like every other
  // latest-value ref in this codebase.
  promptRef.current = systemPrompt;

  // Every send goes through here so no path can leave a thread unanchored —
  // there are three (the composer, a suggestion chip, and a retry) plus the
  // handoff below, and "remember to call anchorNow" at four call sites is a
  // convention, not a guarantee.
  const anchorNow = conversations.anchorNow;
  const chatSend = chat.send;
  const ask = useCallback(
    (text: string, message?: string | (() => Promise<string>)) => {
      anchorNow();
      chatSend(text, message);
    },
    [anchorNow, chatSend],
  );

  useEffect(() => {
    void checkAgent()
      .then(setStatus)
      .catch(() => setStatus({ installed: false, version: null, path: null }));
  }, []);

  useEffect(() => {
    if (!sticky.current) return;
    scrollToLatest(listRef.current);
  }, [chat.messages]);

  // ⌘J is "talk to the assistant", so it has to open something you can type
  // into; and closing it must not drop focus to <body> (M15). The opener has
  // to be read before the composer's autoFocus fires, which is why this is a
  // render-time capture and not an effect (PR #7 review).
  useFocusRestore();

  // A prompt handed over from elsewhere in the app ("Ask the agent to
  // revise" on a concept) is sent once and then cleared. Held while a turn
  // is streaming — sending mid-turn would be dropped by the hook's
  // one-turn guard — and delivered when the stream ends (PR #5 review).
  const streaming = chat.streaming;
  useEffect(() => {
    if (pendingPrompt === null || streaming) return;
    // M17.6: the handoff's SUBJECT becomes a context chip. Six call sites used
    // to hand over a prompt naming a record and drop the record itself, so the
    // agent was asked to revise a concept and handed whatever surface the user
    // happened to be standing on.
    //
    // Attaching is its own pass, ending with the subject consumed rather than
    // the whole handoff: the prompt is built from the chips DURING RENDER, so
    // sending in the same tick would send the context from before the chip
    // existed — the exact staleness this milestone is about.
    if (pendingPrompt.subject !== null) {
      const chip = recordChip(pendingPrompt.subject, entries);
      setPendingPrompt({ text: pendingPrompt.text, subject: null });
      if (chip !== null) {
        const id = chipId(chip);
        setDismissed((prev) => prev.filter((d) => d !== id));
        setAdded((prev) => (prev.some((c) => chipId(c) === id) ? prev : [...prev, chip]));
      }
      return;
    }
    setPendingPrompt(null);
    ask(pendingPrompt.text);
  }, [ask, entries, pendingPrompt, setPendingPrompt, streaming]);

  const submit = () => {
    // Mid-turn, Enter is a no-op: the Send button is already replaced by
    // Stop, and the keyboard must match it. The draft stays in the composer
    // rather than vanishing into a send the hook would drop (PR #5 review).
    if (chat.streaming) return;
    const trimmed = draft.trim();
    if (trimmed === '') return;
    // M13.1: `/name …` expands to the skill's body — the transcript shows what
    // was typed, the agent gets the instructions. The expansion is handed to
    // send() as a deferred read so the turn starts synchronously; an
    // unreadable skill file falls back to sending the message as typed.
    // A draft STARTING with a space is the opt-out: sent literally, never
    // expanded — the one way to say `/weekly-review` to the agent as text.
    const literal = draft.startsWith(' ');
    const invocation = literal ? null : matchSkillInvocation(trimmed, skills);
    setDraft('');
    if (invocation === null || vaultPath === null) {
      ask(trimmed);
      return;
    }
    const { skill, request } = invocation;
    ask(trimmed, () =>
      readNote(vaultPath, skill.path).then((raw) => skillPrompt(skill, raw, request)),
    );
  };

  // M9.7: open the note and show its diff there, rather than stacking a
  // dialog over the panel that produced it.
  const viewDiff = (path: string) => {
    openPath(path);
    openDiff(path);
  };

  const openTarget = (target: string) => {
    const entry = resolveTarget(target, entries);
    if (entry !== null) openPath(entry.path);
  };

  // M15: the failed turn's question is still in the transcript — retrying is
  // one click rather than retyping it from memory. The failed exchange stays
  // visible: it is what the error refers to.
  const retry = (assistantId: string) => {
    if (chat.streaming) return;
    const index = chat.messages.findIndex((m) => m.id === assistantId);
    const question = index > 0 ? chat.messages[index - 1] : undefined;
    if (question === undefined || question.role !== 'user') return;
    ask(question.text);
  };

  const onListScroll = () => {
    const el = listRef.current;
    if (el === null) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    sticky.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };

  const jumpToLatest = () => {
    sticky.current = true;
    setAtBottom(true);
    scrollToLatest(listRef.current);
  };

  return (
    <aside
      aria-label="AI panel"
      data-testid="ai-panel"
      // `relative` hosts the drag handle; `min-w-0` + a 100% ceiling let the
      // panel SHRINK inside the shell's right-hand slot instead of having its
      // close button clipped off the edge (M15 layout contract).
      className="relative flex min-w-0 flex-none flex-col border-l border-n-200 bg-n-0"
      style={{ width, maxWidth: '100%' }}
    >
      <ResizeHandle
        label="Resize AI panel"
        side="left"
        width={width}
        min={AI_WIDTH_MIN}
        max={AI_WIDTH_MAX}
        onResize={(next) => {
          setWidth(next);
          saveAiWidth(next);
        }}
      />
      <header className="flex flex-none items-center gap-2 border-b border-n-200 px-3 py-2">
        <Icon name="sparkles" size={14} color="var(--synapse-500)" />
        {/* M9.5: conversations are kept and named, so this is a switcher
            rather than a label beside a button that erased the transcript. */}
        <ConversationSwitcher state={conversations} />
        {status !== null && !status.installed && (
          <span className="text-2xs text-warn-600">not installed</span>
        )}
        <span className="flex-1" />
        <IconButton
          icon="square-pen"
          label="New conversation"
          size="sm"
          onClick={conversations.start}
        />
        <IconButton
          icon="x"
          label="Close AI panel"
          size="sm"
          onClick={() => setAiPanelOpen(false)}
        />
      </header>

      <div
        ref={listRef}
        onScroll={onListScroll}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {chat.messages.length === 0 ? (
          <div className="flex flex-col gap-2 pt-2">
            <p className="m-0 text-sm leading-[18px] text-n-500">
              {status?.installed === false
                ? 'Claude Code was not found on this machine. Install it and reopen cerebro.'
                : 'I can read and write this vault through cerebro. I maintain the Knowledge bundle; you verify it.'}
            </p>
            {status?.installed !== false &&
              SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => ask(suggestion)}
                  className="rounded-lg border border-n-200 bg-transparent px-2.5 py-1.5 text-left text-xs text-n-700 hover:border-n-300 hover:bg-n-25"
                >
                  {suggestion}
                </button>
              ))}
          </div>
        ) : (
          chat.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              onOpen={openTarget}
              onOpenPath={openPath}
              onViewDiff={isRepo ? viewDiff : undefined}
              onRetry={message.error !== undefined ? () => retry(message.id) : undefined}
            />
          ))
        )}
      </div>

      <div className="relative flex-none border-t border-n-200 p-2.5">
        {/* Only offered when you have actually scrolled away — the transcript
            is sticky to the bottom the rest of the time. */}
        {!atBottom && chat.messages.length > 0 && (
          <button
            type="button"
            data-testid="jump-to-latest"
            onClick={jumpToLatest}
            className="absolute -top-8 left-1/2 z-10 -translate-x-1/2 rounded-full border border-n-200 bg-n-0 px-2.5 py-1 text-2xs text-n-600 shadow-[var(--shadow-lg)] hover:border-n-400"
          >
            Jump to latest
          </button>
        )}
        {/* M17.5: the open thread was had somewhere else. Said, not acted on:
            the assistant navigates you around by design, so a panel that
            swapped threads under a navigation would be M17.2's bug one layer
            up — you would lose the answer you were reading because the agent
            opened the note it was about. The offer is one click either way. */}
        {conversations.elsewhere && (
          <div
            data-testid="thread-elsewhere"
            className="mb-1.5 flex items-center gap-1.5 text-2xs text-n-500"
          >
            <Icon name="corner-down-right" size={11} color="var(--n-400)" />
            {/* Says what CHANGED, not what the chip above already says: the
                place chip names the thread's subject, this names where you
                have walked to. The button is the point of the row. */}
            <span className="min-w-0 flex-1 truncate">
              You’ve moved to {conversations.hereLabel}.
            </span>
            <button
              type="button"
              data-testid="new-conversation-here"
              onClick={conversations.start}
              className="flex-none rounded border-0 bg-transparent px-1 py-0.5 text-2xs text-cortex-600 underline hover:bg-n-50"
            >
              New one here
            </button>
          </div>
        )}
        {/* M17.6: what the agent is being told about, as things rather than as
            a derivation. Removable, because the most useful thing a context
            control can do is take something OUT — an answer about the wrong
            record reads as the model being stupid until you can see that the
            app handed it the wrong page. */}
        {chips.length > 0 && (
          <div
            data-testid="context-chips"
            className="mb-1.5 flex flex-wrap items-center gap-1"
            aria-label="Context"
          >
            {chips.map((chip) => (
              <span
                key={chipId(chip)}
                data-testid="context-chip"
                data-kind={chip.kind}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-n-200 bg-n-25 py-0.5 pl-1.5 pr-0.5 text-2xs text-n-600"
              >
                <Icon
                  name={chip.kind === 'place' ? 'map-pin' : 'file-text'}
                  size={10}
                  color="var(--n-400)"
                />
                <span className="min-w-0 truncate">{chip.label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${chip.label} from context`}
                  onClick={() => removeChip(chip)}
                  className="flex-none rounded border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
                >
                  <Icon name="x" size={9} />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* M9.5: `[[` completes against the vault, and the note you name
            travels into the snapshot with its content rather than as a word
            the agent has to go searching for. */}
        <ChatInput autoFocus value={draft} onChange={setDraft} onSubmit={submit} />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex-1 text-2xs text-n-400">
            {chat.streaming ? 'Working…' : 'Enter to send · [[ to reference a note'}
          </span>
          {chat.streaming ? (
            <Button variant="secondary" size="sm" icon="square" onClick={chat.stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon="send" onClick={submit}>
              Send
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** What the agent is told about where the user is standing, and what it may reach. */
export function buildSystemPrompt(
  selection: { kind: string; path?: string; id?: string; name?: string },
  options: { connectors?: boolean; issuePrefixes?: string; skills?: SkillRef[] } = {},
): string {
  const lines = [
    'You are the assistant inside cerebro, a local markdown work-management app.',
    'Notes are markdown files with YAML frontmatter. A project is a folder holding project.md; its work items live in <folder>/items/. Types are declared by `type: Type` docs in types/.',
    'Use the cerebro MCP tools: get_vault_context to orient, search_notes and get_note to read, and the write tools to change things. Call open_note so the user sees what you are referring to.',
    'When you mention a note, write it as [[note-name]] so it is clickable.',
    "You maintain the knowledge/ bundle in Open Knowledge Format. Record where every claim came from in `sources`, and anchor every concept to the entities it is about with `about` wikilinks — an unanchored concept is unreachable from the work it describes. Never write `verified` — that is the user's stamp, and claiming it would defeat the review model.",
    'To file an Inbox capture, use propose_organize so the user can accept or reject it. Do not edit captures directly.',
    "Never create or modify `type: Type` docs on your own — schema is the user's to change. When a vault clearly needs a new type or field, describe the change and why, and let them make it (the Types screen and the adoption wizard are the human path).",
    'Be concise.',
  ];

  // The connector inlet (M8.2). Said only when the servers are actually
  // reachable — telling the agent to fetch through tools it does not have
  // produces apologies, not sources.
  if (options.connectors === true) {
    lines.push(
      `External material you fetch through another MCP server must be written down with cache_source, which stores it under ${SOURCES_DIR}/. Search for an existing copy before fetching: one fetch, a permanent local file, and every later question reads the file.`,
    );
    const prefixes = parseIssuePrefixes(options.issuePrefixes ?? '');
    if (prefixes.length > 0) {
      lines.push(
        `This vault's issue-tracker project keys are ${prefixes.join(', ')}. A token like ${prefixes[0]}-421 is a ticket worth fetching; nothing else that merely looks similar is.`,
      );
    }
  }

  // M13.1: the skill catalog — one line per skill; bodies load on invocation.
  const skillLine = skillIndex(options.skills ?? []);
  if (skillLine !== null) lines.push(skillLine);

  const where = describeSelection(selection);
  if (where !== null) lines.push(`The user is currently looking at ${where}.`);
  return lines.join('\n');
}

function describeSelection(selection: {
  kind: string;
  path?: string;
  id?: string;
  name?: string;
}): string | null {
  switch (selection.kind) {
    case 'doc':
    case 'project':
      return selection.path ?? null;
    case 'list':
      return selection.id !== undefined ? `the list "${selection.id}"` : null;
    case 'type':
      return selection.name !== undefined ? `the ${selection.name} type screen` : null;
    case 'inbox':
      return 'the Inbox';
    case 'knowledge':
      return 'the Knowledge bundle';
    default:
      return null;
  }
}
