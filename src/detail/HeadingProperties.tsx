import { Icon } from '@/components/ui/Icon';
import { FieldEditor, humanize, type ScalarFieldDraft } from '@/detail/FieldEditor';
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
 * with the Show all properties / Hide properties expander that reveals the full
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
  toggleDisabled = false,
  showEmpty,
  onPatch,
  scalarDrafts,
  onScalarDraftChange,
}: {
  entry: Entry;
  schema: Schema;
  fields: FieldDef[];
  detailsShown?: boolean;
  onToggleDetails?: () => void;
  toggleDisabled?: boolean;
  /** Overrides the live type's show-empty bit — the layout editor's preview
   * passes its draft's; hosts omit it (see stripCells). */
  showEmpty?: boolean;
  /** Caller-owned draft, keyed so every strip cell edits the same record. */
  onPatch?: (patch: Record<string, unknown>) => void;
  scalarDrafts?: Record<string, ScalarFieldDraft>;
  onScalarDraftChange?: (field: string, draft: ScalarFieldDraft | null) => void;
}) {
  const shown = stripCells(entry, schema, fields, showEmpty);
  if (shown.length === 0) return null;

  const expanded = detailsShown === true;
  return (
    <div data-testid="heading-strip" className="cb-heading-properties">
      {shown.map((f) => (
        <div key={f.name} data-field={f.name} className="cb-heading-property">
          <span className="cb-heading-property-label">
            <Icon name={kindMeta(f.kind).icon} size={13} />
            <span className="truncate">{humanize(f.name)}</span>
          </span>
          <div className="cb-heading-property-value">
            <FieldEditor
              entry={entry}
              def={f}
              schema={schema}
              compact
              chrome="strip"
              scalarDraft={scalarDrafts?.[f.name]}
              onScalarDraftChange={
                onScalarDraftChange === undefined
                  ? undefined
                  : (draft) => onScalarDraftChange(f.name, draft)
              }
              onPatch={onPatch === undefined ? undefined : (value) => onPatch({ [f.name]: value })}
            />
          </div>
        </div>
      ))}
      {onToggleDetails !== undefined && (
        <button
          type="button"
          tabIndex={0}
          data-testid="view-details-toggle"
          aria-expanded={expanded}
          onClick={onToggleDetails}
          disabled={toggleDisabled}
          title={toggleDisabled ? 'Finish editing before hiding properties' : undefined}
          className="cb-heading-details rounded-md border-0 bg-transparent px-2 py-1 text-metadata text-n-500 hover:bg-n-50 hover:text-n-700"
        >
          {expanded ? 'Hide properties' : 'Show all properties'}
        </button>
      )}
    </div>
  );
}
