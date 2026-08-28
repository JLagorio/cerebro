import React, { useRef, useState } from 'react';
import { addPropertyToEntry, moveFieldOnType } from '@/app/typeActions';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { GroupLabel } from '@/detail/GroupLabel';
import { PropertyMenu } from '@/detail/PropertyMenu';
import { PropertyRow, ROW_ACTION } from '@/detail/PropertyRow';
import {
  foldsWhenUnset,
  inferKindFromValue,
  splitByVisibility,
  visibilityDelta,
  visibleProperties,
} from '@/engine/properties';
import { resolveLayout } from '@/engine/layout';
import { useSortableList } from '@/hooks/useSortableList';
import { LAYOUT_DEFAULTS } from '@/engine/types';
import type { Entry, FieldDef, FieldKind, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';

/** Readable text for a key the type does not declare. `properties` holds
 * `Scalar | Scalar[]` and, after a field is dropped from a type, can hold
 * object-shaped leftovers (a daterange's {start, end}) — `String(value)`
 * turned those into "[object Object]". */
function undeclaredDisplay(entry: Entry, name: string): string {
  if (name in entry.relationships) return entry.relationships[name].join(', ');
  const value = entry.properties[name];
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Which icon leads an undeclared row. A wikilink field is a relation
 * whatever its value looks like; everything else is read off the shape. */
function undeclaredKind(entry: Entry, name: string): FieldKind {
  return name in entry.relationships ? 'relation' : inferKindFromValue(entry.properties[name]);
}

/**
 * The property stack for one record: declared fields as editors, undeclared
 * frontmatter read-only, plus the add-property flyout. Extracted from
 * DetailPanel (M3) so the overlay panel and the split view's right-hand pane
 * share one code path.
 */
export function RecordProperties({ entry, schema }: { entry: Entry; schema: Schema }) {
  const [addingProp, setAddingProp] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  // The property menu edits the TYPE, so it owes the user the blast radius.
  const recordCount = useVaultStore((s) =>
    entry.type === null ? 0 : s.entries.filter((e) => e.type === entry.type).length,
  );

  const typeDef = entry.type ? (schema.types.get(entry.type) ?? null) : null;
  const allDeclared = typeDef?.fields ?? [];
  const declaredNames = new Set(allDeclared.map((f) => f.name));

  const showEmpty = typeDef?.display.showEmpty === true;

  // M16.10. Revealing folds the hidden rows back into the same list, which
  // also makes the reorder mapping below the identity case.
  const [revealed, setRevealed] = useState(false);
  const folds = foldsWhenUnset(entry, schema, showEmpty);
  const { shown, hidden } = splitByVisibility(allDeclared, folds);
  const declared = revealed ? allDeclared : shown;

  // M45.1: `layout:` arranges the stack into named groups. Resolution
  // partitions `allDeclared` exactly (heading ∪ groups ∪ rest, claim-once by
  // parse), so the split above IS the pooled hidden count: the one expander
  // below spans every container — the heading strip's folds included —
  // without a second bookkeeping pass.
  const layout = resolveLayout(typeDef?.layout ?? LAYOUT_DEFAULTS, allDeclared);
  // Per container, the SAME fold the flat stack makes; revealing opens each
  // container's folds in place.
  const containerRows = (fields: FieldDef[]) =>
    revealed ? fields : splitByVisibility(fields, folds).shown;
  // Heading fields the strip folded. The strip cannot reveal them, so on
  // reveal they surface at the TOP of the stack — the heading is the topmost
  // container — headerless. The strip's SHOWN fields stay out of the stack.
  const headingFolds = splitByVisibility(layout.heading, folds).hidden;
  const undeclared = visibleProperties([
    ...Object.keys(entry.properties),
    ...Object.keys(entry.relationships),
  ]).filter((k) => !declaredNames.has(k) && k !== 'type' && k !== 'key');

  // M16.8: `moveFieldOnType` has existed since M9.6 — hardened, toast-wired,
  // and with zero call sites. Declaration order drives the panel here AND the
  // default column order in every view, and the only way to change it was to
  // hand-edit the Type doc's YAML.
  //
  // `parseFields` is a plain `Object.entries` map, so the i-th row on screen
  // is the i-th key in the mapping and a target index converts straight to a
  // delta. Nothing is injected or hidden in between.
  const sortable = useSortableList({
    ids: declared.map((f) => f.name),
    disabled: entry.type === null,
    labelFor: (id) => humanize(id),
    onReorder: (name, to) => {
      if (entry.type === null) return;
      // The visible list can be a SUBSET of the declared order (M16.10), so
      // the visible index is not the mapping index — writing it straight
      // through would scatter the hidden properties around it.
      const delta = visibilityDelta(
        allDeclared.map((f) => f.name),
        declared.map((f) => f.name),
        name,
        to,
      );
      if (delta !== 0) void moveFieldOnType(entry.type, name, delta);
    },
  });

  // A grouped row carries no grip: declaration order still owns column order,
  // but ARRANGEMENT of a laid-out stack belongs to the layout editor (M45.3),
  // and a drag that silently rewrote `fields:` under a `layout:` would move
  // nothing on screen.
  const groupedRow = (f: FieldDef) => (
    <PropertyRow
      key={f.name}
      kind={f.kind}
      name={f.name}
      align={f.kind === 'checkbox' ? 'center' : 'start'}
      menu={
        entry.type === null
          ? undefined
          : ({ close }) => (
              <PropertyMenu
                def={f}
                sourceType={entry.type ?? ''}
                schema={schema}
                recordCount={recordCount}
                onClose={close}
              />
            )
      }
    >
      <FieldEditor entry={entry} def={f} schema={schema} />
    </PropertyRow>
  );
  const restRows = containerRows(layout.rest);

  return (
    <div className="mb-4 flex flex-col gap-[7px]">
      {layout.flat ? (
        /* Declared fields get their own container: the sortable measures its
           children as the rows, and undeclared keys are not part of the type's
           order — they are not in `fields:` at all. */
        <div
          ref={sortable.containerRef as React.RefObject<HTMLDivElement>}
          className="flex flex-col gap-[7px]"
        >
          {declared.map((f, index) => (
            <PropertyRow
              key={f.name}
              kind={f.kind}
              name={f.name}
              align={f.kind === 'checkbox' ? 'center' : 'start'}
              grip={entry.type === null ? undefined : sortable.gripProps(f.name, index)}
              gripHint={`Drag to reorder — changes every ${entry.type ?? ''}`}
              dragging={sortable.dragging === f.name}
              style={sortable.dropIndicator(index)}
              menu={
                entry.type === null
                  ? undefined
                  : ({ close }) => (
                      <PropertyMenu
                        def={f}
                        sourceType={entry.type ?? ''}
                        schema={schema}
                        recordCount={recordCount}
                        onClose={close}
                      />
                    )
              }
            >
              <FieldEditor entry={entry} def={f} schema={schema} />
            </PropertyRow>
          ))}
        </div>
      ) : (
        <>
          {revealed && headingFolds.length > 0 && (
            <div className="flex flex-col gap-[7px]">{headingFolds.map(groupedRow)}</div>
          )}
          {layout.groups.map((g) => {
            const rows = containerRows(g.fields);
            // Empty after folding renders nothing — a header over no rows
            // would claim the group holds something it does not.
            if (rows.length === 0) return null;
            return (
              <div
                key={g.id}
                data-testid="property-group"
                data-group={g.id}
                className="flex flex-col gap-[7px]"
              >
                <GroupLabel name={g.name} />
                {rows.map(groupedRow)}
              </div>
            );
          })}
          {/* Rest LAST and headerless: a freshly added field lands visibly at
              the bottom of the arranged stack. */}
          {restRows.length > 0 && (
            <div className="flex flex-col gap-[7px]">{restRows.map(groupedRow)}</div>
          )}
        </>
      )}
      {hidden.length > 0 && (
        // Notion's expander. Hidden properties are still ON the record — they
        // are folded, not dropped — so the panel says how many and opens them
        // in place rather than sending anyone to a settings screen.
        <button
          type="button"
          data-testid="hidden-properties-toggle"
          aria-expanded={revealed}
          onClick={() => setRevealed((v) => !v)}
          className="-mx-1 mt-0.5 flex items-center gap-1 self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
        >
          <Icon name={revealed ? 'chevron-down' : 'chevron-right'} size={12} />
          {revealed
            ? `Hide ${hidden.length} ${hidden.length === 1 ? 'property' : 'properties'}`
            : `${hidden.length} hidden ${hidden.length === 1 ? 'property' : 'properties'}`}
        </button>
      )}
      {undeclared.map((name) => (
        // A key the type no longer declares is still the user's data. It used
        // to render `String(value)` — "[object Object]" for a leftover
        // daterange — inside a fixed-width row, with no way to remove it from
        // the panel at all. Now it reads, wraps, and can be dropped.
        <PropertyRow
          key={name}
          kind={undeclaredKind(entry, name)}
          name={name}
          trailing={
            <span className={ROW_ACTION}>
              <IconButton
                icon="x"
                label={`Remove ${humanize(name)}`}
                size="sm"
                onClick={() => void patchFrontmatter(entry.path, { [name]: null })}
              />
            </span>
          }
        >
          <span className="block pt-[3px] text-sm text-n-700 [overflow-wrap:anywhere]">
            {undeclaredDisplay(entry, name)}
          </span>
        </PropertyRow>
      ))}
      {/* The trigger stays mounted: the surface is anchored to it now, and it
          used to be REPLACED by an inline panel that shoved the rest of the
          panel down as it opened (M16.9). */}
      <button
        ref={addRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={addingProp}
        onClick={() => setAddingProp((v) => !v)}
        className="mt-0.5 self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
      >
        + Add property
      </button>
      {addingProp && (
        <AddPropertyPanel
          anchorRef={addRef}
          existingNames={[...declared.map((f) => humanize(f.name)), ...undeclared.map(humanize)]}
          ownerType={entry.type}
          onAdd={(name, kind, relation) => {
            void (async () => {
              if (await addPropertyToEntry(entry, name, kind, relation)) setAddingProp(false);
            })();
          }}
          onCancel={() => setAddingProp(false)}
        />
      )}
    </div>
  );
}
