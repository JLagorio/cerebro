import { useMemo, useState } from 'react';
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
  'flex min-w-0 flex-col gap-2 rounded-[10px] border border-n-200 bg-n-0 px-[14px] py-[13px] text-left hover:border-n-300 hover:shadow-[var(--shadow-sm)]';

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
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold text-n-900">
          {node.label}
        </span>
      </div>
      <div className="text-[11.5px] text-[var(--text-meta)]">
        {count} {count === 1 ? 'thing' : 'things'} inside
      </div>
    </button>
  );
}

/** One heading style for every Home section, so the visual and semantic
 *  levels agree instead of the h2s shipping at two different sizes. */
export const SECTION_HEADING = 'm-0 text-[15px] font-semibold tracking-[-0.005em]';

// Fallback arguments removed (M15): every one of these tokens is defined at
// :root so the fallback never fired, and the literals recorded a *different*
// colour than the token — #c5372c for a --danger-600 that is #bc2438.
const BUCKET_META: { id: DueBucket; label: string; tone: string }[] = [
  { id: 'overdue', label: 'Overdue', tone: 'text-danger-600' },
  { id: 'today', label: 'Today', tone: 'text-warn-700' },
  { id: 'upcoming', label: 'Upcoming', tone: 'text-n-600' },
  { id: 'none', label: 'No due date', tone: 'text-[var(--text-meta)]' },
];

function TaskRow({ task, onToggle }: { task: DocTask; onToggle: (done: boolean) => void }) {
  const entries = useVaultStore((s) => s.entries);
  const open = useOpenPath();
  const source = entries.find((e) => e.path === task.sourcePath) ?? null;
  const bucket = dueBucket(task.due, todayIso());
  const dueTone =
    bucket === 'overdue'
      ? 'bg-danger-50 text-danger-600'
      : bucket === 'today'
        ? 'bg-warn-50 text-warn-700'
        : 'bg-n-50 text-n-600';

  return (
    <div
      data-testid="home-task"
      className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-n-50"
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
            ? 'border-cortex-500 bg-cortex-500 text-n-0'
            : 'border-n-300 bg-n-0 hover:border-cortex-500',
        ].join(' ')}
      >
        {task.done && <Icon name="check" size={11} />}
      </button>
      {/* The label no longer eats the row's slack. It used to, which flushed
          the source chip ~1100px to the right edge: with a shared checklist
          template every row read as the same task, and the only thing telling
          them apart sat at the opposite end from the checkbox you click. */}
      <span
        className={[
          'min-w-0 max-w-[62%] truncate text-[13px]',
          task.done ? 'text-[var(--text-disabled)] line-through' : 'text-n-800',
        ].join(' ')}
      >
        {task.text === '' ? '(untitled task)' : task.text}
      </span>
      {source !== null && (
        <button
          type="button"
          onClick={() => open(source.path)}
          className="min-w-0 max-w-[38%] flex-none truncate rounded-[5px] border-0 bg-n-50 px-1.5 py-px text-[11px] text-[var(--text-meta)] hover:bg-n-100 hover:text-n-900"
          title={source.path}
        >
          {source.title}
        </button>
      )}
      {/* Only the dates and people right-align. */}
      <span className="flex-1" />
      {task.assignees.map((a) => (
        <span
          key={a}
          className="flex-none rounded-full border border-n-200 bg-n-0 px-1.5 py-px text-[11px] text-n-600"
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

  // '· N done' used to be a dead number: nothing anywhere revealed the done
  // set, and checking a box deleted the row from the screen with no way back.
  // It is a control now, and with it on a task you tick stays put, struck
  // through, so a mis-click is one more click to undo.
  const [showDone, setShowDone] = useState(false);

  const byAssignee = (list: DocTask[]) =>
    assigneeFilter === ''
      ? list
      : assigneeFilter === '__unassigned__'
        ? list.filter((t) => t.assignees.length === 0)
        : list.filter((t) => t.assignees.includes(assigneeFilter));

  const openTasks = tasks.filter((t) => !t.done);
  const filtered = byAssignee(showDone ? tasks : openTasks);
  const openCount = byAssignee(openTasks).length;

  const today = todayIso();
  const byBucket = (bucket: DueBucket) =>
    filtered
      .filter((t) => dueBucket(t.due, today) === bucket)
      .sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
          a.text.localeCompare(b.text),
      );

  const doneCount = tasks.length - openTasks.length;

  return (
    <section data-testid="home-tasks" className="mb-7">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className={SECTION_HEADING}>My Tasks</h2>
        <span className="text-[12px] text-[var(--text-meta)]">{openCount} open</span>
        {doneCount > 0 && (
          <button
            type="button"
            data-testid="home-tasks-show-done"
            aria-pressed={showDone}
            onClick={() => setShowDone((v) => !v)}
            className={[
              'rounded-[5px] border-0 bg-transparent px-1 py-px text-[12px] underline decoration-dotted underline-offset-2',
              showDone ? 'text-cortex-600' : 'text-[var(--text-meta)] hover:text-n-900',
            ].join(' ')}
          >
            {doneCount} done
          </button>
        )}
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
        <p className="m-0 rounded-[10px] border border-dashed border-n-200 px-4 py-3 text-[12.5px] text-[var(--text-meta)]">
          No open tasks. Add one in any doc with a checklist item — assign with @, set a due date
          with the calendar chip.
        </p>
      )}
      {BUCKET_META.map(({ id, label, tone }) => {
        const group = byBucket(id);
        if (group.length === 0) return null;
        return (
          <div key={id} className="mb-2">
            <h3
              className={`mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-[0.06em] ${tone}`}
            >
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
    <div className="min-w-0 flex-1 overflow-y-auto bg-n-0">
      <div className="mx-auto max-w-[1080px] px-8 pb-14 pt-8">
        <div className="mb-[18px] flex items-baseline gap-3">
          <h1 className="m-0 text-[22px] font-semibold leading-[30px] tracking-[-0.015em]">
            {greeting}
          </h1>
          <span className="text-[12px] text-[var(--text-meta)]">
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
          <h2 className={SECTION_HEADING}>Collections</h2>
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
