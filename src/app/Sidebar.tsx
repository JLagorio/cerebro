import { useMemo, useState } from 'react';
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
import { deleteCollection, deleteList } from '@/app/listActions';
import { useOpenPath } from '@/app/useOpenPath';
import { rowClass, SECTION_LABEL } from '@/app/sidebarChrome';
import { collectionsTree, effectiveCollections } from '@/engine/collections';
import { inboxCounts } from '@/engine/inbox';
import { listTypes, type TypeListing } from '@/engine/typeCatalog';
import type { CollectionFile, CollectionNode } from '@/engine/types';
import { KnowledgeNav } from '@/knowledge/KnowledgeNav';
import { useNavStore } from '@/stores/navStore';
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useUiStore } from '@/stores/uiStore';
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
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  /** Opens and closes a panel rather than going somewhere. */
  toggle?: boolean;
  /** Queue size shown as a badge; omitted or 0 renders nothing. */
  count?: number;
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
          data-testid="nav-badge"
          className="ml-auto min-w-[15px] rounded-full bg-cortex-500 px-1 text-center text-2xs font-semibold leading-[15px] text-n-0 tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

/**
 * The one nav column (M37.3 — the shell flattening).
 *
 * The 72px icon rail and the per-surface contextual sidebar were two answers
 * to one question. This column is the single answer, Notion-shaped: vault
 * header, search, the destinations as rows, the item world's Collections and
 * Types inline, and the chrome destinations at the foot. A surface's own
 * navigation (the Docs file tree, Base's rows) nests under its destination row
 * while that surface is current — content is still a function of the
 * destination (M15), it just stopped displacing everything else.
 *
 * The six surfaces that used to render NO sidebar (settings, pulse, inbox,
 * library, workspace, diagram) get this one like everything else: their old
 * objection was Collections-and-Types-as-irrelevant-width, and a nav that is
 * the whole shell is not irrelevant to any surface. The collapse control
 * remains the escape hatch for the canvas surfaces that want the width back.
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
  const openPath = useOpenPath();

  const collections = useVaultStore((s) => s.collections);
  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState | null>(null);
  const [typeDialog, setTypeDialog] = useState<TypeDialog | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number; listing: TypeListing } | null>(
    null,
  );

  // M8.1: Base navigates by its own axes rather than borrowing Views and
  // Types, which describe a corpus with a different author; its rows nest
  // under the Base row while that surface is current (M37.3).
  const knowledgeMode = selection.kind === 'knowledge';
  // M9.4: the two git surfaces share one slot's worth of "history".
  const historyActive = selection.kind === 'changes' || selection.kind === 'pulse';
  const homeActive = HOME_KINDS.has(selection.kind);

  // M15: the badge counts what the page will SHOW — the persisted period, not
  // the unfiltered total.
  const queued = useMemo(
    () => (inboxEnabled ? inboxCounts(entries)[inboxPeriod] : 0),
    [entries, inboxEnabled, inboxPeriod],
  );

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

  // M11: collapsed to a hairline rather than unmounted, so the reopen control
  // stays where the sidebar was instead of moving to a different chrome.
  if (collapsed) {
    return (
      <div className="flex w-8 flex-none items-start justify-center border-r border-n-200 bg-n-0 pt-3.5">
        <button
          type="button"
          aria-label="Show sidebar"
          data-testid="sidebar-expand"
          onClick={() => setCollapsed(false)}
          className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name="panel-left-open" size={15} />
        </button>
      </div>
    );
  }

  // The vault, named as its folder. The wordmark lives in the Topbar; this
  // header answers "which vault", which the shell never said anywhere before.
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
      className="relative flex flex-col overflow-hidden border-r border-n-200 bg-n-0"
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
      <div className="flex items-center justify-between pb-1 pl-4 pr-3 pt-3.5">
        {/* An h2, not an h1 (M15): this names the navigator, not the page. */}
        <h2 className="m-0 min-w-0 truncate text-lg font-semibold text-n-900">{vaultName}</h2>
        <button
          type="button"
          aria-label="Hide sidebar"
          data-testid="sidebar-collapse"
          onClick={() => setCollapsed(true)}
          className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-800"
        >
          <Icon name="panel-left-close" size={15} />
        </button>
      </div>
      {/* The same ⌘K the Topbar advertises; here because a one-column nav is
          where the hand already is. One dialog, two doors. */}
      <button
        type="button"
        aria-label="Search"
        onClick={() => setQuickOpen(true)}
        className="mx-2 mb-1 flex h-[30px] flex-none items-center gap-[7px] rounded-md border-0 bg-transparent px-2 text-left text-sm text-n-500 hover:bg-n-100 hover:text-n-700"
      >
        <Icon name="search" size={15} />
        <span>Search</span>
        <kbd className="ml-auto [font-family:var(--font-mono)] text-2xs text-n-400">⌘K</kbd>
      </button>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        <div data-testid="nav-surfaces">
          <SurfaceRow
            icon="house"
            label="Home"
            active={homeActive}
            onClick={() => navigate({ kind: 'home' })}
          />
          {inboxEnabled && (
            <SurfaceRow
              icon="inbox"
              label="Inbox"
              active={selection.kind === 'inbox'}
              count={queued}
              onClick={() => navigate({ kind: 'inbox' })}
            />
          )}
          {/* M30 — mounted repositories. Its own room rather than a section
              of the pages: pages are vault notes, and a surface that renders
              .ts files cannot mean that. The label is the locked name
              (M37.2); the `workspace` KIND stays — kinds are internal
              vocabulary shared with the navigate MCP tool. */}
          <SurfaceRow
            icon="folder-tree"
            label="Work"
            active={selection.kind === 'workspace'}
            onClick={() => navigate({ kind: 'workspace' })}
          />
          {/* M40 — the third locked name. A making surface, so it sits with
              Work rather than below the fold with the chrome. */}
          <SurfaceRow
            icon="pencil-ruler"
            label="Studio"
            active={selection.kind === 'studio'}
            onClick={() => navigate({ kind: 'studio' })}
          />
          {/* M5: the agent's corpus is a peer of Home and Docs — different
              author, different rules. M33a.2 folded the Status hub in, so this
              one destination is both what the base holds and what it knows
              about itself. Still no badge, deliberately: a review count is the
              chrome nagging you to drain a queue (M8.1), a contradiction count
              is worse (M27.8), and the queued-proposal count (M33b.3) says
              itself on the agent's own row, in words. A destination may say how
              big it is; nothing counts up at you from the chrome. */}
          <SurfaceRow
            icon="brain"
            label="Base"
            active={knowledgeMode}
            onClick={() => navigate({ kind: 'knowledge' })}
          />
        </div>
        {/* M37.3 — the geometry M35 deferred: Base's nav rows live inline in
            the one nav column now, nested under the destination that owns
            them (and outside the destinations container, same as the Docs
            tree — its row labels are not destinations). `nav` passed through
            undefined on a nav-less selection: which view that lands on is the
            nav's own answer (M33a.3), and defaulting it here would make the
            sidebar a second opinion. */}
        {knowledgeMode && selection.kind === 'knowledge' && (
          <div className="pl-3">
            <KnowledgeNav nav={selection.nav} />
          </div>
        )}
        <div data-testid="nav-surfaces">
          {/* M9.4 — the vault's history. No badge: a count of commits is
              chrome. The topbar SyncBadge speaks instead, and only when
              something needs doing. */}
          <SurfaceRow
            icon="activity"
            label="History"
            active={historyActive}
            onClick={() => navigate({ kind: 'pulse' })}
          />
        </div>
        {/* M38.3 — the Docs destination died with its surface; the tree it
            used to gate is a standing section now, because in a shell where
            everything is a page the pages ARE navigation, not a mode. Outside
            the destinations containers on purpose: the tree's folder rows
            share accessible names with destination rows (`inbox/` vs Inbox),
            and a spec scoped to `nav-surfaces` must never catch a folder. */}
        <div className={SECTION_LABEL}>Pages</div>
        <FileTree
          root=""
          docsOnly
          activePath={selection.kind === 'doc' ? selection.path : null}
          onOpen={openPath}
        />
        {/* M10: Collections are the top-level navigation of the item world. A
            Collection is a container — it holds Lists, Folders and Docs —
            where a "view" used to be both the container and the query at once. */}
        <div className="flex items-center justify-between pr-1">
          <div className={SECTION_LABEL}>Collections</div>
          <button
            type="button"
            aria-label="New collection"
            data-testid="new-collection"
            onClick={() => setCollectionDialog({ mode: 'new' })}
            className="mt-2 flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-700"
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
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
        {/* M3's collapsible Types section, wearing what it always was
            (M39.2): the databases. The `type:` key, the metamodel, and every
            internal identifier keep the old word — labels spend, kinds stay,
            same rule as M37.2. */}
        <div className="flex items-center justify-between pr-1">
          <button
            type="button"
            aria-expanded={typesOpen}
            onClick={() => setTypesOpen(!typesOpen)}
            className={`${SECTION_LABEL} flex items-center gap-1 border-0 bg-transparent hover:text-n-700`}
          >
            <Icon name={typesOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            Databases
          </button>
          <span className="inline-flex">
            {/* M12.6: the schema doctor — adopt an existing vault's freeform
                frontmatter into declared types, one reviewed pass. */}
            <button
              type="button"
              aria-label="Adopt vault schema"
              onClick={() => setAdopting(true)}
              className="mt-2 flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-700"
            >
              <Icon name="wand-sparkles" size={12} />
            </button>
            <button
              type="button"
              aria-label="New database"
              onClick={() => setTypeDialog({ mode: 'new' })}
              className="mt-2 flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent text-n-400 hover:bg-n-100 hover:text-n-700"
            >
              <Icon name="plus" size={13} />
            </button>
          </span>
        </div>
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
      {/* The chrome destinations, below the fold the way Notion keeps its
          Settings: where you go to CHANGE how the app works rather than
          somewhere you work. The assistant is a companion to whatever surface
          you are on, so it toggles rather than navigating. `blocks`, not
          `library`, for the Library — Docs already owns that glyph, and two
          rows drawn identically is the nav failing at the one job it has (M18). */}
      <div data-testid="nav-surfaces" className="flex-none border-t border-n-200 px-2 py-2">
        <SurfaceRow
          icon="sparkles"
          label="Assistant"
          toggle
          active={aiPanelOpen}
          onClick={() => setAiPanelOpen(!aiPanelOpen)}
        />
        <SurfaceRow
          icon="blocks"
          label="Library"
          active={selection.kind === 'library'}
          onClick={() => navigate({ kind: 'library' })}
        />
        <SurfaceRow
          icon="settings"
          label="Settings"
          active={selection.kind === 'settings'}
          onClick={() => navigate({ kind: 'settings' })}
        />
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
