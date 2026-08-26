import { useEffect, useMemo, useRef, useState } from 'react';
import { FileTree } from '@/components/FileTree';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Icon } from '@/components/ui/Icon';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import {
  DeleteTypeDialog,
  NewTypeDialog,
  RenameTypeDialog,
  TypeStyleDialog,
} from '@/app/TypeDialogs';
import { AdoptSchemaDialog } from '@/app/AdoptSchemaDialog';
import { CollectionTree } from '@/app/CollectionTree';
import { CollectionDialog } from '@/app/CollectionDialog';
import { CreateMenu } from '@/app/CreateMenu';
import { deleteCollection, deleteList } from '@/app/listActions';
import { SectionHeader } from '@/app/SectionHeader';
import { useOpenPath } from '@/app/useOpenPath';
import { rowClass } from '@/app/sidebarChrome';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { collectionsTree, effectiveCollections } from '@/engine/collections';
import { inboxCounts } from '@/engine/inbox';
import { isPaused } from '@/engine/jobs';
import { openWork } from '@/engine/myWork';
import { listTypes, typeStyle, type TypeListing } from '@/engine/typeCatalog';
import type { CollectionFile, CollectionNode } from '@/engine/types';
import { SyncBadge } from '@/git/SyncBadge';
import { KnowledgeNav } from '@/knowledge/KnowledgeNav';
import { useNavStore } from '@/stores/navStore';
import { useRootsStore } from '@/stores/rootsStore';
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useUiStore, type ThemeMode } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export interface SidebarProps {
  /**
   * Opens the New-List builder for one Collection. The folder is required: a
   * List always lives in a Collection, so there is no top-level variant to
   * offer and no null to handle downstream.
   */
  onNewView: (collection: string) => void;
  /**
   * The window is too narrow to honour a stored width (M15). The sidebar draws
   * at its minimum instead — the STORED preference is untouched, so widening
   * the window restores it — and the resize handle is withdrawn rather than
   * left to fight a ceiling it cannot pass.
   */
  narrow?: boolean;
}

/**
 * The surfaces Home is the front door to (M15).
 *
 * A Collection, a List and a Type screen are the item world, and HomePage is
 * where you enter it — so the nav marks Home on all four. Spelled out rather
 * than derived by negating every other slot, which is how `changes` and
 * `settings` had to be remembered in a boolean expression to keep Home dark.
 */
const HOME_KINDS = new Set(['home', 'collection', 'list', 'type']);

/** The footer's theme cycle (M43): what each mode wears, and what follows it. */
const THEME_ICONS: Record<ThemeMode, string> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };

type TypeDialog = { mode: 'new' } | { mode: 'rename' | 'style' | 'delete'; listing: TypeListing };

type CollectionDialogState = { mode: 'new' } | { mode: 'rename'; collection: CollectionFile };

/**
 * One destination row of the flattened nav (M37.3).
 *
 * These were the rail's buttons; they kept the rail's a11y contract when they
 * moved in here: a destination announces `aria-current="page"`, a toggle
 * announces `aria-pressed`, and the queue size rides the accessible name so a
 * screen reader hears "Inbox (2)" rather than two unrelated facts.
 */
function SurfaceRow({
  icon,
  label,
  active,
  toggle = false,
  count,
  hot = false,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  /** Opens and closes a panel rather than going somewhere. */
  toggle?: boolean;
  /** Queue size shown as a badge; omitted or 0 renders nothing. */
  count?: number;
  /** A count that wants acting on — cortex ink instead of the quiet gray
   * (M43, the design's Inbox). Still a number, never a filled pill. */
  hot?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={count !== undefined && count > 0 ? `${label} (${count})` : label}
      aria-current={!toggle && active ? 'page' : undefined}
      aria-pressed={toggle ? active : undefined}
      className={rowClass(active)}
    >
      <Icon name={icon} size={15} />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          // DS: "numbers are quiet facts" — a count, not a filled pill
          // shouting from the chrome (M42.1). Same testid, same text.
          data-testid="nav-badge"
          className={`ml-auto [font-family:var(--font-mono)] text-2xs tabular-nums ${
            hot ? 'text-cortex-600' : 'text-n-500'
          }`}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

/**
 * The one nav column (M37.3 — the shell flattening), which M43 made the whole
 * chrome: the Topbar's tenants (wordmark, ask, search, create, SyncBadge)
 * live here now, so the canvas starts at the window's top edge.
 *
 * Shape, top to bottom: header (vault tile · wordmark · zap · search ·
 * collapse), the New button, the destination rows (Inbox, Home, My work,
 * Work, Studio, Base, History, Library — groups keep their M42.2 chevrons),
 * then the sections — Collections, Pages, Agents, Databases, Favorites — all
 * wearing SectionHeader's one anatomy, then the footer (SyncBadge · Theme ·
 * Settings). Agents left the destination list for a section because the
 * design's `sec()` treats a roster the way Databases already reads: a
 * labelled shelf of subjects, not a place with children.
 */
export function Sidebar({ onNewView, narrow = false }: SidebarProps) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const typesOpen = useUiStore((s) => s.typesOpen);
  const setTypesOpen = useUiStore((s) => s.setTypesOpen);
  const width = useUiStore((s) => s.sidebarWidth);
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const inboxPeriod = useUiStore((s) => s.inboxPeriod);
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const setQuickOpen = useUiStore((s) => s.setQuickOpen);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const favorites = useUiStore((s) => s.favorites);
  const pruneFavorites = useUiStore((s) => s.pruneFavorites);
  const openPath = useOpenPath();

  const collections = useVaultStore((s) => s.collections);
  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState | null>(null);
  const [typeDialog, setTypeDialog] = useState<TypeDialog | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number; listing: TypeListing } | null>(
    null,
  );
  const pagesCreate = useRef<{ newPage(): void; newFolder(): void } | null>(null);

  // M8.1: Base navigates by its own axes rather than borrowing Views and
  // Types, which describe a corpus with a different author; its rows nest
  // under the Base row (always available since M42.2).
  const knowledgeMode = selection.kind === 'knowledge';

  // M42.2 — the Notion turn: a destination that owns subjects is a GROUP, and
  // its subjects nest under it on every surface. Open unless closed, so a new
  // vault shows everything it has. M43 rides the same closed set for the
  // section shelves (collections/pages/agents/favorites).
  const navClosed = useUiStore((s) => s.navClosed);
  const setNavGroupOpen = useUiStore((s) => s.setNavGroupOpen);
  const groupOpen = (key: string) => !navClosed.includes(key);

  const agents = useMemo(
    () => entries.filter(isAgentEntry).map((e) => ({ ref: agentRef(e), paused: isPaused(e) })),
    [entries],
  );
  // The mounted repos, read here rather than waiting for the Work surface to
  // mount: rows the nav promises to show cannot depend on having visited the
  // page that used to own the read.
  const roots = useRootsStore((s) => s.roots);
  const loadRoots = useRootsStore((s) => s.loadRoots);
  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);
  // M9.4: the two git surfaces share one slot's worth of "history".
  const historyActive = selection.kind === 'changes' || selection.kind === 'pulse';
  const homeActive = HOME_KINDS.has(selection.kind);

  // M15: the badge counts what the page will SHOW — the persisted period, not
  // the unfiltered total.
  const queued = useMemo(
    () => (inboxEnabled ? inboxCounts(entries)[inboxPeriod] : 0),
    [entries, inboxEnabled, inboxPeriod],
  );

  // M43: the same contract as the Inbox badge — the count is the page's own
  // membership rule, so the nav never promises work the page cannot show.
  const openCount = useMemo(() => openWork(entries, schema).length, [entries, schema]);

  // M3: every type the vault knows about — system, declared, and ghost.
  const types = useMemo(() => listTypes(entries, schema), [entries, schema]);

  // M10: one tree of Collections holding Lists, Folders and Docs. Project-scoped
  // legacy views are excluded by collectionsTree — they render as project tabs.
  const tree = useMemo(
    () => collectionsTree(collections, views, entries, schema),
    [collections, views, entries, schema],
  );
  // The tree can contain Collections that declare no marker (a folder is one
  // because it holds Lists), so menu actions resolve against the EFFECTIVE set
  // rather than the declared one — otherwise right-clicking such a folder finds
  // nothing and offers no actions at all.
  const effective = useMemo(
    () => effectiveCollections(collections, views, entries),
    [collections, views, entries],
  );

  // M43 — favorites are POINTERS, so a dead one is pruned rather than drawn:
  // the list stays truthful, and the star on any live page shows real state.
  const favoriteRows = useMemo(() => {
    const byPath = new Map(entries.map((e) => [e.path, e]));
    return favorites.flatMap((path) => {
      const entry = byPath.get(path);
      if (entry === undefined) return [];
      if (isAgentEntry(entry)) {
        const ref = agentRef(entry);
        return [
          {
            entry,
            icon: 'bot',
            color: 'var(--synapse-500)',
            onOpen: () => navigate({ kind: 'agents', actor: ref.actor }),
          },
        ];
      }
      const style = entry.type !== null ? typeStyle(entry.type, schema) : null;
      return [
        {
          entry,
          icon: style?.icon ?? 'file-text',
          color: style?.color ?? 'var(--n-500)',
          onOpen: () => openPath(entry.path),
        },
      ];
    });
  }, [favorites, entries, schema, navigate, openPath]);
  useEffect(() => {
    pruneFavorites(new Set(entries.map((e) => e.path)));
  }, [entries, pruneFavorites]);

  const nodeMenuItems = (node: CollectionNode): ContextMenuItem[] => {
    if (node.kind === 'collection') {
      const file = effective.find((c) => c.folder === node.id);
      if (file === undefined) return [];
      const items: ContextMenuItem[] = [
        {
          icon: 'plus',
          label: 'New list…',
          onSelect: () => onNewView(node.id),
        },
        {
          icon: 'pencil',
          label: 'Rename…',
          onSelect: () => setCollectionDialog({ mode: 'rename', collection: file }),
        },
      ];
      // Only a declared Collection has a marker to remove. An implied one is a
      // folder that holds Lists; "removing" it would have to move them, and
      // offering an action that silently does nothing is worse than not
      // offering it.
      if (file.declared) {
        items.push({
          icon: 'folder-minus',
          // Not "Delete": removing the marker un-collects the folder and leaves
          // every List and Doc inside it on disk. The label has to say so, or
          // people will expect their contents to be gone.
          label: 'Remove collection (keeps contents)',
          danger: true,
          onSelect: () => void deleteCollection(file),
        });
      }
      return items;
    }
    if (node.kind === 'list' && node.list !== undefined) {
      const list = node.list;
      return [
        {
          icon: 'trash-2',
          label: 'Delete list',
          danger: true,
          onSelect: () => void deleteList(list),
        },
      ];
    }
    return [];
  };

  const typeMenuItems = (listing: TypeListing): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    // System types are locked at the system level (Salesforce-style):
    // restyle is fine, rename/delete are not.
    if (!listing.system) {
      items.push({
        icon: 'pencil',
        label: 'Change display name…',
        onSelect: () => setTypeDialog({ mode: 'rename', listing }),
      });
    }
    items.push({
      icon: 'palette',
      label: 'Customize icon & color…',
      onSelect: () => setTypeDialog({ mode: 'style', listing }),
    });
    if (!listing.system && listing.docPath !== null) {
      items.push({
        icon: 'trash-2',
        label: 'Delete database',
        danger: true,
        onSelect: () => setTypeDialog({ mode: 'delete', listing }),
      });
    }
    return items;
  };

  // M43 — the design's collapsed state: no hairline column, a floating
  // cluster at the window's top-left instead. Expand, ask, and search stay
  // reachable because those three are the chrome's whole promise; the canvas
  // gets every other pixel.
  if (collapsed) {
    return (
      <div className="absolute left-2.5 top-2.5 z-20 flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Show sidebar"
          data-testid="sidebar-expand"
          onClick={() => setCollapsed(false)}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 bg-transparent text-n-600 hover:bg-n-100 hover:text-n-900"
        >
          <Icon name="panel-left" size={15} />
        </button>
        <button
          type="button"
          aria-label="Assistant"
          aria-pressed={aiPanelOpen}
          onClick={() => setAiPanelOpen(!aiPanelOpen)}
          className={`flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 ${
            aiPanelOpen ? 'bg-surface-selected' : 'bg-transparent'
          } hover:bg-n-100`}
        >
          <Icon name="zap" size={15} color="var(--synapse-500)" />
        </button>
        <button
          type="button"
          aria-label="Search"
          title="Search  ⌘K"
          onClick={() => setQuickOpen(true)}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 bg-transparent text-n-600 hover:bg-n-100 hover:text-n-900"
        >
          <Icon name="search" size={15} />
        </button>
      </div>
    );
  }

  // The vault, named as its folder — worn as the header tile (M43), which
  // keeps answering "which vault" from the slot the design gives an avatar.
  const vaultName = vaultPath?.split('/').filter(Boolean).pop() ?? 'Vault';

  return (
    <nav
      aria-label="Sidebar"
      data-testid="sidebar"
      // `relative` hosts the drag handle; the width is a stored preference
      // rather than a constant, because 264px is only right for some vaults
      // and some window sizes (M11 responsiveness).
      // M15: SHRINKABLE — `flex-none` here is what made the canvas absorb every
      // pixel of a narrow window. It gives ground down to SIDEBAR_WIDTH_MIN
      // before the canvas gives up anything, which is the whole layout contract.
      // DS: the sidebar is a SUNKEN surface — the canvas is the white thing
      // (M42.1). One token, so dark theme remaps it by role.
      className="relative flex flex-col overflow-hidden border-r border-n-200 bg-surface-sunken"
      style={{ width: narrow ? SIDEBAR_WIDTH_MIN : width, minWidth: SIDEBAR_WIDTH_MIN }}
    >
      {/* Withdrawn while narrow: the sidebar is already pinned at its minimum,
          so a handle there could only fight a ceiling — and dragging it would
          overwrite the width the user chose for a wide window. */}
      {!narrow && (
        <ResizeHandle
          label="Resize sidebar"
          side="right"
          width={width}
          min={SIDEBAR_WIDTH_MIN}
          max={SIDEBAR_WIDTH_MAX}
          onResize={setWidth}
        />
      )}
      <div className="flex items-center gap-2 py-3 pl-3.5 pr-2.5">
        <span
          data-testid="vault-tile"
          title={vaultName}
          className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md bg-cortex-500 text-xs font-bold text-n-0"
        >
          {vaultName.charAt(0).toUpperCase()}
        </span>
        <span className="text-[15px] font-bold tracking-[-0.02em] text-n-900">
          cerebro<span className="text-synapse-500">.</span>
        </span>
        <span className="flex-1" />
        {/* The one AI act in the chrome — synapse, and a toggle, not a door. */}
        <button
          type="button"
          aria-label="Assistant"
          aria-pressed={aiPanelOpen}
          onClick={() => setAiPanelOpen(!aiPanelOpen)}
          className={`flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md border-0 ${
            aiPanelOpen ? 'bg-surface-selected' : 'bg-transparent'
          } hover:bg-n-100`}
        >
          <Icon name="zap" size={15} color="var(--synapse-500)" />
        </button>
        {/* The same ⌘K QuickOpen; here because a one-column nav is where the
            hand already is. One dialog, one door since the Topbar dissolved. */}
        <button
          type="button"
          aria-label="Search"
          title="Search  ⌘K"
          onClick={() => setQuickOpen(true)}
          className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-600 hover:bg-n-100 hover:text-n-900"
        >
          <Icon name="search" size={15} />
        </button>
        <button
          type="button"
          aria-label="Hide sidebar"
          data-testid="sidebar-collapse"
          onClick={() => setCollapsed(true)}
          className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name="panel-left" size={15} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {/* The New button (M43) — the CreateMenu, rehomed from the Topbar. */}
        <div className="mb-2">
          <CreateMenu />
        </div>
        {/* M42.2 — every destination that owns subjects is a GROUP whose
            rows nest under it, on every surface (the Notion shape the user
            asked for by name). Heads live in `nav-surfaces` containers;
            nested rows live OUTSIDE them, because nested labels are not
            destinations and an agent named "Home" must never be caught by a
            spec scoped to the destinations. Only the deepest thing you are
            on lights up — a lit parent above a lit child is two rows
            claiming one place. */}
        <div data-testid="nav-surfaces">
          {inboxEnabled && (
            <SurfaceRow
              icon="inbox"
              label="Inbox"
              hot
              active={selection.kind === 'inbox'}
              count={queued}
              onClick={() => navigate({ kind: 'inbox' })}
            />
          )}
          <SurfaceRow
            icon="house"
            label="Home"
            active={homeActive}
            onClick={() => navigate({ kind: 'home' })}
          />
          {/* M43 — open work across every database. The quiet count is the
              page's own membership rule (engine/myWork), never a promise the
              page cannot keep. */}
          <SurfaceRow
            icon="circle-check"
            label="My work"
            active={selection.kind === 'mywork'}
            count={openCount}
            onClick={() => navigate({ kind: 'mywork' })}
          />
          {/* M43.10 — the app-like surfaces are STANDALONE rows under My
              work: Studio and History carry no nested subjects (a prototype
              is reachable from Studio's own bench), and the repos and Base
              moved down into sections, where their rows read like every
              other shelf. */}
          <SurfaceRow
            icon="pencil-ruler"
            label="Studio"
            active={selection.kind === 'studio'}
            onClick={() => navigate({ kind: 'studio' })}
          />
          {/* M9.4 — the vault's history. No badge: a count of commits is
              chrome. The footer SyncBadge speaks instead, and only when
              something needs doing. */}
          <SurfaceRow
            icon="activity"
            label="History"
            active={historyActive}
            onClick={() => navigate({ kind: 'pulse' })}
          />
          {/* Up from the footer (M43): the Library is a place you work —
              agents, skills, blocks — not a dial you set. `blocks`, not
              `library`: Pages already owns the book glyph, and two rows drawn
              identically is the nav failing at the one job it has (M18). */}
          <SurfaceRow
            icon="blocks"
            label="Library"
            active={selection.kind === 'library'}
            onClick={() => navigate({ kind: 'library' })}
          />
        </div>
        {/* M10: Collections are the top-level navigation of the item world. A
            Collection is a container — it holds Lists, Folders and Docs —
            where a "view" used to be both the container and the query at once. */}
        <SectionHeader
          label="Collections"
          open={groupOpen('collections')}
          onToggle={() => setNavGroupOpen('collections', !groupOpen('collections'))}
          actions={[
            {
              icon: 'plus',
              label: 'New collection',
              testId: 'new-collection',
              onClick: () => setCollectionDialog({ mode: 'new' }),
            },
          ]}
        />
        {groupOpen('collections') && (
          <>
            {tree.length === 0 ? (
              <div className="px-2 py-1 text-xs leading-[17px] text-n-400">
                No collections yet — make one to hold lists, folders, and docs.
              </div>
            ) : null}
            {/* Everything lives in a Collection. There is deliberately no second
                grouping beside this one: a folder holding Lists IS a Collection, so
                a List cannot be orphaned and nothing needs a home of last resort. */}
            <CollectionTree
              nodes={tree}
              selection={selection}
              onNavigate={navigate}
              onOpenDoc={openPath}
              menuFor={nodeMenuItems}
              onAdd={(node) => onNewView(node.id)}
            />
          </>
        )}
        {/* M38.3 — the Docs destination died with its surface; the tree it
            used to gate is a standing section, because in a shell where
            everything is a page the pages ARE navigation, not a mode. Outside
            the destinations containers on purpose: the tree's folder rows
            share accessible names with destination rows (`inbox/` vs Inbox),
            and a spec scoped to `nav-surfaces` must never catch a folder.
            M43: creation moved into the header's reveals — the tree's own
            openers, through createRef, so there is exactly one dialog. */}
        <SectionHeader
          label="Pages"
          open={groupOpen('pages')}
          onToggle={() => setNavGroupOpen('pages', !groupOpen('pages'))}
          actions={[
            {
              icon: 'folder-plus',
              label: 'New folder',
              onClick: () => pagesCreate.current?.newFolder(),
            },
            { icon: 'file-plus', label: 'New page', onClick: () => pagesCreate.current?.newPage() },
          ]}
        />
        {groupOpen('pages') && (
          <FileTree
            root=""
            docsOnly
            showCreateBar={false}
            createRef={pagesCreate}
            activePath={selection.kind === 'doc' ? selection.path : null}
            onOpen={openPath}
          />
        )}
        {/* M30 — mounted repositories, worn as a section since M43.10: each
            mounted folder is a row, the way every other shelf lists its
            subjects. The label is the locked name (M37.2); the `workspace`
            KIND stays — kinds are internal vocabulary shared with the
            navigate MCP tool. The ↗ is the door to the Work surface. */}
        <SectionHeader
          label="Work"
          open={groupOpen('work')}
          onToggle={() => setNavGroupOpen('work', !groupOpen('work'))}
          actions={[
            {
              icon: 'arrow-up-right',
              label: 'Open all repositories',
              onClick: () => navigate({ kind: 'workspace' }),
            },
          ]}
        />
        {groupOpen('work') &&
          (roots.length === 0 ? (
            <div className="px-2 py-1 text-xs text-n-400">No repositories mounted</div>
          ) : (
            <div data-section="nav-work">
              {roots.map((root) => {
                const on = selection.kind === 'workspace' && selection.root === root.id;
                return (
                  <button
                    key={root.id}
                    type="button"
                    data-testid="nav-root"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => navigate({ kind: 'workspace', root: root.id })}
                    className={rowClass(on)}
                  >
                    <Icon name="folder-git-2" size={15} color={root.color ?? 'var(--n-500)'} />
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                      {root.label}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        {/* M5: the agent's corpus — different author, different rules — worn
            as a section since M43.10, the same anatomy as Pages. M33a.2
            folded the Status hub in, so this one shelf is both what the base
            holds and what it knows about itself. Still no badge, deliberately
            (M8.1/M27.8): a shelf may say how big it is; nothing counts up at
            you from the chrome. `nav` passed through undefined on a nav-less
            selection: which view that lands on is the nav's own answer
            (M33a.3), and defaulting it here would make the sidebar a second
            opinion. `current` keeps an un-current nav from electing a default
            row for a canvas some other surface owns. */}
        <SectionHeader
          label="Base"
          open={groupOpen('base')}
          onToggle={() => setNavGroupOpen('base', !groupOpen('base'))}
          actions={[
            {
              icon: 'arrow-up-right',
              label: 'Open base',
              onClick: () => navigate({ kind: 'knowledge' }),
            },
          ]}
        />
        {groupOpen('base') && (
          <div data-section="nav-base">
            <KnowledgeNav
              nav={selection.kind === 'knowledge' ? selection.nav : undefined}
              current={knowledgeMode}
            />
          </div>
        )}
        {/* M43 — Agents is a SECTION now, the design's sec(): the fleet is a
            roster of subjects, and the ↗ is the door to the fleet surface the
            M41 destination row used to be. Rows keep their testids and stay
            outside `nav-surfaces` (the e2e scoping rule survives the move). */}
        <SectionHeader
          label="Agents"
          open={groupOpen('agents')}
          onToggle={() => setNavGroupOpen('agents', !groupOpen('agents'))}
          actions={[
            {
              icon: 'arrow-up-right',
              label: 'Open all agents',
              onClick: () => navigate({ kind: 'agents' }),
            },
            {
              icon: 'plus',
              label: 'New agent',
              testId: 'nav-agent-new',
              onClick: () => navigate({ kind: 'library', tab: 'agent' }),
            },
          ]}
        />
        {groupOpen('agents') && (
          <div data-section="nav-agents">
            {agents.map(({ ref, paused }) => {
              const on = selection.kind === 'agents' && selection.actor === ref.actor;
              return (
                <button
                  key={ref.path}
                  type="button"
                  data-testid="nav-agent"
                  aria-current={on ? 'page' : undefined}
                  onClick={() => navigate({ kind: 'agents', actor: ref.actor })}
                  className={`${rowClass(on)}${paused && !on ? ' text-n-500' : ''}`}
                >
                  {/* Synapse, the one violet in the chrome: these rows ARE
                      the AI surfaces the DS reserves it for. A paused agent
                      dims and wears the pause tail — off duty, not gone. */}
                  <Icon
                    name="bot"
                    size={15}
                    color={paused ? 'var(--n-400)' : 'var(--synapse-500)'}
                  />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                    {ref.title}
                  </span>
                  {paused && (
                    <span className="ml-auto inline-flex text-n-400">
                      <Icon name="pause" size={12} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {/* M3's collapsible Types section, wearing what it always was
            (M39.2): the databases. The `type:` key, the metamodel, and every
            internal identifier keep the old word — labels spend, kinds stay,
            same rule as M37.2. Open state stays on `typesOpen` — it was
            persisted long before the closed set existed. */}
        <SectionHeader
          label="Databases"
          open={typesOpen}
          onToggle={() => setTypesOpen(!typesOpen)}
          actions={[
            // M12.6: the schema doctor — adopt an existing vault's freeform
            // frontmatter into declared types, one reviewed pass.
            {
              icon: 'wand-sparkles',
              label: 'Adopt vault schema',
              onClick: () => setAdopting(true),
            },
            { icon: 'plus', label: 'New database', onClick: () => setTypeDialog({ mode: 'new' }) },
          ]}
        />
        {typesOpen &&
          types.map((t) => {
            const typeActive = selection.kind === 'type' && selection.name === t.name;
            return (
              <button
                key={t.name}
                type="button"
                data-testid="sidebar-type"
                aria-current={typeActive ? 'page' : undefined}
                onClick={() => navigate({ kind: 'type', name: t.name })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTypeMenu({ x: e.clientX, y: e.clientY, listing: t });
                }}
                className={rowClass(typeActive)}
              >
                <Icon name={t.icon} size={15} color={t.color ?? 'var(--n-500)'} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t.name}</span>
                <span className="ml-auto [font-family:var(--font-mono)] text-2xs text-n-400">
                  {t.count}
                </span>
              </button>
            );
          })}
        {/* M43 — pinned pages, records, and agents. An empty list IS
            measured-at-zero (nobody pinned anything), so words are the honest
            render — never a hidden section, which would make the first pin
            appear to invent a place. */}
        <SectionHeader
          label="Favorites"
          open={groupOpen('favorites')}
          onToggle={() => setNavGroupOpen('favorites', !groupOpen('favorites'))}
        />
        {groupOpen('favorites') &&
          (favoriteRows.length === 0 ? (
            <div className="px-2 py-1 text-xs text-n-400">No favorites yet</div>
          ) : (
            favoriteRows.map(({ entry, icon, color, onOpen }) => (
              <button
                key={entry.path}
                type="button"
                data-testid="nav-favorite"
                onClick={onOpen}
                className={rowClass(false)}
              >
                <Icon name={icon} size={15} color={color} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                  {entry.title}
                </span>
              </button>
            ))
          ))}
      </div>
      {/* The footer (M43): the SyncBadge speaks only when something needs
          doing (M9.4), the theme cycles in place, and Settings keeps its
          below-the-fold seat — where you go to CHANGE how the app works
          rather than somewhere you work. */}
      <div
        data-testid="nav-surfaces"
        className="flex flex-none items-center gap-0.5 border-t border-n-200 px-2 py-1.5"
      >
        <SyncBadge />
        <button
          type="button"
          onClick={() => setThemeMode(THEME_NEXT[themeMode])}
          title={`Theme: ${themeMode}`}
          className="flex h-[30px] flex-1 items-center gap-2 rounded-md border-0 bg-transparent px-2 text-left text-xs text-n-600 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name={THEME_ICONS[themeMode]} size={15} />
          Theme
        </button>
        <button
          type="button"
          aria-current={selection.kind === 'settings' ? 'page' : undefined}
          onClick={() => navigate({ kind: 'settings' })}
          className={`flex h-[30px] flex-1 items-center gap-2 rounded-md border-0 px-2 text-left text-xs ${
            selection.kind === 'settings'
              ? 'bg-surface-selected font-medium text-cortex-700'
              : 'bg-transparent text-n-600 hover:bg-n-100 hover:text-n-800'
          }`}
        >
          <Icon name="settings" size={15} />
          Settings
        </button>
      </div>
      {typeMenu !== null && (
        <ContextMenu
          x={typeMenu.x}
          y={typeMenu.y}
          items={typeMenuItems(typeMenu.listing)}
          onClose={() => setTypeMenu(null)}
        />
      )}
      {collectionDialog !== null && (
        <CollectionDialog
          state={collectionDialog}
          onClose={() => setCollectionDialog(null)}
          onCreated={(folder) => navigate({ kind: 'collection', folder })}
        />
      )}
      {typeDialog?.mode === 'new' && <NewTypeDialog onClose={() => setTypeDialog(null)} />}
      {typeDialog?.mode === 'rename' && (
        <RenameTypeDialog listing={typeDialog.listing} onClose={() => setTypeDialog(null)} />
      )}
      {typeDialog?.mode === 'style' && (
        <TypeStyleDialog listing={typeDialog.listing} onClose={() => setTypeDialog(null)} />
      )}
      {typeDialog?.mode === 'delete' && (
        <DeleteTypeDialog listing={typeDialog.listing} onClose={() => setTypeDialog(null)} />
      )}
      {adopting && <AdoptSchemaDialog onClose={() => setAdopting(false)} />}
    </nav>
  );
}
