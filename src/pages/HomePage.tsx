import { useMemo } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Dropdown } from '@/components/ui/Dropdown';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { collectionsTree, nodeCount } from '@/engine/collections';
import { dueBucket, formatDue, type DocTask, type DueBucket } from '@/engine/tasks';
import type { CollectionNode } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { useDocTasks } from '@/hooks/useDocTasks';
import { LearnedCard } from '@/knowledge/LearnedCard';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const CARD =
  'flex min-w-0 flex-col gap-2 rounded-[10px] border border-[var(--n-200)] bg-[var(--n-0)] px-[14px] py-[13px] text-left hover:border-[var(--n-300)] hover:shadow-[var(--shadow-sm)]';

/** One root Collection (M12.5 — the grid used to be projects). */
export function CollectionCard({ node }: { node: CollectionNode }) {
  const navigate = useNavStore((s) => s.navigate);
  const count = nodeCount(node);

  return (
    <button
      type="button"
      data-testid="home-collection-card"
      onClick={() => navigate({ kind: 'collection', folder: node.id })}
      className={CARD}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={node.icon} size={15} color={node.color ?? 'var(--n-500)'} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-[var(--n-900)]">
          {node.label}
        </span>
      </div>
      <div className="text-[11.5px] text-[var(--n-500)]">
        {count} {count === 1 ? 'thing' : 'things'} inside
      </div>
    </button>
  );
}

const BUCKET_META: { id: DueBucket; label: string; tone: string }[] = [
  { id: 'overdue', label: 'Overdue', tone: 'text-[var(--danger-600,#c5372c)]' },
  { id: 'today', label: 'Today', tone: 'text-[var(--warn-700,#8a5a13)]' },
  { id: 'upcoming', label: 'Upcoming', tone: 'text-[var(--n-600)]' },
  { id: 'none', label: 'No due date', tone: 'text-[var(--n-500)]' },
];

function TaskRow({
  task,
  onToggle,
}: {
  task: DocTask;
  onToggle: (done: boolean) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const open = useOpenPath();
  const source = entries.find((e) => e.path === task.sourcePath) ?? null;
  const bucket = dueBucket(task.due, todayIso());
  const dueTone =
    bucket === 'overdue'
      ? 'bg-[var(--danger-50,#fdecec)] text-[var(--danger-600,#c5372c)]'
      : bucket === 'today'
        ? 'bg-[var(--warn-50,#fdf3e2)] text-[var(--warn-700,#8a5a13)]'
        : 'bg-[var(--n-50)] text-[var(--n-600)]';

  return (
    <div
      data-testid="home-task"
      className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--n-50)]"
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={task.done}
        aria-label={`Mark "${task.text}" ${task.done ? 'open' : 'done'}`}
        onClick={() => onToggle(!task.done)}
        className={[
          'flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border',
          task.done
            ? 'border-[var(--cortex-500)] bg-[var(--cortex-500)] text-[var(--n-0)]'
            : 'border-[var(--n-300)] bg-[var(--n-0)] hover:border-[var(--cortex-500)]',
        ].join(' ')}
      >
        {task.done && <Icon name="check" size={11} />}
      </button>
      <span
        className={[
          'min-w-0 flex-1 truncate text-[13px]',
          task.done ? 'text-[var(--n-400)] line-through' : 'text-[var(--n-800)]',
        ].join(' ')}
      >
        {task.text === '' ? '(untitled task)' : task.text}
      </span>
      {task.assignees.map((a) => (
        <span
          key={a}
          className="flex-none rounded-full border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 py-px text-[11px] text-[var(--n-600)]"
        >
          {resolveTarget(a, entries)?.title ?? a}
        </span>
      ))}
      {task.due !== null && (
        <span
          className={`flex-none items-center gap-1 rounded-[5px] px-1.5 py-px text-[11px] ${dueTone} inline-flex`}
        >
          <Icon name="calendar" size={11} />
          {formatDue(task.due)}
        </span>
      )}
      {source !== null && (
        <button
          type="button"
          onClick={() => open(source.path)}
          className="flex-none truncate rounded-[5px] border-0 bg-[var(--n-50)] px-1.5 py-px text-[11px] text-[var(--n-500)] hover:bg-[var(--n-100)] hover:text-[var(--n-800)]"
          title={source.path}
        >
          {source.title}
        </button>
      )}
    </div>
  );
}

/** All open checklist tasks across docs, grouped by due bucket (M2.x). */
export function HomeTasks() {
  const { tasks, loading, toggle } = useDocTasks();
  const entries = useVaultStore((s) => s.entries);
  const assigneeFilter = useUiStore((s) => s.homeTaskAssignee);
  const setAssigneeFilter = useUiStore((s) => s.setHomeTaskAssignee);

  const assignees = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of tasks) {
      for (const a of t.assignees) {
        if (!seen.has(a)) seen.set(a, resolveTarget(a, entries)?.title ?? a);
      }
    }
    return [...seen.entries()].sort((x, y) => x[1].localeCompare(y[1]));
  }, [tasks, entries]);

  const open = tasks.filter((t) => !t.done);
  const filtered =
    assigneeFilter === ''
      ? open
      : assigneeFilter === '__unassigned__'
        ? open.filter((t) => t.assignees.length === 0)
        : open.filter((t) => t.assignees.includes(assigneeFilter));

  const today = todayIso();
  const byBucket = (bucket: DueBucket) =>
    filtered
      .filter((t) => dueBucket(t.due, today) === bucket)
      .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.text.localeCompare(b.text));

  const doneCount = tasks.length - open.length;

  return (
    <section data-testid="home-tasks" className="mb-7">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">My Tasks</h2>
        <span className="text-[12px] text-[var(--n-500)]">
          {filtered.length} open{doneCount > 0 ? ` · ${doneCount} done` : ''}
        </span>
        <span className="flex-1" />
        {assignees.length > 0 && (
          <Dropdown
            size="sm"
            label="Assignee"
            options={[
              { value: '', label: 'Everyone' },
              { value: '__unassigned__', label: 'Unassigned' },
              ...assignees.map(([target, title]) => ({ value: target, label: title })),
            ]}
            value={assigneeFilter}
            onChange={setAssigneeFilter}
          />
        )}
      </div>
      {loading && filtered.length === 0 && <div data-testid="home-tasks-loading" />}
      {!loading && filtered.length === 0 && (
        <p className="m-0 rounded-[10px] border border-dashed border-[var(--n-200)] px-4 py-3 text-[12.5px] text-[var(--n-500)]">
          No open tasks. Add one in any doc with a checklist item — assign with @, set a due
          date with the calendar chip.
        </p>
      )}
      {BUCKET_META.map(({ id, label, tone }) => {
        const group = byBucket(id);
        if (group.length === 0) return null;
        return (
          <div key={id} className="mb-2">
            <h3 className={`mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-[0.06em] ${tone}`}>
              {label} · {group.length}
            </h3>
            <div className="flex flex-col">
              {group.map((t) => (
                <TaskRow
                  key={`${t.sourcePath}:${t.line}`}
                  task={t}
                  onToggle={(done) => void toggle(t, done)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function HomePage() {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const schema = useSchema();

  // M12.5: the grid shows Collections — the containers — where it used to
  // show a hardcoded Project type nobody has anymore.
  const roots = useMemo(
    () => collectionsTree(collections, views, entries, schema),
    [collections, views, entries, schema],
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
            {roots.length} {roots.length === 1 ? 'collection' : 'collections'}
          </span>
        </div>

        {roots.length === 0 && (
          // Fresh-vault empty state (M1.x): a brand-new vault rendered a bare
          // section heading with nothing actionable under it.
          <EmptyState
            icon="folder-open"
            title="Nothing here yet"
            description="Use New to create your first collection."
          />
        )}

        {/* M8.3 — the only surface in the app that speaks first, and it is
            capped at three items each of which can be dismissed for good. */}
        <LearnedCard />

        <HomeTasks />

        <div className="mb-2.5 flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.005em]">Collections</h2>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {roots.map((node) => (
            <CollectionCard key={node.id} node={node} />
          ))}
        </div>
      </div>
    </div>
  );
}
