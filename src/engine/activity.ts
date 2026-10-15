import { writerWords, type PageAttribution } from './attribution';
import { pageOfSidecar } from './comments';
import type { FileCommit, PulseCommit } from './git';
import type { Entry } from './types';

/**
 * History's fold (M64.2): raw activity rows into sessions, days and a feed.
 *
 * Rust's `runtime::activity` reads three lanes raw — the vault's write rows,
 * its runs, and when Cerebro had it open — and the mock backend serves the
 * same shape. This module is the one fold over them, so the two backends can
 * never disagree about what a session is. Pure: no DOM, no IPC, no clock it
 * was not handed.
 *
 * **Absent is never zero (CV-05).** A day reads "recorded" only from the day
 * the vault's first write was recorded, and only when Cerebro was open or a
 * write or a run touched it. Any other day is "not recorded", never 0 edits,
 * and a day older than what a capped lane could return is "not read".
 *
 * Days are LOCAL: a key is the reader's calendar date, read from local date
 * parts, and arithmetic on keys ignores the zone, so a DST change never
 * moves a day.
 */

/** How long a quiet stretch ends a session: M58.1's `COALESCE_WINDOW` in
 * `src-tauri/src/runtime/vault_writes.rs`, one rule held by a tripwire. */
export const SESSION_GAP_MS = 5 * 60_000;

/** The kinds that change a page: `write_log::CONTENT_KINDS`, pinned to it by
 * a tripwire. The mock sets `content` from this list, as Rust does. */
export const CONTENT_KINDS: readonly string[] = ['vault.write', 'vault.create', 'vault.rename'];

/** How many days the heatmap and the feed cover, today included. */
export const ACTIVITY_DAYS = 371;

// --- The wire (runtime::activity) --------------------------------------------

/** One `vault_writes` row (`activity::ActivityWrite`). `at` is when it, or
 * the last write of its burst, landed. `actor: null` is not recorded. */
export interface ActivityWrite {
  kind: string;
  content: boolean;
  path: string;
  to: string | null;
  actor: string | null;
  run_id: string | null;
  approved_by: string | null;
  first_at: string;
  at: string;
}

/** What the fold needs of a run; the adapter instantiates it with Fleet's
 * run. `writes_booked`: 1 all booked, 2 booked but the shell may have
 * written elsewhere, anything else not recorded. */
export interface ActivityRunCore {
  run_id: string;
  actor: string | null;
  mode: string;
  started_at: string;
  ended_at: string | null;
  cli_session_id: string | null;
  writes_booked: number;
}

/** When Cerebro had the vault open (`activity::AppSessionSpan`). */
export interface AppSessionSpan {
  opened_at: string;
  until: string;
  precision: string;
}

/** One lane: what it read, or why it could not. */
export type ActivityLane<T> =
  { state: 'read'; rows: T[]; more: boolean } | { state: 'unavailable'; reason: string };

/** The vault's first recorded write. `at: null` is a vault with none. */
export type RecordingSince =
  { state: 'read'; at: string | null } | { state: 'unavailable'; reason: string };

/** Everything History reads for one vault and window (`activity::VaultActivity`). */
export interface VaultActivity<R extends ActivityRunCore = ActivityRunCore> {
  writes: ActivityLane<ActivityWrite>;
  runs: ActivityLane<R>;
  app_sessions: ActivityLane<AppSessionSpan>;
  recording_since: RecordingSince;
}

// --- Days ---------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const ms = (iso: string) => Date.parse(iso);

/** The local calendar day of an instant, `YYYY-MM-DD`. */
export function dayKeyOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function keyDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const keyOfUtc = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** `key` moved by `n` days, on the calendar alone. */
export function addDays(key: string, n: number): string {
  const d = keyDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return keyOfUtc(d);
}

/** 0 for Sunday … 6 for Saturday. */
export function weekdayOf(key: string): number {
  return keyDate(key).getUTCDay();
}

/** How many days `to` is after `from`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((keyDate(to).getTime() - keyDate(from).getTime()) / 86_400_000);
}

/** The window History reads at `now`: local midnight 370 days back to local
 * midnight tomorrow, so the year ends with today. */
export function activityWindow(now: number): {
  since: string;
  until: string;
  first: string;
  today: string;
} {
  const d = new Date(now);
  const since = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (ACTIVITY_DAYS - 1));
  const until = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    first: dayKeyOf(since.getTime()),
    today: dayKeyOf(now),
  };
}

/** Every day from `from` to `to`, both included, clipped to `[lo, hi]`. */
function eachDay(from: string, to: string, lo: string, hi: string, visit: (key: string) => void) {
  let day = from < lo ? lo : from;
  const last = to > hi ? hi : to;
  while (day <= last) {
    visit(day);
    day = addDays(day, 1);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon, Jul 27, 2026": a day in full. */
export function dayWords(key: string): string {
  const d = keyDate(key);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Jul 27", with the year when it is not `today`'s. */
function shortDay(key: string, today: string): string {
  const d = keyDate(key);
  const year = key.slice(0, 4) === today.slice(0, 4) ? '' : `, ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}`;
}

/** A day or a stretch of days, newest last: "Jul 25" or "Jul 21 – Jul 24". */
export function rangeWords(from: string, to: string, today: string): string {
  return from === to ? shortDay(from, today) : `${shortDay(from, today)} – ${shortDay(to, today)}`;
}

// --- Sessions -----------------------------------------------------------------

export type PageVerb = 'created' | 'edited' | 'renamed' | 'deleted' | 'commented';

/** One page a session touched. `from` only for a rename. */
export interface SessionPage {
  path: string;
  verb: PageVerb;
  from: string | null;
}

/** One stretch of writes by one actor in one run (or none), within a local
 * day, with no quiet gap of SESSION_GAP_MS or more. */
export interface ActivitySession {
  key: string;
  actor: string | null;
  run_id: string | null;
  day: string;
  first_at: string;
  at: string;
  /** Some row in it was allowed by a person. */
  approved: boolean;
  /** First-touch order. */
  pages: SessionPage[];
  rows: ActivityWrite[];
}

const VERB_OF: Record<string, PageVerb> = {
  'vault.create': 'created',
  'vault.write': 'edited',
  'vault.rename': 'renamed',
  'vault.delete': 'deleted',
  'vault.comment': 'commented',
};
/** Which verb says more about a page touched twice in one session. */
const WEIGHT: Record<PageVerb, number> = {
  commented: 0,
  edited: 1,
  renamed: 2,
  deleted: 3,
  created: 4,
};
const stronger = (a: PageVerb, b: PageVerb) => (WEIGHT[b] > WEIGHT[a] ? b : a);

function touch(pages: SessionPage[], row: ActivityWrite): void {
  const verb = VERB_OF[row.kind] ?? 'edited';
  if (verb === 'renamed' && row.to !== null) {
    const was = pages.find((p) => p.path === row.path);
    if (was !== undefined) {
      was.from = was.verb === 'created' ? null : (was.from ?? row.path);
      was.path = row.to;
      was.verb = stronger(was.verb, 'renamed');
      return;
    }
    pages.push({ path: row.to, verb, from: row.path });
    return;
  }
  // A comment counts on its page, never as an edit (D10).
  const path = verb === 'commented' ? (pageOfSidecar(row.path) ?? row.path) : row.path;
  const was = pages.find((p) => p.path === path);
  if (was === undefined) pages.push({ path, verb, from: null });
  else was.verb = stronger(was.verb, verb);
}

/** Fold write rows into sessions, oldest first. Rows are keyed by actor and
 * run; a gap of SESSION_GAP_MS or more from one row's end to the next one's
 * start, or a new local day, starts another session. */
export function sessionsOf(rows: ActivityWrite[]): ActivitySession[] {
  const sorted = [...rows].sort((a, b) => ms(a.first_at) - ms(b.first_at) || ms(a.at) - ms(b.at));
  const open = new Map<string, { session: ActivitySession; end: number }>();
  const out: ActivitySession[] = [];
  for (const row of sorted) {
    const key = JSON.stringify([row.actor, row.run_id]);
    const start = ms(row.first_at);
    const end = ms(row.at);
    const day = dayKeyOf(start);
    let current = open.get(key);
    if (
      current === undefined ||
      start - current.end >= SESSION_GAP_MS ||
      day !== current.session.day
    ) {
      current = {
        session: {
          key: `${key}@${row.first_at}`,
          actor: row.actor,
          run_id: row.run_id,
          day,
          first_at: row.first_at,
          at: row.at,
          approved: false,
          pages: [],
          rows: [],
        },
        end,
      };
      open.set(key, current);
      out.push(current.session);
    }
    if (end > current.end) {
      current.end = end;
      current.session.at = row.at;
    }
    current.session.approved ||= row.approved_by !== null;
    current.session.rows.push(row);
    touch(current.session.pages, row);
  }
  return out;
}

// --- Days and the heatmap -----------------------------------------------------

export type DayKind = 'recorded' | 'not-recorded' | 'not-read';

export interface DayState {
  state: DayKind;
  /** Editing sessions that began that day; null unless the day is recorded. */
  sessions: number | null;
  /** A not-recorded day before the vault's first recorded write. */
  beforeRecording: boolean;
}

const sinceAt = (since: RecordingSince): string | null =>
  since.state === 'read' ? since.at : null;

/** The day before which a capped lane could not read: the day of its oldest
 * row, when it stopped short. */
function readFloor<T>(lane: ActivityLane<T>, at: (row: T) => string): string | null {
  if (lane.state !== 'read' || !lane.more || lane.rows.length === 0) return null;
  let oldest = Infinity;
  for (const row of lane.rows) oldest = Math.min(oldest, ms(at(row)));
  return dayKeyOf(oldest);
}

/** Every day from `first` to `today`, read as recorded, not recorded or not
 * read, with its session count when recorded. */
export function dayStates<R extends ActivityRunCore>(
  activity: VaultActivity<R>,
  first: string,
  today: string,
): Map<string, DayState> {
  const touched = new Set<string>();
  const mark = (from: number, to: number) =>
    eachDay(dayKeyOf(from), dayKeyOf(Math.max(from, to)), first, today, (d) => touched.add(d));
  if (activity.app_sessions.state === 'read') {
    for (const span of activity.app_sessions.rows) mark(ms(span.opened_at), ms(span.until));
  }
  if (activity.writes.state === 'read') {
    for (const row of activity.writes.rows) mark(ms(row.first_at), ms(row.at));
  }
  if (activity.runs.state === 'read') {
    for (const run of activity.runs.rows) {
      const start = ms(run.started_at);
      mark(start, run.ended_at === null ? start : ms(run.ended_at));
    }
  }
  const sessions = new Map<string, number>();
  if (activity.writes.state === 'read') {
    for (const s of sessionsOf(activity.writes.rows)) {
      sessions.set(s.day, (sessions.get(s.day) ?? 0) + 1);
    }
  }
  const since = sinceAt(activity.recording_since);
  const recordingDay = since === null ? null : dayKeyOf(ms(since));
  const floors = [
    readFloor(activity.writes, (w) => w.at),
    readFloor(activity.runs, (r) => r.started_at),
    readFloor(activity.app_sessions, (s) => s.opened_at),
  ].filter((f): f is string => f !== null);
  const floor = floors.length === 0 ? null : floors.sort().at(-1)!;
  const out = new Map<string, DayState>();
  eachDay(first, today, first, today, (day) => {
    if (floor !== null && day < floor) {
      out.set(day, { state: 'not-read', sessions: null, beforeRecording: false });
    } else if (recordingDay !== null && day >= recordingDay && touched.has(day)) {
      out.set(day, { state: 'recorded', sessions: sessions.get(day) ?? 0, beforeRecording: false });
    } else {
      const before = recordingDay === null || day < recordingDay;
      out.set(day, { state: 'not-recorded', sessions: null, beforeRecording: before });
    }
  });
  return out;
}

export interface HeatCell {
  day: string;
  state: DayKind;
  sessions: number | null;
  beforeRecording: boolean;
  /** 0 for none, else 1–4 by sessions against the busiest day. */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface Heatmap {
  /** Sunday-first week columns; null pads before the first day and after today. */
  weeks: (HeatCell | null)[][];
  /** The week each month starts in, and its label. */
  months: { week: number; label: string }[];
  /** The stored first write, or null when none was ever recorded. */
  recordingSince: string | null;
}

/** The year as a grid, or null when a lane it needs could not be read: the
 * writes, when Cerebro was open, or when recording began. */
export function heatmapOf<R extends ActivityRunCore>(
  activity: VaultActivity<R>,
  today: string,
): Heatmap | null {
  if (
    activity.writes.state !== 'read' ||
    activity.app_sessions.state !== 'read' ||
    activity.recording_since.state !== 'read'
  ) {
    return null;
  }
  const first = addDays(today, -(ACTIVITY_DAYS - 1));
  const states = dayStates(activity, first, today);
  let max = 0;
  for (const s of states.values()) max = Math.max(max, s.sessions ?? 0);
  const cells: (HeatCell | null)[] = Array.from({ length: weekdayOf(first) }, () => null);
  for (const [day, s] of states) {
    const n = s.sessions ?? 0;
    const level = (n === 0 || max === 0 ? 0 : Math.ceil((n / max) * 4)) as HeatCell['level'];
    cells.push({
      day,
      state: s.state,
      sessions: s.sessions,
      beforeRecording: s.beforeRecording,
      level,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (HeatCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const months: Heatmap['months'] = [];
  weeks.forEach((week, index) => {
    const start = week.find((c) => c !== null && c.day.endsWith('-01'));
    if (start != null)
      months.push({ week: index, label: MONTHS[Number(start.day.slice(5, 7)) - 1] });
  });
  return { weeks, months, recordingSince: activity.recording_since.at };
}

/** One cell in words, for its label and hover. */
export function cellWords(cell: HeatCell): string {
  const day = dayWords(cell.day);
  switch (cell.state) {
    case 'not-read':
      return `${day} — not read`;
    case 'not-recorded':
      return cell.beforeRecording
        ? `${day} — not recorded: before Cerebro began recording edits`
        : `${day} — not recorded: Cerebro wasn't open`;
    case 'recorded': {
      const n = cell.sessions ?? 0;
      if (n === 0) return `${day} — no edits`;
      return `${day} — ${n} editing session${n === 1 ? '' : 's'}`;
    }
  }
}

// --- The feed -----------------------------------------------------------------

export type FeedItem<R extends ActivityRunCore> =
  | { kind: 'session'; key: string; at: number; session: ActivitySession; text: string }
  | {
      kind: 'run';
      key: string;
      at: number;
      /** The run whose cause the row names: the first of a folded day. */
      run: R;
      /** Every run the row stands for: one, or a conversation's turns. */
      runs: R[];
      sessions: ActivitySession[];
      who: string;
      wrote: string;
      approved: boolean;
    }
  | { kind: 'commit'; key: string; at: number; commit: PulseCommit };

export type GapState = 'empty' | 'not-recorded' | 'not-read';

export type FeedGroup<R extends ActivityRunCore> =
  | { kind: 'day'; day: string; items: FeedItem<R>[] }
  | { kind: 'gap'; state: GapState; from: string; to: string; text: string };

/** A page's name: its title when the vault lists it, else its file name. */
export function pageName(path: string, entries: Entry[]): string {
  const entry = entries.find((e) => e.path === path);
  if (entry !== undefined) return entry.title;
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/, '');
}

/** "A", "A and B", "A, B and N more". */
export function listWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** What a session did to its pages, verb by verb, in first-touch order. */
export function pagesWords(pages: SessionPage[], entries: Entry[]): string {
  const order: PageVerb[] = [];
  const by = new Map<PageVerb, SessionPage[]>();
  for (const page of pages) {
    if (!by.has(page.verb)) {
      by.set(page.verb, []);
      order.push(page.verb);
    }
    by.get(page.verb)!.push(page);
  }
  return order
    .map((verb) => {
      const group = by.get(verb)!;
      const names = listWords(group.map((p) => pageName(p.path, entries)));
      switch (verb) {
        case 'renamed':
          return group
            .map(
              (p) =>
                `renamed ${pageName(p.from ?? p.path, entries)} to ${pageName(p.path, entries)}`,
            )
            .join(', ');
        case 'commented':
          return `commented on ${names}`;
        default:
          return `${verb} ${names}`;
      }
    })
    .join(', ');
}

const ALLOWED = ' · you allowed it';

/** One session in words: "You edited How we schedule". A writer nobody
 * recorded is said so, never guessed. */
export function sessionText(session: ActivitySession, entries: Entry[]): string {
  const did = pagesWords(session.pages, entries);
  const allowed = session.approved ? ALLOWED : '';
  if (session.actor === null) {
    return `${did.charAt(0).toUpperCase()}${did.slice(1)} · who was not recorded${allowed}`;
  }
  return `${writerWords(session.actor, entries)} ${did}${allowed}`;
}

/** What a run wrote, as its booking lets it be said. */
function wroteWords(booked: number, names: string[]): string {
  const wrote = names.length === 0 ? null : `wrote ${listWords(names)}`;
  if (booked === 1) return wrote ?? 'wrote no pages';
  if (booked === 2) return `${wrote ?? 'wrote no pages'} · shell changes not recorded`;
  return wrote ?? 'pages written: not recorded';
}

/** A run row in words, given its why in Rust's words (`runWhyText`). */
export function runText<R extends ActivityRunCore>(
  item: Extract<FeedItem<R>, { kind: 'run' }>,
  why: string,
): string {
  const turns = item.runs.length > 1 ? ` · ${item.runs.length} turns` : '';
  return `${item.who} ran${turns} · ${why} · ${item.wrote}${item.approved ? ALLOWED : ''}`;
}

/** Can a gap be said at all? Only when every lane read: a day with nothing
 * in a lane that failed is a day nobody looked at. */
function allRead<R extends ActivityRunCore>(activity: VaultActivity<R> | null): boolean {
  return (
    activity !== null &&
    activity.writes.state === 'read' &&
    activity.runs.state === 'read' &&
    activity.app_sessions.state === 'read' &&
    activity.recording_since.state === 'read'
  );
}

function runItems<R extends ActivityRunCore>(
  runs: R[],
  sessions: ActivitySession[] | null,
  entries: Entry[],
): FeedItem<R>[] {
  // Attended turns of one conversation fold into one row a day.
  const groups = new Map<string, R[]>();
  for (const run of [...runs].sort((a, b) => ms(a.started_at) - ms(b.started_at))) {
    const day = dayKeyOf(ms(run.started_at));
    const key =
      run.mode === 'attended' && run.cli_session_id !== null
        ? `conversation:${run.cli_session_id}@${day}`
        : `run:${run.run_id}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const ids = new Set(group.map((r) => r.run_id));
    const absorbed = (sessions ?? []).filter((s) => s.run_id !== null && ids.has(s.run_id));
    const names: string[] = [];
    for (const s of absorbed) {
      for (const p of s.pages) {
        const name = pageName(p.path, entries);
        if (p.verb !== 'commented' && !names.includes(name)) names.push(name);
      }
    }
    const bookings = group.map((r) => r.writes_booked);
    const booked = bookings.every((b) => b === 1) ? 1 : bookings.some((b) => b === 2) ? 2 : 0;
    const first = group[0];
    const last = group[group.length - 1];
    return {
      kind: 'run' as const,
      key,
      at: ms(last.ended_at ?? last.started_at),
      run: first,
      runs: group,
      sessions: absorbed,
      who: first.actor === null ? 'A run that named no actor' : writerWords(first.actor, entries),
      // With the writes unread, what a run wrote is unknown, never "none".
      wrote: sessions === null ? 'pages written: could not be read' : wroteWords(booked, names),
      approved: absorbed.some((s) => s.approved),
    };
  });
}

/**
 * The feed, newest day first: sessions, runs (each absorbing the sessions of
 * its run) and commits, each on its local day. A commit is its own row,
 * never blended into a session, and still lands when activity could not be
 * read (`activity: null`). Gap lines cover stretches with nothing in them,
 * and appear only when every lane read.
 */
export function feedOf<R extends ActivityRunCore>(
  activity: VaultActivity<R> | null,
  commits: PulseCommit[] | null,
  today: string,
  entries: Entry[],
): FeedGroup<R>[] {
  const items: FeedItem<R>[] = [];
  const runs = activity !== null && activity.runs.state === 'read' ? activity.runs.rows : [];
  const sessions =
    activity !== null && activity.writes.state === 'read' ? sessionsOf(activity.writes.rows) : null;
  items.push(...runItems(runs, sessions, entries));
  const runIds = new Set(runs.map((r) => r.run_id));
  for (const session of sessions ?? []) {
    if (session.run_id !== null && runIds.has(session.run_id)) continue;
    items.push({
      kind: 'session',
      key: session.key,
      at: ms(session.at),
      session,
      text: sessionText(session, entries),
    });
  }
  for (const commit of commits ?? []) {
    items.push({ kind: 'commit', key: `commit:${commit.hash}`, at: commit.date * 1000, commit });
  }
  const byDay = new Map<string, FeedItem<R>[]>();
  for (const item of items) {
    const day =
      item.kind === 'run'
        ? dayKeyOf(ms(item.run.started_at))
        : item.kind === 'session'
          ? item.session.day
          : dayKeyOf(item.at);
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  for (const list of byDay.values()) list.sort((a, b) => b.at - a.at);

  const groups: FeedGroup<R>[] = [];
  if (activity !== null && allRead(activity)) {
    const first = addDays(today, -(ACTIVITY_DAYS - 1));
    const states = dayStates(activity, first, today);
    const open: { gap: Gap | null } = { gap: null };
    const close = () => {
      const gap = open.gap;
      if (gap === null) return;
      groups.push({
        kind: 'gap',
        state: gap.state,
        from: gap.from,
        to: gap.to,
        text: gapText(gap, today),
      });
      open.gap = null;
    };
    for (let day = today; day >= first; day = addDays(day, -1)) {
      const list = byDay.get(day);
      if (list !== undefined) {
        close();
        groups.push({ kind: 'day', day, items: list });
        byDay.delete(day);
        continue;
      }
      const s = states.get(day)!;
      const state: GapState =
        s.state === 'recorded' ? 'empty' : s.state === 'not-read' ? 'not-read' : 'not-recorded';
      const gap = open.gap;
      if (gap !== null && gap.state === state && gap.before === s.beforeRecording) {
        gap.from = day;
      } else {
        close();
        open.gap = { state, before: s.beforeRecording, from: day, to: day };
      }
    }
    close();
  }
  // Days outside the window (a commit from before it, or every day when no
  // gap can be said), newest first.
  for (const day of [...byDay.keys()].sort().reverse()) {
    groups.push({ kind: 'day', day, items: byDay.get(day)! });
  }
  return groups;
}

/** A stretch of days with nothing in them, oldest day `from`. */
interface Gap {
  state: GapState;
  before: boolean;
  from: string;
  to: string;
}

function gapText(gap: Gap, today: string): string {
  const range = rangeWords(gap.from, gap.to, today);
  switch (gap.state) {
    case 'empty':
      return `No edits or runs · ${range}`;
    case 'not-read':
      return `Not read · ${range} — past the most History reads at once`;
    case 'not-recorded':
      return gap.before
        ? `Not recorded · ${range} — before Cerebro began recording edits`
        : `Not recorded · ${range} — Cerebro wasn't open`;
  }
}

/** The groups down to the `days`th day that holds something, with the gap
 * lines between them; `more` when a day past that holds something too. */
export function revealed<R extends ActivityRunCore>(
  groups: FeedGroup<R>[],
  days: number,
): { groups: FeedGroup<R>[]; more: boolean } {
  const out: FeedGroup<R>[] = [];
  let seen = 0;
  for (const group of groups) {
    if (group.kind === 'day') {
      if (seen === days) return { groups: out, more: true };
      seen += 1;
    }
    out.push(group);
  }
  return { groups: out, more: false };
}

// --- A page's History (M64.2b) -------------------------------------------------
//
// One page's tab merges what Rust's `page_activity` read — the rows under the
// page's names and its comment sidecar, the runs that wrote it, and on a
// knowledge page the ledger's events — with its versions (M58.4's
// `FileCommit` rows). A commit stays its own row, never blended into a
// session (CV-35's reading stays CommitAuthor's).

/** One thing the ledger recorded about a concept (`knowledge::ConceptEvent`).
 * `at` and `actor` null are not recorded. */
export interface ConceptEvent {
  event_id: string;
  kind: 'created' | 'revised' | 'verified' | 'proposal';
  revision: number | null;
  state: string | null;
  actor: string | null;
  run_id: string | null;
  at: string | null;
}

/** A concept's ledger lane (`KnowledgeLane`): what it recorded, a vault that
 * keeps no ledger, or a read that failed. */
export type KnowledgeLane =
  | { state: 'read'; events: ConceptEvent[] }
  | { state: 'not_recorded' }
  | { state: 'unavailable'; reason: string };

/** What a page's History reads (`PageActivity`). `chain` is the page's
 * names, newest first; `knowledge` is null outside the bundle. */
export interface PageActivity<R extends ActivityRunCore = ActivityRunCore> {
  chain: string[];
  writes: ActivityLane<ActivityWrite>;
  runs: ActivityLane<R>;
  recording_since: RecordingSince;
  knowledge: KnowledgeLane | null;
}

export type PageEntry<R extends ActivityRunCore> =
  | { kind: 'session'; key: string; at: number; session: ActivitySession; text: string }
  | { kind: 'run'; key: string; at: number; run: R; sessions: ActivitySession[]; text: string }
  | { kind: 'concept'; key: string; at: number | null; event: ConceptEvent; text: string }
  | { kind: 'commit'; key: string; at: number; commit: FileCommit }
  | { kind: 'seam'; key: string; at: number; text: string };

export interface PageTimeline<R extends ActivityRunCore> {
  /** The top line when the page changed outside Cerebro, else null. */
  outside: string | null;
  /** Newest first; entries with no time last, in the order they came. */
  entries: PageEntry<R>[];
}

export const OUTSIDE_WORDS =
  'This page changed outside Cerebro after its last recorded edit, so who changed it is unattributed.';

const fileName = (path: string) => path.split('/').pop() ?? path;
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** What some rows did to this page, in words: "edited it", "wrote it" (an
 * agent's edit), "created it", "renamed it from old.md", "commented". A
 * comment never counts as an edit (D10); beside one it reads "and
 * commented". */
function pageDid(rows: ActivityWrite[], person: boolean, approved: boolean): string {
  let main: { verb: PageVerb; from: string | null } | null = null;
  let commented = false;
  for (const row of rows) {
    const verb = VERB_OF[row.kind] ?? 'edited';
    if (verb === 'commented') {
      commented = true;
      continue;
    }
    const from = verb === 'renamed' ? fileName(row.path) : null;
    if (main === null || WEIGHT[verb] > WEIGHT[main.verb]) main = { verb, from };
  }
  const words: Record<PageVerb, string> = {
    created: 'created it',
    edited: person ? 'edited it' : 'wrote it',
    renamed: `renamed it from ${main?.from ?? 'another name'}`,
    deleted: 'deleted it',
    commented: 'commented',
  };
  const did =
    main === null ? 'commented' : `${words[main.verb]}${commented ? ' and commented' : ''}`;
  return `${did}${approved ? ALLOWED : ''}`;
}

/** A session on this page in words: "You edited it". A writer nobody
 * recorded is said so, never guessed. */
function pageSessionWords(session: ActivitySession, entries: Entry[]): string {
  // "wrote it" names an agent's edit; a writer nobody recorded edited it.
  const person = session.actor === null || session.actor.startsWith('human:');
  const did = pageDid(session.rows, person, session.approved);
  if (session.actor === null) return `${capital(did)} · who was not recorded`;
  return `${writerWords(session.actor, entries)} ${did}`;
}

const STATE_WORDS: Record<string, string> = {
  submitted: 'submitted',
  queued: 'waiting on you',
  applied: 'applied',
  rejected: 'rejected',
  reverted: 'reverted',
};

/** One ledger event in words: "Created by Knowledge agent". */
export function conceptText(event: ConceptEvent, entries: Entry[]): string {
  const who = event.actor === null ? null : writerWords(event.actor, entries);
  const unknown = ' · who was not recorded';
  switch (event.kind) {
    case 'created':
      return who === null ? `Created${unknown}` : `Created by ${who}`;
    case 'revised': {
      const n = event.revision === null ? '' : ` · revision ${event.revision}`;
      return who === null ? `Revised${n}${unknown}` : `Revised by ${who}${n}`;
    }
    case 'verified':
      return who === null ? `Verified${unknown}` : `Verified by ${who}`;
    case 'proposal': {
      const state = STATE_WORDS[event.state ?? ''] ?? event.state ?? 'state not recorded';
      return `${who ?? 'Someone not recorded'} proposed a change · ${state}`;
    }
  }
}

/**
 * One page's History, newest first: its sessions ("You edited it", "<Agent>
 * wrote it"), the runs that wrote it (each absorbing its sessions), its
 * Knowledge events, its versions, and a seam where Cerebro began recording
 * edits after its oldest version. `outside` is said when the page changed
 * outside Cerebro (M58.1b reads Unattributed).
 *
 * On a knowledge page whose ledger lane read, the concept file's write and
 * create rows give way to the ledger's events, which say what they meant;
 * comments stay. A lane that failed (`activity` null, `commits` null) adds
 * nothing and is said by the surface, never read as empty.
 */
export function pageTimeline<R extends ActivityRunCore>({
  activity,
  commits,
  attribution,
  isKnowledge,
  entries,
}: {
  activity: PageActivity<R> | null;
  commits: FileCommit[] | null;
  attribution: PageAttribution | null;
  isKnowledge: boolean;
  entries: Entry[];
}): PageTimeline<R> {
  const out: PageEntry<R>[] = [];
  const ledger =
    isKnowledge && activity?.knowledge?.state === 'read' ? activity.knowledge.events : null;
  if (activity !== null && activity.writes.state === 'read') {
    const rows =
      ledger === null
        ? activity.writes.rows
        : activity.writes.rows.filter((w) => w.kind !== 'vault.write' && w.kind !== 'vault.create');
    const runs = activity.runs.state === 'read' ? activity.runs.rows : [];
    const byRun = new Map(runs.map((r) => [r.run_id, r]));
    const absorbed = new Map<string, ActivitySession[]>();
    for (const session of sessionsOf(rows)) {
      const run = session.run_id === null ? undefined : byRun.get(session.run_id);
      if (run !== undefined) {
        absorbed.set(run.run_id, [...(absorbed.get(run.run_id) ?? []), session]);
        continue;
      }
      out.push({
        kind: 'session',
        key: session.key,
        at: ms(session.at),
        session,
        text: pageSessionWords(session, entries),
      });
    }
    for (const [runId, sessions] of absorbed) {
      const run = byRun.get(runId)!;
      const last = sessions.reduce((a, b) => (ms(b.at) > ms(a.at) ? b : a));
      // The run speaks for its sessions, under its own name.
      const who =
        run.actor === null ? 'A run that named no actor' : writerWords(run.actor, entries);
      const rowsOf = sessions.flatMap((x) => x.rows);
      const did = pageDid(
        rowsOf,
        false,
        sessions.some((x) => x.approved),
      );
      out.push({
        kind: 'run',
        key: `run:${runId}`,
        at: ms(last.at),
        run,
        sessions,
        text: `${who} ${did}`,
      });
    }
  }
  for (const event of ledger ?? []) {
    out.push({
      kind: 'concept',
      key: `concept:${event.event_id}`,
      at: event.at === null ? null : ms(event.at),
      event,
      text: conceptText(event, entries),
    });
  }
  for (const commit of commits ?? []) {
    out.push({ kind: 'commit', key: `commit:${commit.hash}`, at: commit.date * 1000, commit });
  }
  const since =
    activity !== null && activity.recording_since.state === 'read'
      ? activity.recording_since.at
      : null;
  if (since !== null && commits !== null && commits.length > 0) {
    const oldest = Math.min(...commits.map((c) => c.date * 1000));
    if (ms(since) > oldest) {
      out.push({
        kind: 'seam',
        key: 'seam',
        at: ms(since),
        text: `Cerebro began recording edits on ${dayWords(dayKeyOf(ms(since)))}; before this, only versions were kept.`,
      });
    }
  }
  const timed = out.filter((e) => e.at !== null).sort((a, b) => b.at! - a.at!);
  const untimed = out.filter((e) => e.at === null);
  return {
    outside: attribution?.state === 'unattributed' ? OUTSIDE_WORDS : null,
    entries: [...timed, ...untimed],
  };
}

/**
 * The fold over a page's History: the newest `keep` entries, the oldest
 * pinned under them, and how many lie between. Nothing folds while every
 * entry fits beside the pinned one.
 */
export function foldTimeline<E>(
  entries: E[],
  keep = 8,
): { shown: E[]; hidden: number; pinned: E | null } {
  if (entries.length <= keep + 1) return { shown: entries, hidden: 0, pinned: null };
  return {
    shown: entries.slice(0, keep),
    hidden: entries.length - keep - 1,
    pinned: entries[entries.length - 1],
  };
}

/** A page History's day groups, in the entries' order: one per local day,
 * labelled "Today" or "Jul 27", and one "Time not recorded" for entries
 * with no time. */
export function pageDays<E extends { at: number | null }>(
  entries: E[],
  today: string,
): { day: string | null; label: string; entries: E[] }[] {
  const groups: { day: string | null; label: string; entries: E[] }[] = [];
  for (const entry of entries) {
    const day = entry.at === null ? null : dayKeyOf(entry.at);
    const last = groups.at(-1);
    if (last !== undefined && last.day === day) {
      last.entries.push(entry);
      continue;
    }
    const label =
      day === null ? 'Time not recorded' : day === today ? 'Today' : shortDay(day, today);
    groups.push({ day, label, entries: [entry] });
  }
  return groups;
}
