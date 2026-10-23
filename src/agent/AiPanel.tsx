import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { Button } from '@/components/ui/Button';
import { DrawerScrim } from '@/components/ui/DrawerScrim';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { Tooltip } from '@/components/ui/Tooltip';
import { Chat } from '@/components/ai/Chat';
import { Context } from '@/components/ai/Context';
import { useMergedRefs } from '@/components/ai/mergeRefs';
import { MessageScrollerItem } from '@/components/ai/MessageScroller';
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTools,
} from '@/components/ai/PromptInput';
import { Queue, QueueList, QueueSection, TodoQueueItem } from '@/components/ai/Queue';
import { Source, Sources } from '@/components/ai/Sources';
import { Suggestion, Suggestions } from '@/components/ai/Suggestion';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ai/Trace';
import { checkAgent } from '@/agent/agentIpc';
import { historyOf } from '@/agent/AiActionCard';
import { Arrival, Presence, useArrival, useDrawn } from '@/components/ui/motion';
import { Message, TurnCheckpoint } from '@/agent/ChatTurn';
import { ChatInput } from '@/agent/ChatInput';
import {
  copyIn,
  discardCopies,
  pendingFrom,
  sameSource,
  type FileSource,
  type PendingFile,
} from '@/agent/attachments';
import { buildSnapshot, extractReferences, renderSnapshot } from '@/agent/context';
import {
  chipId,
  fileChip,
  placeChip,
  recordChip,
  resolveChips,
  type ContextChip,
} from '@/agent/contextChips';
import { ConversationNavigation, ConversationSwitcher } from '@/agent/ConversationSwitcher';
import { ConversationRail } from '@/agent/rail/ConversationRail';
import { InteractionCard } from '@/agent/InteractionCard';
import { PermissionCard } from '@/agent/PermissionCard';
import { WriteApprovalCard } from '@/agent/WriteApprovalCard';
import { RunOptionsPicker } from '@/agent/RunOptionsPicker';
import { TranscriptNotice } from '@/agent/TranscriptNotice';
import { useConversations } from '@/agent/useConversations';
import { loadDraft, pruneDrafts, saveDraft } from '@/agent/drafts';
import { useAgentChat, type TurnContext } from '@/agent/useAgentChat';
import { useContextUse } from '@/agent/useContextUse';
import { composerFiles } from '@/agent/elements/attachments';
import { contextUsageOf } from '@/agent/elements/composerContext';
import { pageStarters, starterSend } from '@/agent/elements/composerStarters';
import { branchPoints } from '@/agent/elements/panelCheckpoints';
import { livePlan, type LivePlan } from '@/agent/elements/panelPlan';
import {
  PANEL_SOURCES_WORDS,
  pullRequestSources,
  turnKnowledge,
} from '@/agent/elements/panelSources';
import { UpNext } from '@/agent/UpNext';
import { ReviewNotesDock } from '@/agent/ReviewNotesDock';
import { useUpNext, type SkillResolution } from '@/agent/useUpNext';
import { useUpNextStore } from '@/stores/upNextStore';
import { type AgentStatus, type PrLink } from '@/agent/types';
import {
  listSkills,
  matchSkillInvocation,
  skillPrompt,
  type SkillNarrowing,
} from '@/engine/skills';
import { buildSystemPrompt } from '@/agent/systemPrompt';
import { describeAttachments } from '@/engine/attachments';
import type { PromptGrant } from '@/engine/toolGrant';
import { UNDO, undidWords } from '@/engine/undoPlan';
import { listAgents } from '@/engine/agents';
import { isPaused } from '@/engine/jobs';
import { isKnowledgePath, listConcepts } from '@/engine/okf';
import type { Entry } from '@/engine/types';
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
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useNavStore } from '@/stores/navStore';
import { chatRailDocks, dragCeiling, fitWidth } from '@/app/shellLayout';
import { AI_WIDTH_MAX, AI_WIDTH_MIN, useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import './chat.css';
import './panel-sources.css';

/**
 * The AI side panel (M6).
 *
 * A docked conversation with the local agent. Everything it can see or change
 * goes through cerebro's own MCP tools, so the panel shows the tool calls
 * inline: an agent that edits your vault should not do it invisibly.
 */

/** How long the composer waits after the last keystroke to save its draft. */
const DRAFT_SAVE_MS = 300;

/** What the composer says when a thread cannot continue (Q7). */
const BLOCKED_WORDS = {
  elsewhere: 'This conversation was had in another vault. Open that vault to continue it.',
  gone: "Claude Code no longer has this conversation, so it can't continue here.",
};

/** What the minimized button announces while its conversation's turn is
 * busy; the button itself shows it as a ring (working, stopping) or a dot
 * (waiting on the person). */
const BUSY_WORDS = {
  waiting: 'Waiting for your answer',
  stopping: 'Stopping…',
  working: 'Working…',
} as const;

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
      className="motion-hover min-w-0 truncate border-0 bg-transparent p-0 text-2xs text-n-600 hover:text-n-900"
    >
      {agent.title}
      {paused ? ' (paused)' : ''}
    </button>
  );
}

/**
 * The pull requests a conversation's session opened (M56.3), under its
 * thread, as Sources (M91.14): open from the start, since they are what the
 * session made. Each is a link that says it opens a new tab, and the shell's
 * link guard (M53.12) sends its https href to the browser; an address that
 * is not http(s) stays words (CV-16).
 */
function PrLinks({ links }: { links: PrLink[] }) {
  // Opened during a turn, or read back with the thread: it comes in either
  // way, once (components/ui/motion.ts).
  const arrival = useArrival(true);
  const sources = useMemo(() => pullRequestSources(links), [links]);
  return (
    <Sources
      data-testid="thread-pr-links"
      className="cb-chat-pr-links"
      sources={sources}
      title={PANEL_SOURCES_WORDS.pullRequests(sources.length)}
      icon="git-pull-request"
      defaultOpen
      {...arrival}
    />
  );
}

/**
 * The plan the turn at work follows (M91.12c, Q9), over the composer while
 * it works: its todo list as a Queue at the dock's scale, what is left open
 * with the step under way in the agent's own words, and what is done folded
 * under its count. The reply's own Plan line keeps the whole list in the
 * transcript; this is the glance at it from wherever the reader is.
 */
function DockPlan({
  plan,
  working,
  arrive,
}: {
  plan: LivePlan;
  /** The agent is at it now, not waiting on the person or stopping: the
   *  step under way carries the working light. */
  working: boolean;
  arrive: boolean;
}) {
  // A list may name one todo twice; its place in the list is its identity.
  const items = (todos: LivePlan['todo']) =>
    todos.map((todo, index) => <TodoQueueItem key={`${index}:${todo.content}`} todo={todo} />);
  return (
    <Arrival when={arrive}>
      <Queue
        isStreaming={working}
        className="cb-chat-plan"
        render={<section data-testid="live-plan" aria-label="Plan" />}
      >
        {plan.todo.length > 0 && (
          <QueueSection data-section="todo" label="to do" count={plan.todo.length} icon="list-todo">
            <QueueList>{items(plan.todo)}</QueueList>
          </QueueSection>
        )}
        {plan.done.length > 0 && (
          <QueueSection
            data-section="done"
            label="done"
            count={plan.done.length}
            icon="list-checks"
            defaultOpen={false}
          >
            <QueueList>{items(plan.done)}</QueueList>
          </QueueSection>
        )}
      </Queue>
    </Arrival>
  );
}

export function AiPanel({
  room = null,
  presentation = 'floating',
  onTogglePresentation,
  navigationTarget = null,
}: {
  /** The widest the shell can draw the panel, measured; null until it has. */
  room?: number | null;
  /** The shell keeps this same conversation mounted when it expands. */
  presentation?: 'floating' | 'panel' | 'canvas';
  onTogglePresentation?: () => void;
  /** Sidebar slot owned by the shell; the conversation state stays here. */
  navigationTarget?: HTMLElement | null;
} = {}) {
  const asideRef = useRef<HTMLElement>(null);
  // M92.1: the aside's width, which says whether the canvas rail docks. The
  // observer reports a presentation's width a frame after it is drawn, so
  // the width is kept with the presentation it was measured in.
  const [measureAside, asideWidth] = useMeasuredWidth();
  const asideRefs = useMergedRefs(asideRef, measureAside);
  const [measured, setMeasured] = useState({ width: asideWidth, presentation });
  if (measured.width !== asideWidth) setMeasured({ width: asideWidth, presentation });
  // M92.1: the canvas rail's own state (see "Conversation details", below).
  const railPreference = useUiStore((s) => s.chatRailOpen);
  const setRailPreference = useUiStore((s) => s.setChatRailOpen);
  const railRequest = useUiStore((s) => s.chatRailRequest);
  const toggleChatRail = useUiStore((s) => s.toggleChatRail);
  const [railDrawer, setRailDrawer] = useState(false);
  const [railOpened, setRailOpened] = useState(false);
  const [railFocus, setRailFocus] = useState(0);
  const railId = useId();
  const railHeadingRef = useRef<HTMLHeadingElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  // Drawn once: from here on, a control or a block that comes into the
  // panel arrives (chat.css); what it opened with is simply there.
  const onScreen = useDrawn();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const blockedRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const setAiPanelPresentation = useUiStore((s) => s.setAiPanelPresentation);
  const setAiPanelMinimized = useUiStore((s) => s.setAiPanelMinimized);
  const minimizedPreference = useUiStore((s) => s.aiPanelMinimized);
  const minimized = presentation === 'floating' && minimizedPreference;
  const expand = () => setAiPanelMinimized(false);
  const minimize = () => {
    if (presentation !== 'floating') setAiPanelPresentation('floating');
    setAiPanelMinimized(true);
  };
  // Minimized, the conversation is one round button and everything else is
  // hidden but mounted. Folding hands focus to that button when the panel
  // held it (Minimize, Escape, ⌘J from the composer) or nothing did, never
  // when the person is elsewhere on the page, and never at mount: the
  // assistant starts minimized and must not take focus from the page.
  const wasMinimized = useRef(minimized);
  // Whether one of the panel's own popovers (its options, the model picker,
  // the context list) is open: those portal out of the aside, and focus in
  // them is still the panel's. Written each render, below their state.
  const popoverOpen = useRef(false);
  // Focus the fold placed is not a person arriving on the button, so its
  // tooltip waits for a hover or the next focus: a fold never puts a bubble
  // up that takes the next Escape (the drawer toggles' rule, M52).
  const [quietTip, setQuietTip] = useState(false);
  useEffect(() => {
    const folded = minimized && !wasMinimized.current;
    wasMinimized.current = minimized;
    if (!folded) return;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      asideRef.current?.contains(active) ||
      popoverOpen.current
    ) {
      setQuietTip(true);
      fabRef.current?.focus({ preventScroll: true });
    }
  }, [minimized]);
  const shell = useUiStore((s) => s.agentShell);
  // M57.7: Web access, the second ceiling; the chat hook caps it by the
  // addressed or bound agent's record and hands the prompt its grant.
  const web = useUiStore((s) => s.agentWebAccess);
  // M91.2d: the Subagents switch, which every turn sends as it stands; Rust
  // still denies the tool to a record whose narrowing leaves it out.
  const delegate = useUiStore((s) => s.agentDelegate);
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
  // M15: the panel is resizable like every other panel in the shell. The
  // stored width is the one it keeps beside a record; it gives only once the
  // record has given all it can (app/shellLayout.ts). `drawn` is that width
  // as measured, for the drag handle — CSS is what draws it.
  const width = useUiStore((s) => s.aiPanelWidth);
  const setWidth = useUiStore((s) => s.setAiPanelWidth);
  const drawn = room === null ? width : fitWidth(width, room);

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
  const chat = useAgentChat(getTurn, { shell, web, delegate, connectors });
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
  // A minimized composer has no box, so a draft loaded while it was hidden (a
  // thread restored at launch) was sized to nothing. Size it again in the
  // frame it is drawn, so a long draft does not open one line high.
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (minimized || input === null) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [minimized]);
  useEffect(() => {
    // The canvas is a destination, including when this same mounted panel
    // expands or changes thread. Docking must leave page navigation's focus alone.
    if (presentation === 'canvas' || (presentation === 'floating' && !minimized)) {
      (composerRef.current ?? blockedRef.current)?.focus({ preventScroll: true });
    }
  }, [presentation, minimized, activeConversation]);
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
  const [conversationOptionsOpen, setConversationOptionsOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  popoverOpen.current = runOptionsOpen || conversationOptionsOpen || contextOpen;
  const conversationOptionsRef = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setConversationOptionsOpen(false);
    setContextOpen(false);
    setRunOptionsOpen(false);
  }, [minimized, presentation, conversations.activeId]);
  // M91.12a: how full this conversation's context window is, beside the
  // picker. Pulled when its session opens and when a turn ends (M91.5);
  // shown, never kept (Q7).
  const contextUse = contextUsageOf(useContextUse(chat.sessionId, { streaming: chat.streaming }));

  // --- Context chips (M17.6) ------------------------------------------------
  //
  // What the agent is being told about, as things on screen rather than as a
  // derivation nobody can see. `dismissed` and `added` are per-conversation:
  // switching threads must not carry one thread's attachments into another's.
  // They are cleared in the render that shows the new thread, before any of
  // its effects, so a handoff's subject attached to the thread it has just
  // opened is never cleared after it.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [added, setAdded] = useState<ContextChip[]>([]);
  // M91.17: files from outside the vault, waiting to be copied in when the
  // message is sent; per conversation, like the chips.
  const [pending, setPending] = useState<PendingFile[]>([]);
  const activeId = conversations.activeId;
  const [chipsOf, setChipsOf] = useState(activeId);
  if (chipsOf !== activeId) {
    setChipsOf(activeId);
    setDismissed([]);
    setAdded([]);
    setPending([]);
  }

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
  // M91.17: a file chip is drawn on the composer, as an Attachment; the
  // context list and its summary carry the places and records.
  const contextChips = useMemo(
    () => chips.filter((c): c is Exclude<ContextChip, { kind: 'file' }> => c.kind !== 'file'),
    [chips],
  );
  const filePaths = useMemo(
    () => chips.flatMap((c) => (c.kind === 'file' ? [c.path] : [])),
    [chips],
  );
  const files = useMemo(() => composerFiles(chips, pending), [chips, pending]);
  const removeChip = (chip: ContextChip) => {
    const id = chipId(chip);
    setAdded((prev) => prev.filter((c) => chipId(c) !== id));
    setDismissed((prev) => (prev.includes(id) ? prev : [...prev, id]));
    if (contextOpen && chip.kind !== 'file' && contextChips.length === 1) {
      setContextOpen(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  };
  // Attached on purpose: a chip re-added beats an earlier dismissal — see
  // resolveChips.
  const addChips = (next: readonly ContextChip[]) => {
    const ids = new Set(next.map(chipId));
    setDismissed((prev) => prev.filter((d) => !ids.has(d)));
    setAdded((prev) => [
      ...prev,
      ...next.filter((c) => !prev.some((p) => chipId(p) === chipId(c))),
    ]);
  };

  // M91.17: files from outside the vault wait on the composer until the
  // message is sent, which copies them in through the attachment doors.
  // Anything refused on the way in is named, and never waits. Guarded by the
  // vault and the conversation they were attached in: an answer that comes
  // back after either changed attaches nothing.
  const captureThread = useVaultActionGuard(`${vaultPath ?? ''}\u0000${activeId ?? ''}`);
  const toast = useUiStore((s) => s.toast);
  const attachFiles = (sources: readonly FileSource[]) => {
    if (sources.length === 0) return;
    const current = captureThread();
    void pendingFrom(sources).then(({ files: waiting, skipped }) => {
      if (!current()) return;
      if (waiting.length > 0) {
        // Once each, against what already waits and within the batch.
        setPending((prev) =>
          waiting.reduce(
            (held, file) => (held.some((h) => sameSource(h, file)) ? held : [...held, file]),
            prev,
          ),
        );
      }
      if (skipped.length > 0) toast(`Skipped ${skipped.join(', ')}`);
    });
  };
  const removeFile = (id: string) => {
    const chip = chips.find((c) => chipId(c) === id);
    if (chip !== undefined) removeChip(chip);
    else setPending((prev) => prev.filter((file) => file.id !== id));
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  // At most one place chip, so "where this conversation is" stays singular and
  // everything downstream — the rows, the filters, the system prompt's one
  // "you are looking at" line — has a single answer. Removing it means the
  // agent is told nothing about where anyone is standing, which is a real and
  // useful thing to be able to say.
  const contextPlace = contextChips.find((c) => c.kind === 'place')?.place ?? null;
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
        // M91.17: the attached files, by vault path and kind.
        files: filePaths,
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
      filePaths,
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
        // M91.17: what opens each attached file, said for this grant.
        attachments: filePaths,
      }) + renderSnapshot(snapshot),
    [connectors, issuePrefixes, skills, contextSelection, snapshot, filePaths],
  );
  // M50.4: what Knowledge the turn carries, shown with the other context —
  // an answer that leaned on a concept should be traceable to it. M52.4: its
  // line counts what STANDS, as the page's own strip does; a replaced concept
  // still travels (the agent must not quote it as current) and is listed
  // last, marked as replaced (elements/panelSources.ts).
  const knowledge = useMemo(() => turnKnowledge(snapshot.knowledge ?? []), [snapshot.knowledge]);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const starters = useMemo(
    () =>
      pageStarters(
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

  // What a send appends arrives (chat.css): every message from the first one
  // a send adds to this conversation. What the thread opened with, or was
  // read back into, does not. Every send comes through `ask`, below, so it is
  // the one place that knows a message is new rather than restored. A thread
  // opened again starts with none, so nothing in it replays.
  const [arrivals, setArrivals] = useState<{ conversation: string; from: number } | null>(null);
  if (arrivals !== null && arrivals.conversation !== conversations.activeId) setArrivals(null);
  const sentFrom = useRef(0);
  sentFrom.current = chat.messages.length;

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
      narrowing?: SkillNarrowing,
      turn?: TurnContext,
    ) => {
      if (turn === undefined) anchorNow();
      const conversation = turnRef.current.conversationId;
      const from = sentFrom.current;
      if (conversation !== null) {
        setArrivals((prev) =>
          prev?.conversation === conversation ? prev : { conversation, from },
        );
      }
      chatSend(text, message, narrowing, turn);
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
        return { text, skill: null, expand: null, narrowing: {} };
      }
      const { skill, request } = invocation;
      return {
        text,
        skill: { path: skill.path },
        expand: () =>
          readNote(vaultPath, skill.path).then((body) => {
            const now = new Date();
            return skillPrompt(skill, body, request, {
              now,
              offsetMinutes: now.getTimezoneOffset(),
            });
          }),
        // The invoked skill bounds this turn, including a turn queued for later.
        narrowing: {
          allowedTools: skill.allowedTools,
          connectors: skill.connectors,
          disallowedTools: skill.disallowedTools,
        },
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

  // ⌘J is "talk to the assistant", so it has to open something you can type
  // into; and closing it must not drop focus to <body> (M15). The opener has
  // to be read before the composer's autoFocus fires, which is why this is a
  // render-time capture and not an effect (PR #7 review).
  useFocusRestore();

  // A prompt handed over from elsewhere in the app ("Ask to revise" on a
  // concept, a Knowledge ask, Quick Open's Ask), oldest first, each in a
  // conversation of its own: the active one while nothing has happened in it,
  // a new one otherwise. A turn running in the thread it leaves goes on
  // detached (M57.6), never stopped.
  const submitUpNext = upNext.submit;
  const startConversation = conversations.start;
  const threadReady = conversations.ready;
  const record = conversations.active;
  // Nothing has happened in it: no message, session or turn in the chat hook
  // or in the thread's stored record, and nothing waiting in its Up next.
  const untouched =
    chat.messages.length === 0 &&
    chat.sessionId === null &&
    chat.live === null &&
    !chat.streaming &&
    upNext.entries.length === 0 &&
    (record === null ||
      (record.messages.length === 0 && record.sessionId === null && record.live == null));
  // A send still parked before its run starts: leaving the thread now would
  // cancel it (useAgentChat's send epoch), so the next handoff waits for the
  // run, or for the send to fail. A card the turn waits on is left waiting.
  const parked = chat.streaming && chat.live === null && !chat.waiting;
  useEffect(() => {
    if (handoff === null) return;
    // M56.6: not before the panel's binding is read; this effect runs again
    // when it is.
    if (!bindingRead) return;
    // Nor before the stored thread is in the chat hook: whether it is empty
    // is not known until then.
    if (!threadReady) return;
    // A thread with anything in it takes no handoff, and neither does one
    // that cannot continue (M56.3). A new conversation opens first, and the
    // handoff is delivered on the next pass, into it.
    if (blocked !== null || !untouched) {
      if (!parked) startConversation();
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
    // The thread is idle and empty, so Up next sends it at once.
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
    parked,
    startConversation,
    submitUpNext,
    takeHandoff,
    threadReady,
    untouched,
  ]);

  // Enter sends when the conversation is idle and adds to Up next while it is
  // busy (M57.5); a full Up next keeps the draft and says why.
  const sendDraft = () => {
    if (upNext.submit({ text: draft }) !== 'full') {
      setDraft('');
      saveDraft(activeConversation, '');
    }
  };

  // M91.17: a message with files from outside the vault copies them in
  // first, as one batch through the attachment doors, and goes once they are
  // chips naming their vault paths — on the render after, since the turn's
  // prompt is built from the chips during render (the handoff's two passes,
  // above). A copy that fails sends nothing and keeps the draft: what was
  // copied before it stays attached, and the file that failed says why. A
  // send that made new copies says so, with one Undo that moves them all to
  // the Trash.
  const [copyingIn, setCopyingIn] = useState<{ conversation: string | null } | null>(null);
  const copying = copyingIn !== null && copyingIn.conversation === activeId;
  const [outbox, setOutbox] = useState<{ conversation: string | null } | null>(null);
  const sendNext = useRef(sendDraft);
  sendNext.current = sendDraft;
  useEffect(() => {
    if (outbox === null) return;
    setOutbox(null);
    if (outbox.conversation === activeId) sendNext.current();
  }, [outbox, activeId]);

  const undoCopies = (vault: string, paths: readonly string[], label: string) => {
    if (useVaultStore.getState().vaultPath !== vault) {
      toast('Nothing was undone: the vault those files went to is no longer open.');
      return;
    }
    void discardCopies(vault, paths).then(({ moved, failed }) => {
      setAdded((prev) => prev.filter((c) => c.kind !== 'file' || !moved.includes(c.path)));
      toast(failed === null ? undidWords(label) : `${undidWords(label)}. ${failed}`);
    });
  };

  const copyThenSend = () => {
    if (vaultPath === null) {
      toast('Nothing was sent — the vault is still opening.');
      return;
    }
    const vault = vaultPath;
    const conversation = activeId;
    const batch = pending;
    const ids = new Set(batch.map((file) => file.id));
    const current = captureThread();
    setCopyingIn({ conversation });
    setPending((prev) =>
      prev.map((file) =>
        ids.has(file.id) ? { ...file, state: 'copying', reason: undefined } : file,
      ),
    );
    void copyIn(vault, batch, current).then((outcome) => {
      setCopyingIn((prev) => (prev?.conversation === conversation ? null : prev));
      const line = describeAttachments(outcome.copied, []);
      if (!current()) {
        // Only this batch's chips, wherever they still are: another copy may
        // be under way in the conversation now shown.
        setPending((prev) =>
          prev.map((file) =>
            ids.has(file.id) && file.state === 'copying' ? { ...file, state: 'waiting' } : file,
          ),
        );
        if (outcome.copied.length > 0) {
          toast(`${line}. The conversation changed first, so nothing was sent.`);
        }
        return;
      }
      const copied = new Set(outcome.copied.map((file) => file.id));
      const failed = outcome.kind === 'failed' ? outcome.failed : null;
      setPending((prev) =>
        prev
          .filter((file) => !copied.has(file.id))
          .map((file) =>
            file.id === failed?.id
              ? { ...file, state: 'failed', reason: failed.reason }
              : file.state === 'copying'
                ? { ...file, state: 'waiting' }
                : file,
          ),
      );
      addChips(outcome.copied.map((file) => fileChip(file.path)));
      if (failed !== null) {
        const name = batch.find((file) => file.id === failed.id)?.label ?? 'a file';
        toast(`Couldn't add ${name} — ${failed.reason}. Nothing was sent.`);
        return;
      }
      setOutbox({ conversation });
      const fresh = outcome.copied.filter((file) => !file.reused).map((file) => file.path);
      if (fresh.length > 0) {
        toast(line, { action: { label: UNDO, run: () => undoCopies(vault, fresh, line) } });
      }
    });
  };

  const submit = () => {
    if (draft.trim() === '' || copying) return;
    if (pending.length > 0) copyThenSend();
    else sendDraft();
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

  // Message is memoized (ChatTurn): it gets stable handlers that call this
  // render's, so a streamed delta or a keystroke redraws no earlier turn.
  // Assigned during render, like every other latest-value ref here.
  const turnHandlersRef = useRef({ openTarget, openPath, viewDiff, retry, noticeActions });
  turnHandlersRef.current = { openTarget, openPath, viewDiff, retry, noticeActions };
  const turnHandlers = useMemo(() => {
    const current = () => turnHandlersRef.current;
    return {
      openTarget: (target: string) => current().openTarget(target),
      openPath: (path: string) => {
        current().openPath(path);
      },
      viewDiff: (path: string, commit: string | null) => current().viewDiff(path, commit),
      retry: (messageId: string) => current().retry(messageId),
      noticeActions: {
        open_settings: () => current().noticeActions.open_settings(),
        new_conversation: () => current().noticeActions.new_conversation(),
        choose_model: () => current().noticeActions.choose_model(),
      },
    };
  }, []);

  // M91.12c: Branch from here, between turns, where the thread can still be
  // branched (elements/panelCheckpoints.ts).
  const branches = useMemo(
    () => branchPoints(chat.messages, { blocked, transcript: conversations.transcript }),
    [chat.messages, blocked, conversations.transcript],
  );
  // The new conversation holds the thread up to the reply and opens in its
  // place (M91.6); a refusal has said why in a toast (CV-03). The marker
  // goes with the thread it was in, so the new one's composer takes focus.
  const branchFromReply = (messageId: string) => {
    if (conversations.branchFrom(conversations.activeId, messageId) === null) return;
    requestAnimationFrame(() =>
      (composerRef.current ?? blockedRef.current)?.focus({ preventScroll: true }),
    );
  };

  // A card that stops waiting (answered, or settled elsewhere) leaves with
  // the button that held focus; a keyboard user would be left on <body>,
  // outside the aside's Escape. Hand focus to the composer, but only when
  // nothing else has it.
  const waitingCard = chat.interaction?.card.id ?? null;
  const lastWaitingCard = useRef(waitingCard);
  useEffect(() => {
    const had = lastWaitingCard.current;
    lastWaitingCard.current = waitingCard;
    if (had === null || waitingCard !== null) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      composerRef.current?.focus({ preventScroll: true });
    }
  }, [waitingCard]);

  // M91.12c: the plan the turn at work follows, over the composer.
  const plan = useMemo(
    () => livePlan(chat.messages, chat.streaming),
    [chat.messages, chat.streaming],
  );

  const addContext = () => {
    setDraft((text) => `${text}${text !== '' && !/\s$/.test(text) ? ' ' : ''}@`);
    requestAnimationFrame(() => {
      const input = composerRef.current;
      if (input === null) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  // Until the chat hook holds the stored thread (`ready`), the thread is
  // known to hold nothing only when its stored record does.
  const known =
    conversations.ready ||
    (record !== null &&
      record.messages.length === 0 &&
      record.sessionId === null &&
      record.live == null);
  const reading = chat.messages.length === 0 && conversations.transcript.state === 'reading';
  // M91.12c: a thread with nothing in it — no message and no card — shows
  // the empty state in its transcript's place. One still being restored or
  // read is not known to be empty: it keeps its Message Scroller, the
  // reading line in it until its rows come.
  const opening = known && chat.messages.length === 0 && chat.interaction === null && !reading;
  const welcoming = opening && blocked === null && !chat.streaming;

  // --- Conversation details (M92.1) ------------------------------------------
  //
  // In the canvas, a rail of the conversation's details beside its
  // transcript: the aside's third grid area, so the header, the transcript and
  // the composer keep their parents (chat.css). It docks where the canvas has
  // room, as `cerebro.chatRailOpen` says. Where it has not, it folds away,
  // and a person opens it as a drawer over the transcript for the session,
  // never writing the preference; a drawer belongs to the fold it opened
  // over, so it closes once the rail fits again (DocPage's rule). CSS draws
  // docked, folded and drawer in the same layout pass as the frame's width
  // (`@container chat-canvas`), so a resize across the dock width never
  // remounts it; the width React measures says, a frame on, what CSS cannot:
  // that a folded rail is inert, what the toggle says and does, and where
  // focus goes (M52, as the parked assistant). Turned off, and while the
  // conversation welcomes unless the person opened it this session (Q7:
  // nothing speaks first), it is unmounted, and reads nothing.
  const canvas = presentation === 'canvas';
  const railFits =
    canvas && measured.presentation === 'canvas' ? chatRailDocks(measured.width) : null;
  if (railDrawer && (!canvas || railFits === true)) setRailDrawer(false);
  const railShown = canvas && (railPreference || railDrawer) && (!welcoming || railOpened);
  const railInDrawer = railShown && railDrawer;
  const railFolded = railShown && !railDrawer && railFits === false;
  const railVisible = railShown && !railFolded;
  // Whether the rail docks at the aside's width now. Read from layout as a
  // person asks, since the observer's width comes a frame after a
  // presentation is drawn; with no box to read (jsdom), it is the observer's.
  const railFitsNow = () => {
    const width = asideRef.current?.getBoundingClientRect().width ?? 0;
    return width > 0 ? chatRailDocks(width) : railFits;
  };
  // Opening docks the rail, by the preference, where it fits, and opens the
  // drawer where it does not; either way the person lands on its heading.
  const showRail = () => {
    setRailOpened(true);
    setRailFocus((asks) => asks + 1);
    if (railFitsNow() === false) setRailDrawer(true);
    else if (!railPreference) setRailPreference(true);
  };
  const hideRail = () => {
    // Focus in the rail goes back to the toggle that names it, never to <body>.
    if (document.getElementById(railId)?.contains(document.activeElement) === true) {
      railToggleRef.current?.focus({ preventScroll: true });
    }
    if (railDrawer) setRailDrawer(false);
    else setRailPreference(false);
  };
  const toggleRail = () => (railVisible ? hideRail() : showRail());
  // ⌥⌘R and floating's "Expand with conversation details" ask through the
  // store (`toggleChatRail`), which cannot know whether the rail fits; the
  // panel answers in layout, so the rail is drawn in the frame it was asked
  // for. Read through a ref, like the turn handlers above.
  const railAsk = useRef({ show: showRail, hide: hideRail, shown: railVisible });
  railAsk.current = { show: showRail, hide: hideRail, shown: railVisible };
  useLayoutEffect(() => {
    if (railRequest === null || !canvas) return;
    const ask = useUiStore.getState().takeChatRailRequest();
    if (ask === null) return;
    if (ask === 'toggle' && railAsk.current.shown) railAsk.current.hide();
    else railAsk.current.show();
  }, [railRequest, canvas]);
  // After the canvas's own focus on the composer, which runs first.
  useEffect(() => {
    if (railFocus > 0) railHeadingRef.current?.focus({ preventScroll: true });
  }, [railFocus]);
  // A rail row's primary action stays in the canvas (ConversationRail).
  const jumpFromRail = useCallback((go: () => void) => {
    setRailDrawer(false);
    go();
  }, []);

  const notice =
    conversations.transcript.state === 'unavailable' ? (
      <TranscriptNotice
        reason={conversations.transcript.reason}
        retentionDays={conversations.transcript.retentionDays}
        detail={conversations.transcript.detail}
        cached={chat.messages.length > 0}
        arrive
      />
    ) : null;
  const readingLine = (
    <p data-testid="transcript-reading" className="cb-working-text m-0 pt-2 text-sm text-n-500">
      Reading the transcript…
    </p>
  );

  const contextContents = (
    <div className="cb-chat-context" data-testid="chat-context">
      {/* M17.6: what the agent is being told about, as things rather than as
            a derivation. Removable, because the most useful thing a context
            control can do is take something OUT — an answer about the wrong
            record reads as the model being stupid until you can see that the
            app handed it the wrong page. A file is drawn on the composer
            instead, as an Attachment (M91.17). */}
      {contextChips.length > 0 && (
        <div
          data-testid="context-chips"
          className="mb-1.5 flex flex-wrap items-center gap-1"
          aria-label="Context"
        >
          {contextChips.map((chip) => (
            <Arrival key={chipId(chip)} when={onScreen}>
              <span
                data-testid="context-chip"
                data-kind={chip.kind}
                className="cb-chat-chip inline-flex max-w-full items-center gap-1 rounded-md border border-n-200 bg-n-25 py-0.5 pl-1.5 pr-0.5 text-2xs text-n-600"
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
                  className="motion-hover flex-none rounded-xs border-0 bg-transparent p-0.5 text-n-400 hover:text-n-800"
                >
                  <Icon name="x" size={9} />
                </button>
              </span>
            </Arrival>
          ))}
        </div>
      )}
      {/* M50.4 — the Knowledge this turn carries: the concepts about, or
            learned from, what is in context, as Sources (M91.14): one line
            that opens onto them, each a page the app opens. Not removable on
            its own — it follows the chips above, and taking one of those out
            takes its knowledge with it. */}
      {contextChips.length > 0 && knowledge.count > 0 && (
        <TraceCollapsible
          data-slot="sources"
          className="cb-chat-knowledge"
          open={knowledgeOpen}
          onOpenChange={setKnowledgeOpen}
        >
          <TraceCollapsibleTrigger data-testid="context-knowledge">
            <TraceLine>
              <TraceIcon>
                <Icon name="brain" size={16} color="var(--synapse-500)" />
              </TraceIcon>
              <TraceTitle>{PANEL_SOURCES_WORDS.knowledge(knowledge.count)}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent keepMounted>
            <Trace data-slot="sources-list" data-testid="context-knowledge-list">
              {knowledge.rows.map((row) => (
                <Source
                  key={row.ref.path}
                  source={row.ref}
                  description={row.standing}
                  onOpenPath={(path) => openPath(path)}
                />
              ))}
            </Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )}
    </div>
  );
  const floating = presentation === 'floating';
  const contextLabel = contextChips.map((chip) => chip.label).join(', ');
  const busy = chat.waiting
    ? 'waiting'
    : chat.stopping
      ? 'stopping'
      : chat.streaming
        ? 'working'
        : undefined;

  return (
    <aside
      ref={asideRefs}
      aria-label="AI panel"
      data-testid="ai-panel"
      data-presentation={presentation}
      data-minimized={minimized || undefined}
      data-working={chat.streaming || chat.stopping || undefined}
      onKeyDown={(event) => {
        // Child completion/option popovers own Escape in capture first.
        // This nonmodal companion only takes a key from its own DOM, never
        // one from the page or a React-bubbled portalled control.
        if (
          presentation === 'floating' &&
          !minimized &&
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.preventDefault();
          event.stopPropagation();
          minimize();
        }
      }}
      // `relative` hosts the drag handle, and in the canvas the rail's drawer
      // and its scrim. A column, which the canvas draws as a grid of header,
      // transcript and rail instead (chat.css, M92.1). `flex-none`: beside a
      // record the RECORD gives ground, never this (M52). `max-w-full` is
      // what makes it give at all, against the frame App draws it in — the
      // slot, less the record's floor when there is one. A class, not a
      // style, so the frame can lift it when it parks the panel (shellLayout
      // `SHELL_CLASSES`). CSS, so it gives in the same layout pass as the
      // window — sized from a measurement it was a frame late, and for that
      // frame the slot's overflow cut off Send and the close button (M15
      // layout contract).
      className="cb-chat relative flex min-w-0 max-w-full flex-col"
      style={{ width: presentation === 'panel' ? width : '100%' }}
    >
      {/* Minimized, the conversation rests as one round button over the
          page. It says what the turn is doing, a ring while it works and a
          dot while it waits on the person, and opens the same thread, draft
          and pending cards, all still mounted under the hidden body. */}
      {minimized && (
        <>
          <Tooltip label="Open conversation" command="assistant.toggle" disabled={quietTip}>
            <button
              ref={fabRef}
              type="button"
              // WebKit leaves a native button with no explicit tab stop out of
              // the Tab order (the rail's rule, AppRail).
              tabIndex={0}
              className="cb-chat-fab"
              data-testid="ai-panel-fab"
              data-state={busy}
              aria-expanded={false}
              aria-label={blocked !== null ? 'Open unavailable conversation' : 'Open conversation'}
              onClick={expand}
              onPointerEnter={() => setQuietTip(false)}
              onBlur={() => setQuietTip(false)}
            >
              <Icon name="sparkles" size={22} />
              {busy === 'waiting' ? (
                <span className="cb-chat-fab-dot" aria-hidden="true" />
              ) : (
                busy !== undefined && (
                  <span className="cb-chat-fab-ring animate-spin" aria-hidden="true" />
                )
              )}
            </button>
          </Tooltip>
          <span className="sr-only" role="status">
            {busy === undefined ? '' : BUSY_WORDS[busy]}
          </span>
        </>
      )}
      {presentation === 'canvas' &&
        navigationTarget !== null &&
        createPortal(<ConversationNavigation state={conversations} />, navigationTarget)}
      {presentation === 'panel' && (
        <ResizeHandle
          label="Resize AI panel"
          side="left"
          width={drawn}
          preferred={width}
          min={AI_WIDTH_MIN}
          max={dragCeiling(room, AI_WIDTH_MAX)}
          onResize={setWidth}
        />
      )}
      <header className="cb-chat-header" hidden={minimized} inert={minimized}>
        {floating ? (
          <>
            <IconButton icon="minus" label="Minimize conversation" onClick={minimize} />
            <div className="cb-chat-heading">
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
            </div>
            <button
              ref={conversationOptionsRef}
              type="button"
              className="cb-chat-options"
              aria-label="Conversation options"
              aria-haspopup="menu"
              aria-expanded={conversationOptionsOpen}
              tabIndex={0}
              onClick={(event) => {
                event.currentTarget.focus();
                setConversationOptionsOpen(!conversationOptionsOpen);
              }}
            >
              <Icon name="ellipsis" size={18} />
            </button>
            {conversationOptionsOpen && (
              <Popover
                anchorRef={conversationOptionsRef}
                onClose={() => setConversationOptionsOpen(false)}
                ariaLabel="Conversation options"
              >
                <MenuSurface width={224}>
                  <MenuItem
                    label="New conversation"
                    icon="square-pen"
                    onSelect={() => {
                      setConversationOptionsOpen(false);
                      conversations.start();
                    }}
                  />
                  {onTogglePresentation !== undefined && (
                    <MenuItem
                      label="Expand conversation"
                      icon="expand"
                      onSelect={() => {
                        setConversationOptionsOpen(false);
                        onTogglePresentation();
                      }}
                    />
                  )}
                  {/* M92.1: the rail lives in the canvas alone, so this is
                      the floating card's one way to it besides ⌥⌘R. */}
                  {onTogglePresentation !== undefined && (
                    <MenuItem
                      label="Expand with conversation details"
                      icon="panel-right-open"
                      onSelect={() => {
                        setConversationOptionsOpen(false);
                        toggleChatRail();
                      }}
                    />
                  )}
                  <MenuItem
                    label="Dock conversation"
                    icon="panel-right"
                    onSelect={() => {
                      setConversationOptionsOpen(false);
                      setAiPanelPresentation('panel');
                    }}
                  />
                  <MenuSeparator />
                  <MenuItem
                    label="Close AI panel"
                    icon="x"
                    onSelect={() => {
                      setConversationOptionsOpen(false);
                      setAiPanelOpen(false);
                    }}
                  />
                </MenuSurface>
              </Popover>
            )}
          </>
        ) : (
          <>
            <span className="cb-chat-header-mark">
              <Icon name="sparkles" size={16} />
            </span>
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
            {/* M92.1: the canvas rail's toggle. A plain button, as IconButton
                takes no tab stop and says pressed, where this one discloses
                the region it names, under a name that stays the same. Its
                tooltip waits while the drawer it opened is up: a bubble over
                the drawer took the first Escape (M52). */}
            {canvas && (
              <Tooltip
                label="Conversation details"
                command="assistant.rail"
                disabled={railInDrawer}
              >
                <button
                  ref={railToggleRef}
                  type="button"
                  // WebKit leaves a native button with no explicit tab stop
                  // out of the Tab order (AppRail's rule).
                  tabIndex={0}
                  className="cb-chat-rail-toggle"
                  data-testid="conversation-rail-toggle"
                  aria-label="Conversation details"
                  aria-expanded={railVisible}
                  aria-controls={railId}
                  onClick={(event) => {
                    // WKWebView never focuses a clicked button, and a drawer
                    // hands Escape's focus back to what held it as it opened.
                    event.currentTarget.focus();
                    toggleRail();
                  }}
                >
                  <Icon name={railVisible ? 'panel-right-close' : 'panel-right-open'} size={16} />
                </button>
              </Tooltip>
            )}
            {onTogglePresentation !== undefined && (
              <IconButton
                icon={presentation === 'canvas' ? 'minimize-2' : 'expand'}
                label={presentation === 'canvas' ? 'Float conversation' : 'Expand conversation'}
                onClick={onTogglePresentation}
              />
            )}
            {presentation !== 'panel' && (
              <IconButton
                icon="panel-right"
                label="Dock conversation"
                onClick={() => setAiPanelPresentation('panel')}
              />
            )}
            <IconButton icon="minus" label="Minimize conversation" onClick={minimize} />
            <IconButton
              icon="square-pen"
              label="New conversation"
              size="md"
              onClick={conversations.start}
            />
            <IconButton
              icon="x"
              label="Close AI panel"
              size="md"
              onClick={() => setAiPanelOpen(false)}
            />
          </>
        )}
      </header>

      {/* The transcript and composer keep their parents in both layouts. A
          first turn changes spacing, never the input or live chat controller.
          Minimized hides them whole, never unmounts them. */}
      <div className="cb-chat-body" data-empty={welcoming} hidden={minimized} inert={minimized}>
        {/* M91.12c: the transcript is a Chat, its rows in a Message
            Scroller. A question sent settles near the top with a peek of the
            turn before it, its reply growing into the room under it; while
            the reader stays at the live edge the scroller follows the reply,
            and once they scroll away it offers the way back to the latest.
            Keyed by thread, so each one opens at its last turn with its reply
            under it, while the dock below keeps its node, its draft and its
            queue through every switch, as the panel does through every fold. */}
        <Chat
          key={conversations.activeId}
          data-testid="chat-scroll"
          className="cb-chat-conversation"
          contentClassName="cb-chat-thread"
          label="Conversation"
          jumpTestId="jump-to-latest"
          // A turn waiting on the person streams nothing: the card that
          // asks is news, and the log says so as it comes.
          busy={chat.streaming && !chat.waiting}
          empty={
            opening ? (
              <div className="cb-chat-thread">
                {notice}
                {welcoming &&
                  (floating ? (
                    status?.installed === false && (
                      <p className="cb-chat-unavailable" role="status">
                        Claude Code was not found on this machine. Install it and reopen cerebro.
                      </p>
                    )
                  ) : (
                    <Arrival when={onScreen}>
                      <div className="cb-chat-welcome" data-testid="chat-welcome">
                        <p className="cb-chat-eyebrow">
                          <Icon name="sparkles" size={14} />
                          Your workspace, in conversation
                        </p>
                        <h2>
                          {activeEntry === null
                            ? 'What would you like to work on?'
                            : 'A little help with this page?'}
                        </h2>
                        <p className="cb-chat-welcome-copy">
                          {status?.installed === false
                            ? 'Claude Code was not found on this machine. Install it and reopen cerebro.'
                            : 'Find a connection, shape an idea, or work through what comes next.'}
                        </p>
                      </div>
                    </Arrival>
                  ))}
              </div>
            ) : undefined
          }
        >
          {!opening && notice !== null && (
            <MessageScrollerItem className="cb-chat-item">{notice}</MessageScrollerItem>
          )}
          {!opening && reading && (
            <MessageScrollerItem className="cb-chat-item">{readingLine}</MessageScrollerItem>
          )}
          {!opening &&
            chat.messages.map((message, index) => {
              const turn = branches.get(message.id);
              return (
                <Fragment key={message.id}>
                  <MessageScrollerItem
                    messageId={message.id}
                    // The person's turn is the one that settles near the top.
                    scrollAnchor={message.role === 'user'}
                    className="cb-chat-item"
                  >
                    <Message
                      message={message}
                      arriving={arrivals !== null && index >= arrivals.from}
                      latest={index === chat.messages.length - 1}
                      onOpen={turnHandlers.openTarget}
                      onOpenPath={turnHandlers.openPath}
                      onViewDiff={isRepo ? turnHandlers.viewDiff : undefined}
                      history={historyOf(ready, isRepo)}
                      onRetry={
                        message.error !== undefined && blocked === null
                          ? turnHandlers.retry
                          : undefined
                      }
                      noticeActions={turnHandlers.noticeActions}
                      waitingToolId={
                        chat.waiting && chat.interaction?.messageId === message.id
                          ? chat.interaction.card.tool_id
                          : null
                      }
                    />
                  </MessageScrollerItem>
                  {/* M91.12c: Branch from here, between this reply and the
                      turn after it. It comes in with the send that put a
                      turn after it; in a thread opened again it is there. */}
                  {turn !== undefined && (
                    <Arrival when={arrivals !== null && index + 1 >= arrivals.from}>
                      <MessageScrollerItem className="cb-chat-item cb-chat-checkpoint">
                        <TurnCheckpoint
                          turn={turn}
                          disabled={parked}
                          onBranch={() => branchFromReply(message.id)}
                        />
                      </MessageScrollerItem>
                    </Arrival>
                  )}
                </Fragment>
              );
            })}
          {/* M57.1: the call the turn waits on, after the last message. An
            ask-first agent's page write draws as a write card (M57.4); the
            agent's questions as InteractionCard's question card (M57.3); any
            other tool-approval ask (one that names its family, M57.2) as a
            permission card with This conversation; any other as M57.1's. */}
          {/* Each card rises in once, as it comes to wait: keyed by its
                call, so the next ask is a new card arriving, and the one
                still waiting stays the same node across every fold. */}
          {chat.interaction !== null && (
            <Arrival key={chat.interaction.card.id} when>
              <MessageScrollerItem className="cb-chat-item cb-chat-waiting">
                {chat.interaction.card.kind === 'write' ? (
                  <WriteApprovalCard interaction={chat.interaction} onAnswer={chat.answer} />
                ) : chat.interaction.card.kind !== 'question' &&
                  chat.interaction.card.family != null ? (
                  <PermissionCard
                    interaction={chat.interaction}
                    onAnswer={chat.answer}
                    vaultPath={vaultPath}
                  />
                ) : (
                  <InteractionCard interaction={chat.interaction} onAnswer={chat.answer} />
                )}
              </MessageScrollerItem>
            </Arrival>
          )}
          {!opening && chat.prLinks.length > 0 && (
            <MessageScrollerItem className="cb-chat-item">
              <PrLinks links={chat.prLinks} />
            </MessageScrollerItem>
          )}
        </Chat>

        <div className="cb-chat-dock">
          <div className="cb-chat-activity">
            {/* M91.12c: while a turn works through a plan, its steps, over
                what waits for after it. */}
            {plan !== null && (
              <DockPlan plan={plan} working={!chat.waiting && !chat.stopping} arrive={onScreen} />
            )}
            {/* M57.5: what this conversation holds for after its turn. Each is
                drawn with its thread, so what a thread opens holding is simply
                there, and only what comes to wait in it arrives (chat.css). */}
            <UpNext key={`up-next:${conversations.activeId}`} upNext={upNext} />
            <ReviewNotesDock
              key={`review-notes:${conversations.activeId}`}
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
          </div>
          {!floating && contextContents}
          {/* M91.12a: the Prompt Input — the text, its tools and its send in
              one pill. Its children keep their places in every presentation,
              so the textarea is the same node floating, docked and expanded. */}
          <PromptInput
            className="cb-chat-composer"
            data-testid="chat-composer"
            onSubmit={submit}
            disabled={blocked !== null}
          >
            {blocked !== null ? (
              <div
                ref={blockedRef}
                data-testid="thread-blocked"
                role="group"
                aria-label="Conversation unavailable"
                tabIndex={-1}
                className="flex flex-col items-start gap-2 px-1 py-1"
              >
                <p className="m-0 text-xs leading-[17px] text-n-600">
                  {blocked === 'elsewhere' ? BLOCKED_WORDS.elsewhere : BLOCKED_WORDS.gone}
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  icon="square-pen"
                  testId="thread-start-new"
                  tabIndex={0}
                  onClick={conversations.start}
                >
                  Start a new conversation
                </Button>
              </div>
            ) : (
              <>
                <PromptInputButton
                  icon="plus"
                  label="Add context"
                  size="lg"
                  className="cb-chat-pill-add"
                  onClick={addContext}
                />
                {/* Drawn only while expanded: folded onto its button, the
                    conversation keeps no second control naming the page. */}
                {floating && !minimized && contextChips.length > 0 && (
                  <button
                    ref={contextRef}
                    type="button"
                    className="cb-chat-context-summary"
                    aria-label={`Context: ${contextLabel}`}
                    aria-expanded={contextOpen}
                    tabIndex={0}
                    onClick={(event) => {
                      event.currentTarget.focus();
                      setContextOpen(!contextOpen);
                    }}
                  >
                    <Icon
                      name={contextChips.at(-1)?.kind === 'place' ? 'map-pin' : 'file-text'}
                      size={13}
                    />
                    <span>{contextChips.at(-1)?.label}</span>
                    {contextChips.length > 1 && (
                      <span className="cb-chat-context-count">+{contextChips.length - 1}</span>
                    )}
                  </button>
                )}
                {floating && !minimized && contextOpen && contextChips.length > 0 && (
                  <Popover
                    anchorRef={contextRef}
                    onClose={() => setContextOpen(false)}
                    ariaLabel="Conversation context"
                    className="w-[300px] rounded-lg border border-n-200 bg-n-0 p-3 shadow-[var(--shadow-lg)]"
                  >
                    <p className="m-0 mb-2 text-meta text-n-600">Included in your next message</p>
                    {contextContents}
                  </Popover>
                )}
                {/* M9.5: `[[` completes against the vault, and the note you name
              travels into the snapshot with its content rather than as a word
              the agent has to go searching for. Enter sends through the
              PromptInput when the conversation is idle and adds to Up next
              while it is busy (`submit`). */}
                <ChatInput
                  inputRef={composerRef}
                  autoFocus={!minimized}
                  suspended={minimized}
                  placeholder={
                    contextChips.some((chip) => chip.kind === 'record' || chip.place.kind === 'doc')
                      ? 'Work with this page…'
                      : 'Ask anything…'
                  }
                  value={draft}
                  onChange={setDraft}
                  // M17.6b: `@` attaches. A chip re-added on purpose beats an earlier
                  // dismissal — see resolveChips.
                  onAttach={(chip) => addChips([chip])}
                  attached={attachedIds}
                  // M91.17: the message's files, and the ways in for more.
                  files={files}
                  onAttachFiles={attachFiles}
                  onRemoveFile={removeFile}
                />
                <PromptInputFooter className="cb-chat-toolbar">
                  <PromptInputTools>
                    <RunOptionsPicker
                      key={conversations.activeId}
                      value={{
                        model: conversations.active?.model ?? null,
                        effort: conversations.active?.effort ?? null,
                      }}
                      onChange={(choice) =>
                        conversations.setRunOptions(conversations.activeId, choice)
                      }
                      open={runOptionsOpen}
                      onOpenChange={setRunOptionsOpen}
                      disabled={chat.streaming}
                      appearance="icon"
                      reportedModel={floating ? chat.model : null}
                    />
                    {/* Its name is the reading ("62% of context used"), never
                        "Context: …", which names the chips' disclosure. */}
                    <Context
                      usage={contextUse}
                      testId="context-use"
                      className="cb-chat-context-use"
                      // WebKit leaves a native button with no explicit tab
                      // stop out of the Tab order (the rail's rule, AppRail).
                      tabIndex={0}
                    />
                  </PromptInputTools>
                  {chat.streaming || chat.stopping ? (
                    <>
                      <PromptInputButton
                        icon="list-plus"
                        label="Add to Up next"
                        size="sm"
                        disabled={draft.trim() === '' || copying}
                        onClick={submit}
                      />
                      {/* Stop holds Up next until Resume (M57 Q23), then stops the
                      turn, which ends once its run's Done has come. */}
                      <Arrival when={onScreen}>
                        <PromptInputSubmit
                          status={chat.stopping ? 'stopping' : 'streaming'}
                          onStop={() => {
                            upNext.hold();
                            chat.stop();
                          }}
                        >
                          <Icon name="square" size={13} />
                        </PromptInputSubmit>
                      </Arrival>
                    </>
                  ) : (
                    // In a slot of its own, which carries its entrance, as it
                    // trades places with Stop.
                    <Arrival when={onScreen}>
                      <span className="cb-chat-send-slot">
                        <PromptInputSubmit disabled={draft.trim() === '' || copying} />
                      </span>
                    </Arrival>
                  )}
                </PromptInputFooter>
              </>
            )}
          </PromptInput>
          {blocked === null && (!floating || chat.streaming || chat.stopping) && (
            <div className="cb-chat-footer">
              {/* The working words carry the working light; the hint after
                  them, and a turn waiting on the person, stand still. */}
              <span data-testid="composer-status">
                {chat.waiting ? (
                  'Waiting for your answer'
                ) : chat.stopping ? (
                  <span className="cb-working-text">Stopping…</span>
                ) : chat.streaming ? (
                  <>
                    <span className="cb-working-text">Working…</span> · Enter adds to Up next
                  </>
                ) : (
                  'Enter to send · [[ to reference a note'
                )}
              </span>
              {!floating && chat.model !== null && (
                <span data-testid="turn-model" className="cb-chat-model" title={chat.model}>
                  {chat.model}
                </span>
              )}
            </div>
          )}
        </div>
        {/* Keyed by presentation: hidden while the conversation floats,
            the starters are drawn again where they show, and come in there. */}
        {welcoming && status?.installed !== false && (
          <div key={presentation} className="cb-chat-starters" data-testid="chat-starters">
            {/* M91.12a: Suggestions, as Cerebro draws them — borderless rows.
                A row shows its label and sends its prompt (M52.3). */}
            <Suggestions aria-label="Conversation starters">
              {starters.map((starter, index) => (
                <Arrival key={starter.label} when={onScreen}>
                  <Suggestion
                    data-testid="ai-suggestion"
                    className="cb-chat-suggestion"
                    suggestion={starter.prompt ?? starter.label}
                    onClick={() => {
                      const sent = starterSend(starter);
                      ask(sent.text, sent.prompt);
                    }}
                    // Its place in the stagger they come in on (chat.css).
                    style={{ '--i': index } as CSSProperties}
                  >
                    {starter.label}
                  </Suggestion>
                </Arrival>
              ))}
            </Suggestions>
            <Arrival when={onScreen}>
              <p className="cb-chat-welcome-note">Knowledge stays yours to verify.</p>
            </Arrival>
          </div>
        )}
      </div>
      {/* M92.1: the drawer closes on Escape, which hands focus back to what
          held it as the drawer opened, or on a press on the transcript it
          covers, which does not. Non-modal: the canvas keeps its keys. */}
      {railInDrawer && (
        <DrawerScrim
          modal={false}
          onDismiss={() => setRailDrawer(false)}
          label="Close conversation details"
          testId="conversation-rail-scrim"
          className="cb-chat-rail-scrim"
        />
      )}
      {/* The aside's last child, after the composer in the Tab order. A slot
          that is empty outside the canvas, so nothing before it moves or
          remounts; turned off, the rail stays to play its exit (Presence). */}
      {canvas && (
        <Presence<HTMLElement>
          open={railShown}
          render={({ closing, ref }) => (
            <ConversationRail
              ref={ref}
              id={railId}
              headingRef={railHeadingRef}
              drawer={railInDrawer}
              folded={railFolded}
              closing={closing}
              jump={jumpFromRail}
            />
          )}
        />
      )}
    </aside>
  );
}
