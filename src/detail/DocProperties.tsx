import React, { useEffect, useRef, useState } from 'react';
import { addPropertyToEntry, moveFieldOnType, normalizeFieldName } from '@/app/typeActions';
import { useOpenPath } from '@/app/useOpenPath';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Tooltip } from '@/components/ui/Tooltip';
import { AddPropertyPanel } from '@/detail/AddPropertyPanel';
import { FieldEditor, humanize } from '@/detail/FieldEditor';
import { EscapeToClose } from '@/detail/FieldPopover';
import { GroupLabel } from '@/detail/GroupLabel';
import { PropertyMenu } from '@/detail/PropertyMenu';
import { PropertyRow, PROPERTY_LABEL_W, ROW_ACTION } from '@/detail/PropertyRow';
import {
  foldsWhenUnset,
  inferKindFromValue,
  splitByVisibility,
  visibilityDelta,
  visibleProperties,
} from '@/engine/properties';
import { resolveLayout, revealableFields } from '@/engine/layout';
import { useSortableList } from '@/hooks/useSortableList';
import { typeStyle } from '@/engine/typeCatalog';
import { LAYOUT_DEFAULTS } from '@/engine/types';
import type { Entry, FieldDef, FieldKind, Schema } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Undeclared scalar frontmatter: plain text editing. Numeric values stay
 * numeric when the draft still parses as a number.
 *
 * Lists and maps are shown, not edited: `entry.properties` legitimately holds
 * `Scalar | Scalar[]`, and a text input round-tripped `tags: [work, urgent]`
 * back to disk as the single string "work,urgent", destroying the YAML list.
 * A loose key with structure is edited in the file until it is declared. */
function UndeclaredRow({ entry, name }: { entry: Entry; name: string }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const value = entry.properties[name];
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => {
    setDraft(String(value ?? ''));
  }, [value]);

  const commit = () => {
    if (draft === String(value ?? '')) return;
    const next =
      typeof value === 'number' && draft.trim() !== '' && !Number.isNaN(Number(draft))
        ? Number(draft)
        : draft;
    void patchFrontmatter(entry.path, { [name]: next });
  };

  const structured = Array.isArray(value) || (typeof value === 'object' && value !== null);
  const remove = (
    <span className={ROW_ACTION}>
      <IconButton
        icon="x"
        label={`Remove ${humanize(name)}`}
        size="sm"
        onClick={() => void patchFrontmatter(entry.path, { [name]: null })}
      />
    </span>
  );
  const kind = inferKindFromValue(value);

  if (structured) {
    return (
      <PropertyRow kind={kind} name={name} trailing={remove}>
        <Tooltip label="A list or map — edit it in the file, or declare it on a type">
          <span className="block pt-[3px] text-sm text-n-700 [overflow-wrap:anywhere]">
            {Array.isArray(value) ? value.map(String).join(', ') : JSON.stringify(value)}
          </span>
        </Tooltip>
      </PropertyRow>
    );
  }

  return (
    <PropertyRow kind={kind} name={name} align="center" trailing={remove}>
      <Input
        ariaLabel={humanize(name)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className="w-full min-w-0"
      />
    </PropertyRow>
  );
}

/**
 * Info tab of the doc side panel (M2 Task 16, Tolaria Inspector pattern;
 * M2.x: embedded in the tabbed panel): assign a type, edit its declared
 * fields, manage loose frontmatter keys. Everything writes through
 * patchFrontmatter (optimistic, disk-first on rescan).
 *
 * Like `RecordProperties`, it takes no tab (M46.1): a section belongs to the
 * record, so this panel and the page's own stack show the same containers and
 * cannot disagree. The page's strip carries the HEADING on every tab; this
 * panel does not — see `headingFolds` below for the exclusion and its cost.
 */
export function DocProperties({ entry, schema }: { entry: Entry; schema: Schema }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const toast = useUiStore((s) => s.toast);

  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  // The property menu edits the TYPE, so it owes the user the blast radius.
  const recordCount = useVaultStore((s) =>
    entry.type === null ? 0 : s.entries.filter((e) => e.type === entry.type).length,
  );

  const typeDef = entry.type !== null ? (schema.types.get(entry.type) ?? null) : null;
  const allDeclared = typeDef?.fields ?? [];
  const declaredNames = new Set(allDeclared.map((f) => f.name));

  const showEmpty = typeDef?.display.showEmpty === true;

  // M16.10, the same split the record panel makes.
  const [revealed, setRevealed] = useState(false);
  const folds = foldsWhenUnset(entry, schema, showEmpty);
  const { shown } = splitByVisibility(allDeclared, folds);
  const declared = revealed ? allDeclared : shown;

  // M45.1, the record panel's math verbatim. Only the declared stack is
  // arranged: the Type row, Convert flow, and undeclared keys render exactly
  // as the flat panel does.
  const layout = resolveLayout(typeDef?.layout ?? LAYOUT_DEFAULTS, allDeclared);
  const containerRows = (fields: FieldDef[]) =>
    revealed ? fields : splitByVisibility(fields, folds).shown;
  // The one expander counts what THIS stack can reveal — the record panel's
  // rule, through the record panel's helper, so one derivation answers for
  // both stacks.
  const hidden = splitByVisibility(revealableFields(layout), folds).hidden;
  // The strip cannot reveal its own folds; revealed, they surface headerless
  // at the top of the stack. Its SHOWN fields stay out of the stack — an
  // exclusion that is only sound because the host page (DocPage) co-mounts
  // the HeadingProperties strip that renders them. A strip-less host must
  // not reuse this exclusion, or the heading fields render NOWHERE — the
  // M45.1 whole-slice review caught InboxPage shipping exactly that hole.
  const headingFolds = splitByVisibility(layout.heading, folds).hidden;
  const undeclaredScalars = visibleProperties(Object.keys(entry.properties)).filter(
    (k) => !declaredNames.has(k) && k !== 'type',
  );
  const undeclaredRelations = visibleProperties(Object.keys(entry.relationships)).filter(
    (k) => !declaredNames.has(k),
  );

  const [converting, setConverting] = useState(false);
  const [pendingType, setPendingType] = useState<string | null>(null);
  const openPath = useOpenPath();

  // M12.1: a doc's type is not a dropdown. Docs are docs — the only way out
  // is the explicit Convert action, which says what it does to the note.
  //
  // M15: the type rows SELECT; the footer button commits. Conversion has no
  // inverse anywhere in the app — the note leaves Docs and only hand-editing
  // frontmatter brings it back — so a single stray click must not perform it.
  const convertTo = (typeName: string) => {
    setConverting(false);
    setPendingType(null);
    void (async () => {
      await patchFrontmatter(entry.path, { type: typeName });
      toast(`Now a ${typeName} record — this note left Docs`);
      openPath(entry.path);
    })();
  };
  const closeConvert = () => {
    setConverting(false);
    setPendingType(null);
  };
  const convertTargets = [...schema.types.keys()].filter((t) => t !== 'Type').sort();

  // M16.8: the same reorder the record panel gets. Declaration order is the
  // type's, so a typed doc's fields move here too.
  const sortable = useSortableList({
    ids: declared.map((f) => f.name),
    disabled: entry.type === null,
    labelFor: (id) => humanize(id),
    onReorder: (name, to) => {
      if (entry.type === null) return;
      const delta = visibilityDelta(
        allDeclared.map((f) => f.name),
        declared.map((f) => f.name),
        name,
        to,
      );
      if (delta !== 0) void moveFieldOnType(entry.type, name, delta);
    },
  });

  // Adding a property to a TYPED doc extends the type's YAML schema (the
  // properties engine's source of truth); untyped docs get plain
  // frontmatter seeded by kind (M2.x). M3: routed through typeActions so
  // the type screen and the panels share one hardened write path.
  const addProperty = (
    rawName: string,
    kind: FieldKind,
    relation?: { target: string; limit?: 1; reciprocalName?: string },
  ) => {
    const name = normalizeFieldName(rawName);
    if (name === '') return;
    if (declaredNames.has(name)) {
      toast('Property already exists');
      return;
    }
    void (async () => {
      if (await addPropertyToEntry(entry, name, kind, relation)) {
        if (entry.type !== null) toast(`Added "${humanize(name)}" to every ${entry.type}`);
        setAdding(false);
      }
    })();
  };

  // A grouped row carries no grip: arrangement of a laid-out stack belongs
  // to the layout editor (M45.3), and a drag that silently rewrote `fields:`
  // under a `layout:` would move nothing on screen.
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
    <div data-testid="doc-properties" aria-label="Document properties" className="pt-1">
      <div className="flex flex-col gap-[7px]">
        {/* Not a property — a doc's type is the one thing on this list that
            is not in `fields:` — so it takes an explicit icon rather than a
            kind glyph that would claim otherwise. */}
        <PropertyRow kind="text" icon="shapes" name="Type" align="center">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-n-700">
            <Icon
              name={entry.type === null ? 'file-text' : typeStyle(entry.type, schema).icon}
              size={13}
              color={
                entry.type === null
                  ? 'var(--n-400)'
                  : (typeStyle(entry.type, schema).color ?? 'var(--n-400)')
              }
            />
            <span className="truncate">{entry.type ?? 'Doc'}</span>
          </span>
        </PropertyRow>
        {entry.type === null && (
          // Its own row: 96px label + icon + "Doc" + this button never fitted
          // the 272px panel, so it wrapped to two lines and collided with the
          // Type value. And it was painted in --n-400, the token the design
          // system aliases as --text-disabled (2.19:1) — the most consequential
          // control on a doc read as switched off. It is a real secondary
          // button now: bordered, --n-600, one line.
          <button
            type="button"
            onClick={() => setConverting(true)}
            // Indented to the value column: it acts on the Type row above it,
            // and hanging it under the label read as a third, unrelated row.
            style={{ marginLeft: PROPERTY_LABEL_W + 6 }}
            className="self-start whitespace-nowrap rounded-md border border-n-200 bg-transparent px-2 py-1 text-xs text-n-600 hover:bg-n-50 hover:text-n-900"
          >
            Convert to record…
          </button>
        )}
        {layout.flat ? (
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
              // Empty after folding renders nothing — header included.
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
            {/* Rest LAST and headerless: a freshly added field lands visibly. */}
            {restRows.length > 0 && (
              <div className="flex flex-col gap-[7px]">{restRows.map(groupedRow)}</div>
            )}
          </>
        )}
        {hidden.length > 0 && (
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
        {undeclaredScalars.map((name) => (
          <UndeclaredRow key={name} entry={entry} name={name} />
        ))}
        {undeclaredRelations.map((name) => (
          <PropertyRow key={name} kind="relation" name={name}>
            <span className="block pt-[3px] text-sm text-n-700 [overflow-wrap:anywhere]">
              {entry.relationships[name].join(', ')}
            </span>
          </PropertyRow>
        ))}
        {/* The trigger stays mounted: the surface anchors to it now, and it
            used to be REPLACED by an inline panel that shoved the footer down
            as it opened (M16.9). */}
        <button
          ref={addRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
          className="mt-0.5 self-start rounded-md border-0 bg-transparent px-1 py-0.5 text-xs text-n-400 hover:bg-n-50 hover:text-n-700"
        >
          + Add property
        </button>
        {adding && (
          <AddPropertyPanel
            anchorRef={addRef}
            existingNames={[
              ...declared.map((f) => humanize(f.name)),
              ...undeclaredScalars.map(humanize),
              ...undeclaredRelations.map(humanize),
            ]}
            ownerType={entry.type}
            onAdd={addProperty}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
      <div className="mt-4 border-t border-n-100 pt-2 text-2xs text-n-400 [font-family:var(--font-mono)]">
        <div>Created {entry.createdAt.slice(0, 10)}</div>
        <div>Modified {entry.modifiedAt.slice(0, 10)}</div>
      </div>
      {converting && (
        <>
          {/* Dialog has no keydown handling of its own; Escape is where every
              hand goes first, and it was the one exit this modal lacked. */}
          <EscapeToClose onClose={closeConvert} />
          <Dialog
            open
            onClose={closeConvert}
            title="Convert to record"
            width={420}
            footerNote="This cannot be undone from the app."
            secondaryAction={{ label: 'Cancel', onClick: closeConvert }}
            primaryAction={{
              label: pendingType === null ? 'Convert' : `Convert to ${pendingType}`,
              disabled: pendingType === null,
              onClick: () => {
                if (pendingType !== null) convertTo(pendingType);
              },
            }}
          >
            <p className="mb-2 text-xs leading-relaxed text-n-500">
              A record belongs to a type: it opens in the record panel, appears in that type&apos;s
              views and Lists, and leaves the Docs tree. Its text and properties come along
              unchanged.
            </p>
            <div
              role="listbox"
              aria-label="Convert to type"
              className="flex max-h-[300px] flex-col overflow-y-auto"
            >
              {convertTargets.map((t) => {
                const style = typeStyle(t, schema);
                const picked = pendingType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    role="option"
                    aria-selected={picked}
                    onClick={() => setPendingType(t)}
                    className={[
                      'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left',
                      picked ? 'bg-cortex-50' : 'hover:bg-n-50',
                    ].join(' ')}
                  >
                    <span
                      className="inline-flex flex-none"
                      style={{ color: style.color ?? 'var(--n-400)' }}
                    >
                      <Icon name={style.icon} size={14} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-n-900">{t}</span>
                    {picked && <Icon name="check" size={14} color="var(--cortex-600)" />}
                  </button>
                );
              })}
              {convertTargets.length === 0 && (
                <div className="px-2.5 py-4 text-xs text-n-500">
                  No types yet — create one from the Types section of the sidebar first.
                </div>
              )}
            </div>
          </Dialog>
        </>
      )}
    </div>
  );
}
