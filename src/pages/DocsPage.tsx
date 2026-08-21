import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { useOpenPath } from '@/app/useOpenPath';
import { isDocEntry, typeStyle } from '@/engine/typeCatalog';
import type { Entry } from '@/engine/types';
import { isTemplate } from '@/lib/templates';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

const RECENTS_SHOWN = 6;

/** A document here is a note that lives in Docs (M12.1 `isDocEntry`: untyped
 * notes, nothing else). Records belong to their type screen, and templates
 * are scaffolding, not content. */
const isDoc = (e: Entry) => isDocEntry(e) && !isTemplate(e);

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * All-docs surface (M2 Task 11): recents to pick up where you left
 * off. The full folder tree lives in the docs-mode Sidebar (Task 14).
 */
export function DocsPage() {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const open = useOpenPath();

  const recents = entries
    .filter(isDoc)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, RECENTS_SHOWN);

  const projectTitle = (e: Entry) =>
    e.project === null ? null : (entries.find((p) => p.path === e.project)?.title ?? null);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="docs-page">
      <div className="flex flex-none items-center gap-2 px-5 pb-2 pt-3.5">
        <Icon name="library" size={16} color="var(--n-600)" />
        <h1 className="m-0 text-lg font-semibold leading-6 tracking-[-0.005em]">Docs</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {recents.length === 0 && (
          <EmptyState
            icon="file-text"
            title="No documents yet"
            description="Create a page from the file tree in the sidebar."
          />
        )}
        {recents.length > 0 && (
          <>
            <h2 className="mb-1.5 mt-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
              Pick up where you left off
            </h2>
            <ul className="m-0 mb-4 flex max-w-[720px] flex-col gap-0.5 p-0">
              {recents.map((e) => (
                <li key={e.path} className="list-none">
                  <button
                    type="button"
                    data-testid="recent-doc"
                    data-path={e.path}
                    onClick={() => open(e.path)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left hover:bg-n-50"
                  >
                    {(() => {
                      const style = typeStyle(e.type, schema);
                      return (
                        <Icon name={style.icon} size={14} color={style.color ?? 'var(--n-500)'} />
                      );
                    })()}
                    {/* The document name is the LAST thing to give up space,
                        never the first: it has a readable floor, the project
                        chip shrinks before it, and the date drops out of the
                        row entirely on a narrow canvas. */}
                    <span className="min-w-[12ch] flex-1 truncate text-sm text-n-800">
                      {e.title}
                    </span>
                    {projectTitle(e) !== null && (
                      <span className="hidden min-w-0 shrink truncate rounded-sm bg-n-50 px-1.5 py-px text-2xs text-n-600 @[380px]/canvas:inline-block">
                        {projectTitle(e)}
                      </span>
                    )}
                    <span className="hidden flex-none text-2xs text-[var(--text-meta)] [font-family:var(--font-mono)] @[520px]/canvas:inline">
                      {formatDay(e.modifiedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
