import { useEffect, useMemo, useState } from 'react';
import { CollectionDialog } from '@/app/CollectionDialog';
import { deleteCollection, updateCollection } from '@/app/listActions';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { useOpenPath } from '@/app/useOpenPath';
import { collectionsTree, effectiveCollections, nodeCount } from '@/engine/collections';
import { selectSource, sortEntries } from '@/engine/surface';
import { typeStyle } from '@/engine/typeCatalog';
import type { CollectionFile, CollectionNode, Entry, Selection } from '@/engine/types';
import { evaluateFilters } from '@/engine/viewFilters';
import { resolveView } from '@/engine/views';
import { EntityDossier } from '@/knowledge/EntityDossier';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { viewKind } from '@/views/viewKinds';

export type CollectionSelection = Extract<Selection, { kind: 'collection' }>;

/**
 * A Collection's home page (M10, rebuilt M11).
 *
 * Still deliberately not a record canvas — a Collection contains Lists, Folders
 * and Docs and carries no query of its own, so this page hands off rather than
 * querying.
 *
 * What it stopped being is a flat table of contents. The first version listed
 * every child as one identical 40px row with a "List"/"Doc" tag on the right,
 * which told you what was in here but nothing about it: not how many records a
 * List holds, not what type they are, not which of them anyone has touched. A
 * container's home page is the first thing you see when you open your work for
 * the day, so it now answers the question people actually arrive with — what is
 * in here, how big is it, and what changed.
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
    () =>
      effectiveCollections(collections, views, entries).find((c) => c.folder === selection.folder) ?? null,
    [collections, views, entries, selection.folder],
  );

  // M12.5: a legacy project folder reads as a Collection, and the entity
  // dossier that lived on the deleted project page follows it here — what
  // the base believes about this container's work (M8.9).
  const projectDoc = useMemo(
    () =>
      entries.find((e) => e.filename === 'project.md' && e.folder === selection.folder) ?? null,
    [entries, selection.folder],
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

  /** Everything inside, flattened by kind — the page groups, the tree nests. */
  const contents = useMemo(() => flatten(node), [node]);

  // What the Lists in here actually hold. Computed once for the whole page so
  // a card can report a count without each one re-running the query.
  const recent = useMemo(() => {
    const seen = new Map<string, Entry>();
    for (const list of contents.lists) {
      const view = resolveView(list.list!.definition);
      for (const e of selectSource(entries, list.list!.definition.source).filter(
        (e) => view.filters === null || evaluateFilters(e, view.filters, schema),
      )) {
        seen.set(e.path, e);
      }
    }
    return sortEntries([...seen.values()], [{ field: 'modifiedAt', dir: 'desc' }], schema).slice(
      0,
      6,
    );
  }, [contents.lists, entries, schema]);

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
  const empty = node.children.length === 0;

  const openList = (n: CollectionNode) =>
    navigate({ kind: 'list', id: n.id, collection: n.list?.collection ?? null });

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      data-testid="collection-page"
    >
      <header className="flex-none px-8 pb-4 pt-8">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-[10px]"
            style={{
              background: collection.definition.color
                ? `${collection.definition.color}1a`
                : 'var(--n-100)',
            }}
          >
            <Icon
              name={collection.definition.icon ?? 'folder-open'}
              size={19}
              color={collection.definition.color ?? 'var(--n-600)'}
            />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="m-0 truncate text-[24px] font-bold leading-[30px] tracking-[-0.02em] text-[var(--n-900)]">
              {collection.definition.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-[var(--n-400)]">
              {/* The folder is the Collection's identity, and the name can
                  drift from it — so the page says which folder you are on. */}
              <span className="[font-family:var(--font-mono)]">{collection.folder}/</span>
              <span aria-hidden>·</span>
              <span>
                {total} {total === 1 ? 'item' : 'items'}
              </span>
              {!collection.declared && (
                <>
                  <span aria-hidden>·</span>
                  {/* An implied Collection is a folder that is one because it
                      holds Lists. Saying so is honest about why it has no
                      icon of its own and nothing to remove. */}
                  <span title="A folder that holds lists is a collection. Rename it to give it a marker file.">
                    implied by its contents
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-none items-center gap-1">
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
        <Description collection={collection} />
      </header>

      <div className="min-h-0 flex-1 px-8 pb-10">
        {/* M12.5: the entity dossier that lived on the deleted project page —
            rendered whenever the folder carries a project.md, INCLUDING when
            the collection lists nothing else: a legacy project whose records
            all live on type screens still has beliefs worth reading. */}
        {projectDoc !== null && (
          <div className="mb-7">
            <Section title="Knowledge">
              <EntityDossier entry={projectDoc} />
            </Section>
          </div>
        )}
        {empty ? (
          <EmptyState
            icon="folder-open"
            title="Nothing in here yet"
            description="A collection holds lists, folders, and docs. Add a list from the sidebar’s + to start."
          />
        ) : (
          <div className="flex flex-col gap-7">
            {contents.collections.length > 0 && (
              <Section title="Collections" count={contents.collections.length}>
                <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
                  {contents.collections.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      data-testid="collection-card"
                      data-kind="collection"
                      onClick={() => navigate({ kind: 'collection', folder: c.id })}
                      className="flex items-center gap-2.5 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-3 py-2.5 text-left hover:border-[var(--n-300)] hover:bg-[var(--n-25)]"
                    >
                      <Icon name={c.icon} size={16} color={c.color ?? 'var(--n-500)'} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--n-900)]">
                        {c.label}
                      </span>
                      <span className="flex-none [font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
                        {nodeCount(c)}
                      </span>
                    </button>
                  ))}
                </div>
              </Section>
            )}

            {contents.lists.length > 0 && (
              <Section title="Lists" count={contents.lists.length}>
                <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
                  {contents.lists.map((n) => (
                    <ListCard
                      key={n.id}
                      node={n}
                      entries={entries}
                      schema={schema}
                      onOpen={() => openList(n)}
                      onOpenView={(viewId) =>
                        navigate({
                          kind: 'list',
                          id: n.id,
                          collection: n.list?.collection ?? null,
                          view: viewId,
                        })
                      }
                    />
                  ))}
                </div>
              </Section>
            )}

            {contents.docs.length > 0 && (
              <Section title="Docs" count={contents.docs.length}>
                <div className="flex flex-col">
                  {contents.docs.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      data-testid="collection-content-row"
                      data-kind="doc"
                      onClick={() => d.path !== undefined && openPath(d.path)}
                      className="flex h-9 items-center gap-2.5 rounded-md border-0 bg-transparent px-2 text-left hover:bg-[var(--n-25)]"
                    >
                      <Icon name={d.icon} size={14} color={d.color ?? 'var(--n-500)'} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-800)]">
                        {d.label}
                      </span>
                      <span className="flex-none truncate [font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
                        {d.path}
                      </span>
                    </button>
                  ))}
                </div>
              </Section>
            )}

            {contents.folders.length > 0 && (
              <Section title="Folders" count={contents.folders.length}>
                <div className="flex flex-wrap gap-2">
                  {contents.folders.map((f) => (
                    // A Folder is organization, not a destination — it has no
                    // page, so it reads as a label rather than something that
                    // would go nowhere when pressed.
                    <span
                      key={f.id}
                      data-testid="collection-content-row"
                      data-kind="folder"
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--n-200)] px-2.5 py-1 text-[12px] text-[var(--n-600)]"
                    >
                      <Icon name="folder" size={12} color="var(--n-400)" />
                      {f.label}
                      <span className="[font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">
                        {nodeCount(f)}
                      </span>
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {recent.length > 0 && (
              // Last, and only when the Lists in here actually hold something:
              // "nothing speaks first" — this is a place you scroll to, not a
              // feed that opens with news.
              <Section title="Recently updated" count={recent.length}>
                <div className="flex flex-col">
                  {recent.map((e) => {
                    const style = typeStyle(e.type, schema);
                    return (
                      <button
                        key={e.path}
                        type="button"
                        data-testid="collection-recent-row"
                        onClick={() => openPath(e.path)}
                        className="flex h-9 items-center gap-2.5 rounded-md border-0 bg-transparent px-2 text-left hover:bg-[var(--n-25)]"
                      >
                        <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--n-800)]">
                          {e.title}
                        </span>
                        <span className="flex-none [font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">
                          {e.modifiedAt.slice(0, 10)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Section>
            )}
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

/** Children split by kind. The tree nests; the page groups. */
function flatten(node: CollectionNode | null): {
  collections: CollectionNode[];
  lists: CollectionNode[];
  docs: CollectionNode[];
  folders: CollectionNode[];
} {
  const out = {
    collections: [] as CollectionNode[],
    lists: [] as CollectionNode[],
    docs: [] as CollectionNode[],
    folders: [] as CollectionNode[],
  };
  if (node === null) return out;
  for (const child of node.children) {
    if (child.kind === 'collection') out.collections.push(child);
    else if (child.kind === 'list' && child.list !== undefined) out.lists.push(child);
    else if (child.kind === 'doc') out.docs.push(child);
    else out.folders.push(child);
  }
  return out;
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  /** Omitted for sections that are not a countable list (Knowledge). */
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--n-500)]">
        {title}
        {count !== undefined && (
          <span className="[font-family:var(--font-mono)] text-[10.5px] font-normal text-[var(--n-400)]">
            {count}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

/**
 * One List, as a card.
 *
 * It reports what the old row could not: how many records it holds right now,
 * what type they are, and which views it has — the views being clickable,
 * because "open the board" is a thing people mean to do from here and it
 * otherwise costs opening the List and then finding the tab.
 */
function ListCard({
  node,
  entries,
  schema,
  onOpen,
  onOpenView,
}: {
  node: CollectionNode;
  entries: Entry[];
  schema: import('@/engine/types').Schema;
  onOpen: () => void;
  onOpenView: (viewId: string) => void;
}) {
  const list = node.list!;
  const first = resolveView(list.definition);
  const count = useMemo(
    () =>
      selectSource(entries, list.definition.source).filter(
        (e) => first.filters === null || evaluateFilters(e, first.filters, schema),
      ).length,
    [entries, list.definition.source, first.filters, schema],
  );

  return (
    <div
      data-testid="collection-card"
      data-kind="list"
      className="flex flex-col gap-2 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] p-3 hover:border-[var(--n-300)]"
    >
      {/* The icon and the count sit OUTSIDE the button on purpose: folded in,
          they became part of its accessible name, so the card announced
          itself as "At risk 11" rather than as the list it opens. */}
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={node.icon} size={15} color={node.color ?? 'var(--n-500)'} />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left text-[13.5px] font-medium text-[var(--n-900)] hover:underline"
        >
          {node.label}
        </button>
        <span className="flex-none [font-family:var(--font-mono)] text-[11.5px] text-[var(--n-400)]">
          {count}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="inline-flex items-center rounded-full border border-[var(--n-200)] px-1.5 py-px text-[10.5px] text-[var(--n-500)]">
          {list.definition.source.type ?? 'Everything'}
        </span>
        {list.definition.views.map((v) => (
          <button
            key={v.id}
            type="button"
            data-testid="collection-card-view"
            onClick={() => onOpenView(v.id)}
            title={`Open the ${v.name} view`}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--n-200)] px-1.5 py-px text-[10.5px] text-[var(--n-500)] hover:border-[var(--cortex-300)] hover:bg-[var(--cortex-50)] hover:text-[var(--cortex-700)]"
          >
            <Icon name={v.icon ?? viewKind(v.presentation.type).icon} size={10} />
            {v.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The Collection's own description — what this container is for.
 *
 * Edited in place rather than in the rename dialog: it is prose about the work,
 * so it belongs on the page it describes, and a textarea you can click into is
 * a lower bar than remembering which dialog holds it. Saves on blur, and only
 * when it actually changed — every save writes `collection.yml`, and a write
 * per focus-out of an untouched field is a git commit nobody made.
 */
function Description({ collection }: { collection: CollectionFile }) {
  const stored = collection.definition.description ?? '';
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setDraft(stored);
  }, [stored, collection.folder]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === stored.trim()) return;
    void updateCollection(collection, {
      ...collection.definition,
      description: next === '' ? null : next,
    });
  };

  if (!editing && stored === '') {
    return (
      <button
        type="button"
        data-testid="collection-add-description"
        onClick={() => setEditing(true)}
        className="mt-2.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
      >
        + Add a description
      </button>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        data-testid="collection-description"
        onClick={() => setEditing(true)}
        className="mt-2.5 block w-full max-w-[720px] rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-[13px] leading-[19px] text-[var(--n-600)] hover:bg-[var(--n-50)]"
      >
        {stored}
      </button>
    );
  }

  return (
    <textarea
      autoFocus
      aria-label="Collection description"
      value={draft}
      rows={3}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(stored);
          setEditing(false);
        }
        // Enter commits; Shift+Enter is a newline. A description is usually
        // one sentence, and needing the mouse to finish one is a papercut.
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      placeholder="What is this collection for?"
      className="mt-2.5 block w-full max-w-[720px] resize-y rounded-lg border border-[var(--cortex-500)] px-2 py-1.5 text-[13px] leading-[19px] text-[var(--n-800)] shadow-[0_0_0_3px_var(--cortex-100)] outline-none"
    />
  );
}
