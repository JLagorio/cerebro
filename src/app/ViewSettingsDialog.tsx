import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Dropdown } from '@/components/ui/Dropdown';
import { Input } from '@/components/ui/Input';
import { humanize } from '@/engine/schema';
import { listTypes } from '@/engine/typeCatalog';
import type { Entry, Schema, ViewDefinition } from '@/engine/types';
import { DEFAULT_PRESENTATION } from '@/engine/views';
import { FilterBuilder } from '@/views/FilterBuilder';

const ANY = '__any__';
const NONE = '__none__';

/** A fresh view over a type, with that type's fields as its columns. */
export function newViewDefinition(typeName: string | null, schema: Schema): ViewDefinition {
  const fields = typeName === null ? [] : (schema.types.get(typeName)?.fields ?? []);
  return {
    name: '',
    icon: null,
    color: null,
    order: null,
    source: { type: typeName, project: null },
    filters: null,
    presentation: {
      type: 'table',
      groupBy: fields.some((f) => f.kind === 'status') ? 'status' : null,
      orderBy: { ...DEFAULT_PRESENTATION.orderBy },
      visibleFields:
        fields.length > 0 ? fields.map((f) => f.name).slice(0, 6) : [...DEFAULT_PRESENTATION.visibleFields],
      childrenVia: null,
    },
  };
}

const label = 'mb-1 block text-[11.5px] font-medium text-[var(--n-600)]';

/**
 * Create/configure a saved view (M3.5): its source type, project scope,
 * filters, and — for tree layouts — which relation nests the rows. This is
 * the surface that replaces "New project": a project is now a saved view
 * over Work items scoped to a folder.
 */
export function ViewSettingsDialog({
  initial,
  entries,
  schema,
  title,
  onCancel,
  onSubmit,
}: {
  initial: ViewDefinition;
  entries: Entry[];
  schema: Schema;
  title: string;
  onCancel: () => void;
  onSubmit: (definition: ViewDefinition) => void;
}) {
  const [def, setDef] = useState<ViewDefinition>(initial);
  const [busy, setBusy] = useState(false);

  const types = listTypes(entries, schema);
  const projects = entries
    .filter((e) => e.type === 'Project')
    .sort((a, b) => a.title.localeCompare(b.title));

  const sourceFields = def.source.type === null ? [] : (schema.types.get(def.source.type)?.fields ?? []);
  const relationFields = sourceFields.filter((f) => f.kind === 'relation' || f.kind === 'person');
  // Reverse descent: any type declaring a relation back to this one.
  const reverseOptions = types.flatMap((t) =>
    (schema.types.get(t.name)?.fields ?? [])
      .filter((f) => f.kind === 'relation' && f.target === def.source.type)
      .map((f) => ({
        value: `reverse:${t.name}:${f.name}`,
        label: `${t.name} → ${humanize(f.name)}`,
      })),
  );

  const via = def.presentation.childrenVia ?? null;
  const childrenValue =
    via === null
      ? NONE
      : via.direction === 'forward'
        ? `forward:${via.field}`
        : `reverse:${via.type}:${via.field}`;

  const setChildrenVia = (value: string) => {
    if (value === NONE) {
      setDef({ ...def, presentation: { ...def.presentation, childrenVia: null } });
      return;
    }
    const [direction, a, b] = value.split(':');
    setDef({
      ...def,
      presentation: {
        ...def.presentation,
        childrenVia:
          direction === 'forward'
            ? { direction: 'forward', field: a }
            : { direction: 'reverse', type: a, field: b },
      },
    });
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      width={560}
      primaryAction={{
        label: 'Save view',
        onClick: () => {
          if (def.name.trim() === '' || busy) return;
          setBusy(true);
          onSubmit({ ...def, name: def.name.trim() });
        },
        disabled: def.name.trim() === '' || busy,
      }}
      secondaryAction={{ label: 'Cancel', onClick: onCancel }}
    >
      <div className="flex flex-col gap-3">
        <div>
          <span className={label}>Name</span>
          <Input
            autoFocus
            ariaLabel="View name"
            placeholder="Cobra launch, My open bugs…"
            value={def.name}
            onChange={(e) => setDef({ ...def, name: e.target.value })}
            width="100%"
          />
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <span className={label}>Records from</span>
            <Dropdown
              size="sm"
              label="Source type"
              width="100%"
              options={[
                { value: ANY, label: 'Everything' },
                ...types.map((t) => ({ value: t.name, label: t.name, icon: t.icon })),
              ]}
              value={def.source.type ?? ANY}
              onChange={(v) => {
                const type = v === ANY ? null : v;
                const fields = type === null ? [] : (schema.types.get(type)?.fields ?? []);
                setDef({
                  ...def,
                  source: { ...def.source, type },
                  // Columns belong to the source type — reset them with it.
                  presentation: {
                    ...def.presentation,
                    visibleFields: fields.map((f) => f.name).slice(0, 6),
                    childrenVia: null,
                  },
                });
              }}
            />
          </div>
          <div className="flex-1">
            <span className={label}>Scoped to project</span>
            <Dropdown
              size="sm"
              label="Project scope"
              width="100%"
              options={[
                { value: ANY, label: 'Whole vault' },
                ...projects.map((p) => ({ value: p.path, label: p.title })),
              ]}
              value={def.source.project ?? ANY}
              onChange={(v) =>
                setDef({ ...def, source: { ...def.source, project: v === ANY ? null : v } })
              }
            />
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <span className={label}>Layout</span>
            <Dropdown
              size="sm"
              label="Layout"
              width="100%"
              options={[
                { value: 'table', label: 'Table' },
                { value: 'list', label: 'List' },
                { value: 'board', label: 'Board' },
                { value: 'tree', label: 'Hierarchy' },
                { value: 'split', label: 'Browse' },
              ]}
              value={def.presentation.type}
              onChange={(v) =>
                setDef({
                  ...def,
                  presentation: { ...def.presentation, type: v as typeof def.presentation.type },
                })
              }
            />
          </div>
          {def.presentation.type === 'tree' && (
            <div className="flex-1">
              <span className={label}>Nest rows by</span>
              <Dropdown
                size="sm"
                label="Child relation"
                width="100%"
                options={[
                  { value: NONE, label: 'No nesting' },
                  ...relationFields.map((f) => ({
                    value: `forward:${f.name}`,
                    label: `${humanize(f.name)} (this record's links)`,
                  })),
                  ...reverseOptions,
                ]}
                value={childrenValue}
                onChange={setChildrenVia}
              />
            </div>
          )}
        </div>

        <div>
          <span className={label}>Filters</span>
          <FilterBuilder
            filters={def.filters}
            fields={sourceFields}
            onChange={(filters) => setDef({ ...def, filters })}
          />
        </div>
      </div>
    </Dialog>
  );
}
