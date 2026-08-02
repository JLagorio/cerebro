/**
 * Reminders engine (M2.x): date chips carry an optional reminder offset
 * (`📅 2026-07-30 ((remind:1d))`). This module finds them in note bodies and
 * decides when each fires; useReminders wires the schedule to desktop
 * notifications plus in-app toasts.
 */

import { DATE_TOKEN_SOURCE, parseDateToken, remindAt } from './dates';

export interface Reminder {
  sourcePath: string;
  /** Index into body.split('\n') — where the date chip lives. */
  line: number;
  /** Line text with the date token stripped — the notification body. */
  context: string;
  /** Local 'YYYY-MM-DDTHH:MM' the reminder fires at. */
  at: string;
}

/** Stable identity — used to remember which reminders already fired. */
export const reminderKey = (r: Reminder): string => `${r.sourcePath}#${r.line}@${r.at}`;

const DATE_TOKEN = new RegExp(DATE_TOKEN_SOURCE, 'gu');
const WIKILINK_TOKEN = /@?\[\[([^\]|[]+)(?:\|([^\][]*))?\]\]/g;

/** Every reminder-bearing date token in a note body. Fenced code is skipped. */
export function collectReminders(sourcePath: string, body: string): Reminder[] {
  const out: Reminder[] = [];
  let inFence = false;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    DATE_TOKEN.lastIndex = 0;
    for (const m of line.matchAll(DATE_TOKEN)) {
      const value = parseDateToken(m[0]);
      if (value === null) continue;
      const at = remindAt(value);
      if (at === null) continue;
      const context = line
        .replace(DATE_TOKEN, '')
        .replace(/^\s*[-*+] \[( |x|X)\]\s*/, '')
        .replace(WIKILINK_TOKEN, (_, target: string, alias?: string) => alias ?? target)
        .replace(/\s+/g, ' ')
        .trim();
      out.push({ sourcePath, line: i, context, at });
    }
  }
  return out;
}

/**
 * Reminders that should fire now: due, not already fired, and no older than
 * `graceHours` (stale reminders from long-closed sessions stay silent).
 */
export function dueReminders(
  reminders: Reminder[],
  now: string,
  fired: ReadonlySet<string>,
  graceHours = 24,
): Reminder[] {
  const cutoff = new Date(now);
  cutoff.setHours(cutoff.getHours() - graceHours);
  const pad = (n: number) => String(n).padStart(2, '0');
  const cutoffIso = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(
    cutoff.getDate(),
  )}T${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}`;
  return reminders.filter((r) => r.at <= now && r.at >= cutoffIso && !fired.has(reminderKey(r)));
}
