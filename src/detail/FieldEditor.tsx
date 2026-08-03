import { useState } from 'react';
import { PICKABLE_OPTION_COLORS, resolveOptionColor } from '@/lib/swatch';
import { setFieldConfig, setFieldOptions, setTypeStatuses } from '@/app/typeActions';
import { Avatar } from '@/components/ui/Avatar';
import { DatePicker } from '@/components/ui/DatePicker';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { EscapeToClose, FieldPopover, FixedBelowAnchor } from '@/detail/FieldPopover';
import { FilesField } from '@/detail/FilesField';
import type { FieldPopoverOption } from '@/detail/FieldPopover';
import { findOptionByLabel, optionId, personCandidates } from '@/engine/properties';
import { RelationPicker } from '@/detail/RelationPicker';
import {
  DEFAULT_TIME_FORMAT,
  makeDateValue,
  parseDateProperty,
  serializeDateProperty,
  toIsoDate,
  type DateValue,
} from '@/engine/dates';
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

/**
 * A selected multi-select value: a pill tinted with the option's colour.
 *
 * It used to paint the LABEL in the raw option colour over a 13% tint of that
 * same colour — amber text on amber at about 1.8:1 — and built the tint by
 * string concatenation, so `#fff` became `#fff22`, an invalid declaration the
 * browser drops, and a three-digit hex rendered a clear pill (M16.12).
 */
function OptionTag({ label, color }: { label: string; color: string | null }) {
  const sw = resolveOptionColor(color);
  return (
    <span
      className="inline-flex items-center rounded-[5px] px-1.5 py-px text-[11.5px] leading-[16px]"
      style={{ background: sw.tint, color: sw.ink }}
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
    const multi = def.kind === 'multiselect';
    const values = asList(resolved.raw);
    const ownerType = entry.type;

    // The options THIS RECORD's type declares, not whatever `def` carries.
    //
    // In a typeless view `columnUniverse` unions the field across every type
    // present and keeps the first declaration's options, flagging
    // `heterogeneous` only when the KINDS differ. Two types each declaring a
    // select named `status` are therefore not flagged, so creating an option
    // on a row of type B wrote `setFieldOptions(B, name, [...A's options,
    // new])` — replacing B's option set with A's (M16.12).
    const ownerDef =
      ownerType === null
        ? undefined
        : schema.types.get(ownerType)?.fields.find((f) => f.name === def.name);
    const declaredOptions = ownerDef?.options ?? [];
    const options: FieldPopoverOption[] =
      def.kind === 'status'
        ? statuses.map((s) => ({ id: s.id, label: s.label, color: s.color, hollow: s.hollow }))
        : (ownerDef?.options ?? def.options ?? []).map((o) => ({
            id: o.id,
            label: o.label,
            color: o.color,
            hollow: o.hollow,
          }));

    // Where a status set comes from decides whether writing to the type would
    // do anything: a project override lives on the project, not the type.
    const statusSource = schema.statusSourceFor(entry);
    const canWriteOptions =
      ownerType !== null && ownerDef !== undefined && ownerDef.kind === def.kind;

    /**
     * Typing a label into the picker declares it (M3.1, extended M16.12).
     *
     * A freshly declared Select had no options and the popover was a dead
     * end. Status was excluded outright and told you to go to the type
     * screen — which is no longer even the only place, since M16.7 mounts the
     * editors in the record panel. Statuses live in a different store (the
     * type's `statuses:`), so they take a different write, not no write.
     */
    const createOption =
      (def.kind === 'status' ? statusSource === 'type' || statusSource === 'default' : true) &&
      canWriteOptions &&
      ownerType !== null
        ? (label: string) => {
            // Slug-aware: if the label collides with an option that already
            // exists, SELECT it rather than appending a shadowed twin.
            const existing = findOptionByLabel(
              def.kind === 'status' ? statuses : declaredOptions,
              label,
            );
            if (existing !== undefined) {
              patch(multi ? toggle(values, existing.id) : existing.id);
              return;
            }
            const id = optionId(label);
            void (async () => {
              if (def.kind === 'status') {
                // Spreading `statuses` when it is DEFAULT_STATUSES is
                // deliberate: it materialises the default chain onto the Type
                // doc, which is the list the user is looking at. docPath is
                // null because setTypeStatuses resolves the doc itself and
                // creates one when it is missing.
                const ok = await setTypeStatuses({ name: ownerType, docPath: null }, [
                  ...statuses,
                  {
                    id,
                    label,
                    color: PICKABLE_OPTION_COLORS[statuses.length % PICKABLE_OPTION_COLORS.length],
                    // The engine's own fallback; there is no group picker in
                    // a one-line create row.
                    group: 'active',
                  },
                ]);
                if (ok) patch(id);
                return;
              }
              const ok = await setFieldOptions(ownerType, def.name, [
                ...declaredOptions,
                {
                  id,
                  label,
                  color:
                    PICKABLE_OPTION_COLORS[declaredOptions.length % PICKABLE_OPTION_COLORS.length],
                },
              ]);
              if (ok) patch(multi ? toggle(values, id) : id);
            })();
          }
        : undefined;
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
                style={{ background: resolveOptionColor(chips[0].color).solid }}
              />
              {chips[0].label}
            </>
          )}
          <Icon name="chevron-down" size={11} color="var(--n-400)" />
        </button>
        {open && (
          <FieldPopover
            options={options}
            searchable={options.length > 6 || multi || createOption !== undefined}
            {...(createOption !== undefined ? { onCreate: createOption } : {})}
            // Both hints used to send you to the type screen, which stopped
            // being the only route when M16.7 put the property editor in the
            // record panel — and for status it was a dead end, since nothing
            // here could create one at all.
            emptyHint={
              canWriteOptions
                ? `No ${def.kind === 'status' ? 'statuses' : 'options'} yet — type one to add it.`
                : `No ${def.kind === 'status' ? 'statuses' : 'options'} yet — add them from the property menu.`
            }
            unavailableHint={
              def.kind === 'status' && statusSource === 'project'
                ? 'Statuses come from this record’s project — edit them there.'
                : canWriteOptions
                  ? undefined
                  : 'Add options from the property menu.'
            }
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
    //
    // Candidates came from `e.type === 'Person'` until M16.13b, which is the
    // type-name routing AGENTS.md forbids: a vault whose people are
    // `Teammate`s got an empty picker with no control anywhere to fix it.
    const options: FieldPopoverOption[] = personCandidates(def, schema, entries, entry.type).map(
      (c) => ({ id: pathStem(c.path), label: c.title, color: null }),
    );
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
    const targetOf = (id: string) => entries.find((e) => pathStem(e.path) === id) ?? null;

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
        const links = (other.relationships[derived.field] ?? []).filter((raw) => !pointsHere(raw));
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
    // kind can store — a bare date, or a {start, end} range, either endpoint
    // optionally carrying a time (M16.14).
    const today = toIsoDate(new Date());
    const kind = def.kind;
    const stored = parseDateProperty(resolved.raw);
    // Display config lives on the PROPERTY, not in the value, so every record
    // of the type renders the same way — which is what a format setting means.
    // Before M16.14 the picker's format menu was discarded the moment the
    // popover closed.
    const value: DateValue = {
      ...(stored ?? makeDateValue(today)),
      format: def.dateFormat ?? 'short',
      timeFormat: def.timeFormat ?? DEFAULT_TIME_FORMAT,
    };
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
          {empty ? <span className="text-[var(--n-400)]">Empty</span> : resolved.display}
        </button>
        {open && (
          <>
            {/* Escape closes the date popover, not the record panel behind it. */}
            <EscapeToClose onClose={() => setOpen(false)} />
            <button
              type="button"
              tabIndex={-1}
              aria-label="Close popover"
              onClick={() => setOpen(false)}
              onWheel={() => setOpen(false)}
              className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
            />
            <FixedBelowAnchor>
              <DatePicker
                value={value}
                onChange={(v) => {
                  // The value and its display config go to different files: the
                  // dates to this record, the format to the TYPE, so every
                  // record of it renders alike. Splitting them here is what
                  // makes the format menu persist at all (M16.14).
                  if (v.format !== value.format || v.timeFormat !== value.timeFormat) {
                    if (entry.type !== null) {
                      void setFieldConfig(entry.type, def.name, {
                        dateFormat: v.format === 'short' ? null : v.format,
                        timeFormat: v.timeFormat === DEFAULT_TIME_FORMAT ? null : v.timeFormat,
                      });
                    }
                    return;
                  }
                  patch(serializeDateProperty(v, kind));
                }}
                onClear={() => {
                  patch(null);
                  setOpen(false);
                }}
                showEndToggle={kind === 'daterange'}
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

  if (def.kind === 'email' || def.kind === 'phone') {
    // The url branch's shape, with the scheme the kind implies. Nothing
    // validates the value — see validateValue: refusing a frontmatter write
    // is a worse failure than an address that will not linkify — so the
    // link is offered for whatever is stored and the pencil always returns
    // you to the text.
    const value = typeof resolved.raw === 'string' ? resolved.raw : '';
    if (draft === null && value !== '') {
      const href =
        def.kind === 'email'
          ? value.startsWith('mailto:')
            ? value
            : `mailto:${value}`
          : `tel:${value.replace(/[^\d+]/g, '')}`;
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          <a
            href={href}
            className="truncate text-[12.5px] text-[var(--cortex-600)] hover:underline"
          >
            {value.replace(/^mailto:/, '')}
          </a>
          <button
            type="button"
            aria-label={`Edit ${humanize(def.name)}`}
            onClick={() => setDraft(value)}
            className="flex-none rounded-md border-0 bg-transparent p-1 text-[var(--n-400)] hover:bg-[var(--n-50)] hover:text-[var(--n-700)]"
          >
            <Icon name="pencil" size={11} />
          </button>
        </span>
      );
    }
    // Falls through to the shared text editor below.
  }

  if (def.kind === 'files') {
    // M16.13c: picking now COPIES into the vault and stores a vault-relative
    // path, so the value survives the vault being synced or moved. The whole
    // control lives in its own component because it needs hooks, and this
    // function is a chain of early returns.
    return (
      <FilesField
        values={asList(resolved.raw)}
        label={humanize(def.name)}
        onChange={(next) => patch(next.length === 0 ? null : next)}
      />
    );
  }

  if (def.kind === 'rollup' || def.kind === 'created_time' || def.kind === 'last_edited_time') {
    return (
      <span
        title="Computed from the vault — read only"
        className="inline-flex items-center gap-1.5 px-2 py-[3px] text-[12.5px] text-[var(--n-600)]"
      >
        {resolved.display === '' ? (
          <span className="text-[var(--n-400)]">—</span>
        ) : (
          resolved.display
        )}
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
      // A number field's display carries its format ("$1,840", "76%"). The
      // draft is seeded raw (see the read view below), but a user may well
      // retype the decoration they can see, so strip it before parsing —
      // the same tolerance progressRatio applies in engine/properties.
      const numeric = def.kind === 'number' ? trimmed.replace(/[%$,]/g, '').trim() : trimmed;
      // Number('junk') is NaN, which serde_yaml serializes as `.nan` on disk
      // (M1.x): refuse the commit instead of poisoning the frontmatter.
      if (def.kind === 'number' && numeric !== '' && Number.isNaN(Number(numeric))) {
        useUiStore.getState().toast('Enter a number');
        setDraft(null);
        return;
      }
      if (def.kind === 'number') {
        patch(numeric === '' ? null : Number(numeric));
        setDraft(null);
        return;
      }
      patch(trimmed === '' ? null : trimmed);
      setDraft(null);
    };
    return (
      <input
        autoFocus
        // The right keyboard on touch, and the browser's own affordances
        // (autofill, the phone keypad). The input was untyped for every kind.
        type={def.kind === 'email' ? 'email' : def.kind === 'phone' ? 'tel' : 'text'}
        inputMode={def.kind === 'phone' ? 'tel' : def.kind === 'email' ? 'email' : undefined}
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
        className="h-[26px] w-40 rounded-md border border-[var(--cortex-500)] px-1.5 text-[13px] text-[var(--n-900)] shadow-[var(--ring)] outline-none"
      />
    );
  }
  return (
    // max-w-full + truncate keep long text on one line inside a table cell;
    // the full value stays readable in the title and the detail panel.
    // The ellipsis lives on the inner span: `truncate` on a flex CONTAINER
    // clips without one, which is why these cells cut off mid-word.
    <button
      type="button"
      title={resolved.display === '' ? undefined : resolved.display}
      // Seed the draft from the RAW value, never the formatted display: a
      // percent field opened holding "76%" and a currency field "$1,840",
      // and commit then rejected the app's own display string as not a
      // number. Formats are presentation only (engine/properties).
      onClick={() =>
        setDraft(
          def.kind === 'number' && typeof resolved.raw === 'number'
            ? String(resolved.raw)
            : resolved.display,
        )
      }
      className="inline-flex min-w-0 max-w-full rounded-md px-2 py-[3px] text-left text-[13px] text-[var(--n-800)] hover:bg-[var(--n-50)]"
    >
      {resolved.display === '' ? (
        <span className="text-[var(--n-400)]">Empty</span>
      ) : (
        <span className="min-w-0 truncate">{resolved.display}</span>
      )}
    </button>
  );
}
