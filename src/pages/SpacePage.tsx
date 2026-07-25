import { useMemo } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusFlag } from '@/components/ui/StatusFlag';
import { resolveTarget } from '@/engine/wikilink';
import { swatchColor } from '@/lib/swatch';
import { ProjectCard } from '@/pages/HomePage';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export function SpacePage({ path }: { path: string }) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();

  const space = entries.find((e) => e.path === path) ?? null;
  const projects = useMemo(
    () =>
      entries
        .filter(
          (e) =>
            e.type === 'Project' &&
            (e.relationships.space ?? []).some((t) => resolveTarget(t, entries)?.path === path),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [entries, path],
  );
  const statuses = schema.statusSetForSpace(path);

  if (!space) {
    return (
      <EmptyState
        icon="folder"
        title="Space not found"
        description="This space is not in the current vault."
      />
    );
  }

  const description =
    typeof space.properties.description === 'string'
      ? space.properties.description
      : space.snippet;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-[var(--n-0)]">
      <div className="mx-auto max-w-[1080px] px-8 pb-14 pt-7">
        <div className="mb-1.5 flex items-center gap-3">
          <span
            className="inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] text-[15px] font-bold text-[var(--n-0)]"
            style={{ background: swatchColor(space.properties.color) }}
          >
            {space.title.charAt(0).toUpperCase()}
          </span>
          <h1 className="m-0 text-[20px] font-semibold leading-7 tracking-[-0.01em]">
            {space.title}
          </h1>
        </div>
        {description ? (
          <p className="mb-3 ml-[46px] mt-0 max-w-[640px] text-[13px] leading-[19px] text-[var(--n-600)]">
            {description}
          </p>
        ) : null}
        <div className="mb-[26px] ml-[46px] flex flex-wrap items-center gap-1.5">
          {statuses.map((status) => (
            <StatusFlag
              key={status.id}
              label={status.label}
              color={status.color ? swatchColor(status.color) : undefined}
              size="sm"
            />
          ))}
        </div>
        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Projects</h2>
          <span className="text-[12px] text-[var(--n-500)]">{projects.length}</span>
        </div>
        {projects.length === 0 ? (
          <EmptyState
            icon="folder-kanban"
            title="No projects yet"
            description="Projects in this space will appear here."
          />
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {projects.map((project) => (
              <ProjectCard key={project.path} project={project} subtitle={space.title} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
