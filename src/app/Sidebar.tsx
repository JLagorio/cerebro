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
 * Surfaces the Workspace sidebar has nothing to say about (M15).
 *
 * Settings and Pulse are full-width single-column surfaces, and the Inbox is a
 * queue with its own two-pane layout. Rendering Collections + 15 Types beside
 * them put ~25% of the window under navigation unrelated to what is in view,
 * and left a Collection highlighted as though it scoped the page.
 *
 * M18 adds the Library for a sharper reason than width: it lists nothing the
 * Workspace tree contains. Collections and Types describe the vault's subject
 * matter; the library holds the machinery that acts on it. Showing them side
 * by side implied a skill lives in a Collection, which it does not, and left a
 * type row highlighted while you edited a trigger.
 *
 * M30 adds the workspace surface, which brings its OWN tree of mounted roots.
 * Two file trees side by side is the worst version of both: Collections and
 * Types describe the vault's subject matter and say nothing about a mounted
 * repository, so beside a repo tree they are pure width.
 */
// M29.27 adds `diagram` for a different reason again: the page IS a canvas
// (spec D1), and an infinite plane beside a tree reads as a pane, not a
// surface. Navigation back out is the topbar's, same as Settings.
const SIDEBARLESS = new Set(['settings', 'pulse', 'inbox', 'library', 'workspace', 'diagram']);

type TypeDialog = { mode: 'new' } | { mode: 'rename' | 'style' | 'delete'; listing: TypeListing };

type CollectionDialogState = { mode: 'new' } | { mode: 'rename'; collection: CollectionFile };

export function Sidebar({ onNewView, narrow = false }: SidebarProps) {
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
  const openPath = useOpenPath();

  const collections = useVaultStore((s) => s.collections);
  const [collectionDialog, setCollectionDialog] = useState<CollectionDialogState | null>(null);
  const [typeDialog, setTypeDialog] = useState<TypeDialog | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [typeMenu, setTypeMenu] = useState<{ x: number; y: number; listing: TypeListing } | null>(
    null,
  );

  // Task 14: on the Docs surfaces the sidebar is a Drive-style file
  // navigator — folders and files, click to open, right-click to manage.
  const docsMode = selection.kind === 'docs' || selection.kind === 'doc';
  // M8.1: Knowledge navigates by its own axes rather than borrowing Views and
  // Types, which describe a corpus with a different author.
  const knowledgeMode = selection.kind === 'knowledge';

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
        label: 'Delete type',
        danger: true,
        onSelect: () => setTypeDialog({ mode: 'delete', listing }),
      });
    }
    return items;
  };

  // M15: sidebar content is a function of the destination, not a default.
  // Checked BEFORE `collapsed` so these surfaces do not even get the hairline —
  // there is nothing behind it to reopen.
  if (SIDEBARLESS.has(selection.kind)) return null;

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

  return (
    <nav
      aria-label="Sidebar"
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
      <div className="flex items-center justify-between pb-2 pl-4 pr-3 pt-3.5">
        {/* An h2, not an h1 (M15): this names the navigator, not the page. As an
            h1 it gave Docs two level-1 headings and made Inbox/Knowledge read as
            subsections of the file tree. */}
        <h2 className="m-0 min-w-0 truncate text-lg font-semibold text-n-900">
          {docsMode ? 'Docs' : knowledgeMode ? 'Knowledge' : 'Workspace'}
        </h2>
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
      {knowledgeMode && selection.kind === 'knowledge' ? (
        <KnowledgeNav nav={selection.nav ?? { tab: 'all' }} />
      ) : docsMode ? (
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          <div className={SECTION_LABEL}>Files</div>
          <FileTree
            root=""
            docsOnly
            activePath={selection.kind === 'doc' ? selection.path : null}
            onOpen={openPath}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {/* M10: Collections are the top-level navigation. A Collection is a
            container — it holds Lists, Folders and Docs — where a "view" used
            to be both the container and the query at once. */}
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
          {/* M3: collapsible Types section — the databases themselves. */}
          <div className="flex items-center justify-between pr-1">
            <button
              type="button"
              aria-expanded={typesOpen}
              onClick={() => setTypesOpen(!typesOpen)}
              className={`${SECTION_LABEL} flex items-center gap-1 border-0 bg-transparent hover:text-n-700`}
            >
              <Icon name={typesOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              Types
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
                aria-label="New type"
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
      )}
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
