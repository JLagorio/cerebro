import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { Icon } from '@/components/ui/Icon';
import { rowClass } from '@/app/sidebarChrome';
import { nodeCount } from '@/engine/collections';
import type { CollectionNode, Selection } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';

/**
 * The Collections tree (M10).
 *
 * One recursive row renderer for all four node kinds, because they behave the
 * same way structurally — a container expands, a leaf navigates. Collections and
 * Folders differ only in whether they are also a place you can open.
 *
 * Expand state is namespaced `collection:<id>` in the persisted folder map, so a
 * folder's state here is independent of the same folder in the Docs file tree —
 * they are different trees that happen to share paths.
 */

const INDENT = 12;

export interface CollectionTreeProps {
  nodes: CollectionNode[];
  selection: Selection;
  onNavigate: (sel: Selection) => void;
  onOpenDoc: (path: string) => void;
  /** Right-click actions for a node; empty means no menu. */
  menuFor?: (node: CollectionNode) => ContextMenuItem[];
  /** The + affordance on a container row. */
  onAdd?: (node: CollectionNode) => void;
  depth?: number;
}

export function CollectionTree({
  nodes,
  selection,
  onNavigate,
  onOpenDoc,
  menuFor,
  onAdd,
  depth = 0,
}: CollectionTreeProps) {
  return (
    <>
      {nodes.map((node) => (
        <CollectionRow
          key={`${node.kind}:${node.id}`}
          node={node}
          selection={selection}
          onNavigate={onNavigate}
          onOpenDoc={onOpenDoc}
          menuFor={menuFor}
          onAdd={onAdd}
          depth={depth}
        />
      ))}
    </>
  );
}

function isActive(node: CollectionNode, selection: Selection): boolean {
  if (node.kind === 'collection') {
    return selection.kind === 'collection' && selection.folder === node.id;
  }
  if (node.kind === 'list') {
    return (
      selection.kind === 'list' &&
      selection.id === node.id &&
      (selection.collection ?? null) === (node.list?.collection ?? null)
    );
  }
  if (node.kind === 'doc') return selection.kind === 'doc' && selection.path === node.path;
  return false;
}

function CollectionRow({
  node,
  selection,
  onNavigate,
  onOpenDoc,
  menuFor,
  onAdd,
  depth,
}: Omit<CollectionTreeProps, 'nodes'> & { node: CollectionNode; depth: number }) {
  const key = `collection:${node.id}`;
  const expanded = useUiStore((s) => s.expandedFolders[key] === true);
  const toggle = useUiStore((s) => s.toggleFolder);
  const menu = useUiStore((s) => s.nodeMenu);
  const setMenu = useUiStore((s) => s.setNodeMenu);

  const container = node.kind === 'collection' || node.kind === 'folder';
  const items = menuFor?.(node) ?? [];
  const count = container ? nodeCount(node) : 0;

  const open = () => {
    if (node.kind === 'doc' && node.path !== undefined) onOpenDoc(node.path);
    else if (node.kind === 'list') {
      onNavigate({ kind: 'list', id: node.id, collection: node.list?.collection ?? null });
    } else if (node.kind === 'collection') onNavigate({ kind: 'collection', folder: node.id });
    // A Folder is organization, not a destination — clicking it expands it,
    // which the caret already did. Giving it a page would mean inventing a
    // surface for something that is only a grouping of other things.
    else toggle(key);
  };

  return (
    <>
      <div
        className={`${rowClass(isActive(node, selection))} group/row`}
        style={{ paddingLeft: 8 + depth * INDENT }}
        onContextMenu={
          items.length === 0
            ? undefined
            : (e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: `${node.kind}:${node.id}` });
              }
        }
        data-testid={`collection-node-${node.kind}`}
        data-id={node.id}
      >
        {container ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.label}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle(key);
            }}
            className="flex h-4 w-4 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] hover:bg-[var(--n-100)] hover:text-[var(--n-700)]"
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
        ) : (
          <span className="h-4 w-4 flex-none" />
        )}
        <button
          type="button"
          onClick={open}
          className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-inherit"
        >
          <Icon name={node.icon} size={15} color={node.color ?? 'var(--n-500)'} />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{node.label}</span>
        </button>
        {/* M15: revealed by OPACITY, not `display:none`. Hidden it was out of
            the tab order and out of the accessibility tree entirely, so a
            keyboard user could not add a List to a specific Collection at all.
            `group-focus-within/row` is the counterpart hover never had. */}
        {onAdd !== undefined && node.kind === 'collection' && (
          <button
            type="button"
            aria-label={`Add to ${node.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onAdd(node);
            }}
            className="flex h-5 w-5 flex-none items-center justify-center rounded border-0 bg-transparent p-0 text-[var(--n-400)] opacity-0 hover:bg-[var(--n-100)] hover:text-[var(--n-700)] focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
          >
            <Icon name="plus" size={13} />
          </button>
        )}
        {container && count > 0 && (
          <span className="ml-auto flex-none [font-family:var(--font-mono)] text-[11px] text-[var(--n-400)] group-hover/row:hidden group-focus-within/row:hidden">
            {count}
          </span>
        )}
      </div>
      {expanded && node.children.length > 0 && (
        <CollectionTree
          nodes={node.children}
          selection={selection}
          onNavigate={onNavigate}
          onOpenDoc={onOpenDoc}
          menuFor={menuFor}
          onAdd={onAdd}
          depth={depth + 1}
        />
      )}
      {/* An expanded container with nothing in it says so, rather than looking
          like it failed to load. */}
      {expanded && node.children.length === 0 && (
        <div
          className="py-1 text-[11.5px] text-[var(--n-400)]"
          style={{ paddingLeft: 8 + (depth + 1) * INDENT + 20 }}
        >
          Empty
        </div>
      )}
      {menu !== null && menu.id === `${node.kind}:${node.id}` && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
