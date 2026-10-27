import { useMemo, useState } from 'react';
import { Dropdown } from '@/components/ui/Dropdown';
import type { BandContext } from '@/engine/dateBuckets';
import { myWorkRows, type HomeRow } from '@/engine/homeLanes';
import { forwardSection, sectionize } from '@/engine/homeSections';
import { resolveTarget } from '@/engine/wikilink';
import { useDocTasks } from '@/hooks/useDocTasks';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { Lane } from './Lane';
import { TaskRow } from './TaskRow';
import { SelectedTaskRecovery } from '@/editor/SelectedTaskRecovery';

export function MyWorkLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const {
    tasks,
    loading,
    toggle,
    unreadable = [],
    recovering = [],
    toggleUnavailable,
  } = useDocTasks();
  const entries = useVaultStore((s) => s.entries);
  const status = useVaultStore((s) => s.status);
  const schema = useSchema();
  const filter = useUiStore((s) => s.homeTaskAssignee);
  const setFilter = useUiStore((s) => s.setHomeTaskAssignee);
  const [showDone, setShowDone] = useState(false);
  const assignees = useMemo(
    () =>
      [...new Set(tasks.flatMap((task) => task.assignees))]
        .map((target) => ({
          value: target,
          label: resolveTarget(target, entries)?.title ?? target,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [tasks, entries],
  );
  const filtered = tasks.filter(
    (task) =>
      filter === '' ||
      (filter === '__unassigned__' ? task.assignees.length === 0 : task.assignees.includes(filter)),
  );
  const data = myWorkRows(entries, schema, filtered, ctx);
  const done = filtered.filter((task) => task.done);
  if (showDone)
    data.rows.push(
      ...done.map((task): HomeRow => ({
        subject: `${task.sourcePath}#${task.line}`,
        path: task.sourcePath,
        title: task.text,
        date: task.due,
        task,
      })),
    );
  if (unreadable.length > 0)
    data.notes.push(
      `Tasks could not be read in ${unreadable
        .map((path) => entries.find((entry) => entry.path === path)?.title ?? path)
        .slice(0, 3)
        .join(' · ')}${unreadable.length > 3 ? ` · and ${unreadable.length - 3} more` : ''}.`,
    );
  // A done-only checklist still offers its reveal control.
  if (data.rows.length === 0 && done.length > 0) data.notes.push('No open tasks.');
  const state =
    status === 'error'
      ? 'unavailable'
      : loading
        ? 'loading'
        : data.notes.length > 0
          ? 'partial'
          : 'ready';
  const sections = sectionize(
    data.rows,
    (row) =>
      row.task?.done
        ? { key: 'done', label: 'Done', order: 101 }
        : forwardSection(row.date, now, ctx),
    (a, b) =>
      (typeof a.date === 'string' ? a.date : '9999').localeCompare(
        typeof b.date === 'string' ? b.date : '9999',
      ),
  );
  return (
    <>
      {recovering.map((owner) => (
        <SelectedTaskRecovery key={owner.key.ownerId} owner={owner} />
      ))}
      <Lane
        id="mywork"
        state={state}
        data={data}
        sections={sections}
        door="Open My work"
        onDoor={() => useNavStore.getState().navigate({ kind: 'mywork' })}
        controls={
          <div className="mb-1 flex items-center gap-2">
            {done.length > 0 && (
              <button
                type="button"
                data-testid="home-tasks-show-done"
                aria-pressed={showDone}
                onClick={() => setShowDone((value) => !value)}
                className="border-0 bg-transparent p-0 text-xs text-n-500 underline decoration-dotted underline-offset-2"
              >
                {done.length} done
              </button>
            )}
            {assignees.length > 0 && (
              <div className="ml-auto">
                <Dropdown
                  size="sm"
                  label="Task assignee"
                  options={[
                    { value: '', label: 'Everyone' },
                    { value: '__unassigned__', label: 'Unassigned' },
                    ...assignees,
                  ]}
                  value={filter}
                  onChange={setFilter}
                />
              </div>
            )}
          </div>
        }
        renderRow={(row) =>
          row.task === undefined ? undefined : (
            <TaskRow
              task={row.task}
              disabledReason={toggleUnavailable?.(row.task)}
              onToggle={(value) => void toggle(row.task!, value)}
            />
          )
        }
      />
    </>
  );
}
