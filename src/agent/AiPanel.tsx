import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { checkAgent } from '@/agent/agentIpc';
import { historyOf, type GitHistory } from '@/agent/AiActionCard';
import { TranscriptRows } from '@/agent/toolRenderers';
import { TurnChangeset } from '@/agent/TurnChangeset';
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
import { FailureNoticeCard } from '@/agent/FailureNoticeCard';
import { InteractionCard } from '@/agent/InteractionCard';
import { PermissionCard } from '@/agent/PermissionCard';
import { WriteApprovalCard } from '@/agent/WriteApprovalCard';
import { RunOptionsPicker } from '@/agent/RunOptionsPicker';
import { MessageText } from '@/agent/MessageMarkdown';
import { TranscriptNotice } from '@/agent/TranscriptNotice';
import { useConversations } from '@/agent/useConversations';
import { loadDraft, pruneDrafts, saveDraft } from '@/agent/drafts';
import { useAgentChat, type TurnContext } from '@/agent/useAgentChat';
import { UpNext } from '@/agent/UpNext';
import { ReviewNotesDock } from '@/agent/ReviewNotesDock';
import { useUpNext, type SkillResolution } from '@/agent/useUpNext';
import { useUpNextStore } from '@/stores/upNextStore';
import { type AgentStatus, type ChatMessage, type PrLink } from '@/agent/types';
import { listSkills, matchSkillInvocation, skillPrompt } from '@/engine/skills';
import { buildSystemPrompt } from '@/agent/systemPrompt';
import type { PromptGrant } from '@/engine/toolGrant';
import { listAgents } from '@/engine/agents';
import { isPaused } from '@/engine/jobs';
import { isKnowledgePath, listConcepts, type Concept } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import {
  ASK_BASE_LABEL,
  askBasePrompt,
  askedAbout,
  AUGMENT_LABEL,
  augmentDocPrompt,
  conceptAsk,
  DISTILL_LABEL,
  distillPrompt,
} from '@/lib/prompts';
import { placeOf, samePlace } from '@/engine/place';
import { resolveSurface } from '@/engine/surface';
import { resolveView } from '@/engine/views';
import { pausedAgents, readNote } from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import { useGit } from '@/git/useGit';
import { useSchema } from '@/stores/vaultStore';
import { resolveTarget } from '@/engine/wikilink';
import { useOpenPath } from '@/app/useOpenPath';
import { useFocusRestore } from '@/hooks/useFocusRestore';
import { useNavStore } from '@/stores/navStore';
import { dragCeiling, fitWidth } from '@/app/shellLayout';
import { AI_WIDTH_MAX, AI_WIDTH_MIN, useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The AI side panel (M6).
 *
 * A docked conversation with the local agent. Everything it can see or change
 * goes through cerebro's own MCP tools, so the panel shows the tool calls
 * inline: an agent that edits your vault should not do it invisibly.
 */

/** Past this, a prompt is a wall rather than a question, so it is collapsed
 * to a predictable slice of the transcript with a way to see the rest. */
const LONG_PROMPT = 400;

function UserMessage({ text, addressed }: { text: string; addressed?: ChatMessage['addressed'] }) {
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
      {/* M33b.6 — who this turn went to, said once, under the bubble it
          belongs to. Only ever drawn when the person typed an `@`: a mention
          affordance is theirs to invoke, and an app that volunteered agents
          at someone would be the counting chrome M8 forbids. */}
      {addressed !== undefined && (
        <span data-testid="turn-addressed" className="text-2xs text-n-400">
          {addressed.title === null
            ? `No agent called @${addressed.handle} — ${addressed.answeredBy ?? 'the assistant'} took this one.`
            : `To ${addressed.title}`}
        </span>
      )}
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
  history,
  onRetry,
  noticeActions,
  waitingToolId = null,
}: {
  message: ChatMessage;
  onOpen: (t: string) => void;
  onOpenPath: (p: string) => void;
  /** Open a file's diff: at `commit` when this reply's run committed it
   * (M58.3), else in the working tree. */
  onViewDiff?: (p: string, commit: string | null) => void;
  /** The call a card waits on in this message (M57.1), whose row reads
   * waiting. */
  waitingToolId?: string | null;
  /** Whether the vault keeps git history, so a write card can say it has no
   * revert (M55.5); undefined until git status is read. */
  history?: GitHistory;
  /** Re-send the question this answer belongs to (M15). */
  onRetry?: () => void;
  /** What a failure card's fix does, by action (M56.4). */
  noticeActions?: Partial<Record<string, () => void>>;
}) {
  if (message.role === 'user')
    return <UserMessage text={message.text} addressed={message.addressed} />;
  // M58.3: a card's View diff opens the file at the commit this reply's run
  // made of it, so it still shows the run's change after the commit lands.
  const cardDiff =
    onViewDiff === undefined ? undefined : (p: string) => onViewDiff(p, commitOf(message, p));
  return (
    <div className="flex flex-col gap-1.5" data-testid="chat-message" data-role="assistant">
      {/* M56.8: rows by the tool manifest's renderer, consecutive reads
          folded into one; the message's streaming flag decides whether an
          unfinished call is running or interrupted, and a call a hook held
          reads waiting, cancelled, not run or paused (M57.1). */}
      {message.tools.length > 0 && (
        <TranscriptRows
          tools={message.tools}
          streaming={message.streaming === true}
          onOpenPath={onOpenPath}
          onViewDiff={cardDiff}
          history={history}
          waitingToolId={waitingToolId}
        />
      )}
      {/* M15: the text and the error are no longer mutually exclusive. A turn
          that wrote three paragraphs and then failed used to show only the red
          box, throwing away work that was still sitting in state. */}
      {message.text !== '' && (
        <div className="whitespace-pre-wrap break-words text-sm leading-[19px] text-n-800">
          <MessageText text={message.text} onOpen={onOpen} />
        </div>
      )}
      {/* M56.4: a failure Rust could type is a card with its fix; one it
          could not keeps the red box and Claude Code's own words. */}
      {message.error !== undefined && message.notice !== undefined && (
        <FailureNoticeCard
          notice={message.notice}
          raw={message.error}
          actions={noticeActions}
          onRetry={onRetry}
        />
      )}
      {message.error !== undefined && message.notice === undefined && (
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
      {/* M57.6: the journal dropped some of this turn's live events while the
          panel was closed, so what shows is partial until the turn ends and
          its reply is read back from the session file. */}
      {message.gap === true && (
        <span data-testid="turn-gap" className="text-sm text-n-400">
          {GAP_LINE}
        </span>
      )}
      {/* M58.3: what each of this reply's runs changed, from its own commit. */}
      {message.changesets !== undefined && message.changesets.length > 0 && (
        <TurnChangeset
          changesets={message.changesets}
          onViewDiff={onViewDiff}
          onOpenPath={onOpenPath}
        />
      )}
      {/* M57.5: a turn a person stopped (Stop, or Steer past it) says so,
          under whatever it wrote first. */}
      {message.cancelled === true && message.streaming !== true && (
        <span data-testid="turn-cancelled" className="text-sm text-n-400">
          Cancelled
        </span>
      )}
      {/* M56.3: a turn stopped or cut off before it said anything says so,
          rather than leaving an empty bubble. */}
      {message.cancelled !== true &&
        message.interrupted === true &&
        message.streaming !== true &&
        message.text === '' &&
        message.tools.length === 0 &&
        message.error === undefined && (
          <span data-testid="turn-stopped" className="text-sm text-n-400">
            Stopped before it replied.
          </span>
        )}
    </div>
  );
}

/** The commit this reply's run made of `path` (M58.3), the latest first, or
 * null when no run of it committed that file. */
function commitOf(message: ChatMessage, path: string): string | null {
  for (const changeset of [...(message.changesets ?? [])].reverse()) {
    if (changeset.state === 'committed' && changeset.files.some((f) => f.path === path)) {
      return changeset.commit;
    }
  }
  return null;
}

/** What a reply whose live events were dropped says under it (M57.6). */
const GAP_LINE =
  "Live updates from while the panel was closed weren't kept. The full reply appears when this turn finishes.";

/** How long the composer waits after the last keystroke to save its draft. */
const DRAFT_SAVE_MS = 300;

/** What the composer says when a thread cannot continue (Q7). */
const BLOCKED_WORDS = {
  elsewhere: 'This conversation was had in another vault. Open that vault to continue it.',
  gone: "Claude Code no longer has this conversation, so it can't continue here.",
};

/** The pull requests a conversation's session opened (M56.3), as plain links:
 * the shell's link guard (M53.12) sends an https href to the browser. */
/**
 * Who answers in this panel, when Settings binds it to an Agent record
 * (M56.6): the agent's title, which opens its page (D18), and "(paused)"
 * when its record or the fleet pauses it. A pause on the fleet refuses its
 * turns in Rust, so the header says so before a turn is refused. A handle no
 * record answers to is named, because those turns go to the plain assistant.
 * Nothing at all when the panel is unbound, which is the common case.
 */
function PanelAgentLabel({
  vaultPath,
  handle,
  entries,
  streaming,
  onOpen,
}: {
  vaultPath: string;
  handle: string;
  entries: Entry[];
  streaming: boolean;
  onOpen: (path: string) => void;
}) {
  const agent = useMemo(
    () => listAgents(entries).find((a) => a.handle === handle) ?? null,
    [entries, handle],
  );
  const recordPaused = useMemo(() => {
    const entry = agent === null ? undefined : entries.find((e) => e.path === agent.path);
    return entry !== undefined && isPaused(entry);
  }, [agent, entries]);
  // The fleet's pause, re-read when a turn ends: it is what refuses a turn,
  // and it can change on the fleet while this panel is open. A failed read
  // claims nothing, so only the record's own pause shows then.
  const actor = agent?.actor ?? null;
  const [fleetPaused, setFleetPaused] = useState(false);
  useEffect(() => {
    if (actor === null || streaming) return;
    let live = true;
    void pausedAgents(vaultPath).then(
      (paused) => live && setFleetPaused(paused.includes(actor)),
      () => live && setFleetPaused(false),
    );
    return () => {
      live = false;
    };
  }, [actor, streaming, vaultPath]);
  if (agent === null) {
    return (
      <span
        data-testid="panel-agent"
        data-state="missing"
        title={`@${handle} — no agent answers to this name, so the assistant answers`}
        className="min-w-0 truncate text-2xs text-warn-600"
      >
        @{handle} not found
      </span>
    );
  }
  const paused = recordPaused || fleetPaused;
  return (
    <button
      type="button"
      data-testid="panel-agent"
      data-state={paused ? 'paused' : 'bound'}
      title={`${agent.title} answers in this panel. Open its page.`}
      onClick={() => onOpen(agent.path)}
      className="min-w-0 truncate border-0 bg-transparent p-0 text-2xs text-n-600 hover:text-n-900"
    >
      {agent.title}
      {paused ? ' (paused)' : ''}
    </button>
  );
}

function PrLinks({ links }: { links: PrLink[] }) {
  return (
    <div data-testid="thread-pr-links" className="flex flex-wrap items-center gap-2 text-2xs">
      <Icon name="git-pull-request" size={11} color="var(--n-400)" />
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="text-cortex-600 hover:underline"
        >
          {`${link.repository}#${link.number}`}
        </a>
      ))}
    </div>
  );
}

/** jsdom has no element scrolling, and a missing method must not take the
 * transcript down with it. */
function scrollToLatest(el: HTMLDivElement | null): void {
  if (el === null || typeof el.scrollTo !== 'function') return;
  el.scrollTo({ top: el.scrollHeight });
}

const SUGGESTIONS: Suggestion[] = [
  { label: 'What is at risk right now?' },
  { label: 'Help me clear the Inbox' },
  { label: 'What do you know about this vault?' },
];

/** A starter: what the button says, and — when it is not the same — what is
 *  sent (a structured prompt the chip label summarizes) and what the bubble
 *  says it was (M52.3: the act and the page, as every surface names it). */
interface Suggestion {
  label: string;
  prompt?: string;
  asked?: string;
}

/** A page's starter: the act's one label on the button, the page's title in
 *  the bubble it leaves — the same words the surface's own button sends. */
function pageAct(page: Entry, label: string, prompt: string): Suggestion {
  return { label, prompt, asked: askedAbout(label, page.title) };
}

/**
 * Starters from the page you are on (M50.4). The panel offered the same three
 * everywhere, so opening it beside a concept asked about the Inbox. A page
 * gets the questions its own surfaces already ask — what Knowledge says about
 * it, what it is missing, learning from it — and a concept gets its own:
 * the one ask its review bar offers (M52.3 — a recheck only when it is due,
 * and none once it has been replaced).
 */
function pageSuggestions(page: Entry | null, concept: Concept | null): Suggestion[] {
  if (page === null) return SUGGESTIONS;
  if (concept !== null) {
    const act =
      concept.supersededBy === null
        ? conceptAsk({ path: page.path, title: concept.title, stale: concept.stale })
        : null;
    return [
      pageAct(
        page,
        'What supports this concept?',
        `What in this vault supports or contradicts the concept at ${page.path} ("${concept.title}")? Cite the pages.`,
      ),
      ...(act === null ? [] : [pageAct(page, act.label, act.text)]),
      { label: 'What do you know about this vault?' },
    ];
  }
  return [
    pageAct(page, ASK_BASE_LABEL, askBasePrompt(page.path, page.title)),
    pageAct(page, AUGMENT_LABEL, augmentDocPrompt(page.path, page.title)),
    pageAct(page, DISTILL_LABEL, distillPrompt(page.path, page.title)),
  ];
}

export function AiPanel({
  room = null,
}: {
  /** The widest the shell can draw the panel, measured; null until it has. */
  room?: number | null;
} = {}) {
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const shell = useUiStore((s) => s.agentShell);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);
  const handoff = useUiStore((s) => s.handoffs[0] ?? null);
  const markHandoffAttached = useUiStore((s) => s.markHandoffAttached);
  const takeHandoff = useUiStore((s) => s.takeHandoff);
  const setSettingsFocus = useUiStore((s) => s.setSettingsFocus);
  const navigate = useNavStore((s) => s.navigate);
  const detailPath = useUiStore((s) => s.detailPath);
  const selection = useNavStore((s) => s.selection);
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const schema = useSchema();
  const openPath = useOpenPath();
  const openDiff = useUiStore((s) => s.openDiff);
  // M56.6 — who answers in this vault's panel, from the app's config.
  const loadPanelAgent = useUiStore((s) => s.loadPanelAgent);
  const boundAgent = useUiStore((s) =>
    vaultPath === null ? null : (s.panelAgents[vaultPath] ?? null),
  );
  // Absent from the store means not read yet: a handoff waits for the read
  // (the vault store starts it when the vault opens) so it cannot run as the
  // plain assistant in a bound panel. A failed read lets it go.
  const bindingRead = useUiStore(
    (s) =>
      vaultPath === null ||
      s.panelAgents[vaultPath] !== undefined ||
      s.panelAgentsUnreadable[vaultPath] === true,
  );
  useEffect(() => {
    if (vaultPath !== null) void loadPanelAgent(vaultPath);
  }, [loadPanelAgent, vaultPath]);

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  // M15: the panel is resizable like every other panel in the shell. The
  // stored width is the one it keeps beside a record; it gives only once the
  // record has given all it can (app/shellLayout.ts). `drawn` is that width
  // as measured, for the drag handle — CSS is what draws it.
  const width = useUiStore((s) => s.aiPanelWidth);
  const setWidth = useUiStore((s) => s.setAiPanelWidth);
  const drawn = room === null ? width : fitWidth(width, room);
  // Auto-scroll is STICKY, not unconditional: `patchActive` mints a new
  // message array per streamed token, so the old effect yanked you back to
  // the bottom mid-token every time you tried to read anything above.
  const sticky = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Whether the vault keeps git history, for the action cards' diff and
  // revert. A turn's writes are committed in Rust, by the run's own reader,
  // before its Done (M58.3), so no panel has to be open for it.
  const { isRepo, ready } = useGit();

  // M13.1: the skill catalog — names and descriptions only; a body loads when
  // one is invoked, so the vault can hold many skills at no per-turn cost.
  const skills = useMemo(() => listSkills(entries), [entries]);
  // M17.20: the knowledge bundle — for the snapshot, which carries the
  // concepts about what is in context (by `about:` anchor) or learned from it
  // (by `sources`, M52.3), and for the asks a concept's own page offers.
  const quarantine = useQuarantine();
  const ledgerReview = useLedgerReview();
  const concepts = useMemo(
    () => listConcepts(entries, todayIso(), quarantine, ledgerReview),
    [entries, quarantine, ledgerReview],
  );

  // The turn's context is read through a ref at send (M17.6). It has to be
  // built from the CONVERSATION's chips, and the conversation list is built on
  // top of the chat hook — so none of it exists yet at this point in the
  // render. Assigned below, once it does.
  const turnRef = useRef<TurnContext>({
    systemPrompt: () => '',
    place: null,
    conversationId: null,
  });
  const getTurn = useCallback(() => turnRef.current, []);
  const chat = useAgentChat(getTurn, { shell, connectors });
  // M17.5: the SUBJECT of the current selection, with its lenses stripped —
  // the board tab and the table tab of one List are one place. A thread is
  // stamped with it at its first turn, which is what lets a thread be found
  // again by what it was about instead of by when it happened.
  const place = useMemo(() => placeOf(selection), [selection]);
  const placeLookup = useMemo(
    () => ({ entries, views, collections }),
    [entries, views, collections],
  );
  const conversations = useConversations(chat, place, placeLookup, vaultPath);
  const blocked = conversations.blocked;

  // M57.6: the composer's draft is per thread and outlives the panel. A
  // thread's draft loads when it opens, saves 300 ms after typing stops, and
  // is flushed when the thread changes and when the panel closes.
  const activeConversation = conversations.activeId;
  const draftOwner = useRef<string | null>(null);
  const draftNow = useRef(draft);
  draftNow.current = draft;
  useEffect(() => {
    if (draftOwner.current !== null) saveDraft(draftOwner.current, draftNow.current);
    draftOwner.current = activeConversation;
    // Mirrored at once, so a flush before the next render saves what was
    // loaded, never the empty draft it replaces.
    const loaded = loadDraft(activeConversation);
    draftNow.current = loaded;
    setDraft(loaded);
  }, [activeConversation]);
  useEffect(() => {
    const owner = draftOwner.current;
    if (owner === null) return;
    const timer = setTimeout(() => saveDraft(owner, draft), DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(
    () => () => {
      if (draftOwner.current !== null) saveDraft(draftOwner.current, draftNow.current);
    },
    [],
  );
  // M56.5: the composer's model and effort picker, opened by its button or
  // by a failure card's "Choose another model".
  const [runOptionsOpen, setRunOptionsOpen] = useState(false);

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

  // Where you are NOW, and it follows you.
  //
  // This chip briefly showed the thread's anchor instead, which meant walking
  // to the Inbox left the context saying "Home" — wrong, and the only cure on
  // offer was "start a new conversation". That was the app handing its own
  // bookkeeping to the user. Two things make the simple answer the right one:
  // a turn's context is frozen at send (so the agent moving you mid-answer
  // cannot rewrite it), and where the conversation STARTED is told to the
  // agent as a fact (`startedIn`) rather than pinned into the chip. It has the
  // transcript and both places; reconciling them is not a hard problem for it.
  const autoChips = useMemo(() => {
    const list = [placeChip(place, placeLookup)];
    // The open record. Not part of the PLACE (see engine/place.ts) — the agent
    // opens records itself — but very much part of the context.
    const open = detailPath === null ? null : recordChip(detailPath, entries);
    if (open !== null) list.push(open);
    return list;
  }, [place, placeLookup, detailPath, entries]);

  const chips = useMemo(
    () => resolveChips(autoChips, dismissed, added),
    [autoChips, dismissed, added],
  );
  const attachedIds = useMemo(() => chips.map(chipId), [chips]);
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
  // M50.4: a page you are standing on IS the active note. Only the record
  // peek used to count, so beside an open doc or concept the agent got the
  // path as a sentence and none of what Knowledge holds about it.
  const activePath =
    activeChipPath ?? (contextSelection?.kind === 'doc' ? contextSelection.path : null);
  const activeEntry = useMemo(
    () => (activePath === null ? null : (entries.find((e) => e.path === activePath) ?? null)),
    [activePath, entries],
  );

  // Context is a system-prompt suffix, not a hidden first message: it must
  // travel with every turn, because a resumed session re-reads it.
  const snapshot = useMemo(
    () =>
      buildSnapshot({
        selection: contextSelection ?? undefined,
        entries,
        schema,
        activePath,
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
        // Where this conversation began, when the user has since walked. Given
        // to the agent as a FACT rather than turned into a question for the
        // user — it already has the transcript, so "we were on the Roadmap and
        // you are now in the Inbox" is a sentence it can act on.
        startedIn: conversations.startedElsewhere,
        // M17.20: the bundle reaches the turn, by `about:` anchor and (M52.3)
        // by `sources`. Derived here rather than inside buildSnapshot so the
        // O(entries) pass is memoized with the rest of the prompt instead of
        // running per render.
        concepts,
      }),
    // `draft` is deliberately excluded: rebuilding the prompt on every
    // keystroke would thrash, and `send` reads the references it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      contextSelection,
      entries,
      schema,
      activePath,
      collection?.entries,
      activeView,
      recordChips,
      conversations.startedElsewhere,
      concepts,
    ],
  );
  // A composer, not a string (M54.7): the chat hook knows what a turn holds
  // only once its skill and its recipient have narrowed it, and calls this
  // with that grant, so the prompt names only tools the turn can call.
  const composeSystemPrompt = useMemo(
    () => (grant: PromptGrant) =>
      buildSystemPrompt(contextSelection ?? { kind: 'none' }, {
        connectors,
        issuePrefixes,
        skills,
        // M34.1.3: the human-facing assistant keeps the OKF contract — the
        // capability exists so OTHER agents stop inheriting it, not to take
        // it from the panel.
        capabilities: ['knowledge'],
        grant,
      }) + renderSnapshot(snapshot),
    [connectors, issuePrefixes, skills, contextSelection, snapshot],
  );
  // M50.4: what Knowledge the turn carries, shown with the other context —
  // an answer that leaned on a concept should be traceable to it. M52.4: the
  // chip counts what STANDS, as the page's own strip does; a replaced concept
  // still travels (the agent must not quote it as current) and is listed
  // last, marked as replaced.
  const contextKnowledge = snapshot.knowledge ?? [];
  const standing = contextKnowledge.filter((k) => k.supersededBy === undefined);
  const replaced = contextKnowledge.filter((k) => k.supersededBy !== undefined);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const suggestions = useMemo(
    () =>
      pageSuggestions(
        activeEntry,
        activeEntry !== null && isKnowledgePath(activeEntry.path)
          ? (concepts.find((c) => c.entry.path === activeEntry.path) ?? null)
          : null,
      ),
    [activeEntry, concepts],
  );
  // Handed to the chat hook through a ref rather than an argument — see
  // getTurn above. Assigned during render, like every other latest-value ref
  // in this codebase. The run list files a task under where the CONVERSATION
  // started, so it stays findable under what it was about rather than moving
  // to wherever the agent's own `open_note` left the user.
  turnRef.current = {
    systemPrompt: composeSystemPrompt,
    place: conversations.active?.place ?? place,
    conversationId: conversations.activeId,
    // M56.5: the conversation's pick, read at send like the rest.
    model: conversations.active?.model ?? null,
    effort: conversations.active?.effort ?? null,
    // M56.6: who answers when the turn names nobody, read at send.
    boundAgent,
  };

  // Every send goes through here so no path can leave a thread unanchored —
  // there are three (the composer, a suggestion chip, and a retry) plus the
  // handoffs and Up next below, and "remember to call anchorNow" at every
  // call site is a convention, not a guarantee. An Up next entry carries the
  // turn it was queued in (M57.5), and its thread was anchored by the turn it
  // waited behind, so it is not anchored again where the person stands now.
  const anchorNow = conversations.anchorNow;
  const chatSend = chat.send;
  const ask = useCallback(
    (
      text: string,
      message?: string | (() => Promise<string>),
      allowedTools?: string[] | null,
      turn?: TurnContext,
    ) => {
      if (turn === undefined) anchorNow();
      chatSend(text, message, allowedTools, turn);
    },
    [anchorNow, chatSend],
  );

  // M13.1: `/name …` expands to the skill's body — the transcript shows what
  // was typed, the agent gets the instructions. The expansion is a read, run
  // inside the turn for a send and at once for an Up next entry (M57.5), so
  // the entry keeps the skill as it was when it was queued; an unreadable
  // skill file falls back to sending the message as typed. A draft STARTING
  // with a space is the opt-out: sent literally, never expanded — the one way
  // to say `/weekly-review` to the agent as text. Shared by the composer and
  // an entry's editor.
  const resolveSkill = useCallback(
    (raw: string): SkillResolution => {
      const text = raw.trim();
      const invocation = raw.startsWith(' ') ? null : matchSkillInvocation(text, skills);
      if (invocation === null || vaultPath === null) {
        return { text, skill: null, expand: null, allowedTools: null };
      }
      const { skill, request } = invocation;
      return {
        text,
        skill: { path: skill.path },
        expand: () =>
          readNote(vaultPath, skill.path).then((body) => skillPrompt(skill, body, request)),
        // M17.8: a skill's `allowed-tools:` narrows THIS turn. Passed as data
        // to Rust, which intersects it with the granted policy — a vault file
        // may subtract from what Settings allowed and can never add to it.
        allowedTools: skill.allowedTools,
      };
    },
    [skills, vaultPath],
  );

  // M57.5: Up next, one queue per conversation. Text sent mid-turn waits
  // there, frozen in the context it was sent in, instead of being dropped.
  const upNext = useUpNext({
    chat,
    conversationId: conversations.activeId,
    vault: vaultPath,
    getTurn,
    resolve: resolveSkill,
    sendNow: ask,
  });
  const conversationIds = useMemo(
    () => conversations.conversations.map((c) => c.id),
    [conversations.conversations],
  );
  useEffect(() => {
    useUpNextStore.getState().prune(conversationIds);
    pruneDrafts(conversationIds);
  }, [conversationIds]);
  // An entry queued in another vault cannot run here: its context, its skill
  // and its session all belong to that vault.
  useEffect(() => {
    if (vaultPath !== null) useUpNextStore.getState().keepVault(vaultPath);
  }, [vaultPath]);

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

  // A prompt handed over from elsewhere in the app ("Ask to revise" on a
  // concept), oldest first, each taken into Up next once (M57.5): sent now
  // when the conversation is idle, queued behind its turn when it is not.
  const submitUpNext = upNext.submit;
  const startConversation = conversations.start;
  useEffect(() => {
    if (handoff === null) return;
    // M56.6: not before the panel's binding is read; this effect runs again
    // when it is.
    if (!bindingRead) return;
    // M56.3: a thread that cannot continue takes no handoff. A new
    // conversation opens first, and the handoff is delivered on the next pass.
    if (blocked !== null) {
      startConversation();
      return;
    }
    // M17.6: the handoff's SUBJECT becomes a context chip. Six call sites used
    // to hand over a prompt naming a record and drop the record itself, so the
    // agent was asked to revise a concept and handed whatever surface the user
    // happened to be standing on.
    //
    // Attaching is its own pass, ending with the subject consumed rather than
    // the whole handoff: the prompt is built from the chips DURING RENDER, so
    // sending or queueing in the same tick would freeze the context from
    // before the chip existed — the exact staleness M17.6 is about.
    if (handoff.subject !== null) {
      const chip = recordChip(handoff.subject, entries);
      markHandoffAttached(handoff.id);
      if (chip !== null) {
        const id = chipId(chip);
        setDismissed((prev) => prev.filter((d) => d !== id));
        setAdded((prev) => (prev.some((c) => chipId(c) === id) ? prev : [...prev, chip]));
      }
      return;
    }
    takeHandoff(handoff.id);
    // M52.3: a labelled handoff goes the way a suggestion does — the label is
    // the bubble and the thread's title, the prompt is what the agent reads.
    // A full Up next refuses it with one toast (useUpNext).
    void submitUpNext(
      handoff.label === null
        ? { text: handoff.text, handoff: true }
        : { text: handoff.label, prompt: handoff.text, handoff: true },
    );
  }, [
    bindingRead,
    blocked,
    entries,
    handoff,
    markHandoffAttached,
    startConversation,
    submitUpNext,
    takeHandoff,
  ]);

  // Enter sends when the conversation is idle and adds to Up next while it is
  // busy (M57.5); a full Up next keeps the draft and says why.
  const submit = () => {
    if (draft.trim() === '') return;
    if (upNext.submit({ text: draft }) !== 'full') {
      setDraft('');
      saveDraft(activeConversation, '');
    }
  };

  // M9.7: open the note and show its diff there, rather than stacking a
  // dialog over the panel that produced it. At the run's commit when there is
  // one (M58.3): the working tree is clean once the run commits. A turn's
  // commit opens with this conversation and its run, so notes left on its
  // lines come back here (M58.5).
  const viewDiff = (path: string, commit: string | null = null) => {
    openPath(path);
    const conversationId = conversations.activeId;
    if (commit === null || conversationId === null) {
      openDiff(path, commit);
      return;
    }
    const run = chat.messages
      .flatMap((m) => m.changesets ?? [])
      .find((c) => c.state === 'committed' && c.commit === commit);
    openDiff(path, commit, { conversationId, runId: run?.run_id ?? null });
  };

  const openTarget = (target: string) => {
    const entry = resolveTarget(target, entries);
    if (entry !== null) openPath(entry.path);
  };

  // M15: the failed turn's question is still in the transcript — retrying is
  // one click rather than retyping it from memory. The failed exchange stays
  // visible: it is what the error refers to.
  const retry = (assistantId: string) => {
    if (chat.busy()) return;
    const index = chat.messages.findIndex((m) => m.id === assistantId);
    const question = index > 0 ? chat.messages[index - 1] : undefined;
    if (question === undefined || question.role !== 'user') return;
    // A labelled ask retries its prompt, not its label (M52.4).
    ask(question.text, question.prompt);
  };

  // M56.4: the fixes a failure card offers; choose_model opens the
  // composer's picker (M56.5).
  const noticeActions = {
    open_settings: () => {
      setSettingsFocus('claude-code');
      navigate({ kind: 'settings' });
    },
    new_conversation: conversations.start,
    choose_model: () => setRunOptionsOpen(true),
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
      // `relative` hosts the drag handle. `flex-none`: beside a record the
      // RECORD gives ground, never this (M52). `max-w-full` is what makes it
      // give at all, against the frame App draws it in — the slot, less the
      // record's floor when there is one. A class, not a style, so the frame
      // can lift it when it parks the panel (shellLayout `SHELL_CLASSES`).
      // CSS, so it gives in the same layout pass as the window — sized from
      // a measurement it was a frame late, and for that frame the slot's
      // overflow cut off Send and the close button (M15 layout contract).
      className="relative flex min-w-0 max-w-full flex-none flex-col border-l border-n-200 bg-n-0"
      style={{ width }}
    >
      <ResizeHandle
        label="Resize AI panel"
        side="left"
        width={drawn}
        preferred={width}
        min={AI_WIDTH_MIN}
        max={dragCeiling(room, AI_WIDTH_MAX)}
        onResize={setWidth}
      />
      <header className="flex flex-none items-center gap-2 border-b border-n-200 px-3 py-2">
        <Icon name="sparkles" size={14} color="var(--synapse-500)" />
        {/* M9.5: conversations are kept and named, so this is a switcher
            rather than a label beside a button that erased the transcript. */}
        <ConversationSwitcher state={conversations} />
        {vaultPath !== null && boundAgent !== null && (
          <PanelAgentLabel
            vaultPath={vaultPath}
            handle={boundAgent}
            entries={entries}
            streaming={chat.streaming}
            onOpen={openPath}
          />
        )}
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
        {conversations.transcript.state === 'unavailable' && (
          <TranscriptNotice
            reason={conversations.transcript.reason}
            retentionDays={conversations.transcript.retentionDays}
            detail={conversations.transcript.detail}
            cached={chat.messages.length > 0}
          />
        )}
        {chat.messages.length === 0 && conversations.transcript.state === 'reading' ? (
          <p data-testid="transcript-reading" className="m-0 pt-2 text-sm text-n-500">
            Reading the transcript…
          </p>
        ) : chat.messages.length === 0 && blocked !== null ? null : chat.messages.length === 0 ? (
          <div className="flex flex-col gap-2 pt-2">
            <p className="m-0 text-sm leading-[18px] text-n-500">
              {status?.installed === false
                ? 'Claude Code was not found on this machine. Install it and reopen cerebro.'
                : 'I can read and write this vault. What I learn goes into Knowledge, where you verify it.'}
            </p>
            {status?.installed !== false &&
              suggestions.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  data-testid="ai-suggestion"
                  onClick={() => ask(suggestion.asked ?? suggestion.label, suggestion.prompt)}
                  className="rounded-lg border border-n-200 bg-transparent px-2.5 py-1.5 text-left text-xs text-n-700 hover:border-n-300 hover:bg-n-25"
                >
                  {suggestion.label}
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
              history={historyOf(ready, isRepo)}
              onRetry={
                message.error !== undefined && blocked === null
                  ? () => retry(message.id)
                  : undefined
              }
              noticeActions={noticeActions}
              waitingToolId={
                chat.waiting && chat.interaction?.messageId === message.id
                  ? chat.interaction.card.tool_id
                  : null
              }
            />
          ))
        )}
        {/* M57.1: the call the turn waits on, after the last message. An
            ask-first agent's page write draws as a write card (M57.4); the
            agent's questions as InteractionCard's question card (M57.3); any
            other tool-approval ask (one that names its family, M57.2) as a
            permission card with This conversation; any other as M57.1's. */}
        {chat.interaction !== null &&
          (chat.interaction.card.kind === 'write' ? (
            <WriteApprovalCard interaction={chat.interaction} onAnswer={chat.answer} />
          ) : chat.interaction.card.kind !== 'question' && chat.interaction.card.family != null ? (
            <PermissionCard
              interaction={chat.interaction}
              onAnswer={chat.answer}
              vaultPath={vaultPath}
            />
          ) : (
            <InteractionCard interaction={chat.interaction} onAnswer={chat.answer} />
          ))}
        {chat.prLinks.length > 0 && <PrLinks links={chat.prLinks} />}
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
                  className="flex-none rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
                >
                  <Icon name="x" size={9} />
                </button>
              </span>
            ))}
            {/* M50.4 — the Knowledge this turn carries: the concepts about,
                or learned from, what is in context. Not removable on its own
                — it follows the chips above, and taking one of those out takes
                its knowledge with it. Opens to the concepts, each one a page. */}
            {standing.length > 0 && (
              <button
                type="button"
                data-testid="context-knowledge"
                aria-expanded={knowledgeOpen}
                onClick={() => setKnowledgeOpen(!knowledgeOpen)}
                className="inline-flex items-center gap-1 rounded-md border border-n-200 bg-n-25 px-1.5 py-0.5 text-2xs text-n-600 hover:border-n-300"
              >
                <Icon name="brain" size={10} color="var(--synapse-500)" />
                Knowledge · {standing.length}
              </button>
            )}
          </div>
        )}
        {knowledgeOpen && standing.length > 0 && (
          <ul
            data-testid="context-knowledge-list"
            className="m-0 mb-1.5 flex list-none flex-col gap-px p-0"
          >
            {[...standing, ...replaced].map((k) => (
              <li key={k.path}>
                <button
                  type="button"
                  onClick={() => openPath(k.path)}
                  className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-left text-2xs text-n-700 hover:bg-n-50"
                >
                  <Icon name="lightbulb" size={10} color="var(--n-400)" />
                  <span className="min-w-0 truncate">{k.title}</span>
                  {k.supersededBy !== undefined ? (
                    <span className="flex-none text-n-400">· replaced</span>
                  ) : (
                    k.review !== 'current' && (
                      <span className="flex-none text-n-400">· unreviewed</span>
                    )
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* M57.5: what this conversation holds for after its turn. */}
        <UpNext upNext={upNext} />
        <ReviewNotesDock
          vault={vaultPath}
          conversationId={conversations.activeId}
          blocked={blocked !== null}
          submit={upNext.submit}
          onOpenNote={(note) => {
            openPath(note.path);
            openDiff(note.path, note.commit, {
              conversationId: note.conversationId,
              runId: note.runId,
            });
          }}
        />
        {blocked !== null ? (
          <div data-testid="thread-blocked" className="flex flex-col items-start gap-2 px-1 py-1">
            <p className="m-0 text-xs leading-[17px] text-n-600">
              {blocked === 'elsewhere' ? BLOCKED_WORDS.elsewhere : BLOCKED_WORDS.gone}
            </p>
            <Button
              variant="primary"
              size="sm"
              icon="square-pen"
              testId="thread-start-new"
              onClick={conversations.start}
            >
              Start a new conversation
            </Button>
          </div>
        ) : (
          <>
            {/* M9.5: `[[` completes against the vault, and the note you name
              travels into the snapshot with its content rather than as a word
              the agent has to go searching for. */}
            <ChatInput
              autoFocus
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              // M17.6b: `@` attaches. A chip re-added on purpose beats an earlier
              // dismissal — see resolveChips.
              onAttach={(chip) => {
                const id = chipId(chip);
                setDismissed((prev) => prev.filter((d) => d !== id));
                setAdded((prev) => (prev.some((c) => chipId(c) === id) ? prev : [...prev, chip]));
              }}
              attached={attachedIds}
            />
            <div className="mt-1.5 flex items-center gap-2">
              {/* M56.5: the model Claude Code last reported answering, as the
                  fold named it, never the one asked for. */}
              {chat.model !== null && (
                <span
                  data-testid="turn-model"
                  className="max-w-[140px] flex-none truncate font-mono text-2xs text-n-500"
                  title={chat.model}
                >
                  {chat.model}
                </span>
              )}
              <span
                data-testid="composer-status"
                className="min-w-0 flex-1 truncate text-2xs text-n-400"
              >
                {chat.waiting
                  ? 'Waiting for your answer'
                  : chat.stopping
                    ? 'Stopping…'
                    : chat.streaming
                      ? 'Working… · Enter adds to Up next'
                      : 'Enter to send · [[ to reference a note'}
              </span>
              <RunOptionsPicker
                key={conversations.activeId}
                value={{
                  model: conversations.active?.model ?? null,
                  effort: conversations.active?.effort ?? null,
                }}
                onChange={(choice) => conversations.setRunOptions(conversations.activeId, choice)}
                open={runOptionsOpen}
                onOpenChange={setRunOptionsOpen}
                disabled={chat.streaming}
              />
              {chat.streaming || chat.stopping ? (
                <>
                  <IconButton
                    icon="list-plus"
                    label="Add to Up next"
                    size="sm"
                    disabled={draft.trim() === ''}
                    onClick={submit}
                  />
                  {/* Stop holds Up next until Resume (M57 Q23), then stops the
                      turn, which ends once its run's Done has come. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="square"
                    disabled={chat.stopping}
                    onClick={() => {
                      upNext.hold();
                      chat.stop();
                    }}
                  >
                    {chat.stopping ? 'Stopping…' : 'Stop'}
                  </Button>
                </>
              ) : (
                <Button variant="primary" size="sm" icon="send" onClick={submit}>
                  Send
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
