import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { NoteBodyEditor } from '@/editor/NoteBodyEditor';
import type { Selection } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useEntry, useVaultStore } from '@/stores/vaultStore';

export type DocSelection = Extract<Selection, { kind: 'doc' }>;

/**
 * Full-page markdown document (M2 Task 10). The title is the doc's H1,
 * edited inside the editor — each save rescans, so the header and every
 * other surface pick the new title up from the scanner.
 */
export function DocPage({ selection }: { selection: DocSelection }) {
  const entry = useEntry(selection.path);
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);

  if (entry === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <EmptyState
          icon="file-x"
          title="This page no longer exists"
          description="It may have been renamed or moved to the Trash."
          action={
            <Button variant="secondary" onClick={() => navigate({ kind: 'home' })}>
              Go home
            </Button>
          }
        />
      </div>
    );
  }

  const project =
    entry.project === null ? null : (entries.find((e) => e.path === entry.project) ?? null);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="doc-page">
      <div className="flex flex-none items-center gap-1.5 px-5 pb-2 pt-3.5">
        {project !== null && (
          <>
            <button
              type="button"
              onClick={() => navigate({ kind: 'project', path: project.path })}
              className="inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[13px] text-[var(--n-500)] hover:bg-[var(--n-50)] hover:text-[var(--n-800)]"
            >
              <Icon name="folder-kanban" size={13} />
              {project.title}
            </button>
            <Icon name="chevron-right" size={13} color="var(--n-400)" />
          </>
        )}
        <Icon name="file-text" size={15} color="var(--n-600)" />
        <h1
          data-testid="doc-title"
          className="m-0 min-w-0 truncate text-[15px] font-semibold leading-6 tracking-[-0.005em]"
        >
          {entry.title}
        </h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <NoteBodyEditor path={entry.path} />
      </div>
    </div>
  );
}
