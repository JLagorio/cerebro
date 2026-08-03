import { useCallback, useEffect, useState } from 'react';
import { parseTasks, toggleTaskLine, type DocTask } from '@/engine/tasks';
import { isTaskRecord } from '@/engine/typeCatalog';
import type { Entry, Schema } from '@/engine/types';
import { readNote, saveNote } from '@/lib/ipc';
import { isTemplate } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/** Any markdown note can carry tasks except task-like records (M12.2: a
 * record with a status IS the task — its checklists are its own subtasks),
 * Type docs (schema), and templates (scaffolding, not commitments). */
const isTaskSource = (e: Entry, schema: Schema): boolean =>
  e.type !== 'Type' && !isTemplate(e) && !isTaskRecord(e, schema);

// Body cache keyed by path — invalidated by modifiedAt, so the watcher's
// rescans keep the rollup fresh without rereading unchanged files.
const cache = new Map<string, { modifiedAt: string; tasks: DocTask[] }>();

/**
 * Every checklist task across the vault's docs (M2.x docs polish, Home
 * rollup). Reads note bodies lazily with a modifiedAt cache; `toggle`
 * writes the checkbox straight back to the file.
 */
export function useDocTasks(): {
  tasks: DocTask[];
  loading: boolean;
  toggle: (task: DocTask, done: boolean) => Promise<void>;
} {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const [tasks, setTasks] = useState<DocTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (vaultPath === null) return;
    let cancelled = false;
    const sources = entries.filter((e) => isTaskSource(e, schema));
    void (async () => {
      const results = await Promise.all(
        sources.map(async (e) => {
          const hit = cache.get(e.path);
          if (hit !== undefined && hit.modifiedAt === e.modifiedAt) return hit.tasks;
          try {
            const body = await readNote(vaultPath, e.path);
            const parsed = parseTasks(e.path, body);
            cache.set(e.path, { modifiedAt: e.modifiedAt, tasks: parsed });
            return parsed;
          } catch {
            return []; // unreadable note: skip rather than fail the rollup
          }
        }),
      );
      if (cancelled) return;
      setTasks(results.flat());
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, vaultPath, schema]);

  const toggle = useCallback(
    async (task: DocTask, done: boolean) => {
      if (vaultPath === null) return;
      try {
        // Fresh read: the cached line index may be stale after edits.
        const body = await readNote(vaultPath, task.sourcePath);
        const next = toggleTaskLine(body, task.line, done);
        if (next === null) {
          toast('That task moved — refreshing');
          await rescan();
          return;
        }
        await saveNote(vaultPath, task.sourcePath, next);
        cache.delete(task.sourcePath);
        // Optimistic flip so the row responds before the rescan lands.
        setTasks((prev) =>
          prev.map((t) =>
            t.sourcePath === task.sourcePath && t.line === task.line ? { ...t, done } : t,
          ),
        );
        await rescan();
      } catch {
        toast("Couldn't update task");
      }
    },
    [vaultPath, rescan, toast],
  );

  return { tasks, loading, toggle };
}
