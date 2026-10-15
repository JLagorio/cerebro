/** Operational reminder claims and Done marks. Rust and the browser replay
 * src-tauri/fixtures/reminder-state-cases.json (CV-04). */
import { parseDateText } from './dateGrammar';

export type ReminderOutcome = 'fired' | 'missed' | 'moved' | 'imported';
export interface ReminderClaim {
  path: string;
  chip: string;
  ordinal: number;
  fireAt: string;
  outcome: Exclude<ReminderOutcome, 'imported'>;
}
export interface ReminderFire extends Omit<ReminderClaim, 'outcome'> {
  outcome: ReminderOutcome;
  claimedAt: string;
}
export interface ReminderClaimResult {
  fire: ReminderFire;
  fresh: boolean;
}
export interface SessionWindow {
  closedAt: string;
  precision: 'clean_exact' | 'heartbeat_lower_bound';
  reopenedAt: string;
  cause: 'app' | 'vault';
}
export interface ReminderState {
  fires: ReminderFire[];
  window: SessionWindow | null;
}
export type DoneLane = 'insight' | 'run' | 'reminder' | 'change';
export interface DoneMarkInput {
  lane: DoneLane;
  subject: string;
  until: 'revision' | 'forever';
  revision: string | null;
}
export interface DoneMark extends DoneMarkInput {
  markedAt: string;
}
export interface DoneMarkResult {
  set: DoneMark;
  replaced: DoneMark | null;
}
export const fireId = (r: Pick<ReminderFire, 'path' | 'chip' | 'ordinal' | 'fireAt'>): string =>
  JSON.stringify([r.path, r.chip, r.ordinal, r.fireAt]);
export const markId = (r: Pick<DoneMark, 'lane' | 'subject'>): string =>
  JSON.stringify([r.lane, r.subject]);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && [...v].length >= 1 && [...v].length <= max;
export function validFire(v: unknown, importing = false): ReminderClaim {
  const r = record(v);
  if (!bounded(r.path, 1024)) throw new Error('A reminder path must have 1 to 1024 characters.');
  if (typeof r.chip !== 'string' || !/^[0-9a-f]{16}$/.test(r.chip))
    throw new Error('A reminder chip must be 16 lowercase hexadecimal characters.');
  if (typeof r.ordinal !== 'number' || !Number.isSafeInteger(r.ordinal) || r.ordinal < 0)
    throw new Error('A reminder ordinal must be a nonnegative integer.');
  if (
    typeof r.fireAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.fireAt) ||
    Number(r.fireAt.slice(0, 4)) < 1 ||
    parseDateText(r.fireAt) === null
  )
    throw new Error('A reminder time must be a floating local minute.');
  if (!importing && !['fired', 'missed', 'moved'].includes(String(r.outcome)))
    throw new Error('A reminder claim must be fired, missed or moved.');
  return {
    path: r.path,
    chip: r.chip,
    ordinal: r.ordinal,
    fireAt: r.fireAt,
    outcome: importing ? 'fired' : (r.outcome as ReminderClaim['outcome']),
  };
}
export function validMark(v: unknown): DoneMarkInput {
  const r = record(v);
  if (!['insight', 'run', 'reminder', 'change'].includes(String(r.lane)))
    throw new Error('A Done lane must be insight, run, reminder or change.');
  if (!bounded(r.subject, 1024)) throw new Error('A Done subject must have 1 to 1024 characters.');
  if (!['revision', 'forever'].includes(String(r.until)))
    throw new Error('A Done mark must last for a revision or forever.');
  if (r.until === 'revision' ? !bounded(r.revision, 256) : r.revision !== null)
    throw new Error('A revision Done mark needs a revision; a forever mark must have none.');
  return {
    lane: r.lane as DoneLane,
    subject: r.subject,
    until: r.until as DoneMarkInput['until'],
    revision: r.revision as string | null,
  };
}
export function validExactMark(v: unknown): DoneMark {
  const mark = validMark(v);
  const stamp = record(v).markedAt;
  if (typeof stamp !== 'string' || !stamp.endsWith('Z') || !Number.isFinite(Date.parse(stamp)))
    throw new Error('A Done mark must name its recorded UTC time.');
  return { ...mark, markedAt: stamp };
}
