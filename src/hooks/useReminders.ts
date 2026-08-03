import { useEffect, useRef } from 'react';
import { collectReminders, dueReminders, reminderKey, type Reminder } from '@/engine/reminders';
import type { Entry } from '@/engine/types';
import { readNote } from '@/lib/ipc';
import { isTemplate } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const CHECK_MS = 30_000;
const FIRED_KEY = 'cerebro.firedReminders';
const FIRED_CAP = 500;

// Body cache keyed by path, invalidated by modifiedAt (same discipline as
// useDocTasks) — the watcher's rescans keep reminders fresh without
// rereading unchanged files.
const cache = new Map<string, { modifiedAt: string; reminders: Reminder[] }>();

const isReminderSource = (e: Entry): boolean => !isTemplate(e);

function loadFired(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FIRED_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function storeFired(fired: Set<string>): void {
  try {
    window.localStorage.setItem(FIRED_KEY, JSON.stringify([...fired].slice(-FIRED_CAP)));
  } catch {
    // Storage unavailable: fired-state is session-only.
  }
}

function localNowIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Best-effort desktop notification; in-app toast always fires alongside. */
function notifyDesktop(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body });
      });
    }
  } catch {
    // Webview without Notification support: the toast already covers it.
  }
}

/**
 * Reminders host (M2.x): scans note bodies for reminder-bearing date chips
 * and fires each one once — as a desktop notification plus an in-app toast.
 * Fired reminders persist in localStorage so restarts don't re-ping.
 */
export function useReminders(): void {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const reminders = useRef<Reminder[]>([]);

  // Recollect when the vault changes (bodies read lazily, cached).
  useEffect(() => {
    if (vaultPath === null) return;
    let cancelled = false;
    const sources = entries.filter(isReminderSource);
    void (async () => {
      const results = await Promise.all(
        sources.map(async (e) => {
          const hit = cache.get(e.path);
          if (hit !== undefined && hit.modifiedAt === e.modifiedAt) return hit.reminders;
          try {
            const body = await readNote(vaultPath, e.path);
            const collected = collectReminders(e.path, body);
            cache.set(e.path, { modifiedAt: e.modifiedAt, reminders: collected });
            return collected;
          } catch {
            return [];
          }
        }),
      );
      if (!cancelled) reminders.current = results.flat();
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, vaultPath]);

  // The clock: check every 30s (and immediately on mount).
  useEffect(() => {
    if (vaultPath === null) return;
    const check = () => {
      const fired = loadFired();
      const due = dueReminders(reminders.current, localNowIso(), fired);
      if (due.length === 0) return;
      for (const r of due) {
        const text = r.context === '' ? 'Scheduled reminder' : r.context;
        useUiStore.getState().toast(`⏰ Reminder: ${text}`);
        notifyDesktop('Cerebro reminder', text);
        fired.add(reminderKey(r));
      }
      storeFired(fired);
    };
    check();
    const timer = window.setInterval(check, CHECK_MS);
    return () => window.clearInterval(timer);
  }, [vaultPath]);
}

export function RemindersHost(): null {
  useReminders();
  return null;
}
