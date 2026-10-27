import { useCallback, useEffect, useState } from 'react';
import { parseTasks, toggleTaskLine, type DocTask } from '@/engine/tasks';
import { isTaskRecord } from '@/engine/typeCatalog';
import type { Entry, Schema } from '@/engine/types';
import { splitFrontmatter } from '@/engine/frontmatter';
import { isStaleContent } from '@/engine/staleContent';
import { LEAVE_BLOCKED, saveBeforeAction } from '@/app/leaveGuard';
import { announceExternalWrites, heldOpenPages } from '@/editor/openPages';
import { subscribeRecovery } from '@/editor/deletedDraftRecovery';
import type { DocumentOwner } from '@/editor/documentOwner';
import { recoveryOutcomeText } from '@/editor/RecoverySaveStatus';
import {
  flushAnnouncedTask,
  retireRefusedTask,
  selectedTaskOwner,
  selectedTaskOwners,
  selectedTaskRefusalMessage,
} from '@/editor/selectedTaskOwner';
import { sameSelectedObservation, selectedSnapshotFor } from '@/editor/selectedSnapshot';
import type { SelectedEditorSnapshot } from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';
import { readEditorBody, readNoteSource, saveNote, supportsSelectedEditor } from '@/lib/ipc';
import { isTemplate } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { acceptSelectedEditorVersion, useSchema, useVaultStore } from '@/stores/vaultStore';
import { useVaultActionGuard } from './useVaultActionGuard';

const isTaskSource = (e: Entry, schema: Schema): boolean =>
  e.path.endsWith('.md') && e.type !== 'Type' && !isTemplate(e) && !isTaskRecord(e, schema);
// The same path in another vault never borrows its task body.
const cache = new Map<string, { version: string; tasks: DocTask[] }>();
const keyOf = (vault: string, path: string) => JSON.stringify([vault, path]);
const selectedSources = new WeakMap<DocTask, SelectedEditorSnapshot>();
function selectedRows(path: string, source: SelectedEditorSnapshot): DocTask[] {
  const snapshot = structuredClone(source);
  const rows = parseTasks(path, snapshot.body, snapshot.observedBodyHash);
  for (const row of rows) selectedSources.set(row, snapshot);
  return rows;
}
async function selectedRead(vault: string, entry: Entry): Promise<SelectedEditorSnapshot> {
  const version = entry.authority;
  if (version === undefined || !supportsSelectedEditor())
    throw new Error('selected_task_read_unavailable');
  const target = { workspaceId: version.workspaceId, recordId: version.recordId };
  const snapshot = await readEditorBody(vault, entry.path, target);
  if (!selectedSnapshotFor(snapshot, entry.path, target))
    throw new Error('selected_task_snapshot_changed');
  const difference = BigInt(snapshot.version.metadataRevision) - BigInt(version.metadataRevision);
  if (
    difference < 0n ||
    (difference === 0n &&
      (snapshot.version.metadataHash !== version.metadataHash ||
        snapshot.version.bodyHash !== version.bodyHash))
  )
    throw new Error('selected_task_snapshot_superseded');
  return snapshot;
}
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
  recovering: DocumentOwner[];
  toggleUnavailable: (task: DocTask) => string | undefined;
} {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const startAction = useVaultActionGuard(vaultPath ?? '');
  const schema = useSchema();
  const [, updateOwners] = useState(0);
  useEffect(() => subscribeRecovery(() => updateOwners((value) => value + 1)), []);
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
        Array.from(
          {
            length: Math.min(
              sources.some((entry) => entry.authority !== undefined) ? 1 : 8,
              sources.length,
            ),
          },
          async () => {
            while (live && cursor < sources.length) {
              const index = cursor++,
                entry = sources[index],
                key = keyOf(vaultPath, entry.path);
              const hit = cache.get(key);
              try {
                let tasks: DocTask[];
                if (entry.authority !== undefined) {
                  // Always read canonical selected metadata/observation. A body
                  // hash cache cannot hide independent metadata-only changes.
                  tasks = selectedRows(entry.path, await selectedRead(vaultPath, entry));
                } else if (entry.hash !== null && hit?.version === entry.hash) tasks = hit.tasks;
                else {
                  const source = await readNoteSource(vaultPath, entry.path);
                  tasks = parseTasks(
                    entry.path,
                    splitFrontmatter(source.content).body,
                    source.hash,
                  );
                  if (live) cache.set(key, { version: source.hash, tasks });
                }
                results[index] = { tasks, unreadable: [] };
              } catch {
                results[index] = { tasks: [], unreadable: [entry.path] };
              }
            }
          },
        ),
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
      const current = startAction();
      if (!(await saveBeforeAction('all', 'block', current)) || !current()) return;
      // A new buffer can arrive while the flush resolves. Hold this path
      // synchronously before the fresh read, through the write and rescan.
      if (heldOpenPages().includes(task.sourcePath)) {
        useUiStore.getState().toast(LEAVE_BLOCKED);
        return;
      }
      const refresh = async (message?: string) => {
        cache.delete(keyOf(vaultPath, task.sourcePath));
        if (!current()) return;
        useUiStore
          .getState()
          .toast(
            message ??
              `“${task.text}” changed since this list was read, so the tick wasn't saved. The list is refreshed — tick it again.`,
          );
        await useVaultStore.getState().rescan();
      };
      await announceExternalWrites([task.sourcePath], async () => {
        // This announcement deliberately absorbs rejected callbacks. Classify
        // failures here so a refused write cannot disappear into that seam.
        const selected = selectedSources.get(task);
        const entryState = useVaultStore.getState();
        const entry =
          entryState.entriesVault === vaultPath
            ? entryState.entries.find((entry) => entry.path === task.sourcePath)
            : undefined;
        if (selected !== undefined || entry?.authority !== undefined) {
          try {
            if (
              selected === undefined ||
              entry?.authority === undefined ||
              entry.authority.workspaceId !== selected.target.workspaceId ||
              entry.authority.recordId !== selected.target.recordId
            ) {
              await refresh();
              return;
            }
            const fresh = await selectedRead(vaultPath, entry);
            if (!current()) return;
            if (!sameSelectedObservation(selected, fresh)) {
              await refresh();
              return;
            }
            if (!fresh.editable || fresh.coherence !== 'paired') {
              useUiStore
                .getState()
                .toast(
                  fresh.readOnlyReason ??
                    'Open this page to resolve its selected body before ticking tasks.',
                );
              return;
            }
            const row = parseTasks(task.sourcePath, fresh.body, fresh.observedBodyHash).find(
              (row) => row.line === task.line,
            );
            const next =
              row?.text === task.text ? toggleTaskLine(fresh.body, task.line, done) : null;
            if (next === null || !current()) {
              if (current()) await refresh();
              return;
            }
            const owner = selectedTaskOwner(vaultPath, fresh);
            if (!owner.expectSelectedVersion(fresh.version)) {
              useUiStore
                .getState()
                .toast(
                  'The earlier task save is still owned. Check that save before ticking again.',
                );
              return;
            }
            owner.edit(next, 'source');
            const outcome = await flushAnnouncedTask(owner);
            if (outcome.kind === 'failed') {
              // Definite pre-intent refusal: never leave a generated tick for
              // a later barrier to replay against another state.
              const message = selectedTaskRefusalMessage(owner, outcome.code);
              retireRefusedTask(owner);
              if (current()) await refresh(message);
              return;
            }
            if (
              outcome.kind !== 'acknowledged' ||
              (outcome.write.kind !== 'selected_applied' &&
                outcome.write.kind !== 'selected_unchanged')
            )
              return;
            const ack = outcome.write;
            if (!current()) return;
            if (ack.kind === 'selected_applied' && ack.recovery != null) {
              const message = recoveryOutcomeText(ack.recovery);
              if (message) useUiStore.getState().toast(message);
            }
            const version = ack.kind === 'selected_applied' ? ack.currentVersion : ack.version;
            if (ack.kind === 'selected_applied' && ack.reconcileRequired) {
              try {
                await useVaultStore.getState().rescan();
                if (current()) {
                  const observed = await selectedRead(vaultPath, entry);
                  if (current()) {
                    owner.finishReconcile();
                    setRead((prev) =>
                      prev.vault !== vaultPath
                        ? prev
                        : {
                            ...prev,
                            tasks: [
                              ...prev.tasks.filter((row) => row.sourcePath !== task.sourcePath),
                              ...selectedRows(task.sourcePath, observed),
                            ],
                          },
                    );
                  }
                }
              } catch {
                if (current())
                  useUiStore.getState().toast("Task saved, but the list couldn't refresh.");
              }
              return;
            }
            acceptSelectedEditorVersion(vaultPath, task.sourcePath, fresh.target, version);
            const accepted = {
              ...fresh,
              body: next,
              version,
              observedBodyHash: sha256Hex(next),
              coherence: 'paired' as const,
            };
            setRead((prev) =>
              prev.vault !== vaultPath
                ? prev
                : {
                    ...prev,
                    tasks: [
                      ...prev.tasks.filter((row) => row.sourcePath !== task.sourcePath),
                      ...selectedRows(task.sourcePath, accepted),
                    ],
                  },
            );
            try {
              await useVaultStore.getState().rescan();
            } catch {
              if (current())
                useUiStore.getState().toast("Task saved, but the list couldn't refresh.");
            }
          } catch {
            if (current()) useUiStore.getState().toast("Couldn't update task");
          }
          return;
        }
        let acknowledged = false;
        try {
          const source = await readNoteSource(vaultPath, task.sourcePath);
          if (!current()) return;
          if (task.version === null || source.hash !== task.version) {
            await refresh();
            return;
          }
          const body = splitFrontmatter(source.content).body;
          const currentTask = parseTasks(task.sourcePath, body, source.hash).find(
            (row) => row.line === task.line,
          );
          const next =
            currentTask?.text === task.text ? toggleTaskLine(body, task.line, done) : null;
          if (next === null) {
            await refresh();
            return;
          }
          if (!current()) return;
          const version = await saveNote(vaultPath, task.sourcePath, next, task.version);
          acknowledged = true;
          cache.delete(keyOf(vaultPath, task.sourcePath));
          if (!current()) return;
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
          if (!current()) return;
          if (acknowledged) {
            useUiStore.getState().toast("Task saved, but the list couldn't refresh.");
            return;
          }
          if (isStaleContent(error)) {
            await refresh().catch(() => {});
            return;
          }
          useUiStore.getState().toast("Couldn't update task");
        }
      });
    },
    [vaultPath, startAction],
  );
  const current = read.vault === vaultPath && (entriesVault === null || entriesVault === vaultPath);
  const recovering = selectedTaskOwners(vaultPath ?? '');
  const toggleUnavailable = (task: DocTask): string | undefined => {
    const snapshot = selectedSources.get(task);
    if (snapshot === undefined) return undefined;
    if (!snapshot.editable || snapshot.coherence !== 'paired')
      return (
        snapshot.readOnlyReason ??
        'Open this page to resolve its selected body before ticking tasks.'
      );
    if (recovering.some((owner) => owner.key.path === task.sourcePath))
      return 'Check the earlier task save before ticking again.';
    return undefined;
  };
  return {
    recovering,
    toggleUnavailable,
    tasks: current ? read.tasks : [],
    unreadable: current ? read.unreadable : [],
    loading: !current || read.loading,
    toggle,
  };
}
