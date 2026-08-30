import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { MenuItem, MenuLabel, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { columnUniverse } from '@/engine/columns';
import { resolveDatabaseRef } from '@/engine/databaseBlock';
import { resolveSurface } from '@/engine/surface';
import { listTypes, typeStyle, typeViews } from '@/engine/typeCatalog';
import type { Entry, Schema, ViewDefinition } from '@/engine/types';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { ViewCanvas } from './ViewCanvas';

/** What a block writes back when its pointer changes. */
export type DatabasePointer = { database: string; view: string };

/**
 * The block spec's entry point: reads the vault, renders the view.
 *
 * The read lives here rather than in `blocks.tsx` for the same reason
 * `MermaidBlockView` owns its own — a block SPEC is editor plumbing, and a
 * spec that reached for a store would drag app state into the file the editor
 * schema is assembled from. Keeping `DatabaseBlockView` itself
 * everything-in-props is what lets every state below be tested with no store
 * behind it.
 */
export function ConnectedDatabaseBlock({
  database,
  view,
  onChange,
}: DatabasePointer & { onChange?: (next: DatabasePointer) => void }) {
  const entries = useVaultStore((s) => s.entries);
  return (
    <DatabaseBlockView
      database={database}
      view={view}
      schema={useSchema()}
      entries={entries}
      onChange={onChange}
    />
  );
}

/**
 * A database embedded in a page (M47.2, grid added M47.3).
 *
 * The rows come from `resolveSurface({ kind: 'type' })` — the same resolver
 * the database's own screen uses, so an embed and the full page cannot drift
 * into showing different rows for the same view. What the dashboard's embed
 * had to do by hand (find a List file, thread its source through) a database
 * gets for free: its name IS the query.
 *
 * Split from `blocks.tsx` for the same reason `MermaidBlockView` is: the block
 * SPEC is editor plumbing, and what it draws is a view.
 */
export function DatabaseBlockView({
  database,
  view,
  schema,
  entries,
  onChange,
}: {
  database: string;
  /** '' is the prop-schema spelling of "named no view" — see markdown.ts. */
  view: string;
  schema: Schema;
  entries: Entry[];
  /**
   * Rewrites the block's own pointer. ABSENT means read-only, and that is a
   * real state rather than a test convenience: a block rendered outside an
   * editor has no document to write back to, and offering a picker that
   * silently does nothing would be worse than offering none.
   */
  onChange?: (next: DatabasePointer) => void;
}) {
  const resolved = useMemo(
    () =>
      database === ''
        ? null
        : resolveDatabaseRef({ database, view: view === '' ? null : view }, schema),
    [database, view, schema],
  );

  const shown = resolved === null || resolved.kind === 'no-database' ? null : viewOf(resolved);

  const surface = useMemo(
    () =>
      shown === null
        ? null
        : resolveSurface({ kind: 'type', name: database, view: shown.id }, entries, schema, []),
    [shown, database, entries, schema],
  );

  const fields = useMemo(
    () =>
      surface === null
        ? []
        : columnUniverse(
            { type: database, project: null },
            surface.entries,
            schema,
            surface.presentation.group,
          ),
    [surface, database, schema],
  );

  // A block whose fence named nothing should never have become a block at
  // all (`parseDatabaseRef` returns null and the code block survives), so
  // this is the arm for a block built in memory rather than read from disk —
  // a create flow that has not chosen a database yet.
  if (resolved === null) {
    return (
      <Shell tone="pending" testid="database-block-unset">
        {onChange === undefined ? (
          <span className="text-n-600">No database chosen yet</span>
        ) : (
          <DatabasePicker
            label="Choose a database"
            entries={entries}
            schema={schema}
            onPick={(name) => onChange({ database: name, view: '' })}
          />
        )}
      </Shell>
    );
  }

  /**
   * "Not there" is not "empty". A page pointing at a database nobody has
   * created says WHICH one is missing, because the alternative — an empty
   * table — tells the reader the database exists and holds nothing, which is
   * a different and false sentence.
   */
  if (resolved.kind === 'no-database') {
    return (
      <Shell tone="broken" testid="database-block-missing">
        <span className="text-n-700">
          No database named <strong className="font-medium">{resolved.database}</strong>
        </span>
      </Shell>
    );
  }

  const style = typeStyle(resolved.database, schema);

  return (
    <Shell tone="ok" testid="database-block">
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
        <span className="truncate font-medium text-n-800">{resolved.database}</span>
        <span className="text-n-400">·</span>
        {/* Read-only renders the view's name as text. An editor gets the same
            name as a switcher — one affordance, two moods, so the header never
            offers a control that cannot do anything. */}
        {onChange === undefined ? (
          <span className="truncate text-n-600">{shown?.name}</span>
        ) : (
          <ViewPicker
            current={shown?.name ?? ''}
            views={typeViews(resolved.database, schema)}
            onPick={(id) => onChange({ database: resolved.database, view: id })}
          />
        )}
      </span>
      {/* The database is here and the named view is not. Showing the fallback
          silently would be confidently showing the wrong data, so the block
          renders what it CAN and says what it could not. */}
      {resolved.kind === 'no-view' && (
        <span className="text-xs text-n-500" data-testid="database-block-view-missing">
          No view named “{resolved.view}” — showing {resolved.fallback.name}
        </span>
      )}
      {surface !== null && (
        <div className="mt-1 flex min-h-0 flex-col overflow-hidden">
          <ViewCanvas
            embedded
            entries={surface.entries}
            allEntries={entries}
            presentation={surface.presentation}
            schema={schema}
            fields={fields}
            scope={`database-block:${resolved.database}:${shown?.id ?? ''}`}
            // "+ New" here creates a record of THIS database, landing in its
            // declared `folder:` — which is the whole point of embedding one
            // in the page you are writing.
            createType={resolved.database}
            filtered={shown?.filters != null}
          />
        </div>
      )}
    </Shell>
  );
}

/** The view a resolution actually draws — the named one, or the fallback. */
const viewOf = (r: Exclude<ReturnType<typeof resolveDatabaseRef>, { kind: 'no-database' }>) =>
  r.kind === 'no-view' ? r.fallback : r.view;

/**
 * Door 1 of `/database` (spec §6): show a database that already exists.
 *
 * Every database in the vault, from the one registry — reading lists, grocery
 * lists, Risk alike. Nothing is filtered out by name or by system-ness: what
 * makes a row offerable is that it IS a database, and "no type special-casing"
 * is the rule that keeps this list honest as the vault grows.
 */
function DatabasePicker({
  label,
  entries,
  schema,
  onPick,
}: {
  label: string;
  entries: Entry[];
  schema: Schema;
  onPick: (database: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const databases = useMemo(() => listTypes(entries, schema), [entries, schema]);

  return (
    <span className="relative inline-flex">
      <button
        ref={anchorRef}
        type="button"
        data-testid="database-block-pick"
        onClick={() => setOpen((v) => !v)}
        className="motion-hover inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-n-300 bg-n-0 px-2 py-1 text-sm text-n-700 hover:bg-n-50"
      >
        <Icon name="table-2" size={14} color="var(--n-500)" />
        {label}
      </button>
      {open && (
        <Popover
          anchorRef={anchorRef}
          onClose={() => setOpen(false)}
          role="menu"
          ariaLabel="Databases"
        >
          <MenuSurface width={240}>
            <MenuLabel>Databases</MenuLabel>
            {databases.map((d) => (
              <MenuItem
                key={d.name}
                label={d.name}
                icon={d.icon}
                // The count is what tells you which "Tasks" you meant once a
                // vault has grown two similarly named databases.
                hint={String(d.count)}
                onSelect={() => {
                  setOpen(false);
                  onPick(d.name);
                }}
              />
            ))}
          </MenuSurface>
        </Popover>
      )}
    </span>
  );
}

/** Which of a database's views this block shows. */
function ViewPicker({
  current,
  views,
  onPick,
}: {
  current: string;
  views: ViewDefinition[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <span className="relative inline-flex min-w-0">
      <button
        ref={anchorRef}
        type="button"
        data-testid="database-block-view-pick"
        onClick={() => setOpen((v) => !v)}
        className="motion-hover inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1 py-0.5 text-sm text-n-600 hover:bg-n-50"
      >
        <span className="truncate">{current}</span>
        <Icon name="chevron-down" size={12} color="var(--n-500)" />
      </button>
      {open && (
        <Popover anchorRef={anchorRef} onClose={() => setOpen(false)} role="menu" ariaLabel="Views">
          <MenuSurface width={200}>
            {views.map((v) => (
              <MenuItem
                key={v.id}
                label={v.name}
                checked={v.name === current}
                onSelect={() => {
                  setOpen(false);
                  onPick(v.id);
                }}
              />
            ))}
          </MenuSurface>
        </Popover>
      )}
    </span>
  );
}

const TONE = {
  ok: 'border-n-200 bg-n-0',
  broken: 'border-danger-200 bg-danger-50',
  pending: 'border-dashed border-n-300 bg-n-50',
} as const;

function Shell({
  tone,
  testid,
  children,
}: {
  tone: keyof typeof TONE;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testid}
      contentEditable={false}
      className={`my-1 flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-sm ${TONE[tone]}`}
    >
      {children}
    </div>
  );
}
