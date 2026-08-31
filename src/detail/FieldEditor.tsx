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
import {
  findOptionByLabel,
  normalizeUrl,
  optionId,
  peopleTypes,
  progressRatio,
  personCandidates,
  relationTargetFor,
} from '@/engine/properties';
import { createTarget } from '@/engine/createRecord';
import { RelationPicker } from '@/detail/RelationPicker';
import { slugify } from '@/lib/slug';
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
      className="inline-flex items-center rounded-sm px-1.5 py-px text-xs leading-[16px]"
      style={{ background: sw.tint, color: sw.ink }}
    >
      {label}
    </span>
  );
}

/**
 * What an unset value draws (M16.35).
 *
 * `ghost` is Notion's RECORD PAGE: grey "Empty" standing in for the value, so
 * the property is still a visible, clickable row. `blank` is Notion's TABLE
 * CELL: nothing at all — no ghost text, no chevron, no per-cell type icon —
 * with the affordance arriving on hover/focus instead.
 *
 * Deliberately NOT derived from `compact`, which means "this view does not
 * wrap text": turning column wrapping on would otherwise silently repaint
 * every empty cell.
 */
export type FieldPlaceholder = 'ghost' | 'blank';

/**
 * A blank cell draws nothing, so the BUTTON has to be the hit target — Notion's
 * unset cell is clickable across its whole width, not in the 16px of padding
 * that is all a button with no children would occupy. `flex-1 self-stretch`
 * fills the cell it is laid into; the `min-h` is the floor when nothing around
 * it has height either.
 */
const BLANK_FILL = 'min-h-[22px] flex-1 self-stretch';

/**
 * Which surface's value CELL this control is (M46.2 Task 7, reference §A.1
 * and §A.2). The measurements are of one box under three shapes, so they are
 * declared in one table rather than repeated across the control branches
 * below.
 *
 * - `cell` — a table or list cell. Untouched by the row work: the grid has its
 *   own chrome and its own hover story (`styles/table-chrome.css`).
 * - `panel` — a vertical property row's value. `padding: 6px`, radius **4px**,
 *   `min-height: 34px`, `overflow: hidden`, `cursor: pointer`, and **no hover
 *   background at all**. The radius being SMALLER than the label cell's 6px is
 *   the measured hierarchy, and ours had it exactly inverted (8 against 6).
 *   The missing wash is the point of §A6: only the label lights, or the row
 *   reads as two buttons instead of as one label with a value.
 * - `strip` — the heading strip's value: `4px 6px`, radius 4px, `min-height:
 *   30px`. Notion's strip value cell was measured for geometry only — no hover
 *   was read on that surface either way — so the wash STAYS here, where the
 *   value is the only thing in the column you can click. That keeps the
 *   strip's own version of the one-lit-region rule without inventing a
 *   measurement. Its wash carries the 20ms hover token, which the re-measure
 *   found it was missing while the panel's label cell had it (M46.2 Task 8):
 *   an undeclared wash strobes under a pointer crossing the strip, and the
 *   guard is the same one for the same reason wherever a wash exists. `cell`
 *   is left alone on purpose — the grid's hover is its own story and was
 *   never on the measured checklist.
 */
export type FieldChrome = 'cell' | 'panel' | 'strip';

const CHROME: Record<FieldChrome, string> = {
  cell: 'rounded-md px-2 py-[3px] hover:bg-n-50',
  panel: 'min-h-[34px] cursor-pointer overflow-hidden rounded-xs p-1.5',
  strip:
    'min-h-[30px] cursor-pointer overflow-hidden rounded-xs px-1.5 py-1 motion-hover hover:bg-n-50',
};

export interface FieldEditorProps {
  entry: Entry;
  def: FieldDef;
  schema: Schema;
  /** Single-line mode for table cells: multi-values clip instead of wrapping
   * onto extra rows (M3.4 — table rows are a fixed height). */
  compact?: boolean;
  /** M11: how relation chips draw. Per view — see Presentation.chips. */
  chips?: ChipStyle;
  /** M16.35: how an UNSET value draws. Defaults to the record page's ghost
   * "Empty" so every existing consumer is unchanged; the table opts into
   * `blank`. See FieldPlaceholder. */
  placeholder?: FieldPlaceholder;
  /** M46.2: which surface's value cell this is. Defaults to the grid's, so a
   * consumer that has not been fitted keeps exactly the box it had. */
  chrome?: FieldChrome;
}

export function FieldEditor({
  entry,
  def,
  schema,
  compact = false,
  chips = 'plain',
  placeholder = 'ghost',
  chrome = 'cell',
}: FieldEditorProps) {
  const wrapClass = compact ? 'flex-nowrap overflow-hidden' : 'flex-wrap';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const entries = useVaultStore((s) => s.entries);
  // M20.1: the person branch can create a person. Hooks cannot live inside it —
  // this component is a chain of early returns keyed on `def.kind`.
  const createItem = useVaultStore((s) => s.createItem);
  const resolved = schema.resolveField(entry, def.name);

  const patch = (value: unknown) => void patchFrontmatter(entry.path, { [def.name]: value });
  /**
   * A multi-value field emptied back to nothing drops its KEY (M20.3).
   *
   * It used to write `field: []`, which is not what "unset" looks like
   * anywhere else in the vault: `files` and `relation` already patch `null`,
   * every read path treats an absent key and an empty list identically, and
   * the difference is a line of YAML that only ever accumulates. `null` is the
   * one delete spelling every backend honours (see vaultStore.patchFrontmatter).
   */
  const patchList = (next: unknown[]) => patch(next.length === 0 ? null : next);

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
    // Nothing chosen and this is a table cell: paint the cell blank, chevron
    // included (M16.35).
    const blank = placeholder === 'blank' && chips.length === 0;
    return (
      <span className={`relative inline-flex min-w-0 max-w-full ${blank ? BLANK_FILL : ''}`}>
        {/* No aria-label while there is a value: the accessible name is the
            value ("Todo"), which is what both screen readers and the panel
            tests read. A blank cell has no such name, so it borrows the
            property's. `text-left` matters once values wrap — buttons center
            their text by default. */}
        <button
          type="button"
          {...(blank ? { 'aria-label': humanize(def.name) } : {})}
          data-cell-primary
          onClick={() => setOpen(true)}
          className={`inline-flex min-w-0 max-w-full ${wrapClass} ${blank ? BLANK_FILL : ''} items-center gap-1 ${CHROME[chrome]} text-left text-sm text-n-800`}
        >
          {chips.length === 0 ? (
            blank ? null : (
              <span className="text-n-400">Empty</span>
            )
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
          {!blank && <Icon name="chevron-down" size={11} color="var(--n-400)" />}
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
            {...(values.length > 0 ? { onClear: () => patch(null) } : {})}
            // Picking the option already chosen CLEARS it (M20.3). A
            // single-select had no route back to empty: the popover offered
            // the declared options and nothing else, and clicking the active
            // one re-wrote the same value. Demo-vault's Priority declares a
            // literal "None" option, which masked this; Estimate (XS/S/M/L/XL)
            // is the honest case, and it was a one-way door. Multi already
            // toggles, which is the same gesture meaning the same thing.
            onPick={(id) =>
              multi ? patchList(toggle(values, id)) : patch(values[0] === id ? null : id)
            }
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
    const options: FieldPopoverOption[] = personCandidates(def, schema, entries, entry).map((c) => {
      // M20.3: every row drew the same grey dot, so a Project and a person
      // were indistinguishable in a picker whose whole job is telling them
      // apart. The relation CHIPS already carry the target type's icon.
      const style = typeStyle(c.type, schema);
      return {
        id: pathStem(c.path),
        label: c.title,
        color: null,
        icon: style.icon,
        iconColor: style.color,
      };
    });
    const values = asList(resolved.raw).map(stripWikilink);
    /**
     * M20.3: `limit: 1` means one person, and this branch ignored it in both
     * halves — the picker toggled and stayed open, and `validateValue`'s
     * person case never checked the cardinality its relation case enforces.
     * A person field IS a relation with an avatar renderer (M16.13b), so it
     * answers this the same way: picking replaces, and the popover closes.
     */
    const single = def.limit === 1;
    const labelOf = (id: string) => options.find((o) => o.id === id)?.label ?? id;
    const blank = placeholder === 'blank' && values.length === 0;

    /**
     * Typing a name that does not exist creates that person (M20.1).
     *
     * Every other picker in the app could do this and only the person branch
     * could not: a select cell offers "Create Blocker", a relation cell offers
     * "Link or create a …" and writes a real record, and a person cell said
     * "No matches" and stopped. Which is why `personCandidates` used to fall
     * back to listing the whole vault — the dead end was real, but the answer
     * was a create affordance, not a picker full of Projects.
     *
     * Which type to create is the same question the picker answers, in the
     * same order: the field's declared or inferred target, then the vault's
     * one people type. With no notion of people at all it is `Person` — the
     * last-resort convention `peopleTypes` already documents, and creating the
     * first one is what ESTABLISHES the vault's people type, because
     * `relationTargetFor` then infers it back off the value just written. With
     * two or more people types and no target the answer is genuinely ambiguous,
     * so nothing is offered; the picker still lists all of them.
     */
    const known = peopleTypes(schema, entries);
    const createType =
      relationTargetFor(def, entries, entry.type) ??
      (known.size === 1 ? [...known][0] : known.size === 0 ? 'Person' : null);
    const createPerson =
      createType === null
        ? undefined
        : (name: string) => {
            void (async () => {
              const target = createTarget(createType, { project: null, entries, schema });
              try {
                const path = await createItem({
                  folder: target.folder,
                  slug: slugify(name) || `person-${Date.now().toString(36)}`,
                  frontmatter: target.frontmatter,
                  body: `# ${name}\n`,
                });
                // By the stem it LANDED on — create_note may deduplicate.
                const stem = pathStem(path);
                patch(single ? [formatWikilink(stem)] : toggle(values, stem).map(formatWikilink));
              } catch {
                useUiStore.getState().toast(`Couldn't create "${name}"`);
              }
            })();
          };
    return (
      <span className={`relative inline-flex min-w-0 max-w-full ${blank ? BLANK_FILL : ''}`}>
        <button
          type="button"
          {...(blank ? { 'aria-label': humanize(def.name) } : {})}
          data-cell-primary
          onClick={() => setOpen(true)}
          className={`inline-flex min-w-0 max-w-full ${wrapClass} ${blank ? BLANK_FILL : ''} items-center gap-1 ${CHROME[chrome]} text-left text-sm text-n-800`}
        >
          {values.length === 0 && !blank && <span className="text-n-400">Empty</span>}
          {values.map((v) => (
            <span key={v} className="inline-flex min-w-0 items-center gap-[5px]">
              <Avatar name={labelOf(v)} size={18} />
              <span className="truncate">{labelOf(v)}</span>
            </span>
          ))}
          {!blank && <Icon name="chevron-down" size={11} color="var(--n-400)" />}
        </button>
        {open && (
          <FieldPopover
            searchable
            options={options}
            {...(single ? { activeId: values[0] ?? null } : { activeIds: values })}
            {...(values.length > 0 ? { onClear: () => patch(null) } : {})}
            {...(createPerson !== undefined ? { onCreate: createPerson } : {})}
            emptyHint={
              createPerson === undefined
                ? 'This vault has no people yet.'
                : `No people yet — type a name to add one${
                    createType === null ? '' : ` as a new ${createType}`
                  }.`
            }
            onPick={(id) =>
              single
                ? patch(values[0] === id ? null : [formatWikilink(id)])
                : patchList(toggle(values, id).map(formatWikilink))
            }
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
      const jobs: Promise<boolean>[] = [];
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
    const blank = placeholder === 'blank' && values.length === 0;
    return (
      <span className={`inline-flex min-w-0 max-w-full ${blank ? BLANK_FILL : ''}`}>
        <button
          type="button"
          data-testid="relation-field"
          aria-label={`Edit ${humanize(def.name)}`}
          data-cell-primary
          onClick={() => setOpen(true)}
          className={`inline-flex min-w-0 max-w-full ${wrapClass} ${blank ? BLANK_FILL : ''} items-center gap-1 ${CHROME[chrome]} text-left text-sm text-n-800`}
        >
          {values.length === 0 && !blank && <span className="text-n-400">Empty</span>}
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
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm bg-n-100 px-1.5 py-px leading-[17px] text-n-700"
              >
                {style !== null && (
                  <Icon name={style.icon} size={10} color={style.color ?? 'var(--n-400)'} />
                )}
                <span className="truncate">{target?.title ?? v}</span>
              </span>
            );
          })}
          {!blank && <Icon name="chevron-down" size={11} color="var(--n-400)" />}
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
    // The calendar glyph goes with the ghost text: Notion's Due column is
    // plain text with no icon, and an unset one is nothing at all (M16.35).
    const blank = placeholder === 'blank' && empty;
    return (
      <span className={`relative inline-flex min-w-0 max-w-full ${blank ? BLANK_FILL : ''}`}>
        <button
          type="button"
          aria-label={humanize(def.name)}
          data-cell-primary
          onClick={() => setOpen(true)}
          // whitespace-nowrap: a date range is two dates and an arrow, which
          // wrapped onto a second line inside a fixed-height table row and
          // clipped through the row below it (M11 item 3).
          className={`inline-flex min-w-0 max-w-full ${blank ? BLANK_FILL : ''} items-center gap-1.5 truncate whitespace-nowrap ${CHROME[chrome]} text-sm text-n-800`}
        >
          {!blank && <Icon name="calendar" size={12} color="var(--n-500)" />}
          {empty && !blank && <span className="text-n-400">Empty</span>}
          {!empty && resolved.display}
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
            className="truncate text-sm text-cortex-600 hover:underline"
          >
            {url}
          </a>
          <button
            type="button"
            aria-label={`Edit ${humanize(def.name)}`}
            onClick={() => setDraft(url)}
            className="flex-none rounded-md border-0 bg-transparent p-1 text-n-400 hover:bg-n-50 hover:text-n-700"
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
          <a href={href} className="truncate text-sm text-cortex-600 hover:underline">
            {value.replace(/^mailto:/, '')}
          </a>
          <button
            type="button"
            aria-label={`Edit ${humanize(def.name)}`}
            onClick={() => setDraft(value)}
            className="flex-none rounded-md border-0 bg-transparent p-1 text-n-400 hover:bg-n-50 hover:text-n-700"
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
        className="inline-flex items-center gap-1.5 px-2 py-[3px] text-sm text-n-600"
      >
        {resolved.display === '' ? <span className="text-n-400">—</span> : resolved.display}
        <Icon name="lock" size={10} color="var(--n-300)" />
      </span>
    );
  }

  if (def.kind === 'checkbox') {
    return <Switch checked={resolved.raw === true} onChange={(checked) => patch(checked)} />;
  }

  // text | number — inline input on click
  if (draft !== null) {
    /**
     * A refused write keeps the draft (M20.3).
     *
     * `setDraft(null)` ran unconditionally, so a value the schema turned away
     * took the text with it: type `example.com` into a URL cell and you got a
     * toast, the old value back, and nothing left to correct. The write path
     * reports refusals now (vaultStore.patchFrontmatter), so the editor can
     * stay open on exactly what was typed.
     */
    const commitValue = (value: unknown) => {
      void (async () => {
        if (await patchFrontmatter(entry.path, { [def.name]: value })) setDraft(null);
      })();
    };
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
        return;
      }
      if (def.kind === 'number') {
        commitValue(numeric === '' ? null : Number(numeric));
        return;
      }
      // M20.3: the scheme people leave off. The renderer already prepends one
      // when it draws the anchor, so refusing `example.com` on the way in held
      // the value to a stricter standard than the way out.
      const text = def.kind === 'url' ? normalizeUrl(trimmed) : trimmed;
      commitValue(text === '' ? null : text);
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
            // Abandoning is still one keystroke — keeping a refused draft is
            // about not LOSING work, not about trapping anyone in the cell.
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className="h-[26px] w-40 rounded-md border border-cortex-500 px-1.5 text-sm text-n-900 shadow-[var(--ring)] outline-none"
      />
    );
  }
  const blank = placeholder === 'blank' && resolved.display === '';
  // A progress-formatted number draws its bar as the resting state (M20.3).
  const ratio =
    def.kind === 'number' && def.format === 'progress' ? progressRatio(resolved.display) : null;
  return (
    // max-w-full + truncate keep long text on one line inside a table cell;
    // the full value stays readable in the title and the detail panel.
    // The ellipsis lives on the inner span: `truncate` on a flex CONTAINER
    // clips without one, which is why these cells cut off mid-word.
    <button
      type="button"
      title={resolved.display === '' ? undefined : resolved.display}
      // A blank cell renders no text, so nothing is left to name it. The
      // property does the naming instead — blank means "draws no glyph", not
      // "is invisible to a screen reader or a click" (M16.35).
      {...(blank ? { 'aria-label': humanize(def.name) } : {})}
      data-cell-primary
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
      className={`inline-flex min-w-0 max-w-full ${blank ? BLANK_FILL : ''} ${CHROME[chrome]} text-left text-sm text-n-800`}
    >
      {resolved.display === '' ? (
        blank ? null : (
          <span className="text-n-400">Empty</span>
        )
      ) : ratio === null ? (
        <span className="min-w-0 truncate">{resolved.display}</span>
      ) : (
        // M20.3: a format is a DISPLAY, not a permission. The bar used to be
        // drawn by the table, which then had to render the cell read-only to
        // draw it — so the same property was editable in the panel and not in
        // the grid. Drawn here, it is the resting state of an ordinary number
        // editor and clicking it opens the input in both surfaces.
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-n-100">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${ratio}%`,
                background: ratio >= 100 ? 'var(--success-500)' : 'var(--cortex-500)',
              }}
            />
          </span>
          <span className="flex-none [font-family:var(--font-mono)] text-2xs text-n-600">
            {resolved.display}
          </span>
        </span>
      )}
    </button>
  );
}
