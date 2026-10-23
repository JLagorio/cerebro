import { useOpenPath } from '@/app/useOpenPath';
import { Icon } from '@/components/ui/Icon';
import { dueBucket, formatDue, type DocTask } from '@/engine/tasks';
import { resolveTarget } from '@/engine/wikilink';
import { todayIso } from '@/lib/templates';
import { useVaultStore } from '@/stores/vaultStore';

export function TaskRow({ task, onToggle }: { task: DocTask; onToggle: (done: boolean) => void }) {
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
      className="cb-home-task group flex min-w-0 items-center gap-2 rounded-md hover:bg-n-50"
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={task.done}
        aria-label={`Mark "${task.text}" ${task.done ? 'open' : 'done'}`}
        onClick={() => onToggle(!task.done)}
        className={[
          'flex h-4 w-4 flex-none items-center justify-center rounded-full border',
          task.done
            ? 'border-cortex-500 bg-cortex-500 text-inverse'
            : 'border-n-400 bg-n-0 hover:border-cortex-500',
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
          'min-w-0 max-w-[62%] truncate text-ui',
          task.done ? 'text-[var(--text-disabled)] line-through' : 'text-n-800',
        ].join(' ')}
      >
        {task.text === '' ? '(untitled task)' : task.text}
      </span>
      {source !== null && (
        <button
          type="button"
          onClick={() => open(source.path)}
          className="min-w-0 max-w-[38%] flex-none truncate rounded-sm border-0 bg-n-50 px-1.5 py-px text-2xs text-[var(--text-meta)] hover:bg-n-100 hover:text-n-900"
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
          className="flex-none rounded-full border border-n-200 bg-n-0 px-1.5 py-px text-2xs text-n-600"
        >
          {resolveTarget(a, entries)?.title ?? a}
        </span>
      ))}
      {task.due !== null && (
        <span
          className={`flex-none items-center gap-1 rounded-sm px-1.5 py-px text-2xs ${dueTone} inline-flex`}
        >
          <Icon name="calendar" size={11} />
          {formatDue(task.due)}
        </span>
      )}
    </div>
  );
}
