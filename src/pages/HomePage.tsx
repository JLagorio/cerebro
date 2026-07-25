import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Tag } from '@/components/ui/Tag';
import type { Entry, Schema } from '@/engine/types';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Items belonging to the project (containment, v2), done-group count. */
export function projectProgress(
  project: Entry,
  entries: Entry[],
  schema: Schema,
): { total: number; done: number } {
  const items = entries.filter((e) => e.project === project.path && e.type === 'Work item');
  let done = 0;
  for (const item of items) {
    const statuses = schema.statusSetForProject(item.project);
    const def = statuses.find((s) => s.id === item.properties.status);
    if (def?.group === 'done') done += 1;
  }
  return { total: items.length, done };
}

const CARD =
  'flex min-w-0 flex-col gap-2 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-[14px] py-[13px] text-left hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)]';

export function ProjectCard({ project, subtitle }: { project: Entry; subtitle: string }) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const { total, done } = useMemo(
    () => projectProgress(project, entries, schema),
    [project, entries, schema],
  );
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const projectKey =
    typeof project.properties.key === 'string' ? project.properties.key : null;

  return (
    <button
      type="button"
      onClick={() => navigate({ kind: 'project', path: project.path })}
      className={CARD}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="folder-kanban" size={15} color="var(--n-500)" />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-[var(--n-900)]">
          {project.title}
        </span>
        <span className="flex-1" />
        {projectKey ? (
          <Tag style={{ fontFamily: 'var(--font-mono)' }}>{projectKey}</Tag>
        ) : null}
      </div>
      <div className="text-[11.5px] text-[var(--n-500)]">{subtitle}</div>
      <div className="flex items-center gap-2">
        <ProgressBar value={percent} width={150} />
        <span className="text-[11px] text-[var(--n-600)] [font-family:var(--font-mono)]">
          {done}/{total} done
        </span>
      </div>
    </button>
  );
}

/** 'execution' → 'Execution' — light display casing for project states. */
function humanizeState(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const words = value.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function HomePage() {
  const entries = useVaultStore((s) => s.entries);

  const projects = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Project')
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    [entries],
  );

  const greeting = greetingForHour(new Date().getHours());

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--n-0)]">
      <div className="mx-auto max-w-[1080px] px-8 pb-14 pt-8">
        <div className="mb-[18px] flex items-baseline gap-3">
          <h1 className="m-0 text-[22px] font-semibold leading-[30px] tracking-[-0.015em]">
            {greeting}
          </h1>
          <span className="text-[12px] text-[var(--n-500)]">
            {projects.length} {projects.length === 1 ? 'project' : 'projects'}
          </span>
        </div>

        {projects.length === 0 && (
          // Fresh-vault empty state (M1.x): a brand-new vault rendered a bare
          // section heading with nothing actionable under it.
          <EmptyState
            icon="folder-kanban"
            title="Nothing here yet"
            description="Use New to create your first project."
          />
        )}

        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Projects</h2>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {projects.map((project) => (
            <ProjectCard
              key={project.path}
              project={project}
              subtitle={humanizeState(project.properties.state) ?? project.folder}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
