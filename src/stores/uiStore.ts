import { create } from 'zustand';
import type { RunRecord } from '@/agent/runs';
import type { OrganizeProposal } from '@/agent/types';
import { scrubStdioApprovals } from '@/engine/connectors';
import type { InboxPeriod } from '@/engine/inbox';

export type DocPanelTab = 'outline' | 'info' | 'links' | 'knowledge';

/**
 * What the person chose, NOT what is on screen (M16.36).
 *
 * `system` is a standing instruction — "track the OS" — so it is the value
 * that persists, and resolving it to a concrete light/dark happens in
 * `useTheme`. Storing the resolved theme instead would freeze whichever
 * appearance the OS happened to have the day the choice was made.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Narrow anything to a ThemeMode, defaulting to 'system'.
 *
 * Exported because two call sites need the same answer: the loader below
 * (a hand-edited or half-written localStorage value must not throw or leave
 * the app themeless) and the Settings control (SegmentedControl's onChange is
 * typed `string`, and a cast there would let a typo through the compiler).
 */
export function asThemeMode(v: unknown): ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

interface UiState {
  /**
   * The record showing in the right-hand area, or null.
   *
   * M15 made `detailPath` and `aiPanelOpen` the two occupants of ONE slot,
   * mutually exclusive in the store rather than at the call sites, because as
   * independent booleans they stacked: a record panel plus the assistant
   * beside a 264px sidebar left a ~20px canvas on a 1280px window.
   *
   * M17.2 undoes the exclusivity and keeps the width discipline, because the
   * exclusivity had a consequence nobody costed. The assistant's system prompt
   * tells it to call `open_note`; `open_note` routes to `openDetail`;
   * `openDetail` closed the assistant; the panel is rendered conditionally, so
   * closing it UNMOUNTED it; and its unmount cleanup kills the in-flight run.
   * The agent could not show you a note without killing its own answer
   * mid-sentence — and neither could you, by clicking a [[wikilink]] in one.
   *
   * So they are independent again, and the width problem is solved where it
   * actually lives: in the layout (see SHELL_TWO_PANEL_MIN in App.tsx), which
   * draws both when there is room and hides one WITHOUT unmounting when there
   * is not. A hidden panel keeps streaming; a closed one still stops.
   */
  detailPath: string | null;
  openDetail(path: string): void;
  closeDetail(): void;
  /**
   * The records the open canvas is showing, in its order (M16.11) — what the
   * panel's previous/next step through.
   *
   * It lives here rather than being threaded through `openDetail` because a
   * row does not know its neighbours: every surface opens a record through
   * one `useOpenPath(path)` call, and only the canvas knows the filtered,
   * sorted list that call came out of.
   */
  detailSiblings: string[];
  setDetailSiblings(paths: string[]): void;
  /** Move the open record along `detailSiblings`. No-op at either end. */
  stepDetail(delta: number): void;
  /**
   * Width of the record side panel, in px (M11). Persisted.
   *
   * It is a stored preference rather than a constant because the panel is now
   * a COLUMN of the layout rather than an overlay: how much of the window it
   * takes is a trade the person reading is making between the record and the
   * table beside it, and only they know which way it goes today.
   */
  detailWidth: number;
  setDetailWidth(px: number): void;
  /** Sidebar width in px, and whether it is collapsed. Both persisted. */
  sidebarWidth: number;
  setSidebarWidth(px: number): void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed(v: boolean): void;
  quickOpenVisible: boolean;
  setQuickOpen(v: boolean): void;
  /**
   * Light, dark, or follow the OS (M16.36). Persisted; defaults to 'system'.
   *
   * The store holds the CHOICE only — nothing here touches the DOM. What ends
   * up on `<html data-theme>` is resolved by `useTheme`, which is also what
   * keeps 'system' live when the OS flips mid-session.
   */
  themeMode: ThemeMode;
  setThemeMode(v: ThemeMode): void;
  /**
   * Collapsed group bands and tree rows (M9.1), keyed scope → key → true.
   * Scope is the surface's identity (`view:<id>`, `project:<path>`,
   * `type:<name>`); key is the group path or tree row key.
   *
   * This lived in component `useState` in TableView and TreeView, so every
   * expansion reset the moment you navigated away — which read as "the
   * nesting doesn't stick". It is session state, not view configuration, so
   * it belongs in the store and NOT in the view's YAML.
   */
  collapsed: Record<string, Record<string, boolean>>;
  toggleCollapsed(scope: string, key: string): void;
  isCollapsed(scope: string, key: string): boolean;
  /**
   * The diff currently being read, shown INLINE in place of the editor
   * rather than in a dialog (M9.7).
   *
   * A diff is a way of looking at the note you are already on, not a
   * separate thing that interrupts it — a modal makes it impossible to
   * scroll the note beside its own history, and traps focus for something
   * you are only reading.
   */
  diffView: { path: string; commit: string | null } | null;
  openDiff(path: string, commit?: string | null): void;
  closeDiff(): void;
  // File-tree expand state, persisted across sessions (M2 Task 10).
  expandedFolders: Record<string, boolean>;
  toggleFolder(path: string): void;
  /** Manual sibling order per directory (M2.x drag & drop): basenames in
   * display order. Dirs without an entry sort folders-first alphabetical. */
  treeOrder: Record<string, string[]>;
  setTreeOrder(dir: string, order: string[]): void;
  // Doc right-hand side panel (M2.x docs polish): one panel, three tabs.
  docPanelOpen: boolean;
  setDocPanelOpen(v: boolean): void;
  docPanelTab: DocPanelTab;
  setDocPanelTab(tab: DocPanelTab): void;
  // Left-hand Pages panel on multi-page docs; collapsed state persists.
  docPagesOpen: boolean;
  setDocPagesOpen(v: boolean): void;
  // Home tasks rollup assignee filter ('' = everyone), persisted.
  homeTaskAssignee: string;
  setHomeTaskAssignee(v: string): void;
  // Sidebar "Types" section collapse (M3); persisted.
  typesOpen: boolean;
  setTypesOpen(v: boolean): void;

  /**
   * Per-filetype icons and colour in the workspace tree (M30.22); persisted.
   *
   * On by default because shape and colour are what make a repo tree scannable
   * before you read a single name. Off gives one neutral glyph per kind, for
   * when the colour is noise rather than signal.
   */
  workspaceFileIcons: boolean;
  setWorkspaceFileIcons(v: boolean): void;

  /** Show gitignored entries in the workspace tree (M30); persisted. */
  workspaceShowIgnored: boolean;
  setWorkspaceShowIgnored(v: boolean): void;

  /** Line numbers in the code viewer (M30.24); persisted. On, as in an editor. */
  workspaceLineNumbers: boolean;
  setWorkspaceLineNumbers(v: boolean): void;

  /**
   * Wrap long source lines instead of scrolling them (M30.24); persisted.
   *
   * Off by default: wrapping reflows code whose indentation carries meaning,
   * so an editor makes you ask for it.
   */
  workspaceWordWrap: boolean;
  setWorkspaceWordWrap(v: boolean): void;
  /**
   * The open sidebar-tree context menu (M10), keyed by node id.
   *
   * In the store rather than in each row's local state because only ONE menu
   * may be open at a time — per-row state let two menus coexist after a
   * right-click on a second row, with two overlapping popovers on screen.
   */
  nodeMenu: { x: number; y: number; id: string } | null;
  setNodeMenu(v: { x: number; y: number; id: string } | null): void;
  /** Inbox workflow (M4). Off = every note reads as organized and the Rail
   * hides the Inbox — for people who file at capture time. Persisted. */
  inboxEnabled: boolean;
  setInboxEnabled(v: boolean): void;
  /** After organizing, open the next queued capture automatically. */
  inboxAutoAdvance: boolean;
  setInboxAutoAdvance(v: boolean): void;
  /** M9.4: commit automatically when work pauses, and after agent writes.
   * Intent only — the repo probe decides whether it can actually run. */
  autoCheckpoint: boolean;
  setAutoCheckpoint(v: boolean): void;
  /** Selected Inbox period pill; persisted so the queue reopens as left. */
  inboxPeriod: InboxPeriod;
  setInboxPeriod(v: InboxPeriod): void;
  /**
   * Which capture the Inbox has open. In the store rather than inside the
   * page because the agent has to be able to point the queue at the capture
   * it is proposing a filing for — a proposal you land next to the wrong note
   * is invisible, which is the one thing propose_organize exists to prevent.
   * Session-only: a stale selection restored across reloads is noise.
   */
  inboxSelectedPath: string | null;
  setInboxSelectedPath(v: string | null): void;
  /** Identity for OKF actor stamps (M5): written as `human:<id>` when you
   * verify a concept. Per device — it records who reviewed, not who owns. */
  actorId: string;
  setActorId(v: string): void;
  // --- Local agent (M6) ---
  aiPanelOpen: boolean;
  setAiPanelOpen(v: boolean): void;
  /** The one agent ceiling (M8.1) — see AgentPolicy. Persisted. */
  agentShellAccess: boolean;
  setAgentShellAccess(v: boolean): void;
  /** Let the agent reach the user's own MCP servers (M8.2). Persisted. */
  agentConnectors: boolean;
  setAgentConnectors(v: boolean): void;
  /**
   * stdio connector approval KEYS — SHA-256 digests of the approved
   * fingerprints — keyed by vault path (PR #5 security review). Persisted
   * HERE — outside the vault — on purpose: `.cerebro/connectors.json`
   * travels with the vault, so an untrusted vault could otherwise name an
   * arbitrary command and have the agent runtime spawn it. A stdio entry
   * runs only after a person approved that exact name+command+args+env on
   * THIS machine. Digests, never the fingerprints themselves: a spec's env
   * carries credentials, and localStorage must not become a second
   * plaintext home for them — see engine/connectors.stdioApprovalKey.
   */
  stdioApprovals: Record<string, string[]>;
  approveStdio(vault: string, fingerprint: string): void;
  revokeStdio(vault: string, fingerprint: string): void;
  /** Comma-separated issue-tracker project keys, e.g. "PHX, SYN". Issue
   * references cannot be recognised by shape, only declared — see
   * engine/ingest.ts. Persisted. */
  issuePrefixes: string;
  setIssuePrefixes(v: string): void;
  /**
   * A prompt handed to the panel from elsewhere ("Ask the agent to revise").
   *
   * M17.6: it carries its SUBJECT. Six call sites used to hand over a prompt
   * string naming a record and drop the record itself on the floor — so the
   * agent was told to revise a concept and then handed whatever surface the
   * user happened to be standing on as context. The subject arrives as a
   * context chip instead: visible, and removable if it was the wrong one.
   */
  agentPendingPrompt: { text: string; subject: string | null } | null;
  setAgentPendingPrompt(v: { text: string; subject: string | null } | null): void;
  /** Open the panel and hand it a prompt about `subject`. One action because
   * the two halves were always done together, and doing only the second is a
   * prompt that lands in a panel nobody can see. */
  askAgent(text: string, subject?: string | null): void;
  // --- Automatic learning (M8.6) ---
  /**
   * Let the base read filed captures and edited notes on its own. Persisted.
   *
   * A ceiling rather than a per-note choice, for the same reason the
   * permission dropdown was deleted: whether the assistant may spend a turn
   * reading your work is a standing decision, not one to re-litigate per note.
   */
  autoLearn: boolean;
  setAutoLearn(v: boolean): void;
  /** Captures handed to the distiller when they were filed. Persisted. */
  filedForLearning: string[];
  fileForLearning(path: string): void;
  /** Drop a filed path that can never produce a learn job — a capture that
   * is (or became) a Skill/Agent record. Only a learn attempt consumes a
   * filing, and these never get one, so without this the path reads as
   * "filed" in the persisted ledger forever (PR #5 review). */
  unfileForLearning(path: string): void;
  /**
   * path → the note version last handed to the distiller. Persisted, and the
   * only thing stopping a note nobody could learn anything from being read
   * again on every tick — see engine/learn.ts.
   */
  learnAttempts: Record<string, string>;
  recordLearnAttempt(path: string, modifiedAt: string): void;
  /**
   * Vault path → skill path → the schedule fire key last run (M13.2).
   * Persisted; the same loop-stopper discipline as learnAttempts. Scoped by
   * vault like stdioApprovals (PR #5 review): fire keys are calendar values,
   * identical everywhere, so a flat map would let `records/skills/digest.md`
   * in one vault mark the same path in another vault as already run.
   */
  skillRuns: Record<string, Record<string, string>>;
  recordSkillRun(vault: string, path: string, fireKey: string): void;
  /**
   * Vault → agent identity → when it last ran from an EVENT trigger, ISO
   * (M17.12). Separate from skillRuns because it answers a different question:
   * skillRuns says "has this exact fire been answered", this says "how long
   * ago did this agent last wake at all". Only the second can break the loop
   * an agent creates by writing into the folder it watches, because every such
   * write mints a genuinely new fire key.
   */
  triggerRuns: Record<string, Record<string, string>>;
  recordTriggerRun(vault: string, agent: string, at: string): void;
  /**
   * Everything the assistant is doing, in start order (M17.7).
   *
   * Was `agentBusy` (a boolean) plus `learningPath` (a string), both unowned
   * and both written from whichever hook felt like it. See agent/runs.ts for
   * why a flag stopped being able to answer the question.
   */
  runs: RunRecord[];
  startRun(record: RunRecord): void;
  /** Record the child once it exists, so Stop has something to kill. */
  attachChild(id: string, run: number): void;
  endRun(id: string): void;
  /**
   * Home insight cards the user has waved away (M8.3), by concept path.
   * Persisted, because a card you dismissed and that came back tomorrow is
   * the definition of the nagging this surface is not allowed to do.
   */
  dismissedInsights: string[];
  dismissInsight(path: string): void;
  /** Filings the agent has suggested but not applied (M7), keyed by path. */
  proposals: Record<string, OrganizeProposal>;
  addProposal(p: OrganizeProposal): void;
  dismissProposal(path: string): void;
  toasts: { id: number; message: string }[];
  toast(message: string): void;
  dismissToast(id: number): void;
}

const EXPANDED_KEY = 'cerebro.expandedFolders';
const PANEL_OPEN_KEY = 'cerebro.docPanelOpen';
const PANEL_TAB_KEY = 'cerebro.docPanelTab';
const PAGES_OPEN_KEY = 'cerebro.docPagesOpen';
const TREE_ORDER_KEY = 'cerebro.treeOrder';
const TASK_ASSIGNEE_KEY = 'cerebro.homeTaskAssignee';
const TYPES_OPEN_KEY = 'cerebro.typesOpen';
const FILE_ICONS_KEY = 'cerebro.workspaceFileIcons';
const SHOW_IGNORED_KEY = 'cerebro.workspaceShowIgnored';
const LINE_NUMBERS_KEY = 'cerebro.workspaceLineNumbers';
const WORD_WRAP_KEY = 'cerebro.workspaceWordWrap';
const INBOX_ENABLED_KEY = 'cerebro.inboxEnabled';
const INBOX_ADVANCE_KEY = 'cerebro.inboxAutoAdvance';
const INBOX_PERIOD_KEY = 'cerebro.inboxPeriod';
const ACTOR_ID_KEY = 'cerebro.actorId';
const AI_PANEL_KEY = 'cerebro.aiPanelOpen';
const AGENT_SHELL_KEY = 'cerebro.agentShellAccess';
const AGENT_CONNECTORS_KEY = 'cerebro.agentConnectors';
const ISSUE_PREFIXES_KEY = 'cerebro.issuePrefixes';
const DISMISSED_INSIGHTS_KEY = 'cerebro.dismissedInsights';
const AUTO_LEARN_KEY = 'cerebro.autoLearn';
const FILED_LEARN_KEY = 'cerebro.filedForLearning';
const STDIO_APPROVALS_KEY = 'cerebro.stdioApprovals';
const LEARN_ATTEMPTS_KEY = 'cerebro.learnAttempts';
const SKILL_RUNS_KEY = 'cerebro.skillRuns';
const TRIGGER_RUNS_KEY = 'cerebro.triggerRuns';
const AUTO_CHECKPOINT_KEY = 'cerebro.autoCheckpoint';
const DETAIL_WIDTH_KEY = 'cerebro.detailWidth';
const SIDEBAR_WIDTH_KEY = 'cerebro.sidebarWidth';
const SIDEBAR_COLLAPSED_KEY = 'cerebro.sidebarCollapsed';
const COLLAPSED_KEY = 'cerebro.collapsed';
/**
 * DUPLICATED VERBATIM in index.html's pre-paint theme script (M16.36).
 *
 * That script has to run before any module loads — it cannot import this
 * constant — so changing this string means changing it there too, or a
 * dark-mode user gets a white flash on every launch.
 */
export const THEME_MODE_KEY = 'cerebro.themeMode';

/**
 * Panel sizing (M11).
 *
 * 560 rather than the old 420: at 420 a record's properties column and its
 * values were both cramped, and a date range wrapped. The ceiling exists so
 * dragging it to full width cannot hide the canvas the panel is annotating.
 */
export const DETAIL_WIDTH_DEFAULT = 560;
export const DETAIL_WIDTH_MIN = 360;
export const DETAIL_WIDTH_MAX = 1000;
export const SIDEBAR_WIDTH_DEFAULT = 264;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 460;

/**
 * Layout floors (M15).
 *
 * The canvas is the thing every other column annotates, so it is the one
 * column that never yields: the sidebar shrinks to SIDEBAR_WIDTH_MIN and the
 * right-hand panel is capped at `100% - CANVAS_MIN_WIDTH` before the canvas
 * gives up a pixel. Before this, every flanking column was `flex-none` and the
 * canvas carried `min-w-0`, so content absorbed 100% of any shortfall — at
 * 1024px with a record open the reading pane measured 108px and wrapped body
 * text one character per line.
 */
export const CANVAS_MIN_WIDTH = 400;
/** How narrow the right-hand slot may get before the sidebar has to yield. */
export const RIGHT_PANEL_MIN_WIDTH = 320;

function loadNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(loadString(key, String(fallback)));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function loadExpanded(): Record<string, boolean> {
  try {
    // window.localStorage explicitly: the bare global is Node's experimental
    // stub under vitest and shadows jsdom's working implementation.
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Collapsed bands and tree rows, scope → key → true (M16.21).
 *
 * Only COLLAPSED entries are stored — `toggleCollapsed` deletes the key on
 * the way back open rather than writing `false`. Absent already means
 * expanded everywhere that reads this, and a map that accumulated a `false`
 * for every band anyone ever touched would grow without bound in
 * localStorage while meaning nothing.
 */
function loadCollapsed(): Record<string, Record<string, boolean>> {
  try {
    // window.localStorage explicitly, for the same reason loadExpanded does.
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, boolean>> = {};
    for (const [scope, band] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof band !== 'object' || band === null || Array.isArray(band)) continue;
      out[scope] = Object.fromEntries(
        Object.entries(band as Record<string, unknown>).filter(
          (pair): pair is [string, boolean] => pair[1] === true,
        ),
      );
    }
    return out;
  } catch {
    return {};
  }
}

function loadTreeOrder(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(TREE_ORDER_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, string[]>)
      : {};
  } catch {
    return {};
  }
}

function loadStringList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function loadStringMap(key: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** vault → path → value. Entries whose value is not itself a string map are
 * dropped — which also migrates the pre-scoping flat `skillRuns` format by
 * discarding it (worst case each schedule fires once more, its fresh-vault
 * behavior anyway). */
function loadNestedStringMap(key: string): Record<string, Record<string, string>> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, Record<string, string>> = {};
    for (const [vault, map] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
      out[vault] = Object.fromEntries(
        Object.entries(map as Record<string, unknown>).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string',
        ),
      );
    }
    return out;
  } catch {
    return {};
  }
}

/** stdio approvals persisted before PR #5 round 7 were raw fingerprints —
 * env values included, i.e. credential material in localStorage. Scrub on
 * load: hash any pre-digest entry to its approval key and persist the
 * cleaned map immediately, so the approval survives and the plaintext is
 * gone after one launch. */
function loadStdioApprovals(key: string): Record<string, string[]> {
  const scrubbed = scrubStdioApprovals(loadStringListMap(key));
  if (scrubbed.changed) storeString(key, JSON.stringify(scrubbed.map));
  return scrubbed.map;
}

function loadStringListMap(key: string): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([k, v]): [string, string[]][] =>
        Array.isArray(v) ? [[k, v.filter((x): x is string => typeof x === 'string')]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function loadString(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function storeString(key: string, v: string): void {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    // Storage unavailable: session-only.
  }
}

function loadPanelTab(): DocPanelTab {
  const v = loadString(PANEL_TAB_KEY, 'outline');
  return v === 'info' || v === 'links' || v === 'knowledge' ? v : 'outline';
}

function loadInboxPeriod(): InboxPeriod {
  const v = loadString(INBOX_PERIOD_KEY, 'all');
  return v === 'week' || v === 'month' ? v : 'all';
}

let nextToastId = 1;

export const useUiStore = create<UiState>((set, get) => ({
  detailPath: null,
  // M17.2: opening a record no longer closes the assistant. This line WAS the
  // bug — `open_note` is the tool the system prompt tells the agent to call,
  // and it landed here, where closing the panel unmounted it and killed the
  // run that was mid-answer. Showing you something must never end the sentence
  // that referred to it.
  openDetail: (path) => set({ detailPath: path }),
  closeDetail: () => set({ detailPath: null }),

  detailSiblings: [],
  setDetailSiblings: (paths) => {
    // Reference-stable when nothing changed: this is set from a render-time
    // effect on every canvas render, and a fresh array each time would
    // re-render the panel continuously.
    const current = get().detailSiblings;
    if (current.length === paths.length && current.every((p, i) => p === paths[i])) return;
    set({ detailSiblings: paths });
  },
  stepDetail: (delta) => {
    const { detailPath, detailSiblings } = get();
    if (detailPath === null) return;
    const at = detailSiblings.indexOf(detailPath);
    const next = detailSiblings[at + delta];
    if (at === -1 || next === undefined) return;
    get().openDetail(next);
  },

  detailWidth: loadNumber(
    DETAIL_WIDTH_KEY,
    DETAIL_WIDTH_DEFAULT,
    DETAIL_WIDTH_MIN,
    DETAIL_WIDTH_MAX,
  ),
  setDetailWidth: (px) => {
    const clamped = Math.round(Math.min(DETAIL_WIDTH_MAX, Math.max(DETAIL_WIDTH_MIN, px)));
    storeString(DETAIL_WIDTH_KEY, String(clamped));
    set({ detailWidth: clamped });
  },

  sidebarWidth: loadNumber(
    SIDEBAR_WIDTH_KEY,
    SIDEBAR_WIDTH_DEFAULT,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
  ),
  setSidebarWidth: (px) => {
    const clamped = Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px)));
    storeString(SIDEBAR_WIDTH_KEY, String(clamped));
    set({ sidebarWidth: clamped });
  },
  sidebarCollapsed: loadString(SIDEBAR_COLLAPSED_KEY, 'false') === 'true',
  setSidebarCollapsed: (v) => {
    storeString(SIDEBAR_COLLAPSED_KEY, String(v));
    set({ sidebarCollapsed: v });
  },

  quickOpenVisible: false,
  setQuickOpen: (v) => set({ quickOpenVisible: v }),

  // Stored as the bare word, matching every other scalar preference here
  // (docPanelTab, inboxPeriod) — the pre-paint script in index.html reads it
  // with a plain getItem, so a JSON-quoted value would cost it a parse it has
  // no business doing. Anything unrecognised reads back as 'system'.
  themeMode: asThemeMode(loadString(THEME_MODE_KEY, 'system')),
  setThemeMode: (v) => {
    storeString(THEME_MODE_KEY, v);
    set({ themeMode: v });
  },

  autoCheckpoint: loadString(AUTO_CHECKPOINT_KEY, 'true') === 'true',
  setAutoCheckpoint: (v) => {
    storeString(AUTO_CHECKPOINT_KEY, String(v));
    set({ autoCheckpoint: v });
  },

  diffView: null,
  openDiff: (path, commit = null) => set({ diffView: { path, commit } }),
  closeDiff: () => set({ diffView: null }),

  // M16.21: persisted. It was the one member of this store's collapse family
  // that was not — `expandedFolders`, `docPagesOpen`, `typesOpen` and the
  // sidebar all write themselves back — so a list's bands sprang open on every
  // reload and a deep nesting had to be re-collapsed each session.
  collapsed: loadCollapsed(),
  toggleCollapsed: (scope, key) =>
    set((s) => {
      const band = { ...(s.collapsed[scope] ?? {}) };
      // Delete rather than store false: absent already means expanded, and a
      // false per band ever touched would grow this map for no information.
      if (band[key] === true) delete band[key];
      else band[key] = true;
      const next = { ...s.collapsed, [scope]: band };
      storeString(COLLAPSED_KEY, JSON.stringify(next));
      return { collapsed: next };
    }),
  isCollapsed: (scope, key) => get().collapsed[scope]?.[key] === true,

  expandedFolders: loadExpanded(),
  toggleFolder: (path) =>
    set((s) => {
      const next = { ...s.expandedFolders, [path]: !s.expandedFolders[path] };
      try {
        window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable (private mode): expand state stays session-only.
      }
      return { expandedFolders: next };
    }),

  treeOrder: loadTreeOrder(),
  setTreeOrder: (dir, order) =>
    set((s) => {
      const next = { ...s.treeOrder, [dir]: order };
      try {
        window.localStorage.setItem(TREE_ORDER_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable: order stays session-only.
      }
      return { treeOrder: next };
    }),

  docPanelOpen: loadString(PANEL_OPEN_KEY, 'true') === 'true',
  setDocPanelOpen: (v) => {
    storeString(PANEL_OPEN_KEY, String(v));
    set({ docPanelOpen: v });
  },
  docPanelTab: loadPanelTab(),
  setDocPanelTab: (tab) => {
    storeString(PANEL_TAB_KEY, tab);
    set({ docPanelTab: tab });
  },
  docPagesOpen: loadString(PAGES_OPEN_KEY, 'true') === 'true',
  setDocPagesOpen: (v) => {
    storeString(PAGES_OPEN_KEY, String(v));
    set({ docPagesOpen: v });
  },

  homeTaskAssignee: loadString(TASK_ASSIGNEE_KEY, ''),
  setHomeTaskAssignee: (v) => {
    storeString(TASK_ASSIGNEE_KEY, v);
    set({ homeTaskAssignee: v });
  },

  nodeMenu: null,
  setNodeMenu: (v) => set({ nodeMenu: v }),
  typesOpen: loadString(TYPES_OPEN_KEY, 'true') === 'true',
  setTypesOpen: (v) => {
    storeString(TYPES_OPEN_KEY, String(v));
    set({ typesOpen: v });
  },

  workspaceFileIcons: loadString(FILE_ICONS_KEY, 'true') === 'true',
  setWorkspaceFileIcons: (v) => {
    storeString(FILE_ICONS_KEY, String(v));
    set({ workspaceFileIcons: v });
  },

  workspaceShowIgnored: loadString(SHOW_IGNORED_KEY, 'false') === 'true',
  setWorkspaceShowIgnored: (v) => {
    storeString(SHOW_IGNORED_KEY, String(v));
    set({ workspaceShowIgnored: v });
  },

  workspaceLineNumbers: loadString(LINE_NUMBERS_KEY, 'true') === 'true',
  setWorkspaceLineNumbers: (v) => {
    storeString(LINE_NUMBERS_KEY, String(v));
    set({ workspaceLineNumbers: v });
  },

  workspaceWordWrap: loadString(WORD_WRAP_KEY, 'false') === 'true',
  setWorkspaceWordWrap: (v) => {
    storeString(WORD_WRAP_KEY, String(v));
    set({ workspaceWordWrap: v });
  },

  inboxEnabled: loadString(INBOX_ENABLED_KEY, 'true') === 'true',
  setInboxEnabled: (v) => {
    storeString(INBOX_ENABLED_KEY, String(v));
    set({ inboxEnabled: v });
  },
  inboxAutoAdvance: loadString(INBOX_ADVANCE_KEY, 'true') === 'true',
  setInboxAutoAdvance: (v) => {
    storeString(INBOX_ADVANCE_KEY, String(v));
    set({ inboxAutoAdvance: v });
  },
  inboxPeriod: loadInboxPeriod(),
  setInboxPeriod: (v) => {
    storeString(INBOX_PERIOD_KEY, v);
    set({ inboxPeriod: v });
  },
  inboxSelectedPath: null,
  setInboxSelectedPath: (v) => set({ inboxSelectedPath: v }),

  actorId: loadString(ACTOR_ID_KEY, 'me'),
  setActorId: (v) => {
    storeString(ACTOR_ID_KEY, v);
    set({ actorId: v });
  },

  aiPanelOpen: loadString(AI_PANEL_KEY, 'false') === 'true',
  setAiPanelOpen: (v) => {
    storeString(AI_PANEL_KEY, String(v));
    // M17.2: the other half of the one-slot rule, and the other half of the
    // damage. Opening the assistant used to null `detailPath`, which is why
    // every "Ask the agent about this" button threw away the record it was
    // asking about — the snapshot's activeNote is derived from detailPath,
    // so only whatever was baked into the prompt string survived.
    set({ aiPanelOpen: v });
  },
  // Defaults off: shell access is a choice the user makes, never one they
  // inherit. Everything else the agent can do follows from the folder model.
  agentShellAccess: loadString(AGENT_SHELL_KEY, 'false') === 'true',
  setAgentShellAccess: (v) => {
    storeString(AGENT_SHELL_KEY, String(v));
    set({ agentShellAccess: v });
  },
  // Also off by default: reaching other systems is a choice, never one
  // inherited from opening the panel.
  agentConnectors: loadString(AGENT_CONNECTORS_KEY, 'false') === 'true',
  setAgentConnectors: (v) => {
    storeString(AGENT_CONNECTORS_KEY, String(v));
    set({ agentConnectors: v });
  },
  stdioApprovals: loadStdioApprovals(STDIO_APPROVALS_KEY),
  approveStdio: (vault, fingerprint) =>
    set((s) => {
      const list = s.stdioApprovals[vault] ?? [];
      if (list.includes(fingerprint)) return s;
      const next = { ...s.stdioApprovals, [vault]: [...list, fingerprint] };
      storeString(STDIO_APPROVALS_KEY, JSON.stringify(next));
      return { stdioApprovals: next };
    }),
  revokeStdio: (vault, fingerprint) =>
    set((s) => {
      const list = s.stdioApprovals[vault] ?? [];
      if (!list.includes(fingerprint)) return s;
      const next = { ...s.stdioApprovals, [vault]: list.filter((f) => f !== fingerprint) };
      storeString(STDIO_APPROVALS_KEY, JSON.stringify(next));
      return { stdioApprovals: next };
    }),
  issuePrefixes: loadString(ISSUE_PREFIXES_KEY, ''),
  setIssuePrefixes: (v) => {
    storeString(ISSUE_PREFIXES_KEY, v);
    set({ issuePrefixes: v });
  },
  agentPendingPrompt: null,
  setAgentPendingPrompt: (v) => set({ agentPendingPrompt: v }),
  askAgent: (text, subject = null) => {
    storeString(AI_PANEL_KEY, 'true');
    set({ aiPanelOpen: true, agentPendingPrompt: { text, subject } });
  },

  autoLearn: loadString(AUTO_LEARN_KEY, 'true') === 'true',
  setAutoLearn: (v) => {
    storeString(AUTO_LEARN_KEY, String(v));
    set({ autoLearn: v });
  },
  filedForLearning: loadStringList(FILED_LEARN_KEY),
  fileForLearning: (path) =>
    set((s) => {
      if (s.filedForLearning.includes(path)) return s;
      const next = [...s.filedForLearning, path];
      storeString(FILED_LEARN_KEY, JSON.stringify(next));
      return { filedForLearning: next };
    }),
  unfileForLearning: (path) =>
    set((s) => {
      if (!s.filedForLearning.includes(path)) return s;
      const next = s.filedForLearning.filter((p) => p !== path);
      storeString(FILED_LEARN_KEY, JSON.stringify(next));
      return { filedForLearning: next };
    }),
  learnAttempts: loadStringMap(LEARN_ATTEMPTS_KEY),
  recordLearnAttempt: (path, modifiedAt) =>
    set((s) => {
      // Filing is consumed here rather than on completion: the attempt is
      // what the record is for, and a run that dies mid-way must not leave the
      // path queued to be tried again on the next tick.
      const filed = s.filedForLearning.filter((p) => p !== path);
      const next = { ...s.learnAttempts, [path]: modifiedAt };
      storeString(LEARN_ATTEMPTS_KEY, JSON.stringify(next));
      storeString(FILED_LEARN_KEY, JSON.stringify(filed));
      return { learnAttempts: next, filedForLearning: filed };
    }),
  triggerRuns: loadNestedStringMap(TRIGGER_RUNS_KEY),
  recordTriggerRun: (vault, agent, at) =>
    set((s) => {
      const scoped = { ...(s.triggerRuns[vault] ?? {}), [agent]: at };
      const next = { ...s.triggerRuns, [vault]: scoped };
      storeString(TRIGGER_RUNS_KEY, JSON.stringify(next));
      return { triggerRuns: next };
    }),
  skillRuns: loadNestedStringMap(SKILL_RUNS_KEY),
  recordSkillRun: (vault, path, fireKey) =>
    set((s) => {
      const scoped = { ...(s.skillRuns[vault] ?? {}), [path]: fireKey };
      const next = { ...s.skillRuns, [vault]: scoped };
      storeString(SKILL_RUNS_KEY, JSON.stringify(next));
      return { skillRuns: next };
    }),
  runs: [],
  startRun: (record) => set((s) => ({ runs: [...s.runs, record] })),
  attachChild: (id, run) =>
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, run } : r)) })),
  // Idempotent: a turn can end through Done, through Error, through the panel
  // unmounting, or through Stop, and more than one of those routinely happens
  // for the same run.
  endRun: (id) => set((s) => ({ runs: s.runs.filter((r) => r.id !== id) })),

  dismissedInsights: loadStringList(DISMISSED_INSIGHTS_KEY),
  dismissInsight: (path) =>
    set((s) => {
      if (s.dismissedInsights.includes(path)) return s;
      const next = [...s.dismissedInsights, path];
      storeString(DISMISSED_INSIGHTS_KEY, JSON.stringify(next));
      return { dismissedInsights: next };
    }),

  proposals: {},
  addProposal: (p) => set((s) => ({ proposals: { ...s.proposals, [p.path]: p } })),
  dismissProposal: (path) =>
    set((s) => {
      const next = { ...s.proposals };
      delete next[path];
      return { proposals: next };
    }),

  toasts: [],
  toast: (message) => set((s) => ({ toasts: [...s.toasts, { id: nextToastId++, message }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
