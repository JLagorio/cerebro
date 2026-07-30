import { useMemo, useState } from 'react';
import { CollectionDialog } from '@/app/CollectionDialog';
import { deleteCollection } from '@/app/listActions';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { useOpenPath } from '@/app/useOpenPath';
import { collectionsTree, effectiveCollections, nodeCount } from '@/engine/collections';
import type { CollectionNode, Selection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export type CollectionSelection = Extract<Selection, { kind: 'collection' }>;

/**
 * A Collection's page (M10): what is in here.
 *
 * Deliberately not a record canvas. A Collection contains Lists, Folders and
 * Docs and carries no query of its own — the moment a container also filters,
 * "what is in here" has two answers. So this page lists its contents and hands
 * off: a List opens its own canvas, a Doc opens the editor.
 */
export function CollectionPage({ selection }: { selection: CollectionSelection }) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();

  const [renaming, setRenaming] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Resolve against the EFFECTIVE set: a folder that holds Lists is a
  // Collection even with no marker, and looking only at declared ones would
  // send you to "this collection no longer exists" for a folder plainly in the
  // sidebar.
  const collection = useMemo(
    () => effectiveCollections(collections, views).find((c) => c.folder === selection.folder) ?? null,
    [collections, views, selection.folder],
  );

  const node = useMemo(() => {
    const find = (nodes: CollectionNode[]): CollectionNode | null => {
      for (const n of nodes) {
        if (n.kind === 'collection' && n.id === selection.folder) return n;
        const hit = find(n.children);
        if (hit !== null) return hit;
      }
      return null;
    };
    return find(collectionsTree(collections, views, entries, schema));
  }, [collections, views, entries, schema, selection.folder]);

  if (collection === null || node === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="folder-open"
          title="This collection no longer exists"
          description="Its marker file may have been removed. Anything that was inside it is still on disk."
        />
      </div>
    );
  }

  const total = nodeCount(node);

  const open = (child: CollectionNode) => {
    if (child.kind === 'doc' && child.path !== undefined) openPath(child.path);
    else if (child.kind === 'list') {
      navigate({ kind: 'list', id: child.id, collection: child.list?.collection ?? null });
    } else if (child.kind === 'collection') navigate({ kind: 'collection', folder: child.id });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="collection-page">
      <div className="flex-none px-5 pb-3 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            name={collection.definition.icon ?? 'folder-open'}
            size={16}
            color={collection.definition.color ?? 'var(--n-600)'}
          />
          <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">
            {collection.definition.name}
          </h1>
          <span className="[font-family:var(--font-mono)] text-[11.5px] text-[var(--n-400)]">
            {total}
          </span>
          {/* The folder is the Collection's identity, and the name can drift
              from it — so the page says which folder you are looking at. */}
          <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
            {collection.folder}/
          </span>
          <span className="flex-1" />
          <IconButton icon="pencil" label="Rename collection" onClick={() => setRenaming(true)} />
          {/* An implied Collection — a folder that is one because it holds
              Lists — has no marker to remove. */}
          {collection.declared && (
            <IconButton
              icon="folder-minus"
              label="Remove collection"
              onClick={() => setConfirmRemove(true)}
            />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {node.children.length === 0 ? (
          <EmptyState
            icon="folder-open"
            title="Nothing in here yet"
            description="A collection holds lists, folders, and docs. Add a list from the sidebar’s + to start."
          />
        ) : (
          <div className="flex flex-col">
            {node.children.map((child) => (
              <ContentRow key={`${child.kind}:${child.id}`} node={child} onOpen={open} />
            ))}
          </div>
        )}
      </div>

      {renaming && (
        <CollectionDialog
          state={{ mode: 'rename', collection }}
          onClose={() => setRenaming(false)}
        />
      )}
      {confirmRemove && (
        <Dialog
          open
          onClose={() => setConfirmRemove(false)}
          title={`Remove "${collection.definition.name}"?`}
          width={440}
          primaryAction={{
            label: 'Remove collection',
            onClick: () => {
              setConfirmRemove(false);
              void (async () => {
                if (await deleteCollection(collection)) navigate({ kind: 'home' });
              })();
            },
          }}
          secondaryAction={{ label: 'Cancel', onClick: () => setConfirmRemove(false) }}
        >
          <p className="m-0 text-[13px] text-[var(--n-600)]">
            The folder stops being a collection. The {total}{' '}
            {total === 1 ? 'thing' : 'things'} inside stay on disk in{' '}
            <code>{collection.folder}/</code> — removing a container is not a way to lose work.
          </p>
        </Dialog>
      )}
    </div>
  );
}

const KIND_LABEL: Record<CollectionNode['kind'], string> = {
  collection: 'Collection',
  folder: 'Folder',
  list: 'List',
  doc: 'Doc',
};

function ContentRow({
  node,
  onOpen,
}: {
  node: CollectionNode;
  onOpen: (node: CollectionNode) => void;
}) {
  const container = node.kind === 'folder' || node.kind === 'collection';
  const count = container ? nodeCount(node) : 0;
  return (
    <div
      data-testid="collection-content-row"
      data-kind={node.kind}
      className="flex h-10 items-center gap-2.5 border-b border-[var(--n-100)]"
    >
      <Icon name={node.icon} size={15} color={node.color ?? 'var(--n-500)'} />
      {/* A Folder is organization, not a destination — it has no page, so its
          label is text rather than a button that would go nowhere. */}
      {node.kind === 'folder' ? (
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-700)]">
          {node.label}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(node)}
          className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[13px] text-[var(--n-900)] hover:underline"
        >
          {node.label}
        </button>
      )}
      <span className="flex-none rounded-full border border-[var(--n-200)] px-2 py-0.5 text-[11px] text-[var(--n-500)]">
        {KIND_LABEL[node.kind]}
      </span>
      {container && (
        <span className="w-8 flex-none text-right [font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
          {count}
        </span>
      )}
    </div>
  );
}
