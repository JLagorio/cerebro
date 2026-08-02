import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Dropdown } from '@/components/ui/Dropdown';
import { Input } from '@/components/ui/Input';
import { listTypes } from '@/engine/typeCatalog';
import type { Entry, Presentation, Schema, ListDefinition, ViewDefinition } from '@/engine/types';
import { DEFAULT_PRESENTATION, layoutLabel } from '@/engine/views';
import { FilterBuilder } from '@/views/FilterBuilder';
import { VIEW_KINDS } from '@/views/viewKinds';

const ANY = '__any__';

/** The presentation a fresh List's first view starts from. */
function seedPresentation(typeName: string | null, schema: Schema): Presentation {
  const fields = typeName === null ? [] : (schema.types.get(typeName)?.fields ?? []);
  return {
    type: 'table',
    group: fields.some((f) => f.kind === 'status') ? [{ field: 'status' }] : [],
    sort: DEFAULT_PRESENTATION.sort.map((s) => ({ ...s })),
    columns:
      fields.length > 0
        ? fields.slice(0, 6).map((f) => ({ field: f.name }))
        : DEFAULT_PRESENTATION.columns.map((c) => ({ ...c })),
  };
}

/** A fresh List over a type, with that type's fields as its first view's columns. */
export function newViewDefinition(typeName: string | null, schema: Schema): ListDefinition {
  const presentation = seedPresentation(typeName, schema);
  return {
    name: '',
    icon: null,
    color: null,
    order: null,
    source: { type: typeName, project: null },
    // M11: a List is created with exactly one view, and gains more from its
    // tab row. Naming it after its layout is what Notion does and it reads
    // correctly the moment there are two.
    views: [
      {
        id: 'table',
        name: layoutLabel(presentation.type),
        icon: null,
        filters: null,
        presentation,
      },
    ],
  };
}

/** The first (and, on a fresh List, only) view — what this dialog configures. */
const firstView = (def: ListDefinition) => def.views[0];

function withFirstView(def: ListDefinition, next: Partial<ViewDefinition>): ListDefinition {
  return { ...def, views: [{ ...def.views[0], ...next }, ...def.views.slice(1)] };
}

const label = 'mb-1 block text-[11.5px] font-medium text-[var(--n-600)]';

/**
 * Create/configure a List (M10): its source type, project scope,
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
  initial: ListDefinition;
  entries: Entry[];
  schema: Schema;
  title: string;
  onCancel: () => void;
  /** Resolve true on success — the dialog closes only then, so a failed
   * write keeps the configuration the user just built on screen (M14.8). */
  onSubmit: (definition: ListDefinition) => Promise<boolean>;
}) {
  const [def, setDef] = useState<ListDefinition>(initial);
  const [busy, setBusy] = useState(false);

  const types = listTypes(entries, schema);
  const projects = entries
    .filter((e) => e.type === 'Project')
    .sort((a, b) => a.title.localeCompare(b.title));

  const sourceFields =
    def.source.type === null ? [] : (schema.types.get(def.source.type)?.fields ?? []);

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
          void (async () => {
            const ok = await onSubmit({ ...def, name: def.name.trim() });
            // On success the parent unmounts us; on failure the action has
            // already toasted and the form stays editable.
            if (!ok) setBusy(false);
          })();
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
            ariaLabel="List name"
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
                setDef(
                  withFirstView(
                    { ...def, source: { ...def.source, type } },
                    {
                      // Columns belong to the source type — reset them with it.
                      presentation: {
                        ...firstView(def).presentation,
                        columns: fields.slice(0, 6).map((f) => ({ field: f.name })),
                        // The grouping chain names properties and relations of
                        // the OLD type; none of it survives a source change.
                        group: [],
                      },
                    },
                  ),
                );
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
            {/* M11: this names the FIRST view's layout. More tabs are added
                from the List's own tab row, where the thing they belong to is
                already on screen. */}
            <span className={label}>First view</span>
            <Dropdown
              size="sm"
              label="Layout"
              width="100%"
              options={VIEW_KINDS.map((k) => ({ value: k.value, label: k.label }))}
              value={firstView(def).presentation.type}
              onChange={(v) => {
                const type = v as Presentation['type'];
                setDef(
                  withFirstView(def, {
                    name: layoutLabel(type),
                    presentation: { ...firstView(def).presentation, type },
                  }),
                );
              }}
            />
          </div>
        </div>

        <div>
          <span className={label}>Filters</span>
          <FilterBuilder
            filters={firstView(def).filters}
            fields={sourceFields}
            onChange={(filters) => setDef(withFirstView(def, { filters }))}
          />
        </div>
      </div>
    </Dialog>
  );
}
