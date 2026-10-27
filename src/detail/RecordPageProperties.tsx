import { selectedEntryIssue, selectedPropertyKeys } from '@/engine/selectedEntryProjection';
import { useSourcePropertyRow } from '@/editor/sourceReveal';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { HeadingProperties, stripCells } from '@/detail/HeadingProperties';
import { RecordProperties } from '@/detail/RecordProperties';
import { humanize } from '@/detail/FieldEditor';
import { resolveLayout } from '@/engine/layout';
import { kindMeta, visibleProperties } from '@/engine/properties';
import type { Entry, FieldDef, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';

/** An authored empty heading is a choice, not a request for inferred fields.
 * The schema normalizes absent and empty layouts alike, so consult its Type
 * document for presence, using the same last-definition-wins source order. */
export function recordPageSummary(entry: Entry, schema: Schema, entries: Entry[]) {
  const type = entry.type === null ? undefined : schema.types.get(entry.type);
  const source = [...entries]
    .reverse()
    .find((candidate) => candidate.type === 'Type' && candidate.title === entry.type);
  const raw = source?.properties.layout;
  const explicit =
    (type?.layout.heading.length ?? 0) > 0 ||
    (raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Object.hasOwn(raw, 'heading'));
  const heading = type === undefined ? [] : resolveLayout(type.layout, type.fields).heading;
  const priority = (field: FieldDef) => {
    if (field.kind === 'status' || field.kind === 'select') return 0;
    if (['person', 'relation', 'date', 'daterange'].includes(field.kind)) return 1;
    if (kindMeta(field.kind).computed) return 2;
    return 3;
  };
  const fields = explicit
    ? heading
    : (type?.fields ?? [])
        .filter((field) => {
          if (field.visibility === 'hide') return false;
          const value = schema.resolveField(entry, field.name);
          if (value.selectedValue?.kind === 'present' || value.unavailableReason)
            return value.display !== '';
          return (
            value.raw !== null &&
            value.raw !== undefined &&
            value.raw !== '' &&
            (!Array.isArray(value.raw) || value.raw.length > 0) &&
            value.display !== ''
          );
        })
        .sort((left, right) => priority(left) - priority(right))
        .slice(0, 3);
  const declared = new Set(type?.fields.map((field) => field.name) ?? []);
  const undeclared = new Set(
    visibleProperties([...selectedPropertyKeys(entry), ...Object.keys(entry.relationships)]).filter(
      (name) => !declared.has(name) && name !== 'type' && name !== 'key',
    ),
  );
  return { automatic: !explicit, fields, count: declared.size + undeclared.size };
}

/** The record's metadata stays in the same portal on every related tab.
 * Automatic summaries are read-only doors into the single property editor;
 * opening one never creates a second draft for the same field. */
export function RecordPageProperties({ entry, schema }: { entry: Entry; schema: Schema }) {
  const entries = useVaultStore((state) => state.entries);
  const summary = recordPageSummary(entry, schema, entries);
  const stripShows = stripCells(entry, schema, summary.fields).length > 0;
  const [shown, setShown] = useState<boolean | null>(null);
  const expanded = shown ?? (!summary.automatic && !stripShows);
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  const manager = useRef<HTMLDivElement>(null);
  const sourceField = useSourcePropertyRow(entry.path, entry.hash, manager, () => {
    setOpened(true);
    setShown(true);
  });
  const [focusField, setFocusField] = useState<string | null>(null);
  const reveal = (field?: string) => {
    setFocusField(field ?? null);
    setOpened(true);
    setShown(true);
  };
  useEffect(() => {
    if (!expanded || focusField === null) return;
    const name = focusField;
    setFocusField(null);
    const row = [...(manager.current?.querySelectorAll<HTMLElement>('[data-property]') ?? [])].find(
      (candidate) => candidate.dataset.property === name,
    );
    const control =
      row?.querySelector<HTMLElement>('[data-cell-primary]') ??
      row?.querySelector<HTMLElement>('input, button');
    control?.focus();
  }, [expanded, focusField]);
  const toggle = () => {
    if (expanded) {
      if (!editing) setShown(false);
    } else reveal();
  };
  return (
    <section className="cb-record-page-properties" aria-label="Record properties">
      {(selectedEntryIssue(entry) ??
        (entry.type ? schema.types.get(entry.type)?.unavailableReason : undefined)) && (
        <p role="status" className="section-unavailable text-xs text-n-600">
          {selectedEntryIssue(entry) ??
            (entry.type ? schema.types.get(entry.type)?.unavailableReason : undefined)}
        </p>
      )}
      {summary.automatic ? (
        <div className="cb-record-summary" data-testid="record-summary">
          {summary.fields.map((field) => (
            <button
              type="button"
              tabIndex={0}
              key={field.name}
              className="cb-record-summary-field"
              onClick={() => reveal(field.name)}
              aria-label={`Show ${humanize(field.name)} property`}
              title={`${humanize(field.name)}: ${schema.resolveField(entry, field.name).display}`}
            >
              <Icon name={kindMeta(field.kind).icon} size={13} />
              <span className="cb-record-summary-label">{humanize(field.name)}</span>
              <span className="cb-record-summary-value">
                {schema.resolveField(entry, field.name).display}
              </span>
            </button>
          ))}
          <button
            type="button"
            tabIndex={0}
            data-testid="record-properties-toggle"
            aria-expanded={expanded}
            onClick={toggle}
            disabled={expanded && editing}
            title={expanded && editing ? 'Finish editing before hiding properties' : undefined}
            className="cb-record-properties-toggle"
          >
            <Icon name={expanded ? 'chevron-up' : 'sliders-horizontal'} size={13} />
            {expanded ? 'Hide properties' : 'Show all properties'}
            {!expanded && summary.count > 0 && <span>{summary.count}</span>}
          </button>
        </div>
      ) : stripShows ? (
        <HeadingProperties
          entry={entry}
          schema={schema}
          fields={summary.fields}
          detailsShown={expanded}
          onToggleDetails={toggle}
          toggleDisabled={expanded && editing}
        />
      ) : null}
      {(expanded || opened) && (
        <div
          ref={manager}
          hidden={!expanded}
          data-testid="page-properties"
          className="cb-record-property-manager"
        >
          <RecordProperties
            entry={entry}
            schema={schema}
            onEditingChange={setEditing}
            sourceField={sourceField}
          />
        </div>
      )}
    </section>
  );
}
