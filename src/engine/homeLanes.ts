import { isTemplate } from '@/lib/templates';
import { sha256Hex } from '@/lib/sha256';
import { agentRef, isAgentEntry } from './agents';
import { actorLabel } from './authors';
import { reminderId, type Reminder } from './reminders';
import {
  fireId,
  markId,
  type DoneMark,
  type DoneMarkInput,
  type ReminderFire,
} from './reminderState';
import {
  dayKeyOf,
  dayWords,
  sessionsOf,
  type ActivitySession,
  type VaultActivity,
} from './activity';
import { type BandContext } from './dateBuckets';
import { dateEpoch, readDateValue } from './dateGrammar';
import { addDays } from './dates';
import { inboxEntries, type InboxPeriod } from './inbox';
import { workSections, workState } from './myWork';
import { isKnowledgePath } from './okf';
import { humanize } from './schema';
import { type DocTask } from './tasks';
import type { Entry, Schema } from './types';

export const HOME_LANES = [
  { id: 'mywork', label: 'My work', kind: 'state' },
  { id: 'proposals', label: 'Waiting on you', kind: 'state' },
  { id: 'runs', label: 'Agents', kind: 'event' },
  { id: 'captures', label: 'Captures', kind: 'state' },
  { id: 'reminders', label: 'Reminders', kind: 'event' },
  { id: 'changes', label: 'Knowledge changed', kind: 'event' },
  { id: 'edits', label: 'Your recent edits', kind: 'state' },
  { id: 'comingup', label: 'Coming up', kind: 'state' },
] as const;
export type HomeLaneId = (typeof HOME_LANES)[number]['id'];
export const ROW_CAP = 10;
export interface HomeRow {
  subject: string;
  path: string | null;
  title: string;
  detail?: string;
  at?: string | null;
  date?: unknown;
  task?: DocTask;
  /** A page write opens Review even if its target already exists. */
  review?: boolean;
  done?: DoneMarkInput;
  runId?: string;
  danger?: boolean;
}
export interface LaneData {
  rows: HomeRow[];
  line: string;
  notes: string[];
}
export type LaneState = 'loading' | 'unavailable' | 'ready' | 'partial';
export function laneView(
  state: LaneState,
  data: LaneData,
): (LaneData & { state: LaneState; total: number }) | null {
  if (
    state === 'loading' ||
    (state === 'ready' && data.rows.length === 0) ||
    (state === 'partial' && data.rows.length === 0 && data.notes.length === 0)
  )
    return null;
  return { ...data, state, total: data.rows.length };
}
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface HomeRun {
  run_id: string;
  actor: string | null;
  ended_at: string | null;
  outcome: string;
}
export type HomeMarks = Record<string, DoneMark> | null;
const marksNote = 'Done history could not be read; these rows may include events you marked done.';
const markFor = (marks: HomeMarks, lane: DoneMarkInput['lane'], subject: string) =>
  marks?.[markId({ lane, subject })];

/** The backend supplies only ended, unattended runs in this vault. A first
 * look has a bounded window; it cannot honestly say "since you looked". */
export function runRows(
  runs: HomeRun[],
  marks: HomeMarks,
  entries: Entry[],
  now: Date,
  truncated = false,
): LaneData {
  const groups = new Map<string, HomeRun[]>();
  let unmarked = false;
  for (const run of runs) {
    const at = run.ended_at === null ? null : dateEpoch(run.ended_at);
    if (at === null || run.outcome === 'running') continue;
    const subject = run.actor ?? 'unattributed';
    const mark = markFor(marks, 'run', subject);
    if (mark?.until === 'forever') continue;
    const since = mark?.revision == null ? null : dateEpoch(mark.revision);
    if (since === null ? at < now.getTime() - 7 * 86_400_000 : at <= since) continue;
    unmarked ||= since === null;
    const group = groups.get(subject) ?? [];
    group.push(run);
    groups.set(subject, group);
  }
  const rows: HomeRow[] = [];
  let total = 0,
    failed = 0;
  for (const [subject, group] of groups) {
    group.sort(
      (a, b) =>
        (dateEpoch(b.ended_at!) ?? 0) - (dateEpoch(a.ended_at!) ?? 0) ||
        a.run_id.localeCompare(b.run_id),
    );
    const latest = group[0];
    total += group.length;
    failed += group.filter((run) => run.outcome !== 'succeeded').length;
    const entry = entries.find(
      (entry) => isAgentEntry(entry) && agentRef(entry).actor === latest.actor,
    );
    rows.push({
      subject,
      path: entry?.path ?? null,
      title: actorLabel(latest.actor, entries).text,
      at: latest.ended_at,
      runId: latest.run_id,
      danger: latest.outcome !== 'succeeded',
      detail: `${latest.outcome.replaceAll('_', ' ')}${group.length > 1 ? ` · +${group.length - 1} earlier` : ''}`,
      done: { lane: 'run', subject, until: 'revision', revision: latest.ended_at },
    });
  }
  return {
    rows,
    line: `${count(total, 'run')} ended${!unmarked && marks !== null ? ' since you looked' : ''}${failed > 0 ? ` · ${failed} didn't succeed` : ''}`,
    notes: [
      ...(unmarked ? ["Agents you haven't marked done show their last 7 days."] : []),
      ...(marks === null ? [marksNote] : []),
      ...(truncated ? ['Only the newest 200 finished runs are counted.'] : []),
    ],
  };
}

export function reminderRows(
  fires: ReminderFire[],
  reminders: Reminder[],
  marks: HomeMarks,
  entries: Entry[],
  now: Date,
): LaneData {
  const live = new Map(reminders.map((reminder) => [reminderId(reminder), reminder]));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  let missed = 0;
  const rows: HomeRow[] = [];
  for (const fire of fires) {
    if (
      !['fired', 'missed'].includes(fire.outcome) ||
      (dateEpoch(fire.claimedAt) ?? 0) < now.getTime() - 7 * 86_400_000
    )
      continue;
    const id = fireId(fire);
    // A page path can itself be 1024 characters; keep the mark's subject
    // bounded while retaining the full identity in its deterministic digest.
    const subject = sha256Hex(`home-reminder-v1\0${id}`);
    const mark = markFor(marks, 'reminder', subject);
    if (mark?.until === 'forever' || mark?.revision === fire.fireAt) continue;
    const reminder = live.get(id);
    const page = byPath.get(fire.path);
    const gone = reminder === undefined;
    const title = gone
      ? `A reminder in ${page?.title ?? fire.path} (since removed)`
      : reminder.context || 'Scheduled reminder';
    if (fire.outcome === 'missed') missed++;
    rows.push({
      subject,
      path: page === undefined ? null : fire.path,
      title,
      at: fire.fireAt,
      detail: fire.outcome === 'missed' ? 'Passed while Cerebro was closed' : page?.title,
      done: { lane: 'reminder', subject, until: 'revision', revision: fire.fireAt },
    });
  }
  return {
    rows,
    line: `${count(rows.length, 'reminder')}${missed > 0 ? ` · ${missed} passed while Cerebro was closed` : ''}`,
    notes: marks === null ? [marksNote] : [],
  };
}

export interface HomeChanges {
  window: { from_seq: number; to_seq: number };
  quiet: boolean;
  changed_at?: string;
  sections: { lines: unknown[] }[];
}
export function changeRows(view: HomeChanges | null, marks: HomeMarks): LaneData {
  const mark = markFor(marks, 'change', 'knowledge');
  const hidden =
    view === null ||
    view.quiet ||
    mark?.until === 'forever' ||
    (mark?.revision != null && Number(mark.revision) >= view.window.to_seq);
  const total = view?.sections.reduce((n, section) => n + section.lines.length, 0) ?? 0;
  const rows: HomeRow[] = hidden
    ? []
    : [
        {
          subject: 'knowledge',
          path: null,
          title: 'Knowledge changed',
          at: view.changed_at ?? null,
          detail: count(total, 'change'),
          done: {
            lane: 'change',
            subject: 'knowledge',
            until: 'revision',
            revision: String(view.window.to_seq),
          },
        },
      ];
  return {
    rows,
    line: `Knowledge changed ${mark === undefined ? 'since the last convergence run' : 'since you looked'} · ${count(total, 'change')}`,
    notes: view === null || view.quiet ? [] : marks === null ? [marksNote] : [],
  };
}

export function myWorkRows(
  entries: Entry[],
  schema: Schema,
  tasks: DocTask[],
  ctx: BandContext,
): LaneData {
  const sections = workSections(entries, schema, ctx).filter((section) =>
    ['overdue', 'today', 'tomorrow', 'this_week'].includes(section.bucket),
  );
  const rows = sections.flatMap((section) =>
    section.rows.map(({ entry, deadline }) => ({
      subject: entry.path,
      path: entry.path,
      title: entry.title,
      detail: entry.type ?? undefined,
      date: deadline?.date,
    })),
  );
  const open = tasks.filter((task) => !task.done);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const taskRows: HomeRow[] = open.map((task) => ({
    subject: `${task.sourcePath}#${task.line}`,
    path: task.sourcePath,
    title: task.text || '(untitled task)',
    detail: byPath.get(task.sourcePath)?.title,
    date: task.due,
    task,
  }));
  const inSection = (key: string) => sections.find((s) => s.bucket === key)?.rows.length ?? 0;
  const counts: [number, string][] = [
    [inSection('overdue'), 'overdue'],
    [inSection('today'), 'due today'],
    [inSection('tomorrow') + inSection('this_week'), 'due this week'],
  ];
  const line = [
    ...counts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`),
    ...(open.length > 0 ? [count(open.length, 'open task')] : []),
  ].join(' · ');
  return { rows: [...rows, ...taskRows], line, notes: [] };
}

export interface ProposalInput {
  proposal_id: string;
  targets: { path?: string | null }[];
  submitted_at?: string | null;
}
export interface PendingWriteInput {
  pending_id: string;
  target: string;
  queued_at: string;
}
export function proposalRows(
  cards: readonly ProposalInput[],
  writes: readonly PendingWriteInput[],
  entries: Entry[],
): LaneData {
  const byPath = new Map(entries.map((entry) => [entry.path, entry.title]));
  const groups = new Map<string, { row: HomeRow; proposals: number; writes: number }>();
  const add = (
    subject: string,
    path: string | null,
    stamp: string | null | undefined,
    write: boolean,
  ) => {
    const group = groups.get(subject) ?? {
      row: {
        subject,
        path,
        title: path === null ? 'Review proposals' : (byPath.get(path) ?? path),
        at: null,
      },
      proposals: 0,
      writes: 0,
    };
    if (write) {
      group.writes++;
      group.row.review = true;
    } else group.proposals++;
    const epoch = stamp == null ? null : dateEpoch(stamp);
    const previous = group.row.at == null ? null : dateEpoch(group.row.at);
    if (epoch !== null && (previous === null || epoch > previous)) group.row.at = stamp;
    groups.set(subject, group);
  };
  for (const card of cards) {
    const path = card.targets[0]?.path ?? null;
    add(path ?? `proposal:${card.proposal_id}`, path, card.submitted_at, false);
  }
  for (const write of writes) add(write.target, write.target, write.queued_at, true);
  const line = (proposals: number, pageWrites: number) =>
    [
      proposals > 0 ? `${count(proposals, 'proposal')} waiting` : '',
      pageWrites > 0 ? `${count(pageWrites, 'page write')} waiting` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  return {
    rows: [...groups.values()].map(({ row, proposals, writes }) => ({
      ...row,
      detail: line(proposals, writes),
    })),
    line: line(cards.length, writes.length),
    notes: [],
  };
}

export function captureRows(entries: Entry[], period: InboxPeriod, now: Date): LaneData {
  const rows = inboxEntries(entries, period, now).map((entry) => ({
    subject: entry.path,
    path: entry.path,
    title: entry.title,
    at: entry.createdAt,
  }));
  return { rows, line: `${count(rows.length, 'capture')} to organize`, notes: [] };
}

/** Follow recorded renames in time order, including another actor's rename of
 * a page the person edited. */
export function editRows(sessions: ActivitySession[], entries: Entry[]): LaneData {
  const edited = new Map<string, { count: number; at: string }>();
  const latest = (a: string, b: string) =>
    (dateEpoch(a) ?? -Infinity) > (dateEpoch(b) ?? -Infinity) ? a : b;
  const writes = sessions
    .flatMap((session) => session.rows.map((row) => ({ row, end: session.at })))
    .sort(
      (a, b) =>
        (dateEpoch(a.row.first_at) ?? 0) - (dateEpoch(b.row.first_at) ?? 0) ||
        (dateEpoch(a.row.at) ?? 0) - (dateEpoch(b.row.at) ?? 0),
    );
  for (const { row, end } of writes) {
    const path = row.kind === 'vault.rename' && row.to !== null ? row.to : row.path;
    if (path !== row.path) {
      const previous = edited.get(row.path);
      if (previous !== undefined) {
        const destination = edited.get(path);
        edited.set(path, {
          count: previous.count + (destination?.count ?? 0),
          at: destination === undefined ? previous.at : latest(previous.at, destination.at),
        });
        edited.delete(row.path);
      }
    }
    if (!row.content || row.actor !== 'human:me') continue;
    const previous = edited.get(path);
    edited.set(path, {
      count: (previous?.count ?? 0) + 1,
      at: previous === undefined ? end : latest(previous.at, end),
    });
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const rows: HomeRow[] = [];
  let gone = 0;
  for (const [path, edit] of edited) {
    const entry = byPath.get(path);
    if (entry === undefined) gone++;
    else
      rows.push({
        subject: path,
        path,
        title: entry.title,
        at: edit.at,
        detail: `edited ${count(edit.count, 'time')}`,
      });
  }
  rows.sort(
    (a, b) =>
      (dateEpoch(b.at!) ?? 0) - (dateEpoch(a.at!) ?? 0) || a.subject.localeCompare(b.subject),
  );
  return {
    rows,
    line: `${count(rows.length, 'page')} you edited in the last 7 days`,
    notes: [
      "Edits made outside Cerebro aren't listed.",
      ...(gone > 0
        ? [`${count(gone, 'edited page')} ${gone === 1 ? 'is' : 'are'} no longer in the vault.`]
        : []),
    ],
  };
}

/** This lane needs only writes. A failed runs or app-session read cannot hide
 * edits, while an unavailable recording boundary is stated separately. */
export function editsData(
  activity: VaultActivity,
  entries: Entry[],
  since: string,
): {
  state: LaneState;
  data: LaneData;
} {
  if (activity.writes.state === 'unavailable')
    return { state: 'unavailable', data: { rows: [], line: '', notes: [] } };
  const data = editRows(sessionsOf(activity.writes.rows), entries);
  if (activity.writes.more) data.notes.push('More edits were recorded than could be read.');
  const recording = activity.recording_since;
  if (recording.state === 'unavailable')
    data.notes.push('When edit recording began could not be read.');
  else if (recording.at === null) {
    data.line = 'Editing history not recorded';
    data.notes.push("Edits haven't been recorded for this vault.");
  } else if ((dateEpoch(recording.at) ?? 0) > (dateEpoch(since) ?? 0))
    data.notes.push(
      `Edits before ${dayWords(dayKeyOf(dateEpoch(recording.at)!))} weren't recorded.`,
    );
  return { state: data.notes.length > 1 ? 'partial' : 'ready', data };
}

export function comingUpRows(
  entries: Entry[],
  schema: Schema,
  now: Date,
  ctx: BandContext,
): LaneData {
  const rows: HomeRow[] = [],
    unreadable: string[] = [];
  const wall = `${ctx.today} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const until = addDays(ctx.today, 7);
  for (const entry of entries) {
    if (isTemplate(entry) || isKnowledgePath(entry.path) || workState(entry, schema) === 'finished')
      continue;
    const type = entry.type === null ? undefined : schema.types.get(entry.type);
    const dates: { field: string; raw: unknown; start: string; ongoing: boolean }[] = [];
    for (const field of type?.fields ?? []) {
      if (!['date', 'daterange'].includes(field.kind) || field.name === type?.deadline) continue;
      const raw = schema.fieldValue(entry, field.name);
      if (raw == null || raw === '') continue;
      const parsed = readDateValue(raw);
      if (parsed === null) {
        unreadable.push(`${entry.title} · ${humanize(field.name)}`);
        continue;
      }
      const start = `${parsed.start.date} ${parsed.start.time ?? '00:00'}`;
      const end = parsed.end === null ? null : `${parsed.end.date} ${parsed.end.time ?? '23:59'}`;
      const ongoing = end !== null && start <= wall && end >= wall;
      const future = parsed.start.time === null ? parsed.start.date >= ctx.today : start >= wall;
      if (ongoing || (future && parsed.start.date <= until))
        dates.push({ field: field.name, raw, start, ongoing });
    }
    dates.sort(
      (a, b) =>
        Number(b.ongoing) - Number(a.ongoing) ||
        a.start.localeCompare(b.start) ||
        a.field.localeCompare(b.field),
    );
    const next = dates[0];
    if (next !== undefined)
      rows.push({
        subject: entry.path,
        path: entry.path,
        title: entry.title,
        detail: humanize(next.field),
        date: next.raw,
        at: next.start,
      });
  }
  rows.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.subject.localeCompare(b.subject));
  const notes =
    unreadable.length === 0
      ? []
      : [
          `Dates could not be read on ${unreadable.slice(0, 3).join(' · ')}${unreadable.length > 3 ? ` · and ${unreadable.length - 3} more` : ''}.`,
        ];
  if (rows.length > 200) notes.push(`Showing 200 of ${rows.length} upcoming records.`);
  return { rows: rows.slice(0, 200), line: `${rows.length} coming up in the next 7 days`, notes };
}
