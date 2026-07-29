import { create } from 'zustand';
import type { OrganizeProposal, PermissionMode } from '@/agent/types';
import type { InboxPeriod } from '@/engine/inbox';

export type DocPanelTab = 'outline' | 'info' | 'links';

interface UiState {
  detailPath: string | null;
  openDetail(path: string): void;
  closeDetail(): void;
  quickOpenVisible: boolean;
  setQuickOpen(v: boolean): void;
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
  /** Inbox workflow (M4). Off = every note reads as organized and the Rail
   * hides the Inbox — for people who file at capture time. Persisted. */
  inboxEnabled: boolean;
  setInboxEnabled(v: boolean): void;
  /** After organizing, open the next queued capture automatically. */
  inboxAutoAdvance: boolean;
  setInboxAutoAdvance(v: boolean): void;
  /** Selected Inbox period pill; persisted so the queue reopens as left. */
  inboxPeriod: InboxPeriod;
  setInboxPeriod(v: InboxPeriod): void;
  /** Identity for OKF actor stamps (M5): written as `human:<id>` when you
   * verify a concept. Per device — it records who reviewed, not who owns. */
  actorId: string;
  setActorId(v: string): void;
  // --- Local agent (M6) ---
  aiPanelOpen: boolean;
  setAiPanelOpen(v: boolean): void;
  agentPermissionMode: PermissionMode;
  setAgentPermissionMode(v: PermissionMode): void;
  /** A prompt handed to the panel from elsewhere ("Ask the agent to revise"). */
  agentPendingPrompt: string | null;
  setAgentPendingPrompt(v: string | null): void;
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
const AGENT_MODE_KEY = 'cerebro.agentPermissionMode';

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
  return v === 'info' || v === 'links' ? v : 'outline';
}

function loadPermissionMode(): PermissionMode {
  // Defaults to vault_edits, not power: shell access should be a choice the
  // user makes, never one they inherit.
  const v = loadString(AGENT_MODE_KEY, 'vault_edits');
  return v === 'read_only' || v === 'power' ? v : 'vault_edits';
}

function loadInboxPeriod(): InboxPeriod {
  const v = loadString(INBOX_PERIOD_KEY, 'all');
  return v === 'week' || v === 'month' ? v : 'all';
}

let nextToastId = 1;

export const useUiStore = create<UiState>((set) => ({
  detailPath: null,
  openDetail: (path) => set({ detailPath: path }),
  closeDetail: () => set({ detailPath: null }),

  quickOpenVisible: false,
  setQuickOpen: (v) => set({ quickOpenVisible: v }),

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
  agentPermissionMode: loadPermissionMode(),
  setAgentPermissionMode: (v) => {
    storeString(AGENT_MODE_KEY, v);
    set({ agentPermissionMode: v });
  },
  agentPendingPrompt: null,
  setAgentPendingPrompt: (v) => set({ agentPendingPrompt: v }),

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
