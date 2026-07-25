import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Tag } from '@/components/ui/Tag';
import type { Entry, Schema } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { swatchColor } from '@/lib/swatch';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Items belonging to the project, and how many sit in a done-group status. */
export function projectProgress(
  project: Entry,
  entries: Entry[],
  schema: Schema,
): { total: number; done: number } {
  const items = entries.filter((e) =>
    (e.relationships.project ?? []).some((t) => resolveTarget(t, entries)?.path === project.path),
  );
  let done = 0;
  for (const item of items) {
    const itemSpace = schema.spaceForEntry(item);
    const statuses = schema.statusSetForSpace(itemSpace?.path ?? null);
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

export function HomePage() {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);

  const spaces = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Space')
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries],
  );
  const projects = useMemo(
    () =>
      entries
        .filter((e) => e.type === 'Project')
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    [entries],
  );
  const projectCountBySpace = useMemo(() => {
    const map = new Map<string, number>();
    for (const project of entries.filter((e) => e.type === 'Project')) {
      const target = project.relationships.space?.[0];
      const space = target ? resolveTarget(target, entries) : null;
      if (space) map.set(space.path, (map.get(space.path) ?? 0) + 1);
    }
    return map;
  }, [entries]);
  const spaceTitleFor = (project: Entry): string => {
    const target = project.relationships.space?.[0];
    const space = target ? resolveTarget(target, entries) : null;
    return space?.title ?? '—';
  };

  const greeting = greetingForHour(new Date().getHours());

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--n-0)]">
      <div className="mx-auto max-w-[1080px] px-8 pb-14 pt-8">
        <div className="mb-[18px] flex items-baseline gap-3">
          <h1 className="m-0 text-[22px] font-semibold leading-[30px] tracking-[-0.015em]">
            {greeting}
          </h1>
          <span className="text-[12px] text-[var(--n-500)]">
            {spaces.length} {spaces.length === 1 ? 'space' : 'spaces'} · {projects.length}{' '}
            {projects.length === 1 ? 'project' : 'projects'}
          </span>
        </div>

        {spaces.length === 0 && projects.length === 0 && (
          // Fresh-vault empty state (M1.x): a brand-new vault rendered two
          // bare section headings with nothing actionable under them.
          <EmptyState
            icon="box"
            title="Nothing here yet"
            description="Use New to create a space, then add projects inside it."
          />
        )}

        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Spaces</h2>
        </div>
        <div className="mb-[30px] grid grid-cols-3 gap-2.5">
          {spaces.map((space) => {
            const count = projectCountBySpace.get(space.path) ?? 0;
            return (
              <button
                key={space.path}
                type="button"
                onClick={() => navigate({ kind: 'space', path: space.path })}
                className="flex min-w-0 flex-col gap-[9px] rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-[14px] py-[13px] text-left hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)]"
              >
                <div className="flex min-w-0 items-center gap-[9px]">
                  <span
                    className="inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] text-[12px] font-bold text-[var(--n-0)]"
                    style={{ background: swatchColor(space.properties.color) }}
                  >
                    {space.title.charAt(0).toUpperCase()}
                  </span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-[var(--n-900)]">
                    {space.title}
                  </span>
                </div>
                {space.snippet ? (
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-[var(--n-500)]">
                    {space.snippet}
                  </div>
                ) : null}
                <div className="text-[12px] text-[var(--n-500)]">
                  {count === 1 ? '1 project' : `${count} projects`}
                </div>
              </button>
            );
          })}
        </div>

        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Active projects</h2>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {projects.map((project) => (
            <ProjectCard key={project.path} project={project} subtitle={spaceTitleFor(project)} />
          ))}
        </div>
      </div>
    </div>
  );
}
