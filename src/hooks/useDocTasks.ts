import { useCallback, useEffect, useState } from 'react';
import { parseTasks, toggleTaskLine, type DocTask } from '@/engine/tasks';
import { isTaskRecord } from '@/engine/typeCatalog';
import type { Entry, Schema } from '@/engine/types';
import { splitFrontmatter } from '@/engine/frontmatter';
import { isStaleContent } from '@/engine/staleContent';
import { readNoteSource, saveNote } from '@/lib/ipc';
import { isTemplate } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

const isTaskSource = (e: Entry, schema: Schema): boolean =>
  e.path.endsWith('.md') && e.type !== 'Type' && !isTemplate(e) && !isTaskRecord(e, schema);
// The same path in another vault never borrows its task body.
const cache = new Map<string, { version: string; tasks: DocTask[] }>();
const keyOf = (vault: string, path: string) => JSON.stringify([vault, path]);
interface TaskRead {
  vault: string | null;
  tasks: DocTask[];
  unreadable: string[];
  loading: boolean;
}
/** Lazy body reads; unreadable names are surfaced rather than silently omitted. */
export function useDocTasks(): {
  tasks: DocTask[];
  unreadable: string[];
  loading: boolean;
  toggle: (task: DocTask, done: boolean) => Promise<void>;
} {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const schema = useSchema();
  const [read, setRead] = useState<TaskRead>({
    vault: null,
    tasks: [],
    unreadable: [],
    loading: true,
  });
  useEffect(() => {
    if (vaultPath === null || (entriesVault !== null && entriesVault !== vaultPath)) return;
    let live = true;
    setRead({ vault: vaultPath, tasks: [], unreadable: [], loading: true });
    void (async () => {
      const sources = entries.filter((entry) => isTaskSource(entry, schema));
      const results: { tasks: DocTask[]; unreadable: string[] }[] = new Array(sources.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, sources.length) }, async () => {
          while (live && cursor < sources.length) {
            const index = cursor++,
              entry = sources[index],
              key = keyOf(vaultPath, entry.path);
            const hit = cache.get(key);
            try {
              let tasks: DocTask[];
              if (entry.hash !== null && hit?.version === entry.hash) tasks = hit.tasks;
              else {
                const source = await readNoteSource(vaultPath, entry.path);
                tasks = parseTasks(entry.path, splitFrontmatter(source.content).body, source.hash);
                if (live) cache.set(key, { version: source.hash, tasks });
              }
              results[index] = { tasks, unreadable: [] };
            } catch {
              results[index] = { tasks: [], unreadable: [entry.path] };
            }
          }
        }),
      );
      if (live)
        setRead({
          vault: vaultPath,
          tasks: results.flatMap((r) => r.tasks),
          unreadable: results.flatMap((r) => r.unreadable),
          loading: false,
        });
    })();
    return () => {
      live = false;
    };
  }, [entries, vaultPath, entriesVault, schema]);
  const toggle = useCallback(
    async (task: DocTask, done: boolean) => {
      if (vaultPath === null || useVaultStore.getState().vaultPath !== vaultPath) return;
      const refresh = async () => {
        cache.delete(keyOf(vaultPath, task.sourcePath));
        if (useVaultStore.getState().vaultPath !== vaultPath) return;
        useUiStore
          .getState()
          .toast(
            `“${task.text}” changed since this list was read, so the tick wasn't saved. The list is refreshed — tick it again.`,
          );
        await useVaultStore.getState().rescan();
      };
      try {
        const source = await readNoteSource(vaultPath, task.sourcePath);
        if (task.version === null || source.hash !== task.version) {
          await refresh();
          return;
        }
        const body = splitFrontmatter(source.content).body;
        const current = parseTasks(task.sourcePath, body, source.hash).find(
          (row) => row.line === task.line,
        );
        const next = current?.text === task.text ? toggleTaskLine(body, task.line, done) : null;
        if (next === null) {
          await refresh();
          return;
        }
        if (useVaultStore.getState().vaultPath !== vaultPath) return;
        const version = await saveNote(vaultPath, task.sourcePath, next, task.version);
        cache.delete(keyOf(vaultPath, task.sourcePath));
        if (useVaultStore.getState().vaultPath !== vaultPath) return;
        setRead((prev) =>
          prev.vault !== vaultPath
            ? prev
            : {
                ...prev,
                tasks: prev.tasks.map((row) =>
                  row.sourcePath === task.sourcePath
                    ? { ...row, version, done: row.line === task.line ? done : row.done }
                    : row,
                ),
              },
        );
        await useVaultStore.getState().rescan();
      } catch (error) {
        if (isStaleContent(error)) {
          await refresh().catch(() => {});
          return;
        }
        if (useVaultStore.getState().vaultPath === vaultPath)
          useUiStore.getState().toast("Couldn't update task");
      }
    },
    [vaultPath],
  );
  const current = read.vault === vaultPath && (entriesVault === null || entriesVault === vaultPath);
  return {
    tasks: current ? read.tasks : [],
    unreadable: current ? read.unreadable : [],
    loading: !current || read.loading,
    toggle,
  };
}
