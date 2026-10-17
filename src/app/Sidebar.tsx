import { AppRail } from '@/app/AppRail';
import { areaForSelection, NAV_AREAS, type NavArea } from '@/app/shellNavigation';
import { openBesideIntent } from '@/app/openIntent';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import type { PageNavigationControls, PageNavigationKind } from './PageNavigation';
import { FileTree } from '@/components/FileTree';
import { EntryIcon } from '@/components/PageIcon';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { DrawerScrim, useDrawerFocus } from '@/components/ui/DrawerScrim';
import { Icon } from '@/components/ui/Icon';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import {
  DeleteTypeDialog,
  NewTypeDialog,
  RenameTypeDialog,
  TypeStyleDialog,
} from '@/app/TypeDialogs';
import { AdoptSchemaDialog } from '@/app/AdoptSchemaDialog';
import { CsvImportDialog } from '@/app/CsvImportDialog';
import { CollectionTree } from '@/app/CollectionTree';
import { CollectionDialog } from '@/app/CollectionDialog';
import { CreateMenu } from '@/app/CreateMenu';
import { createPageIn, deleteCollection, deleteList } from '@/app/listActions';
import { createDatabase } from '@/app/typeActions';
import { SectionHeader } from '@/app/SectionHeader';
import { SHELL_CLASSES, type ShellBands } from '@/app/shellLayout';
import { useOpenPath } from '@/app/useOpenPath';
import { rowClass } from '@/app/sidebarChrome';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { collectionsTree, effectiveCollections } from '@/engine/collections';
import { destination, visibleDestinations, type DestinationKind } from '@/engine/destinations';
import { inboxCounts } from '@/engine/inbox';
import { isPaused } from '@/engine/jobs';
import { openWork } from '@/engine/myWork';
import { isKnowledgePath, RESERVED_FILENAMES, sectionOfPath } from '@/engine/okf';
import { listTypes, typeStyle, type TypeListing } from '@/engine/typeCatalog';
import type {
  CollectionFile,
  CollectionNode,
  KnowledgeNav as KnowledgeNavState,
} from '@/engine/types';
import { SyncBadge } from '@/git/SyncBadge';
import { KnowledgeNav } from '@/knowledge/KnowledgeNav';
import { useNavStore } from '@/stores/navStore';
import { useRootsStore } from '@/stores/rootsStore';
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export interface SidebarProps {
  onAssistantNavigationTarget?: (node: HTMLDivElement | null) => void;
  pageNavigationKind?: PageNavigationKind | null;
  onPageNavigationTarget?: (node: HTMLDivElement | null) => void;
  pageNavigationRef?: Ref<PageNavigationControls>;
  /** Narrow windows keep the rail and open the context panel as a drawer.
   * The stored width stays untouched for the next wide window. */
  narrow?: boolean;
  /**
   * Where the window's width steps the sidebar down to its icon rail, so a
   * record and the assistant both fit — or, narrower still, the parked
   * assistant's tab (M52, app/shellLayout.ts `shellBands`).
   * CSS draws the step, in the same layout pass as the width that calls for
   * it: the column and the rail are both mounted, and a media query shows
   * one. Derived, like `narrow`: the stored collapsed flag is not asked or
   * written.
   */
  railBand?: ShellBands['rail'];
  /**
   * The rail is what is drawn now (`shellPlan`) — a frame behind the CSS, so
   * it decides nothing on screen. The rail's expand control opens the whole
   * sidebar as a drawer over the canvas, and this closes that drawer once
   * the rail is gone.
   */
  rail?: boolean;
  /**
   * The widest the sidebar can be drawn beside the main column's floor (M52,
   * `sidebarCeiling`). Its drag stops here, so it never stores a width it
   * cannot draw.
   */
  maxWidth?: number;
}

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
  command,
  count,
  hot = false,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  /** Opens and closes a panel rather than going somewhere. */
  toggle?: boolean;
  command?: string;
  /** Queue size shown as a badge; omitted or 0 renders nothing. */
  count?: number;
  /** A count that wants acting on — cortex ink instead of the quiet gray
   * (M43, the design's Inbox). Still a number, never a filled pill. */
  hot?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} command={command}>
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
    </Tooltip>
  );
}

/** M71: a persistent application rail and one contextual navigation panel.
 * Existing trees and their actions keep their owners; choosing a rail area
 * changes which shelf is visible, without changing the underlying corpus. */
export function Sidebar({
  narrow = false,
  railBand = 'none',
  rail = false,
  maxWidth,
  onAssistantNavigationTarget,
  pageNavigationKind = null,
  onPageNavigationTarget,
  pageNavigationRef,
}: SidebarProps) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const status = useVaultStore((s) => s.status);
  const views = useVaultStore((s) => s.views);
  const schema = useSchema();
  const selection = useNavStore((s) => s.selection);
  const navigateInPlace = useNavStore((s) => s.navigate);
  const openPane = useNavStore((s) => s.openPane);
  const navigate = (selection: import('@/engine/types').Selection) =>
    openBesideIntent() ? openPane(selection) : navigateInPlace(selection);
  const typesOpen = useUiStore((s) => s.typesOpen);
  const setTypesOpen = useUiStore((s) => s.setTypesOpen);
  const width = useUiStore((s) => s.sidebarWidth);
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const inboxPeriod = useUiStore((s) => s.inboxPeriod);
  const favoritesByVault = useUiStore((s) => s.favorites);
  const renamePending = useUiStore(
    (s) => vaultPath !== null && (s.pendingRenames[vaultPath] ?? 0) > 0,
  );
  const pruneFavorites = useUiStore((s) => s.pruneFavorites);
  const openPath = useOpenPath();

  const collections = useVaultStore((s) => s.collections);
  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState | null>(null);
  const [typeDialog, setTypeDialog] = useState<TypeDialog | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; folder: string } | null>(null);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number; listing: TypeListing } | null>(
    null,
  );
  const pagesCreate = useRef<{ newPage(): void; newFolder(): void } | null>(null);
  // The contextual drawer belongs to the selection it opened on, so going
  // anywhere closes it. Returning to the full column also retires it.
  const [pickedArea, setPickedArea] = useState<{
    selection: typeof selection;
    area: NavArea;
  } | null>(null);
  const area =
    pickedArea?.selection === selection ? pickedArea.area : areaForSelection(selection, entries);
  const chat = useUiStore((state) => state.aiPanelOpen && state.aiPanelPresentation === 'canvas');
  const pageContext = !chat && pickedArea?.selection !== selection ? pageNavigationKind : null;
  const show = (...areas: NavArea[]) => !chat && pageContext === null && areas.includes(area);
  const compact = collapsed || rail || narrow;
  const [drawerAt, setDrawerAt] = useState<typeof selection | null>(null);
  if (!compact && drawerAt !== null) setDrawerAt(null);
  const drawer = compact && drawerAt === selection;
  const drawerRef = useDrawerFocus<HTMLElement>(drawer);
  const navigationOpener = useRef<HTMLElement | null>(null);
  const hidePageNavigation = useCallback(() => {
    const priorFocus = document.activeElement;
    const restore =
      drawer && priorFocus instanceof HTMLElement && drawerRef.current?.contains(priorFocus);
    const opener = navigationOpener.current;
    setDrawerAt(null);
    if (restore && opener)
      queueMicrotask(() => {
        const current = document.activeElement;
        if (
          opener.isConnected &&
          !opener.closest('[hidden], [inert]') &&
          (current === priorFocus ||
            current === document.body ||
            (current instanceof Node && drawerRef.current?.contains(current)))
        ) {
          opener.focus({ preventScroll: true });
        }
      });
  }, [drawer, drawerRef]);
  useImperativeHandle(
    pageNavigationRef,
    () => ({
      show: (opener) => {
        // WebKit pointer clicks need not focus buttons. Give the existing
        // drawer's Escape restoration the same explicit opener as selection.
        opener?.focus({ preventScroll: true });
        navigationOpener.current =
          opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setPickedArea(null);
        if (compact) setDrawerAt(selection);
      },
      hide: hidePageNavigation,
    }),
    [compact, hidePageNavigation, selection],
  );
  const chooseArea = (next: NavArea) => {
    useUiStore.getState().setAiPanelPresentation('panel');
    const target = NAV_AREAS.find((item) => item.id === next)?.destination;
    if (target !== undefined) navigate(destination(target).selection);
    const current = useNavStore.getState().selection;
    setPickedArea(
      current.kind === 'workspace' && next === 'work' ? null : { selection: current, area: next },
    );
    if (compact) setDrawerAt(current);
  };

  // M8.1: Base navigates by its own axes rather than borrowing Views and
  // Types, which describe a corpus with a different author; its rows nest
  // under the Base row (always available since M42.2).
  //
  // M52.3 — a concept opens as a page (M50.1), and on that page no row lit:
  // the nav said you were nowhere in Knowledge while you read one of its
  // concepts. Its folder row lights, the way the Pages tree lights the page
  // you are on. The bundle's own `index.md`/`log.md` are structure, not
  // concepts (M52.4): at the root they would light "Ungrouped", a folder they
  // are not counted in. A folder's own index still lights its folder.
  const onConcept =
    selection.kind === 'doc' &&
    isKnowledgePath(selection.path) &&
    !(
      sectionOfPath(selection.path) === '' &&
      RESERVED_FILENAMES.includes(selection.path.split('/').pop() ?? '')
    );
  const knowledgeNav: KnowledgeNavState | undefined =
    selection.kind === 'knowledge'
      ? selection.nav
      : onConcept
        ? { tab: 'section', folder: sectionOfPath(selection.path) }
        : undefined;
  const knowledgeMode = selection.kind === 'knowledge' || onConcept;

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
  // M15: the badge counts what the page will SHOW — the persisted period, not
  // the unfiltered total.
  const queued = useMemo(
    () => (inboxEnabled ? inboxCounts(entries)[inboxPeriod] : 0),
    [entries, inboxEnabled, inboxPeriod],
  );

  // M43: the same contract as the Inbox badge — the count is the page's own
  // membership rule, so the nav never promises work the page cannot show.
  const openCount = useMemo(() => openWork(entries, schema).length, [entries, schema]);
  const counts: Partial<Record<DestinationKind, number>> = { inbox: queued, mywork: openCount };
  // The table's standalone rows, in its order; Inbox only with its workflow.
  const rows = visibleDestinations({ inboxEnabled }).filter((d) => d.nav === 'row');
  const work = destination('workspace');
  const knowledge = destination('knowledge');
  const fleet = destination('agents');

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
  // Read (and pruned) for THIS vault only: another vault's pins are none of
  // this scan's business, and pruning them against it would delete them.
  const favorites = useMemo(
    () => (vaultPath === null ? [] : (favoritesByVault[vaultPath] ?? [])),
    [favoritesByVault, vaultPath],
  );
  const favoriteRows = useMemo(() => {
    const byPath = new Map(entries.map((e) => [e.path, e]));
    return favorites.flatMap((path) => {
      const entry = byPath.get(path);
      if (entry === undefined) return [];
      // An agent opens as its page like any pin (M55.12); it keeps its bot.
      if (isAgentEntry(entry)) {
        return [
          {
            entry,
            icon: 'bot',
            color: 'var(--synapse-500)',
            onOpen: () => openPath(entry.path),
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
  }, [favorites, entries, schema, openPath]);
  useEffect(() => {
    if (vaultPath === null || status !== 'ready' || entriesVault !== vaultPath || renamePending)
      return;
    pruneFavorites(vaultPath, new Set(entries.map((e) => e.path)));
  }, [entries, entriesVault, pruneFavorites, status, vaultPath, renamePending]);

  const nodeMenuItems = (node: CollectionNode): ContextMenuItem[] => {
    if (node.kind === 'collection') {
      const file = effective.find((c) => c.folder === node.id);
      if (file === undefined) return [];
      const items: ContextMenuItem[] = [
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

  /**
   * What a container's `+` offers (M47.5, narrowed by M47.6).
   *
   * A PAGE first, then a database — the two things a container can hold now
   * that everything is a page. The only door this had before was "New list",
   * which is why the empty collection page could do nothing but tell you to go
   * and use the sidebar, and why there was no way to put a doc in a collection
   * at all. M47.6 closed the third door: a saved view belongs to the database
   * it queries (`views:` on its Type doc), so authoring a standalone
   * `*.list.yml` would be authoring the lane M47 exists to retire. The ones
   * already on disk still open and still edit — see listActions.
   */
  const addMenuItems = (folder: string): ContextMenuItem[] => [
    {
      icon: 'file-plus',
      label: 'New page',
      onSelect: () =>
        void (async () => {
          // createPageIn toasts its own failure and answers null.
          const path = await createPageIn(folder);
          if (path !== null) openPath(path);
        })(),
    },
    {
      icon: 'table-2',
      label: 'New database',
      onSelect: () =>
        void (async () => {
          const name = await createDatabase('Untitled database');
          if (name !== null) navigate({ kind: 'type', name });
        })(),
    },
  ];

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

  const band = SHELL_CLASSES.rail[railBand];

  // The widest this can be drawn, and so where its drag stops (M52).
  const ceiling = maxWidth ?? SIDEBAR_WIDTH_MAX;

  // The vault, named as its folder — worn as the header tile (M43), which
  // keeps answering "which vault" from the slot the design gives an avatar.
  const vaultName = vaultPath?.split('/').filter(Boolean).pop() ?? 'Vault';

  const nav = (
    <nav
      ref={drawerRef}
      aria-label="Sidebar"
      data-testid="sidebar"
      data-nav-area={area}
      data-page-navigation={pageContext ?? undefined}
      hidden={collapsed && !drawer}
      // Neutral chrome for the keymap, like the rail above (M65.1).
      data-key-neutral
      data-overlay={drawer || undefined}
      tabIndex={drawer ? -1 : undefined}
      // `relative` hosts the drag handle; the width is a stored preference
      // rather than a constant, because 240px is only right for some vaults
      // and some window sizes (M11 responsiveness).
      // M15: SHRINKABLE — `flex-none` here is what made the canvas absorb every
      // pixel of a narrow window. It gives ground down to SIDEBAR_WIDTH_MIN
      // before the canvas gives up anything, which is the whole layout contract.
      // DS: the sidebar is a SUNKEN surface — the canvas is the white thing
      // (M42.1). One token, so dark theme remaps it by role.
      // M52: opened from the rail it is a drawer, over the canvas and out of
      // the row — the row had no room for it, which is why it was a rail.
      className={[
        'm71-sidebar flex flex-col overflow-hidden',
        drawer
          ? 'm71-sidebar-drawer fixed inset-y-0 z-40 shadow-[var(--shadow-lg)] outline-none'
          : `relative max-[1048px]:hidden ${band.column}`,
      ].join(' ')}
      style={
        drawer
          ? { width, maxWidth: 'calc(100vw - 64px)', left: 54 }
          : { width, minWidth: SIDEBAR_WIDTH_MIN }
      }
    >
      {/* Withdrawn while narrow: the sidebar opens as a drawer,
          so a handle there would
          overwrite the width the user chose for a wide window. Withdrawn from
          the drawer too, which floats at the stored width rather than in the
          row the handle measures against. */}
      {!narrow && !drawer && (
        <ResizeHandle
          label="Resize sidebar"
          side="right"
          width={Math.min(width, ceiling)}
          preferred={width}
          min={SIDEBAR_WIDTH_MIN}
          max={ceiling}
          onResize={setWidth}
        />
      )}
      <div className="m71-sidebar-header">
        <div className="m71-workspace-name" title={vaultName}>
          <span data-testid="vault-tile" className="m71-vault-tile">
            {vaultName.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 truncate">{vaultName}</span>
        </div>
        <Tooltip label="Hide sidebar">
          <button
            type="button"
            aria-label="Hide sidebar"
            data-testid="sidebar-collapse"
            onClick={() => (drawer ? setDrawerAt(null) : setCollapsed(true))}
            className="m71-icon-button"
          >
            <Icon name="panel-left" size={17} />
          </button>
        </Tooltip>
      </div>
      <div className="m71-context-heading">
        <span>
          {chat
            ? 'Assistant'
            : pageContext === 'inbox'
              ? 'Inbox'
              : pageContext === 'settings'
                ? 'Settings'
                : pageContext === 'workspace'
                  ? 'Work'
                  : pageContext === 'studio'
                    ? 'Studio'
                    : NAV_AREAS.find((item) => item.id === area)?.label}
        </span>
      </div>
      <div className="m71-context-body flex-1 overflow-y-auto px-3 pb-4">
        <div ref={onAssistantNavigationTarget} data-testid="assistant-navigation" hidden={!chat} />
        <div
          ref={onPageNavigationTarget}
          data-testid="page-navigation"
          hidden={pageContext === null}
        />

        {/* The New button (M43) — the CreateMenu, rehomed from the Topbar. */}
        <div className="m81-context-create" hidden={chat || pageContext !== null}>
          <CreateMenu />
        </div>
        {/* The destination rows, from engine/destinations.ts (M59.1) — each
            row's rationale lives on its row there. Nested rows live OUTSIDE
            `nav-surfaces`, because nested labels are not destinations and an
            agent named "Home" must never be caught by a spec scoped to the
            destinations. */}
        <div data-testid="nav-surfaces" hidden={!show('home')}>
          {rows.map((d) => (
            <SurfaceRow
              key={d.kind}
              icon={d.icon}
              label={d.label}
              command={`go.${d.id}`}
              hot={d.hot === true}
              active={d.lights.includes(selection.kind)}
              count={counts[d.kind]}
              onClick={() => navigate(d.selection)}
            />
          ))}
        </div>
        <div hidden={!show('home', 'pages')}>
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
                // The `+` opens a menu; see addMenuItems for what is behind it
                // and why the third door closed (M47.5, M47.6).
                onAdd={(node, at) => setAddMenu({ ...at, folder: node.id })}
              />
            </>
          )}
        </div>
        <div hidden={!show('pages')}>
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
              {
                icon: 'file-plus',
                label: 'New page',
                onClick: () => pagesCreate.current?.newPage(),
              },
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
        </div>
        <div hidden={!show('work')}>
          {/* M30 — mounted repositories, worn as a section since M43.10: each
            mounted folder is a row, the way every other shelf lists its
            subjects. The label and the ↗ door to the Work surface are the
            table's (M59.1). */}
          <SectionHeader
            label={work.label}
            open={groupOpen('work')}
            onToggle={() => setNavGroupOpen('work', !groupOpen('work'))}
            actions={[
              {
                icon: 'arrow-up-right',
                label: work.door ?? work.label,
                command: `go.${work.id}`,
                onClick: () => navigate(work.selection),
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
        </div>
        <div hidden={!show('knowledge')}>
          {/* M5: the agent's corpus — different author, different rules — worn
            as a section since M43.10, the same anatomy as Pages. M50.5 named
            it Knowledge (it was "Base"; the group key and `data-section` keep
            the old word); M51 made its rows the bundle's folders and the
            review queue, and the ↗ opens every concept. Still no badge,
            deliberately (M8.1/M27.8): a shelf may say how big it is; nothing
            counts up at you from the chrome. `current` keeps an un-current
            nav from lighting a row for a canvas some other surface owns. */}
          <SectionHeader
            label={knowledge.label}
            open={groupOpen('base')}
            onToggle={() => setNavGroupOpen('base', !groupOpen('base'))}
            actions={[
              {
                icon: 'arrow-up-right',
                label: knowledge.door ?? knowledge.label,
                command: `go.${knowledge.id}`,
                onClick: () => navigate(knowledge.selection),
              },
            ]}
          />
          {groupOpen('base') && (
            <div data-section="nav-base">
              <KnowledgeNav nav={knowledgeNav} current={knowledgeMode} />
            </div>
          )}
        </div>
        <div hidden={!show('agents')}>
          {/* M43 — Agents is a SECTION now, the design's sec(): the fleet is a
            roster of subjects, and the ↗ is the door to the fleet surface the
            M41 destination row used to be. Each row opens that agent's page
            (M55.12). Rows keep their testids and stay outside `nav-surfaces`
            (the e2e scoping rule survives the move). */}
          <SectionHeader
            label={fleet.label}
            open={groupOpen('agents')}
            onToggle={() => setNavGroupOpen('agents', !groupOpen('agents'))}
            actions={[
              {
                icon: 'arrow-up-right',
                label: fleet.door ?? fleet.label,
                command: `go.${fleet.id}`,
                onClick: () => navigate(fleet.selection),
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
                const on = selection.kind === 'doc' && selection.path === ref.path;
                return (
                  <button
                    key={ref.path}
                    type="button"
                    data-testid="nav-agent"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => navigate({ kind: 'doc', path: ref.path })}
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
        </div>
        <div hidden={!show('databases')}>
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
              { icon: 'upload', label: 'Import CSV', onClick: () => setImportingCsv(true) },
              {
                icon: 'plus',
                label: 'New database',
                onClick: () => setTypeDialog({ mode: 'new' }),
              },
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
        </div>
        <div hidden={!show('home', 'pages')}>
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
                  {/* A page's own icon first (M55.11); an agent keeps its bot. */}
                  {isAgentEntry(entry) ? (
                    <Icon name={icon} size={15} color={color} />
                  ) : (
                    <EntryIcon entry={entry} size={15} fallback={{ name: icon, color }} />
                  )}
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.title}
                  </span>
                </button>
              ))
            ))}
        </div>
      </div>
      <div className="m71-sidebar-footer">
        <SyncBadge />
      </div>
      {typeMenu !== null && (
        <ContextMenu
          x={typeMenu.x}
          y={typeMenu.y}
          items={typeMenuItems(typeMenu.listing)}
          onClose={() => setTypeMenu(null)}
        />
      )}
      {addMenu !== null && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          items={addMenuItems(addMenu.folder)}
          onClose={() => setAddMenu(null)}
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
      {importingCsv && <CsvImportDialog onClose={() => setImportingCsv(false)} />}
    </nav>
  );
  // One shape whether or not there is a rail or a drawer, so neither ever
  // remounts the nav and everything open inside it.
  return (
    <>
      <AppRail
        area={area}
        onArea={chooseArea}
        expanded={!compact || drawer}
        inert={drawer}
        onExpand={() =>
          collapsed && !rail && !narrow ? setCollapsed(false) : setDrawerAt(selection)
        }
      />
      {/* Under the drawer, over everything else — the record panel sits at
          z-30 — so a press anywhere past the drawer closes it (M52). */}
      {drawer && (
        <DrawerScrim
          modal={pageContext === null}
          onDismiss={pageContext === null ? () => setDrawerAt(null) : hidePageNavigation}
          label="Close the sidebar"
          testId="sidebar-drawer-scrim"
          className="fixed inset-0 z-40"
        />
      )}
      {nav}
    </>
  );
}
