import { useEffect } from 'react';
import {
  announcements,
  bannerFor,
  type ReminderAnnouncement,
  carriedRenames,
  collectReminders,
  legacyImports,
  planReminders,
  propertyReminders,
  reminderClaimFor,
  reminderId,
  toLocalWindow,
  type Reminder,
} from '@/engine/reminders';
import { fireId, type ReminderClaim } from '@/engine/reminderState';
import { workState } from '@/engine/myWork';
import { buildSchema } from '@/engine/schema';
import { localStamp } from '@/engine/whenText';
import {
  pageAttribution,
  postNotification,
  readNote,
  reminderClaim,
  reminderImport,
  reminderState,
} from '@/lib/ipc';
import { isKnowledgePath } from '@/engine/okf';
import { sha256Hex } from '@/lib/sha256';
import { isTemplate } from '@/lib/templates';
import { useReminderStore } from '@/stores/reminderStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const CHECK_MS = 30_000;
const WARNING = 'Reminder history could not be read, so a reminder may fire again after a restart.';
// A file with the same path and mtime in another vault is still a different file.
const cache = new Map<string, { modifiedAt: string; reminders: Reminder[] }>();
const previousPaths = new Map<string, Set<string>>();
const imported = new Set<string>();
const warned = new Set<string>();
const fallback = new Map<string, Set<string>>();
// One claim sequence per vault across effect replacement and StrictMode remounts.
const checking = new Set<string>();
const deferredChecks = new Map<string, () => Promise<void>>();
// A save can replace the entries snapshot while its claim is in flight.
// Carry the fresh claim into the next snapshot so it is announced once if
// that reminder still exists, instead of silently consuming its identity.
const pendingNotices = new Map<string, Map<string, { row: Reminder; kind: 'missed' | 'fired' }>>();
function legacyKeys(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('cerebro.firedReminders') ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
function warn(vault: string): void {
  if (!warned.has(vault)) {
    warned.add(vault);
    useUiStore.getState().toast(WARNING);
  }
}
/** Claim before announcing. Only the database's fresh result owns the notice. */
export function useReminders(): void {
  const entries = useVaultStore((s) => s.entries);
  const vault = useVaultStore((s) => s.vaultPath);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  useEffect(() => {
    const previousVault = useReminderStore.getState().vault;
    if (previousVault !== vault) {
      if (previousVault) {
        pendingNotices.delete(previousVault);
        deferredChecks.delete(previousVault);
      }
      useReminderStore.getState().reset(vault);
    }
    if (!vault || entriesVault !== vault) return;
    const schema = buildSchema(entries);
    let active = true,
      ready = false;
    let reminders: Reminder[] = [];
    let moved: ReminderClaim[] = [];
    const current = () => active && useVaultStore.getState().vaultPath === vault;
    const check = async () => {
      if (!current() || !ready) return;
      if (checking.has(vault)) {
        deferredChecks.set(vault, check);
        return;
      }
      checking.add(vault);
      try {
        const state = useReminderStore.getState();
        const now = localStamp(new Date()).replace(' ', 'T');
        let session = fallback.get(vault);
        if (!session) {
          session = new Set();
          fallback.set(vault, session);
        }
        const claimed = new Set([...Object.keys(state.fires), ...session, ...moved.map(fireId)]);
        const window = toLocalWindow(state.window);
        const plan = planReminders({ reminders, now, claimed, window });
        const notices = pendingNotices.get(vault) ?? new Map();
        pendingNotices.set(vault, notices);
        const publish = () => {
          if (!current()) return;
          const live = new Map(reminders.map((r) => [reminderId(r), r]));
          const groups = (['missed', 'fired'] as const).map((kind) => ({
            kind,
            rows: [...notices].flatMap(([id, notice]) => {
              const row = live.get(id);
              return notice.kind === kind && row ? [row] : [];
            }),
          }));
          // The in-app notice is independent of attribution or native delivery.
          for (const { kind, rows } of groups)
            for (const text of announcements(rows, kind, now, window?.cause))
              useUiStore.getState().toast(text);
          notices.clear();
          void (async () => {
            const writers = new Map<string, Promise<boolean>>();
            const mine = (row: Reminder): Promise<boolean> => {
              if (isKnowledgePath(row.sourcePath)) return Promise.resolve(false);
              if (row.line === -1) return Promise.resolve(true); // Human-only Type setting.
              let value = writers.get(row.sourcePath);
              if (!value) {
                value = pageAttribution(vault, row.sourcePath)
                  .then((a) => a.state === 'recorded' && a.actor === 'human:me')
                  .catch(() => false);
                writers.set(row.sourcePath, value);
              }
              return value;
            };
            const native: ReminderAnnouncement[] = [];
            const ids: string[] = [];
            for (const { kind, rows } of groups) {
              const allowed = await Promise.all(rows.map(mine));
              const own = rows.filter((_, i) => allowed[i]);
              ids.push(...own.map(reminderId));
              for (const body of announcements(own, kind, now, window?.cause))
                native.push({
                  title: own.length === 1 ? 'Reminder' : `${own.length} reminders`,
                  body,
                  count: own.length,
                });
            }
            const banner = bannerFor(native);
            if (!banner || !current()) return;
            const id = sha256Hex('cerebro-notification-v1\0' + ids.join('\0'));
            await postNotification(id, banner.title, banner.body);
          })().catch(() => undefined); // The toast already owns delivery failure.
        };
        for (const [kind, rows] of [
          ['missed', plan.missed],
          ['fired', plan.due],
        ] as const) {
          const fresh: Reminder[] = [];
          for (let i = 0; i < rows.length; i += 500) {
            const batch = rows.slice(i, i + 500);
            try {
              if (state.status === 'error') throw new Error('history unavailable');
              const results = await reminderClaim(
                vault,
                batch.map((r) => reminderClaimFor(r, kind)),
              );
              useReminderStore.getState().addFires(
                vault,
                results.map((r) => r.fire),
              );
              for (const result of results)
                if (result.fresh) {
                  session.add(fireId(result.fire));
                  const r = batch.find((r) => reminderId(r) === fireId(result.fire));
                  if (r) fresh.push(r);
                }
            } catch {
              if (current()) warn(vault);
              // Q17: one per session even when durable history cannot be read.
              for (const r of batch)
                if (!session.has(reminderId(r))) {
                  session.add(reminderId(r));
                  fresh.push(r);
                }
            }
          }
          for (const row of fresh) notices.set(reminderId(row), { row, kind });
        }
        if (moved.length) {
          try {
            for (let i = 0; i < moved.length; i += 500) {
              const results = await reminderClaim(vault, moved.slice(i, i + 500));
              useReminderStore.getState().addFires(
                vault,
                results.map((r) => r.fire),
              );
              results.forEach((r) => session.add(fireId(r.fire)));
            }
          } catch {
            if (current()) warn(vault);
            moved.forEach((r) => session.add(fireId(r)));
          }
          moved = [];
        }
        publish();
      } finally {
        checking.delete(vault);
        const deferred = deferredChecks.get(vault);
        deferredChecks.delete(vault);
        if (deferred) void deferred();
      }
    };
    void (async () => {
      const results = await Promise.all(
        entries
          .filter((e) => !isTemplate(e) && workState(e, schema) !== 'finished')
          .map(async (e) => {
            const key = JSON.stringify([vault, e.path]),
              hit = cache.get(key);
            if (hit?.modifiedAt === e.modifiedAt) return hit.reminders;
            try {
              const body = await readNote(vault, e.path),
                rows = collectReminders(e.path, body);
              cache.set(key, { modifiedAt: e.modifiedAt, reminders: rows });
              return rows;
            } catch {
              return [];
            }
          }),
      );
      if (!current()) return;
      reminders = [...results.flat(), ...propertyReminders(entries, schema)];
      await useReminderStore.getState().hydrate(vault);
      if (!current()) return;
      let state = useReminderStore.getState();
      if (state.status === 'error') warn(vault);
      if (state.status === 'ready' && !Object.keys(state.fires).length && !imported.has(vault)) {
        try {
          const rows = legacyImports(
            legacyKeys(),
            reminders,
            localStamp(new Date()).replace(' ', 'T'),
          );
          await reminderImport(vault, rows);
          if (rows.length) {
            const result = await reminderState(vault);
            useReminderStore.getState().addFires(vault, result.fires);
          }
          imported.add(vault);
        } catch {
          if (current()) warn(vault);
        }
      }
      if (!current()) return;
      state = useReminderStore.getState();
      const paths = new Set(entries.map((e) => e.path));
      moved = carriedRenames(
        Object.values(state.fires),
        reminders,
        previousPaths.get(vault) ?? paths,
        paths,
      );
      previousPaths.set(vault, paths);
      useReminderStore.getState().setReminders(vault, reminders);
      ready = true;
      void check();
    })();
    const timer = window.setInterval(() => void check(), CHECK_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [entries, vault, entriesVault]);
}
export function RemindersHost(): null {
  useReminders();
  return null;
}
