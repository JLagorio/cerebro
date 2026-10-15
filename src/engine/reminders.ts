/**
 * Reminders engine (M2.x): date chips carry an optional reminder offset
 * (`📅 2026-07-30 ((remind:1d))`), and declared date fields can remind every
 * record of their type. One identity and schedule cover both sources.
 */

import { sha256Hex } from '@/lib/sha256';
import { isTemplate } from '@/lib/templates';
import { workState } from './myWork';
import { humanize } from './schema';
import type { Entry, Schema } from './types';
import { lateBy, localStamp } from './whenText';
import { fireId, type ReminderClaim, type ReminderFire, type SessionWindow } from './reminderState';
import { DATE_TOKEN_SOURCE, parseDateProperty, parseDateToken, remindAt } from './dates';

export interface Reminder {
  sourcePath: string;
  chip: string;
  ordinal: number;
  /** Index into body.split('\n'), or -1 for a declared date field. */
  line: number;
  /** Line text with the date token stripped — the notification body. */
  context: string;
  /** Local 'YYYY-MM-DDTHH:MM' the reminder fires at. */
  at: string;
}

/** A chip's token is its identity; surrounding prose and line numbers are not. */
export const reminderChip = (token: string): string =>
  sha256Hex('cerebro-reminder-chip-v1\0' + token.trim()).slice(0, 16);
export const reminderId = (r: Reminder): string =>
  fireId({
    path: r.sourcePath,
    chip: r.chip,
    ordinal: r.ordinal,
    fireAt: r.at,
  });
export const reminderClaimFor = (
  r: Reminder,
  outcome: ReminderClaim['outcome'],
): ReminderClaim => ({
  path: r.sourcePath,
  chip: r.chip,
  ordinal: r.ordinal,
  fireAt: r.at,
  outcome,
});

const DATE_TOKEN = new RegExp(DATE_TOKEN_SOURCE, 'gu');
const WIKILINK_TOKEN = /@?\[\[([^\]|[]+)(?:\|([^\][]*))?\]\]/g;

/** Every reminder-bearing date token in a note body. Fenced code and checked
 * tasks are quiet; checked tokens still count toward stable duplicate ordinals. */
export function collectReminders(sourcePath: string, body: string): Reminder[] {
  const out: Reminder[] = [];
  let inFence = false;
  const ordinals = new Map<string, number>();
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const checked = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]\s/.test(line);
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
      const chip = reminderChip(m[0]);
      const ordinal = ordinals.get(chip) ?? 0;
      ordinals.set(chip, ordinal + 1);
      if (checked) continue;
      out.push({ sourcePath, chip, ordinal, line: i, context, at });
    }
  }
  return out;
}

/** A Type doc's setting supplies the offset, without reading any page body.
 * Ranges remind before their start even when they are the type's deadline. */
export function propertyReminders(entries: readonly Entry[], schema: Schema): Reminder[] {
  const out: Reminder[] = [];
  for (const entry of entries) {
    if (entry.parseError !== null || isTemplate(entry) || workState(entry, schema) === 'finished') {
      continue;
    }
    const type = entry.type === null ? undefined : schema.types.get(entry.type);
    for (const field of type?.fields ?? []) {
      if (field.remind === undefined || (field.kind !== 'date' && field.kind !== 'daterange'))
        continue;
      const value = parseDateProperty(schema.fieldValue(entry, field.name));
      if (value === null) continue;
      const at = remindAt({ ...value, remind: field.remind });
      if (at === null) continue;
      out.push({
        sourcePath: entry.path,
        chip: reminderChip(`field:${field.name}`),
        ordinal: 0,
        line: -1,
        context: `${entry.title} · ${humanize(field.name)}`,
        at,
      });
    }
  }
  return out;
}

export interface LocalSessionWindow extends Omit<SessionWindow, 'closedAt' | 'reopenedAt'> {
  closedAt: string;
  reopenedAt: string;
}
/** Convert UTC observations to the local floating-minute schedule. A partial
 * minute rounds forward, so a chip at :00 never falls after a :30 close. */
export function toLocalWindow(window: SessionWindow | null): LocalSessionWindow | null {
  if (!window) return null;
  const minute = (iso: string): string | null => {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return null;
    if (date.getSeconds() || date.getMilliseconds()) date.setMinutes(date.getMinutes() + 1, 0, 0);
    return localStamp(date).replace(' ', 'T');
  };
  const closedAt = minute(window.closedAt),
    reopenedAt = minute(window.reopenedAt);
  return closedAt && reopenedAt && closedAt <= reopenedAt
    ? { ...window, closedAt, reopenedAt }
    : null;
}
export function planReminders({
  reminders,
  now,
  claimed,
  window,
  graceHours = 24,
}: {
  reminders: readonly Reminder[];
  now: string;
  claimed: ReadonlySet<string>;
  window: LocalSessionWindow | null;
  graceHours?: number;
}): { missed: Reminder[]; due: Reminder[] } {
  const cutoff = new Date(now);
  cutoff.setHours(cutoff.getHours() - graceHours);
  const grace = localStamp(cutoff).replace(' ', 'T');
  const start = window && window.reopenedAt > grace ? window.reopenedAt : grace;
  const missed: Reminder[] = [],
    due: Reminder[] = [];
  for (const r of reminders) {
    if (claimed.has(reminderId(r)) || r.at > now) continue;
    if (window && r.at >= window.closedAt && r.at < window.reopenedAt) missed.push(r);
    else if (r.at >= start) due.push(r);
  }
  return { missed, due };
}
/** Only an exact, unambiguous old line identity may become a durable claim. */
export function legacyImports(
  keys: readonly string[],
  reminders: readonly Reminder[],
  now: string,
): ReminderClaim[] {
  const out: ReminderClaim[] = [];
  for (const key of new Set(keys)) {
    const matches = reminders.filter(
      (r) => `${r.sourcePath}#${r.line}@${r.at}` === key && r.at <= now,
    );
    if (matches.length === 1) out.push(reminderClaimFor(matches[0], 'fired'));
  }
  return out;
}
/** A vanished page can carry a claim only to one newly appeared page. */
export function carriedRenames(
  fires: readonly ReminderFire[],
  reminders: readonly Reminder[],
  previousPaths: ReadonlySet<string>,
  currentPaths: ReadonlySet<string>,
): ReminderClaim[] {
  const out: ReminderClaim[] = [];
  const same = (r: Reminder, f: ReminderFire) =>
    r.chip === f.chip && r.ordinal === f.ordinal && r.at === f.fireAt;
  for (const f of fires) {
    if (currentPaths.has(f.path)) continue;
    const matches = reminders.filter((r) => !previousPaths.has(r.sourcePath) && same(r, f));
    const origins = fires.filter(
      (other) =>
        !currentPaths.has(other.path) &&
        other.chip === f.chip &&
        other.ordinal === f.ordinal &&
        other.fireAt === f.fireAt,
    );
    if (matches.length === 1 && origins.length === 1)
      out.push(reminderClaimFor(matches[0], 'moved'));
  }
  return out;
}
export function announcements(
  reminders: readonly Reminder[],
  kind: 'fired' | 'missed',
  now: string,
  cause: 'app' | 'vault' = 'app',
): string[] {
  if (!reminders.length) return [];
  const texts = reminders.map((r) => r.context.trim() || 'Scheduled reminder');
  const summary =
    texts.slice(0, 3).join(' · ') + (texts.length > 3 ? ` · and ${texts.length - 3} more` : '');
  if (kind === 'missed') {
    const closed = cause === 'vault' ? 'while this vault was closed' : 'while Cerebro was closed';
    return [
      reminders.length === 1
        ? `⏰ A reminder passed ${closed}: ${summary}`
        : `⏰ ${reminders.length} reminders passed ${closed}: ${summary}`,
    ];
  }
  if (reminders.length > 1) return [`⏰ ${reminders.length} reminders: ${summary}`];
  const late = lateBy(reminders[0].at, now);
  return [late ? `⏰ Reminder (${late} late): ${summary}` : `⏰ Reminder: ${summary}`];
}

export interface ReminderAnnouncement {
  title: string;
  body: string;
  count: number;
}
/** One native banner per tick, with Unicode character caps rather than bytes. */
export function bannerFor(
  items: readonly ReminderAnnouncement[],
): { title: string; body: string } | null {
  if (!items.length) return null;
  return {
    title: [
      ...(items.length === 1
        ? items[0].title
        : `${items.reduce((n, a) => n + a.count, 0)} reminders`),
    ]
      .slice(0, 120)
      .join(''),
    body: [...items.map((a) => a.body).join(' · ')].slice(0, 400).join(''),
  };
}
