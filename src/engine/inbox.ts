import { isTemplate } from '@/lib/templates';
import { isKnowledgePath } from './okf';
import type { Entry, Schema } from './types';

/**
 * Inbox (M4) — the capture-then-organize workflow, after Tolaria's Inbox.
 *
 * Fast capture should not require perfect structure, so a note can land in
 * the vault untyped and unlinked; the Inbox is the queue of everything not
 * yet given a shape. Membership is a FLAG, not a folder: folders already
 * mean "project" in cerebro (vault format v2), so a folder-based Inbox
 * would collide with containment the moment you filed a capture.
 *
 * The default is what makes this work on an existing vault without a
 * migration pass:
 *
 *   - an explicit `_organized: true|false` always wins;
 *   - otherwise a note is organized IF IT HAS A TYPE.
 *
 * So every typed record in a vault is already out of the Inbox on day one,
 * and untyped captures collect in it. That also states the workflow's whole
 * point in one line: giving a note a type is what organizing IS.
 */

/** Default folder for quick captures. Membership is the flag, not this dir. */
export const INBOX_DIR = 'inbox';

/** App-managed frontmatter key. `_`-prefixed keys are hidden from property
 * surfaces (see isSystemProperty in engine/properties.ts). */
export const ORGANIZED_KEY = '_organized';

export type InboxPeriod = 'week' | 'month' | 'all';

export const INBOX_PERIODS: { value: InboxPeriod; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All' },
];

/**
 * Files that are structure rather than content: they are never "captures",
 * so they never queue for organizing no matter what frontmatter they carry.
 * Type docs configure the schema, project.md is a project's identity,
 * templates are scaffolding, and index/log are OKF reserved names (M5).
 */
export function isStructural(entry: Entry): boolean {
  return (
    entry.type === 'Type' ||
    entry.filename === 'project.md' ||
    entry.filename === 'index.md' ||
    entry.filename === 'log.md' ||
    isTemplate(entry) ||
    // Knowledge concepts (M5) are the agent's to write and yours to verify.
    // They are reviewed on the Knowledge surface, not organized in the Inbox.
    isKnowledgePath(entry.path)
  );
}

/** Explicit `_organized` wins; otherwise having a type means organized. */
export function isOrganized(entry: Entry): boolean {
  const flag = entry.properties[ORGANIZED_KEY];
  if (typeof flag === 'boolean') return flag;
  return entry.type !== null;
}

export function inInbox(entry: Entry): boolean {
  return !isStructural(entry) && !isOrganized(entry);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Record<InboxPeriod, number | null> = { week: 7, month: 30, all: null };

/** True when `entry` was captured inside `period` counting back from `now`. */
export function withinPeriod(entry: Entry, period: InboxPeriod, now: Date): boolean {
  const days = PERIOD_DAYS[period];
  if (days === null) return true;
  const created = Date.parse(entry.createdAt);
  // An unparseable createdAt must not silently vanish from every bounded
  // period — surface it rather than hide it.
  if (Number.isNaN(created)) return true;
  return now.getTime() - created <= days * DAY_MS;
}

/** Inbox contents for a period, newest capture first. */
export function inboxEntries(
  entries: Entry[],
  period: InboxPeriod = 'all',
  now: Date = new Date(),
): Entry[] {
  return entries
    .filter((e) => inInbox(e) && withinPeriod(e, period, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title));
}

/** Per-period counts for the filter pills. */
export function inboxCounts(entries: Entry[], now: Date = new Date()): Record<InboxPeriod, number> {
  const queued = entries.filter(inInbox);
  return {
    week: queued.filter((e) => withinPeriod(e, 'week', now)).length,
    month: queued.filter((e) => withinPeriod(e, 'month', now)).length,
    all: queued.length,
  };
}

/** Total Inbox size — the Rail badge. */
export function inboxCount(entries: Entry[]): number {
  return entries.filter(inInbox).length;
}

// --- Organize checklist ----------------------------------------------------

export interface OrganizeCheck {
  id: 'title' | 'type' | 'status' | 'links';
  label: string;
  done: boolean;
  /** Why it matters — shown when the check is outstanding. */
  hint: string;
}

/** `fld-7.md` → "Fld 7" — the parser's own title fallback (see Entry.title). */
export function humanizeStem(filename: string): string {
  const stem = filename.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim();
  return stem === '' ? '' : stem[0].toUpperCase() + stem.slice(1);
}

/**
 * Whether the note carries a real H1 rather than the humanized-filename
 * fallback. Entry has no "had an H1" flag, so this compares against what
 * the fallback would have produced — advisory only, and a note whose H1
 * happens to match its filename reads as untitled. The checklist never
 * blocks organizing, so a false negative costs nothing but a nudge.
 */
export function hasRealTitle(entry: Entry): boolean {
  return entry.title.trim() !== '' && entry.title !== humanizeStem(entry.filename);
}

/**
 * The review checklist for one capture: what would make this note findable
 * later. Advisory — organizing is always allowed with items outstanding.
 */
export function organizeChecklist(entry: Entry, schema: Schema): OrganizeCheck[] {
  const checks: OrganizeCheck[] = [
    {
      id: 'title',
      label: 'Has a clear title',
      done: hasRealTitle(entry),
      hint: 'The first H1 is the title. A capture named after its filename is hard to find later.',
    },
    {
      id: 'type',
      label: 'Has a type',
      done: entry.type !== null,
      hint: 'The type decides which screens, views, and properties this note belongs to.',
    },
  ];

  // Status only matters when the note's own type declares one — asking for
  // a status on a Person or a Reference would be noise.
  const statuses = entry.type === null ? [] : schema.statusSetFor(entry);
  if (statuses.length > 0) {
    const current = entry.properties.status;
    checks.push({
      id: 'status',
      label: 'Has a status',
      done: typeof current === 'string' && statuses.some((s) => s.id === current),
      hint: 'Actionable notes need a status to show up in the right column or view.',
    });
  }

  checks.push({
    id: 'links',
    label: 'Connected to something',
    done: Object.keys(entry.relationships).length > 0 || entry.outgoingLinks.length > 0,
    hint: 'A wikilink or a relation property is what makes this reachable from anywhere else.',
  });

  return checks;
}
