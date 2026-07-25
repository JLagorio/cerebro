import { FileTree } from '@/components/FileTree';
import { Icon } from '@/components/ui/Icon';
import type { Entry } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const RECENTS_SHOWN = 6;

/** A document here is any markdown file that isn't a work item; project.md
 * files stay out of recents (their surface is the project page). */
const isDoc = (e: Entry) => e.type !== 'Work item' && !e.path.endsWith('project.md');

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * All-docs rail surface (M2 Task 11): recents to pick up where you left
 * off, plus the whole vault as a folder tree.
 */
export function DocsPage() {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const openDetail = useUiStore((s) => s.openDetail);

  const recents = entries
    .filter(isDoc)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, RECENTS_SHOWN);

  const projectTitle = (e: Entry) =>
    e.project === null ? null : (entries.find((p) => p.path === e.project)?.title ?? null);

  // Same open rule as the project tree/QuickOpen: work items belong to the
  // detail panel on their project canvas, project.md IS the project, and
  // everything else is a document.
  const open = (path: string) => {
    const opened = entries.find((e) => e.path === path);
    if (opened?.type === 'Project') {
      navigate({ kind: 'project', path });
      return;
    }
    if (opened?.type === 'Work item') {
      if (opened.project !== null) navigate({ kind: 'project', path: opened.project });
      openDetail(path);
      return;
    }
    navigate({ kind: 'doc', path });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="docs-page">
      <div className="flex flex-none items-center gap-2 px-5 pb-2 pt-3.5">
        <Icon name="library" size={16} color="var(--n-600)" />
        <h1 className="m-0 text-[15px] font-semibold leading-6 tracking-[-0.005em]">Docs</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {recents.length > 0 && (
          <>
            <h2 className="mb-1.5 mt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">
              Pick up where you left off
            </h2>
            <ul className="m-0 mb-4 flex max-w-[720px] flex-col gap-0.5 p-0">
              {recents.map((e) => (
                <li key={e.path} className="list-none">
                  <button
                    type="button"
                    data-testid="recent-doc"
                    onClick={() => open(e.path)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left hover:bg-[var(--n-50)]"
                  >
                    <Icon name="file-text" size={14} color="var(--n-500)" />
                    <span className="truncate text-[13px] text-[var(--n-800)]">{e.title}</span>
                    {projectTitle(e) !== null && (
                      <span className="flex-none rounded-[5px] bg-[var(--n-50)] px-1.5 py-px text-[11px] text-[var(--n-600)]">
                        {projectTitle(e)}
                      </span>
                    )}
                    <span className="ml-auto flex-none text-[11px] text-[var(--n-400)] [font-family:var(--font-mono)]">
                      {formatDay(e.modifiedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--n-500)]">
          All files
        </h2>
        <FileTree root="" onOpen={open} />
      </div>
    </div>
  );
}
