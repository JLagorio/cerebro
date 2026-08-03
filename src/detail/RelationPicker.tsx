import { useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { createTarget } from '@/engine/createRecord';
import { humanize } from '@/engine/schema';
import { typeStyle } from '@/engine/typeCatalog';
import type { Entry, Schema } from '@/engine/types';
import { slugify } from '@/lib/slug';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

/**
 * Linking related records (M11).
 *
 * This replaces a 240px option popover that did the job badly in both
 * directions. Choosing what to link to meant scrolling a list of bare titles
 * with no idea which "Overview" was which; and SEEING what was already linked
 * meant reading the same list looking for ticks, with no way to reorder and
 * nothing but the same tick to unlink with.
 *
 * So it is one dialog with two halves, which is what Notion's is:
 *
 * - **Linked** — what is attached now, in order, each row removable and
 *   movable. Order matters: it is the order the chips render in, and the first
 *   one is the one a narrow table cell shows.
 * - **Search** — everything else it could point at, with enough context per row
 *   (type, folder, project) to tell two same-named records apart, and a create
 *   affordance for the case where the record does not exist yet.
 */

export interface RelationPickerProps {
  /** Field being edited — named in the header so the dialog says what it is for. */
  fieldName: string;
  /** Type the relation points at; null accepts anything (an undeclared field). */
  targetType: string | null;
  /** Currently linked ids (filename stems), in order. */
  value: string[];
  /** 1 → a single linked record: picking replaces and closes (M12.4). */
  limit?: 1;
  entries: Entry[];
  schema: Schema;
  onChange: (next: string[]) => void;
  onClose: () => void;
}

export function RelationPicker({
  fieldName,
  targetType,
  value,
  limit,
  entries,
  schema,
  onChange,
  onClose,
}: RelationPickerProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const createItem = useVaultStore((s) => s.createItem);
  const toast = useUiStore((s) => s.toast);

  const candidates = useMemo(
    () =>
      entries
        .filter((e) => (targetType === null ? e.type !== 'Type' : e.type === targetType))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries, targetType],
  );

  const byId = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const e of candidates) map.set(pathStem(e.path), e);
    return map;
  }, [candidates]);

  const trimmed = query.trim();
  const linkedSet = new Set(value);
  const results = useMemo(() => {
    const needle = trimmed.toLowerCase();
    return candidates.filter(
      (e) =>
        !linkedSet.has(pathStem(e.path)) &&
        (needle === '' ||
          e.title.toLowerCase().includes(needle) ||
          e.path.toLowerCase().includes(needle)),
    );
    // linkedSet is derived from `value`, which is in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, trimmed, value]);

  const exactExists = candidates.some((e) => e.title.toLowerCase() === trimmed.toLowerCase());
  const canCreate = targetType !== null && trimmed !== '' && !exactExists;

  /** Linking under a limit of 1 replaces the link and finishes the errand. */
  const link = (stem: string) => {
    if (limit === 1) {
      onChange([stem]);
      onClose();
      return;
    }
    onChange([...value, stem]);
    setQuery('');
  };

  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const create = async () => {
    if (targetType === null || busy) return;
    setBusy(true);
    try {
      const target = createTarget(targetType, { project: null, entries });
      const path = await createItem({
        folder: target.folder,
        slug: slugify(trimmed) || `record-${Date.now().toString(36)}`,
        frontmatter: target.frontmatter,
        body: `# ${trimmed}\n`,
      });
      // Link the record that was just written, by the stem it landed on —
      // create_note may have deduplicated the slug.
      link(pathStem(path));
    } catch {
      toast(`Couldn't create "${trimmed}"`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        // tabIndex -1: a click-away scrim is not a stop on the tab route.
        // Focus landing on an invisible full-screen button reads as focus
        // being lost, and Escape does nothing while parked there.
        tabIndex={-1}
        aria-label="Close relation picker"
        onClick={onClose}
        className="fixed inset-0 z-[1000] cursor-default border-0 bg-[var(--scrim)]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Link ${humanize(fieldName)}`}
        data-testid="relation-picker"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        className="fixed left-1/2 top-[8vh] z-[1001] flex max-h-[80vh] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-xl border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
      >
        <header className="flex flex-none items-center gap-2 border-b border-n-100 px-4 py-3">
          <Icon name="link" size={15} color="var(--n-500)" />
          <h2 className="m-0 text-md font-semibold text-n-900">{humanize(fieldName)}</h2>
          <span className="rounded-full border border-n-200 px-2 py-0.5 text-2xs text-n-500">
            {targetType ?? 'Any record'}
            {limit === 1 && ' · single'}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-n-50 hover:text-n-800"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="flex-none px-4 pt-3">
          <Input
            autoFocus
            icon="search"
            ariaLabel="Search records to link"
            placeholder={
              targetType === null ? 'Search records…' : `Link or create a ${targetType}…`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter links the first result, or creates when there is none —
              // the whole flow without leaving the keyboard.
              if (e.key !== 'Enter') return;
              if (results.length > 0) {
                link(pathStem(results[0].path));
              } else if (canCreate) {
                void create();
              }
            }}
            width="100%"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2 pt-3">
          {value.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
                Linked · {value.length}
              </h3>
              <div className="flex flex-col gap-px">
                {value.map((id, i) => {
                  const entry = byId.get(id) ?? null;
                  const style = typeStyle(entry?.type ?? null, schema);
                  return (
                    <div
                      key={id}
                      data-testid="relation-linked-row"
                      className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-n-25"
                    >
                      {/* 12x16px stacked with no gap was well under WCAG
                          2.5.8's 24x24 floor, on a control that decides which
                          link a narrow table cell shows. The glyph stays 11px;
                          the target grows to 24x24. */}
                      <span className="flex flex-none flex-col gap-0.5">
                        <button
                          type="button"
                          aria-label={`Move ${entry?.title ?? id} up`}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                          className="flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-n-300 hover:bg-n-50 hover:text-n-700 disabled:opacity-30"
                        >
                          <Icon name="chevron-up" size={11} />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${entry?.title ?? id} down`}
                          disabled={i === value.length - 1}
                          onClick={() => move(i, 1)}
                          className="flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-n-300 hover:bg-n-50 hover:text-n-700 disabled:opacity-30"
                        >
                          <Icon name="chevron-down" size={11} />
                        </button>
                      </span>
                      <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-n-900">
                          {entry?.title ?? id}
                        </span>
                        {/* A link to something that is not there any more is a
                            fact about the data, not an error to hide. */}
                        <span className="block truncate text-2xs text-n-400">
                          {entry === null
                            ? 'Not found in this vault'
                            : entry.folder || 'Vault root'}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Unlink ${entry?.title ?? id}`}
                        onClick={() => onChange(value.filter((v) => v !== id))}
                        className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-0 bg-transparent text-n-400 hover:bg-danger-50 hover:text-danger-600"
                      >
                        <Icon name="minus" size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            {trimmed === '' ? 'Link a record' : `Matches · ${results.length}`}
          </h3>
          <div className="flex flex-col gap-px">
            {results.map((entry) => {
              const style = typeStyle(entry.type, schema);
              const project = schema.projectForEntry(entry);
              return (
                <button
                  key={entry.path}
                  type="button"
                  data-testid="relation-result-row"
                  onClick={() => link(pathStem(entry.path))}
                  className="flex items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
                >
                  <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-n-900">{entry.title}</span>
                    <span className="block truncate text-2xs text-n-400">
                      {/* Enough to tell two "Overview"s apart, which the old
                          popover's bare title could not. */}
                      {[entry.type, project?.title, entry.folder || 'Vault root']
                        .filter((s) => s != null && s !== '')
                        .join(' · ')}
                    </span>
                  </span>
                  <Icon name="plus" size={13} color="var(--n-400)" />
                </button>
              );
            })}
            {results.length === 0 && !canCreate && (
              <p className="m-0 px-2 py-4 text-center text-sm text-n-400">
                {candidates.length === 0
                  ? `Nothing of type ${targetType ?? 'any'} exists yet.`
                  : 'Everything that matches is already linked.'}
              </p>
            )}
            {canCreate && (
              <button
                type="button"
                data-testid="relation-create"
                disabled={busy}
                onClick={() => void create()}
                className="flex items-center gap-2 rounded-md border-0 bg-transparent px-2 py-2 text-left hover:bg-n-50 disabled:opacity-50"
              >
                <Icon name="plus" size={14} color="var(--cortex-600)" />
                <span className="min-w-0 flex-1 truncate text-sm text-n-700">
                  Create <span className="font-medium text-n-900">{trimmed}</span>
                  {targetType !== null && (
                    <span className="text-n-400"> as a new {targetType}</span>
                  )}
                </span>
              </button>
            )}
          </div>
        </div>

        <footer className="flex flex-none items-center gap-2 border-t border-n-100 px-4 py-2.5">
          <span className="text-xs text-n-400">
            Links save as you make them. Order here is the order they render in.
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-n-200 bg-transparent px-3 py-1 text-sm text-n-700 hover:bg-n-50"
          >
            Done
          </button>
        </footer>
      </div>
    </>
  );
}
