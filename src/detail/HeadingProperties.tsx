import { Icon } from '@/components/ui/Icon';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { foldsWhenUnset, kindMeta, splitByVisibility } from '@/engine/properties';
import type { Entry, FieldDef, Schema } from '@/engine/types';

/**
 * The strip's post-fold cells: which of the resolved heading fields actually
 * render. Exported so the HOSTS gate on the strip actually SHOWING — they
 * render the full stack whenever this comes back empty (the amended Task 7
 * ruling), and sharing the predicate here is what keeps the host's gate and
 * the strip's own fold from drifting apart.
 *
 * `showEmpty` overrides the live type's display bit (M45.2): the layout
 * editor's preview folds by its DRAFT, not the vault. Hosts omit it and keep
 * the live lookup.
 */
export function stripCells(
  entry: Entry,
  schema: Schema,
  fields: FieldDef[],
  showEmpty?: boolean,
): FieldDef[] {
  const show =
    showEmpty ?? (entry.type ? schema.types.get(entry.type)?.display.showEmpty === true : false);
  return splitByVisibility(fields, foldsWhenUnset(entry, schema, show)).shown;
}

/**
 * The key-property strip under a record's title (M45.1, spec §3.4): the
 * type's `layout.heading` fields as a horizontal wrap of labeled editors,
 * with the View details / Hide details expander that reveals the full
 * property stack.
 *
 * `fields` is the RESOLVED heading — the hosts run `resolveLayout` and pass
 * defs, so the strip never reads `layout:` itself. Visibility folding still
 * applies here: `hide` and empty-under-`hide_when_empty` fields fold out of
 * the strip with the SAME predicate the property stack uses, so the two
 * surfaces never disagree about what a field's visibility means. When
 * folding leaves nothing, the strip renders nothing at all — including the
 * toggle, which exists to expand a strip that is on screen.
 */
export function HeadingProperties({
  entry,
  schema,
  fields,
  detailsShown,
  onToggleDetails,
  showEmpty,
}: {
  entry: Entry;
  schema: Schema;
  fields: FieldDef[];
  detailsShown?: boolean;
  onToggleDetails?: () => void;
  /** Overrides the live type's show-empty bit — the layout editor's preview
   * passes its draft's; hosts omit it (see stripCells). */
  showEmpty?: boolean;
}) {
  const shown = stripCells(entry, schema, fields, showEmpty);
  if (shown.length === 0) return null;

  const expanded = detailsShown === true;
  // gap-x-2 is 8px, the measured strip gap (§A.2). It reads as the 20px it
  // always did, because each cell now carries its own 6px of padding.
  return (
    <div data-testid="heading-strip" className="mb-3 flex flex-wrap items-start gap-x-2 gap-y-2">
      {shown.map((f) => (
        <div key={f.name} data-field={f.name} className="flex min-w-0 flex-col">
          {/* The same label cell as the panel's, folded 90° — and the one
              place the two are deliberately DIFFERENT: 13/500/18 here against
              14/400/20 there (§A8). Smaller and heavier, because this label is
              a column header rather than a row label. Ours had them identical,
              which was the real defect; the sizes come from our own ramp.

              The icon→text gap is 2px here and 6px in the panel (§A10), and
              the glyph is 14px rather than 16 — the slot stays 18 x 24 so a
              strip cell and a panel row start their text at the same offset. */}
          <span className="flex h-6 items-center gap-0.5 rounded-sm px-1.5">
            <span className="flex h-6 w-[18px] flex-none items-center justify-center">
              <Icon name={kindMeta(f.kind).icon} size={14} color="var(--n-400)" />
            </span>
            <span className="truncate text-sm font-medium leading-[18px] text-n-500">
              {humanize(f.name)}
            </span>
          </span>
          <FieldEditor entry={entry} def={f} schema={schema} compact chrome="strip" />
        </div>
      ))}
      {onToggleDetails !== undefined && (
        <button
          type="button"
          data-testid="view-details-toggle"
          aria-expanded={expanded}
          onClick={onToggleDetails}
          className="mt-0.5 self-center rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
        >
          {expanded ? 'Hide details' : 'View details'}
        </button>
      )}
    </div>
  );
}
