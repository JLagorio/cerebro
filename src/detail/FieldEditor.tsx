import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { DatePicker } from '@/components/ui/DatePicker';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { FieldPopover, FixedBelowAnchor } from '@/detail/FieldPopover';
import type { FieldPopoverOption } from '@/detail/FieldPopover';
import { RelationPicker } from '@/detail/RelationPicker';
import { formatDateValue, makeDateValue, toIsoDate, type DateValue } from '@/engine/dates';
import { typeStyle } from '@/engine/typeCatalog';
import { formatWikilink, resolveTarget } from '@/engine/wikilink';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { ChipStyle, Entry, FieldDef, Schema } from '@/engine/types';

const pathStem = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/, '');

export const humanize = (s: string) => {
  const t = s.replace(/[-_]/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Frontmatter holds a scalar OR a list for multi-value kinds; normalize to
 * a list so one code path renders both (advisory schema: a multi-select that
 * still holds a bare string keeps working). */
const asList = (raw: unknown): string[] => {
  if (raw === null || raw === undefined || raw === '') return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String).filter((v) => v !== '');
};

const stripWikilink = (v: string) => v.replace(/^\[\[/, '').replace(/\]\]$/, '');

const toggle = (values: string[], id: string): string[] =>
  values.includes(id) ? values.filter((v) => v !== id) : [...values, id];

/** A selected multi-select value: filled pill in the option's color. */
function OptionTag({ label, color }: { label: string; color: string | null }) {
  return (
    <span
      className="inline-flex items-center rounded-[5px] px-1.5 py-px text-[11.5px] leading-[16px]"
      style={
        color === null
          ? { background: 'var(--n-100)', color: 'var(--n-700)' }
          : { background: `${color}22`, color }
      }
    >
      {label}
    </span>
  );
}

export interface FieldEditorProps {
  entry: Entry;
  def: FieldDef;
  schema: Schema;
  /** Single-line mode for table cells: multi-values clip instead of wrapping
   * onto extra rows (M3.4 — table rows are a fixed height). */
  compact?: boolean;
  /** M11: how relation chips draw. Per view — see Presentation.chips. */
  chips?: ChipStyle;
}

export function FieldEditor({
  entry,
  def,
  schema,
  compact = false,
  chips = 'plain',
}: FieldEditorProps) {
  const wrapClass = compact ? 'flex-nowrap overflow-hidden' : 'flex-wrap';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const entries = useVaultStore((s) => s.entries);
  const resolved = schema.resolveField(entry, def.name);

  const patch = (value: unknown) => void patchFrontmatter(entry.path, { [def.name]: value });

  if (def.kind === 'status' || def.kind === 'select' || def.kind === 'multiselect') {
    const statuses = schema.statusSetFor(entry);
    const options: FieldPopoverOption[] =
      def.kind === 'status'
        ? statuses.map((s) => ({ id: s.id, label: s.label, color: s.color, hollow: s.hollow }))
        : (def.options ?? []).map((o) => ({ id: o.id, label: o.label, color: o.color, hollow: o.hollow }));
    const multi = def.kind === 'multiselect';
    const values = asList(resolved.raw);
    const chips = values.map((v) => {
      const match = options.find((o) => o.id === v);
      return { id: v, label: match?.label ?? v, color: match?.color ?? null };
    });
    return (
      <span className="relative inline-flex min-w-0 max-w-full">
        {/* No aria-label: the accessible name is the value ("Todo"), which is
            what both screen readers and the panel tests read. `text-left`
            matters once values wrap — buttons center their text by default. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`inline-flex min-w-0 max-w-full ${wrapClass} items-center gap-1 rounded-md px-2 py-[3px] text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]`}
        >
          {chips.length === 0 ? (
            <span className="text-[var(--n-400)]">Empty</span>
          ) : multi ? (
            chips.map((c) => <OptionTag key={c.id} label={c.label} color={c.color} />)
          ) : (
            <>
              <span
                className="box-border h-[9px] w-[9px] flex-none rounded-full"
                style={{ background: chips[0].color ?? 'var(--n-300)' }}
              />
              {chips[0].label}
            </>
          )}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          <FieldPopover
            options={options}
            searchable={options.length > 6 || multi}
            {...(multi ? { activeIds: values } : { activeId: values[0] ?? null })}
            onPick={(id) => patch(multi ? toggle(values, id) : id)}
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    );
  }

  if (def.kind === 'person') {
    // M3.1: people hold as many targets as you pick — the popover toggles and
    // stays open, and values render as avatars.
    const options: FieldPopoverOption[] = entries
      .filter((e) => e.type === 'Person')
      .map((c) => ({ id: pathStem(c.path), label: c.title, color: null }));
    const values = asList(resolved.raw).map(stripWikilink);
    const labelOf = (id: string) => options.find((o) => o.id === id)?.label ?? id;
    return (
      <span className="relative inline-flex min-w-0 max-w-full">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`inline-flex min-w-0 max-w-full ${wrapClass} items-center gap-1 rounded-md px-2 py-[3px] text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]`}
        >
          {values.length === 0 && <span className="text-[var(--n-400)]">Empty</span>}
          {values.map((v) => (
            <span key={v} className="inline-flex min-w-0 items-center gap-[5px]">
              <Avatar name={labelOf(v)} size={18} />
              <span className="truncate">{labelOf(v)}</span>
            </span>
          ))}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          <FieldPopover
            searchable
            options={options}
            activeIds={values}
            onPick={(id) => patch(toggle(values, id).map(formatWikilink))}
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    );
  }

  if (def.kind === 'relation') {
    // A derived reciprocal (M12.4) points at the OWNING side: its candidates
    // are records of `from.type`, and edits patch those records' `from.field`
    // rather than this entry's frontmatter — one link, stored once.
    const derived = def.from !== undefined ? def.from : null;
    const targetType = derived !== null ? derived.type : (def.target ?? null);
    const values = asList(resolved.raw).map(stripWikilink);
    const targetOf = (id: string) =>
      entries.find((e) => pathStem(e.path) === id) ?? null;

    // Entry.relationships holds bracket-stripped targets; frontmatter wants
    // them back as wikilinks, so every write re-wraps the whole list.
    const pointsHere = (raw: string) =>
      resolveTarget(raw, entries)?.path === entry.path ||
      stripWikilink(raw) === pathStem(entry.path);
    const patchReciprocal = (next: string[]) => {
      if (derived === null) return;
      const current = new Set(values);
      const wanted = new Set(next);
      const jobs: Promise<void>[] = [];
      for (const id of next) {
        if (current.has(id)) continue;
        const other = targetOf(id);
        if (other === null) continue;
        const links = other.relationships[derived.field] ?? [];
        jobs.push(
          patchFrontmatter(other.path, {
            [derived.field]: [...links, pathStem(entry.path)].map(formatWikilink),
          }),
        );
      }
      for (const id of values) {
        if (wanted.has(id)) continue;
        const other = targetOf(id);
        if (other === null) continue;
        const links = (other.relationships[derived.field] ?? []).filter(
          (raw) => !pointsHere(raw),
        );
        jobs.push(
          patchFrontmatter(other.path, {
            [derived.field]: links.length === 0 ? null : links.map(formatWikilink),
          }),
        );
      }
      void Promise.all(jobs);
    };
    return (
      <span className="inline-flex min-w-0 max-w-full">
        <button
          type="button"
          data-testid="relation-field"
          aria-label={`Edit ${humanize(def.name)}`}
          onClick={() => setOpen(true)}
          className={`inline-flex min-w-0 max-w-full ${wrapClass} items-center gap-1 rounded-md px-2 py-[3px] text-left text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]`}
        >
          {values.length === 0 && <span className="text-[var(--n-400)]">Empty</span>}
          {values.map((v) => {
            const target = targetOf(v);
            // M11: a related record is a CHIP. It used to carry an
            // `arrow-up-right` glyph, which said "this is a link" — something
            // the chip shape already says — and cost a fifth of the width in a
            // narrow cell. The per-view setting swaps it for the icon of the
            // type it points at, which is information rather than decoration.
            const style = chips === 'type-icon' ? typeStyle(target?.type ?? null, schema) : null;
            return (
              <span
                key={v}
                data-testid="relation-chip"
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[5px] bg-[var(--n-100)] px-1.5 py-px leading-[17px] text-[var(--n-700)]"
              >
                {style !== null && (
                  <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-400)'} />
                )}
                <span className="truncate">{target?.title ?? v}</span>
              </span>
            );
          })}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          // M11: a dialog, not a 240px popover. Choosing what to link and
          // seeing what already is are the same question, and neither fits.
          <RelationPicker
            fieldName={def.name}
            targetType={targetType === '' ? null : targetType}
            value={values}
            limit={def.limit}
            entries={entries}
            schema={schema}
            onChange={(next) =>
              derived !== null
                ? patchReciprocal(next)
                : patch(next.length === 0 ? null : next.map(formatWikilink))
            }
            onClose={() => setOpen(false)}
          />
        )}
      </span>
    );
  }

  if (def.kind === 'date' || def.kind === 'daterange') {
    // The shared DatePicker (M2.x): frontmatter carries only what the field
    // kind can store — a bare date, or a {start, end} range.
    const today = toIsoDate(new Date());
    let value: DateValue;
    if (def.kind === 'date') {
      const raw = typeof resolved.raw === 'string' ? resolved.raw : '';
      value = makeDateValue(raw === '' ? today : raw);
    } else {
      const raw = (resolved.raw ?? {}) as { start?: string | null; end?: string | null };
      value = { ...makeDateValue(raw.start ?? today), end: raw.end ?? null };
    }
    const empty = resolved.display === '';
    return (
      <span className="relative inline-flex min-w-0 max-w-full">
        <button
          type="button"
          aria-label={humanize(def.name)}
          onClick={() => setOpen(true)}
          // whitespace-nowrap: a date range is two dates and an arrow, which
          // wrapped onto a second line inside a fixed-height table row and
          // clipped through the row below it (M11 item 3).
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 truncate whitespace-nowrap rounded-md px-2 py-[3px] text-[12.5px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
        >
          <Icon name="calendar" size={12} color="var(--n-500)" />
          {empty ? (
            <span className="text-[var(--n-400)]">Empty</span>
          ) : (
            formatDateValue({ ...value, format: 'short' }, today)
          )}
        </button>
        {open && (
          <>
            <button
              type="button"
              aria-label="Close popover"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
            />
            <FixedBelowAnchor>
              <DatePicker
                value={value}
                onChange={(v) =>
                  patch(
                    def.kind === 'date'
                      ? v.start
                      : { start: v.start, end: v.end },
                  )
                }
                onClear={() => {
                  patch(null);
                  setOpen(false);
                }}
                showEndToggle={def.kind === 'daterange'}
                showTime={false}
                showRemind={false}
              />
            </FixedBelowAnchor>
          </>
        )}
      </span>
    );
  }

  if (def.kind === 'url') {
    const url = typeof resolved.raw === 'string' ? resolved.raw : '';
    if (draft === null && url !== '') {
      const href = url.startsWith('www.') ? `https://${url}` : url;
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[12.5px] text-[var(--cortex-600)] hover:underline"
          >
            {url}
          </a>
          <button
            type="button"
            aria-label={`Edit ${humanize(def.name)}`}
            onClick={() => setDraft(url)}
            className="flex-none rounded-md border-0 bg-transparent p-1 text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
          >
            <Icon name="pencil" size={11} />
          </button>
        </span>
      );
    }
    // Falls through to the text-editing branch below via `draft`.
  }

  if (def.kind === 'files') {
    const files =
      Array.isArray(resolved.raw)
        ? resolved.raw.map(String)
        : typeof resolved.raw === 'string' && resolved.raw !== ''
          ? [resolved.raw]
          : [];
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {files.map((f) => (
          <span
            key={f}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--n-50)] px-1.5 py-px text-[12px] text-[var(--n-700)]"
          >
            <Icon name="paperclip" size={11} color="var(--n-500)" />
            <span className="truncate">{f.split('/').pop()}</span>
            <button
              type="button"
              aria-label={`Remove ${f}`}
              onClick={() => patch(files.filter((x) => x !== f))}
              className="border-0 bg-transparent p-0 text-[var(--n-400)] hover:text-[var(--danger-600,#c5372c)]"
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {draft !== null ? (
          <input
            autoFocus
            aria-label={`Add file to ${humanize(def.name)}`}
            placeholder="Path or URL"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim() !== '') patch([...files, draft.trim()]);
              setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setDraft(null);
            }}
            className="h-[22px] w-36 rounded-md border border-[var(--cortex-500)] px-1.5 text-[12px] outline-none"
          />
        ) : (
          <button
            type="button"
            aria-label={`Add file to ${humanize(def.name)}`}
            onClick={() => setDraft('')}
            className="rounded-md border-0 bg-transparent px-1 py-px text-[12px] text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
          >
            + Add
          </button>
        )}
      </span>
    );
  }

  if (def.kind === 'rollup' || def.kind === 'created_time' || def.kind === 'last_edited_time') {
    return (
      <span
        title="Computed from the vault — read only"
        className="inline-flex items-center gap-1.5 px-2 py-[3px] text-[12.5px] text-[var(--n-600)]"
      >
        {resolved.display === '' ? <span className="text-[var(--n-400)]">—</span> : resolved.display}
        <Icon name="lock" size={10} color="var(--n-300)" />
      </span>
    );
  }

  if (def.kind === 'checkbox') {
    return <Switch checked={resolved.raw === true} onChange={(checked) => patch(checked)} />;
  }

  // text | number — inline input on click
  if (draft !== null) {
    const commit = () => {
      const trimmed = draft.trim();
      // Number('junk') is NaN, which serde_yaml serializes as `.nan` on disk
      // (M1.x): refuse the commit instead of poisoning the frontmatter.
      if (def.kind === 'number' && trimmed !== '' && Number.isNaN(Number(trimmed))) {
        useUiStore.getState().toast('Enter a number');
        setDraft(null);
        return;
      }
      patch(trimmed === '' ? null : def.kind === 'number' ? Number(trimmed) : trimmed);
      setDraft(null);
    };
    return (
      <input
        autoFocus
        aria-label={humanize(def.name)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className="h-[26px] w-40 rounded-md border border-[var(--cortex-500)] px-1.5 text-[13px] text-[var(--n-900)] shadow-[0_0_0_3px_var(--cortex-100)] outline-none"
      />
    );
  }
  return (
    // max-w-full + truncate keep long text on one line inside a table cell;
    // the full value stays readable in the title and the detail panel.
    <button
      type="button"
      title={resolved.display === '' ? undefined : resolved.display}
      onClick={() => setDraft(resolved.display)}
      className="inline-flex max-w-full truncate rounded-md px-2 py-[3px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
    >
      {resolved.display === '' ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
    </button>
  );
}
