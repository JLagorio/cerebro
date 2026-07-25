import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { FieldChip } from '@/views/FieldChip';
import { groupEntries } from '@/engine/grouping';
import { nextItemKey } from '@/engine/itemKeys';
import { formatWikilink } from '@/engine/wikilink';
import { slugify } from '@/lib/slug';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { Entry, Group, Presentation, Schema } from '@/engine/types';

export interface ListViewProps {
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** project context enables the quick-add row; pass null outside a project */
  project: Entry | null;
}

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

function QuickAddRow({ group, groupBy, project }: { group: Group; groupBy: string | null; project: Entry }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const createItem = useVaultStore((s) => s.createItem);
  const allEntries = useVaultStore((s) => s.entries);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    const prefix = typeof project.properties.key === 'string' ? project.properties.key : 'WRK';
    const frontmatter: Record<string, unknown> = {
      type: 'Work item',
      key: nextItemKey(prefix, allEntries),
      project: formatWikilink(pathStem(project.path)),
    };
    if (groupBy && group.key !== '__none__') frontmatter[groupBy] = group.key;
    try {
      await createItem({ folder: 'items', slug: slugify(trimmed), frontmatter });
    } catch {
      // Deviation from the plan's verbatim body (execution-log binding note
      // 16a, mirroring the accepted Task 17 pattern in vaultStore): createItem
      // throws to callers by design — surface the failure and keep the draft
      // instead of leaving an unhandled rejection.
      useUiStore.getState().toast(`Couldn't create "${trimmed}"`);
      return;
    }
    setTitle('');
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-[34px] w-full items-center gap-2 border-b border-[var(--n-100)] px-5 text-[12.5px] text-[var(--n-400)] hover:bg-[var(--n-25)] hover:text-[var(--n-700)]"
      >
        <Icon name="plus" size={13} />
        Add item
      </button>
    );
  }
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-[var(--n-100)] px-5">
      <Icon name="plus" size={13} color="var(--n-400)" />
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') {
            setTitle('');
            setEditing(false);
          }
        }}
        placeholder="Item title — Enter to create"
        aria-label={`New item in ${group.label}`}
        className="h-6 flex-1 border-none bg-transparent text-[13px] text-[var(--n-900)] outline-none"
      />
    </div>
  );
}

function ListRow({ entry, presentation, schema }: { entry: Entry; presentation: Presentation; schema: Schema }) {
  const openDetail = useUiStore((s) => s.openDetail);
  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
  const key = typeof entry.properties.key === 'string' ? entry.properties.key : '';

  if (entry.parseError) {
    return (
      <div
        role="row"
        onClick={() => openDetail(entry.path)}
        className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] px-5 hover:bg-[var(--n-50)]"
      >
        <span className="w-[52px] flex-none" />
        <span className="inline-flex flex-none text-[var(--warn-500)]">
          <Icon name="triangle-alert" size={14} />
        </span>
        <span className="truncate text-[13px] text-[var(--n-700)]">{entry.filename}</span>
        <span className="inline-flex flex-none items-center rounded-md border border-[var(--warn-500)] px-1.5 py-0.5 text-[11px] text-[var(--warn-500)]">
          Cannot parse
        </span>
      </div>
    );
  }

  return (
    <div
      role="row"
      onClick={() => openDetail(entry.path)}
      className="flex h-10 cursor-pointer items-center gap-2.5 border-b border-[var(--n-100)] px-5 hover:bg-[var(--n-50)]"
    >
      <span className="w-[52px] flex-none [font-family:var(--font-mono)] text-[10.5px] text-[var(--n-400)]">{key}</span>
      <span title={entry.type ?? undefined} className="inline-flex flex-none" style={{ color: typeDef?.color ?? 'var(--n-400)' }}>
        <Icon name={typeDef?.icon ?? 'file-text'} size={14} />
      </span>
      <span className="truncate text-[13px] text-[var(--n-900)]">{entry.title}</span>
      <span className="flex-1" />
      {presentation.visibleFields
        .filter((f) => f !== 'key')
        .map((f) => (
          <FieldChip key={f} resolved={schema.resolveField(entry, f)} />
        ))}
    </div>
  );
}

export function ListView({ entries, presentation, schema, project }: ListViewProps) {
  const groupBy = presentation.groupBy;
  const groups: Group[] = groupBy
    ? groupEntries(entries, groupBy, schema)
    : [{ key: '', label: 'All items', color: null, ghost: false, entries }];

  return (
    // Deviation from the plan's verbatim root (reported): the shared contract
    // requires data-testid="list-view" on the root, and ProjectPage/App
    // provide no scrolling ancestor (App is overflow-hidden) — so the root
    // keeps the placeholder's scroll-container classes; the plan's
    // min-w-[720px] block sits inside it.
    <div data-testid="list-view" className="min-h-0 min-w-0 flex-1 overflow-auto">
      <div className="min-w-[720px]">
        {groups.map((g) => (
          <section key={g.key || g.label}>
            <header
              data-testid="group-header"
              className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-[var(--n-100)] bg-[var(--n-25)] px-5"
            >
              <span
                className="box-border h-[11px] w-[11px] rounded-full"
                style={
                  g.ghost || !g.color
                    ? { border: '1.5px solid var(--n-400)' }
                    : { background: g.color, border: `1.5px solid ${g.color}` }
                }
              />
              <span className="text-[12.5px] font-semibold text-[var(--n-800)]">{g.label}</span>
              <span className="[font-family:var(--font-mono)] text-[11px] text-[var(--n-400)]">{g.entries.length}</span>
            </header>
            {g.entries.map((e) => (
              <ListRow key={e.path} entry={e} presentation={presentation} schema={schema} />
            ))}
            {project && <QuickAddRow group={g} groupBy={groupBy} project={project} />}
          </section>
        ))}
      </div>
    </div>
  );
}
