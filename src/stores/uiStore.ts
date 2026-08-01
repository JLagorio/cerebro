import { create } from 'zustand';
import type { OrganizeProposal } from '@/agent/types';
import type { InboxPeriod } from '@/engine/inbox';

export type DocPanelTab = 'outline' | 'info' | 'links' | 'knowledge';

interface UiState {
  detailPath: string | null;
  openDetail(path: string): void;
  closeDetail(): void;
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
   * stdio connector fingerprints approved to RUN, keyed by vault path
   * (PR #5 security review). Persisted HERE — outside the vault — on
   * purpose: `.cerebro/connectors.json` travels with the vault, so an
   * untrusted vault could otherwise name an arbitrary command and have the
   * agent runtime spawn it. A stdio entry runs only after a person approved
   * that exact name+command+args+env on THIS machine — see
   * engine/connectors.stdioFingerprint.
   */
  stdioApprovals: Record<string, string[]>;
  approveStdio(vault: string, fingerprint: string): void;
  revokeStdio(vault: string, fingerprint: string): void;
  /** Comma-separated issue-tracker project keys, e.g. "PHX, SYN". Issue
   * references cannot be recognised by shape, only declared — see
   * engine/ingest.ts. Persisted. */
  issuePrefixes: string;
  setIssuePrefixes(v: string): void;
  /** A prompt handed to the panel from elsewhere ("Ask the agent to revise"). */
  agentPendingPrompt: string | null;
  setAgentPendingPrompt(v: string | null): void;
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
  /** True while ANY agent turn is in flight — the chat's or the runner's. */
  agentBusy: boolean;
  setAgentBusy(v: boolean): void;
  /** The note the background distiller is reading right now, if any. */
  learningPath: string | null;
  setLearningPath(v: string | null): void;
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
const AUTO_CHECKPOINT_KEY = 'cerebro.autoCheckpoint';
const DETAIL_WIDTH_KEY = 'cerebro.detailWidth';
const SIDEBAR_WIDTH_KEY = 'cerebro.sidebarWidth';
const SIDEBAR_COLLAPSED_KEY = 'cerebro.sidebarCollapsed';

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
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, boolean>)
      : {};
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

function loadStringListMap(key: string): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(
        ([k, v]): [string, string[]][] =>
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
  openDetail: (path) => set({ detailPath: path }),
  closeDetail: () => set({ detailPath: null }),

  detailWidth: loadNumber(DETAIL_WIDTH_KEY, DETAIL_WIDTH_DEFAULT, DETAIL_WIDTH_MIN, DETAIL_WIDTH_MAX),
  setDetailWidth: (px) => {
    const clamped = Math.round(Math.min(DETAIL_WIDTH_MAX, Math.max(DETAIL_WIDTH_MIN, px)));
    storeString(DETAIL_WIDTH_KEY, String(clamped));
    set({ detailWidth: clamped });
  },

  sidebarWidth: loadNumber(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX),
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

  autoCheckpoint: loadString(AUTO_CHECKPOINT_KEY, 'true') === 'true',
  setAutoCheckpoint: (v) => {
    storeString(AUTO_CHECKPOINT_KEY, String(v));
    set({ autoCheckpoint: v });
  },

  diffView: null,
  openDiff: (path, commit = null) => set({ diffView: { path, commit } }),
  closeDiff: () => set({ diffView: null }),

  collapsed: {},
  toggleCollapsed: (scope, key) =>
    set((s) => {
      const band = s.collapsed[scope] ?? {};
      return { collapsed: { ...s.collapsed, [scope]: { ...band, [key]: band[key] !== true } } };
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
  stdioApprovals: loadStringListMap(STDIO_APPROVALS_KEY),
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
  skillRuns: loadNestedStringMap(SKILL_RUNS_KEY),
  recordSkillRun: (vault, path, fireKey) =>
    set((s) => {
      const scoped = { ...(s.skillRuns[vault] ?? {}), [path]: fireKey };
      const next = { ...s.skillRuns, [vault]: scoped };
      storeString(SKILL_RUNS_KEY, JSON.stringify(next));
      return { skillRuns: next };
    }),
  agentBusy: false,
  setAgentBusy: (v) => set({ agentBusy: v }),
  learningPath: null,
  setLearningPath: (v) => set({ learningPath: v }),

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
  toast: (message) =>
    set((s) => ({ toasts: [...s.toasts, { id: nextToastId++, message }] })),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
