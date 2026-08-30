import { Icon } from '@/components/ui/Icon';
import { resolveDatabaseRef } from '@/engine/databaseBlock';
import { typeStyle } from '@/engine/typeCatalog';
import type { Schema } from '@/engine/types';
import { useSchema } from '@/stores/vaultStore';

/**
 * The block spec's entry point: reads the vault, renders the view.
 *
 * The read lives here rather than in `blocks.tsx` for the same reason
 * `MermaidBlockView` owns its own — a block SPEC is editor plumbing, and a
 * spec that reached for a store would drag app state into the file the editor
 * schema is assembled from. Keeping `DatabaseBlockView` itself schema-in-props
 * is what lets every state below be tested without a store behind it.
 */
export function ConnectedDatabaseBlock({ database, view }: { database: string; view: string }) {
  return <DatabaseBlockView database={database} view={view} schema={useSchema()} />;
}

/**
 * A database embedded in a page (M47.2).
 *
 * This slice renders the RESOLUTION, not the rows: the pointer is the new
 * thing and it is what can be wrong, so it gets its own surface before the
 * grid is lifted in from `DashboardView` (M47.3). What that buys is that the
 * three failure states below are real, tested states from the first commit
 * rather than an afterthought bolted onto a working happy path.
 *
 * Split from `blocks.tsx` for the same reason `MermaidBlockView` is: the
 * block SPEC is editor plumbing, and what it draws is a view.
 */
export function DatabaseBlockView({
  database,
  view,
  schema,
}: {
  database: string;
  /** '' is the prop-schema spelling of "named no view" — see markdown.ts. */
  view: string;
  schema: Schema;
}) {
  // A block whose fence named nothing should never have become a block at
  // all (`parseDatabaseRef` returns null and the code block survives), so
  // this is the defensive arm for a block built in memory rather than read
  // from disk — a create flow that has not chosen a database yet.
  if (database === '') {
    return (
      <Shell tone="pending" testid="database-block-unset">
        <span className="text-n-600">No database chosen yet</span>
      </Shell>
    );
  }

  const resolved = resolveDatabaseRef({ database, view: view === '' ? null : view }, schema);

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
  const shown = resolved.kind === 'no-view' ? resolved.fallback : resolved.view;

  return (
    <Shell tone="ok" testid="database-block">
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
        <span className="truncate font-medium text-n-800">{resolved.database}</span>
        <span className="text-n-400">·</span>
        <span className="truncate text-n-600">{shown.name}</span>
      </span>
      {/* The database is here and the named view is not. Showing the fallback
          silently would be confidently showing the wrong data, so the block
          renders what it CAN and says what it could not. */}
      {resolved.kind === 'no-view' && (
        <span className="text-xs text-n-500" data-testid="database-block-view-missing">
          No view named “{resolved.view}” — showing {resolved.fallback.name}
        </span>
      )}
    </Shell>
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
