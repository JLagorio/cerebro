import { Icon } from '@/components/ui/Icon';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { isEmptyForVisibility, kindMeta, splitByVisibility } from '@/engine/properties';
import type { Entry, FieldDef, Schema } from '@/engine/types';

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
}: {
  entry: Entry;
  schema: Schema;
  fields: FieldDef[];
  detailsShown?: boolean;
  onToggleDetails?: () => void;
}) {
  const showEmpty = entry.type ? schema.types.get(entry.type)?.display.showEmpty === true : false;
  const { shown } = splitByVisibility(
    fields,
    (f) => !showEmpty && isEmptyForVisibility(f, schema.resolveField(entry, f.name).display),
  );
  if (shown.length === 0) return null;

  const expanded = detailsShown === true;
  return (
    <div data-testid="heading-strip" className="mb-3 flex flex-wrap items-start gap-x-5 gap-y-2">
      {shown.map((f) => (
        <div key={f.name} data-field={f.name} className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <Icon name={kindMeta(f.kind).icon} size={13} color="var(--n-400)" />
            <span className="truncate text-xs text-n-500">{humanize(f.name)}</span>
          </span>
          <FieldEditor entry={entry} def={f} schema={schema} compact />
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
