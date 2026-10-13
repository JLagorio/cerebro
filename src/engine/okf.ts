import { addDays, toIsoDate } from './dates';
import STALENESS from '../../shared/policy/staleness.v1.json';
import type { Entry } from './types';
import { resolveTarget } from './wikilink';

/**
 * Knowledge (M5, reworked in M8.1) — the AI knowledge base, modelled on the
 * Open Knowledge Format v0.2 (docs/knowledge-catalog-main/okf/SPEC.md).
 *
 * `knowledge/` in the vault IS an OKF bundle: a directory of markdown
 * concepts an agent writes and maintains. Humans do not edit it — they
 * VERIFY it. That asymmetry is the whole point of the format: when most of
 * a corpus is machine-generated, a reader needs to know where a claim came
 * from, how much to trust it, and whether it is still true.
 *
 * Everything here is DERIVED, never stored. A trust tier written into a
 * file goes stale the moment anything changes and is not portable between
 * consumers, so OKF records the signals and each consumer infers (§5.3).
 *
 * Conformance (§11) is deliberately forgiving: a concept is never rejected
 * for a missing optional family, an unknown type, or a broken link. Absent
 * fields carry meaning — unverified is a state, not an error.
 */

/** The bundle root. One directory, so the read-only boundary is one check. */
export const KNOWLEDGE_DIR = 'knowledge';

/** OKF §3.1 — reserved filenames that are structure, not concepts. */
export const RESERVED_FILENAMES = ['index.md', 'log.md'];

/**
 * True for the bundle root and anything beneath it — judged on the path the
 * filesystem resolves (M49.4), not the raw string: `./knowledge/x.md`,
 * `records/../knowledge/x.md` and, on case-folding APFS, `Knowledge/x.md`
 * are all the bundle. Mirrors `knowledge::is_knowledge_path` in Rust; both
 * assert the same case table.
 */
export function isKnowledgePath(path: string): boolean {
  return canonicalKnowledgePath(path) !== null;
}

/** The bundle path in its one canonical spelling (`knowledge/…`), or null
 * when `path` does not resolve into the bundle. Mirrors `canonical_path`. */
export function canonicalKnowledgePath(path: string): string | null {
  if (path.startsWith('/')) return null;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.pop() === undefined) return null;
      continue;
    }
    segments.push(segment);
  }
  const [head, ...rest] = segments;
  // ASCII-only folding, as Rust's eq_ignore_ascii_case: toLowerCase would
  // also fold the Kelvin sign into `k`, and the two backends must agree.
  if (head === undefined || !/^knowledge$/i.test(head)) return null;
  return [KNOWLEDGE_DIR, ...rest].join('/');
}

/** True for notes inside the bundle — excluded from Docs, Inbox, and the
 * type screens so agent knowledge never mixes into your own content. */
export function isConcept(entry: Entry): boolean {
  return isKnowledgePath(entry.path) && !RESERVED_FILENAMES.includes(entry.filename);
}

// --- Actors (§7) -----------------------------------------------------------

export type ActorKind = 'human' | 'process' | 'agent';

export interface Actor {
  kind: ActorKind;
  /** Display label: the id for human/process, `producer/version` for agents. */
  label: string;
  raw: string;
}

/**
 * `human:<id>` · `process:<id>` · `<producer>/<version>` for agents and
 * tools. Trust classification keys off the `human:` prefix (§7), so an
 * unrecognized shape must NOT be guessed into a human.
 */
export function parseActor(raw: unknown): Actor | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;
  if (value.startsWith('human:')) {
    return { kind: 'human', label: value.slice(6) || value, raw: value };
  }
  if (value.startsWith('process:')) {
    return { kind: 'process', label: value.slice(8) || value, raw: value };
  }
  return { kind: 'agent', label: value, raw: value };
}

// --- Provenance (§5.1) -----------------------------------------------------

export interface Source {
  /** Stable key used to attribute individual claims via `[^id]` footnotes. */
  id: string | null;
  /** A followable artifact OR a scope descriptor ("all queries in project X"). */
  resource: string;
  title: string | null;
  /** Credibility signals — objective facts, never a score. */
  author: Actor | null;
  usageCount: number | null;
  lastModified: string | null;
  usageWindow: { from: string | null; to: string | null } | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

function asWindow(value: unknown): { from: string | null; to: string | null } | null {
  const record = asRecord(value);
  if (record === null) return null;
  const from = asString(record.from);
  const to = asString(record.to);
  return from === null && to === null ? null : { from, to };
}

export function parseSources(entry: Entry): Source[] {
  const raw = entry.properties.sources;
  if (!Array.isArray(raw)) return [];
  // `usage_window` is written once beside `sources` and frames every
  // usage_count; an entry may override it with its own (§5.1).
  const shared = asWindow(entry.properties.usage_window);
  const sources: Source[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) continue;
    const resource = asString(record.resource);
    // `resource` is required within an entry — an entry without one names
    // nothing and cannot be followed or attributed.
    if (resource === null) continue;
    sources.push({
      id: asString(record.id),
      resource,
      title: asString(record.title),
      author: parseActor(record.author),
      usageCount: typeof record.usage_count === 'number' ? record.usage_count : null,
      lastModified: asString(record.last_modified),
      usageWindow: asWindow(record.usage_window) ?? shared,
    });
  }
  return sources;
}

/**
 * How many sources a concept cites — or null when its file keeps no
 * `sources` list at all (M52.5). `parseSources` answers both with `[]`, which
 * is right for walking them and wrong for counting them: a list written
 * empty is measured at zero, and a key nobody wrote is not recorded, so a
 * count column that printed 0 for both would say the second is the first.
 */
export function sourceCount(entry: Entry): number | null {
  return Array.isArray(entry.properties.sources) ? parseSources(entry).length : null;
}

// --- Trust (§5.2, §5.3) ----------------------------------------------------

export interface Stamp {
  by: Actor;
  at: string | null;
}

function parseStamp(value: unknown): Stamp | null {
  const record = asRecord(value);
  if (record === null) return null;
  const by = parseActor(record.by);
  // `by` is required within `generated` — a stamp with no actor attributes
  // nothing, so it is dropped rather than shown as an empty author.
  if (by === null) return null;
  return { by, at: asString(record.at) };
}

export function parseGenerated(entry: Entry): Stamp | null {
  return parseStamp(entry.properties.generated);
}

/** A bare `verified: {by, at}` mapping MUST read as a one-element list (§5.2). */
export function parseVerified(entry: Entry): Stamp[] {
  const raw = entry.properties.verified;
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map(parseStamp).filter((s): s is Stamp => s !== null);
}

/**
 * M23.4: when a verified concept is revised afterwards, the projection
 * renders the review state as a plain string — "verified at r3; current is
 * r5 — attestation predates revision" — instead of silently dropping the
 * stamp. Surfaced verbatim; the concept still reads as unverified (the
 * review no longer covers the current content).
 */
export function verifiedNotice(entry: Entry): string | null {
  const raw = entry.properties.verified;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Whether a review covers what this concept currently says (M27.5c).
 *
 * This subsumes the old three-rung `trustTier`, which mixed two questions
 * into one ladder: whether anybody reviewed, and who. They separate here
 * because M27's three axes make the first one an axis of its own — D8's
 * review channel, the same `ReviewStatus` `dynamics::review` derives from the
 * ledger. The projection is what the ledger wrote, so the file-side answer
 * and the ledger-side answer are the same answer read from two places.
 *
 * It is NEVER Support. An attestation says a human looked; Support says what
 * rests underneath, and a concept can be reviewed and unsupported at once.
 */
export type ReviewState = 'unreviewed' | 'current' | 'predates_current' | 'disputed';

/** Each review state's word — the page's review chip, and the word a queued
 * concept's row wears for the same state (M52.5), so a row and the page it
 * opens name it once. */
export const REVIEW_LABELS: Record<ReviewState, string> = {
  unreviewed: 'Unreviewed',
  current: 'Reviewed',
  predates_current: 'Changed since review',
  disputed: 'Review disputed',
};

/**
 * What a concept only an agent has confirmed is called, wherever it is shown
 * (M52.5): the Review queue's reason and the concept's own review chip. It is
 * still waiting — an agent's confirmation keeps it in the queue — so it is
 * never "Reviewed" in green on its page while the table calls it waiting.
 */
export const AGENT_ONLY_LABEL = 'Needs a person';

export function reviewStatus(entry: Entry): ReviewState {
  if (parseVerified(entry).length > 0) return 'current';
  // M23 r5: the stamp is there but names an older revision, so the projection
  // rendered a notice instead of a stamp. Reviewed-but-not-of-this is its own
  // answer, and collapsing it into `unreviewed` throws away the fact that
  // somebody once looked.
  return verifiedNotice(entry) !== null ? 'predates_current' : 'unreviewed';
}

/**
 * Who attested, when anybody did. Carried BESIDE the status rather than
 * folded into it: a nightly process confirming a claim and a person signing
 * off on it are different events, and the old ladder could only say which by
 * ranking one above the other.
 */
export function reviewedBy(entry: Entry): 'human' | 'agent' | null {
  const verified = parseVerified(entry);
  if (verified.length === 0) return null;
  return verified.some((v) => v.by.kind === 'human') ? 'human' : 'agent';
}

/** The quarantined knowledge paths — or `unknown` when the status could not
 * be read or the bundle could not be compared, in which case no file's own
 * review claim is trusted (unavailable is never empty). */
export type Quarantine = ReadonlySet<string> | 'unknown';

/** No quarantine known — the browser mock, or before the status is read. */
export const NO_QUARANTINE: ReadonlySet<string> = new Set();

/**
 * What the ledger says about review that supersession is gated on (M49.8) —
 * the same record Rust's `knowledge::about` reads, so the UI and the agent
 * retire the same concepts.
 */
export interface LedgerReviewView {
  /** `supersessionKey(replacement, replaced)` of every card-approved one. */
  approved: ReadonlySet<string>;
  /** Concepts whose current review the LEDGER records as a person's —
   * `null` when no readable ledger answers, and the file's own stamp is
   * all there is. */
  recordedHuman: ReadonlySet<string> | null;
}

/** No ledger answer (the browser mock, or before the status is read). */
export const NO_LEDGER_REVIEW: LedgerReviewView = { approved: new Set(), recordedHuman: null };

/** The key `approvalsOf` files a person-approved supersession under. */
export function supersessionKey(replacement: string, replaced: string): string {
  return `${replacement}\u0000${replaced}`;
}

/**
 * Both facts, together — the question the review queue actually asks.
 *
 * The old `trust === 'human-reviewed'` said this in one comparison because
 * the ladder had already decided that a person outranks a process. Splitting
 * the ladder means the two callers that depend on the combination have to
 * name it, which is the point: a nightly job confirming a claim does not
 * take it off a human's list.
 */
export function humanReviewed(concept: Concept): boolean {
  return concept.review === 'current' && concept.reviewedBy === 'human';
}

/** The most recent verification instant — "how recently" is the latest `at`. */
export function lastVerifiedAt(entry: Entry): string | null {
  const times = parseVerified(entry)
    .map((v) => v.at)
    .filter((at): at is string => at !== null);
  return times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b));
}

// --- Lifecycle (§5.4, §5.5) ------------------------------------------------

export type Lifecycle = 'draft' | 'stable' | 'deprecated';

/**
 * OKF spells this `status:`, which already means work-item status in
 * cerebro. Ours is `lifecycle:` and translates to `status` on OKF export —
 * one word is not worth two meanings for the same key.
 */
export function lifecycleOf(entry: Entry): Lifecycle {
  const raw = entry.properties.lifecycle;
  return raw === 'draft' || raw === 'deprecated' ? raw : 'stable';
}

/** `stale_after` is an ABSOLUTE date, so staleness is a plain comparison
 * with no reference to when the concept was read (§5.5). */
export function staleAfter(entry: Entry): string | null {
  const raw = entry.properties.stale_after;
  return typeof raw === 'string' ? asString(raw) : staleAfterOf(raw);
}

/**
 * When a concept is stale — ONE rule, as data (M49.8, K24):
 * shared/policy/staleness.v1.json, read by this and by Rust's
 * `knowledge::is_stale`, and both replay its cases. It was a lexical
 * `today >= after` written twice, so `2027-7-1` sorted after every 2027
 * date and `never` was never stale.
 */
export function staleFrom(after: string | null, today: string): boolean {
  if (after === null) return false;
  if (!readableHorizon(after)) return STALENESS.malformed_is_stale;
  return STALENESS.inclusive ? today >= after : today > after;
}

/**
 * Whether a raw `stale_after` reads as a date at all: exactly `YYYY-MM-DD`,
 * and a day the calendar has (`2026-02-30` is not). One test, because the
 * staleness rule, the queue's "a person already rechecked it" and every line
 * that prints the date must agree on which horizons can be read (M52.4).
 */
export function readableHorizon(after: string | null): boolean {
  return (
    after !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(after) &&
    !Number.isNaN(Date.parse(`${after}T00:00:00Z`)) &&
    new Date(`${after}T00:00:00Z`).toISOString().slice(0, 10) === after
  );
}

/**
 * The local calendar day a stamp's `at` fell on, as `todayIso` names today —
 * `null` when `at` is no instant at all (M52.4).
 *
 * A date-only `at` is already a day and is kept as written: `Date.parse` reads
 * one as UTC midnight, which west of Greenwich is the evening before. An
 * instant is placed in the reader's zone, so a person in Sydney who verified at
 * 08:00 on the 26th verified on the 26th, not on the UTC 25th.
 */
export function localDayOf(at: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : toIsoDate(new Date(ms));
}

/**
 * The raw `stale_after` a reader judges: a string as written, and any other
 * PRESENT value in its JSON spelling — a hand-typed `2027` or `true` is a
 * horizon nobody can read, so it is malformed (stale), never "never". `null`
 * only when the key is absent or null. Mirrors Rust's `stale_after_of`.
 */
export function staleAfterOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

export function isStale(entry: Entry, today: string): boolean {
  // The RAW value, as Rust's `is_stale` reads it: an empty or padded string
  // is a malformed horizon (stale), where `staleAfter` would trim it away.
  return staleFrom(staleAfterOf(entry.properties.stale_after), today);
}

// --- Entity anchors (M8.1) -------------------------------------------------

/**
 * `about:` names the vault entities a concept is knowledge OF — the project,
 * person, or record it describes.
 *
 * This is the join M5 was missing. Without it the bundle is a parallel corpus
 * that merely happens to mention your work, so the same subject ends up
 * documented in two places with no way to get from one to the other. `sources`
 * answers "where did this come from"; `about` answers "what is this about",
 * and only the second can put knowledge on a project page.
 *
 * Written as wikilinks, which the note parser hands back in `relationships`
 * already reduced to raw targets. A plain string is accepted too: a concept
 * that names its subject imprecisely still beats one that never names it.
 */
export function parseAbout(entry: Entry): string[] {
  const linked = entry.relationships.about;
  if (Array.isArray(linked) && linked.length > 0) return linked;
  const raw = entry.properties.about;
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((v) => String(v).trim()).filter((v) => v !== '');
}

// --- Concept-to-concept relations (M8.7) -----------------------------------

/**
 * How one concept stands to another.
 *
 * OKF §6.1 leaves the KIND of a link to prose: a link is an untyped directed
 * edge and the surrounding sentence says what it means. That is right for a
 * reader and useless for a consumer — "is this still true" and "did something
 * replace it" cannot be answered by a paragraph. So the kind is lifted into
 * frontmatter as an extension the spec explicitly permits (§11: unknown fields
 * are tolerated, never fatal), and the body keeps the explanation.
 *
 * Three kinds, because each one changes what the reader should DO:
 *
 * - `supersedes` — this replaces that. The only relation that retires
 *   something, and the reason the bundle can stop being append-only.
 * - `refines` — this is a narrower or more exact statement of that. Both stay
 *   true; the pair is a hierarchy, not a correction.
 * - `contradicts` — the two disagree and neither has won. Deliberately NOT
 *   self-resolving: a machine that decided which of two claims to keep would
 *   be exercising the judgement this whole trust model reserves for a person.
 */
export type RelationKind = 'supersedes' | 'refines' | 'contradicts';

export const RELATION_KINDS: readonly RelationKind[] = ['supersedes', 'refines', 'contradicts'];

/** How each relation reads from the other end. */
export const RELATION_LABELS: Record<RelationKind, { out: string; in: string }> = {
  supersedes: { out: 'Replaces', in: 'Replaced by' },
  refines: { out: 'Refines', in: 'Refined by' },
  // Symmetric: disagreement has no direction, and labelling one side as the
  // author of the conflict would imply it is the one that is wrong.
  contradicts: { out: 'Contradicts', in: 'Contradicts' },
};

/** Wikilink targets per relation, in the same shape `about:` uses. */
export function parseRelations(entry: Entry): Record<RelationKind, string[]> {
  const out = {} as Record<RelationKind, string[]>;
  for (const kind of RELATION_KINDS) {
    const linked = entry.relationships[kind];
    if (Array.isArray(linked) && linked.length > 0) {
      out[kind] = linked;
      continue;
    }
    const raw = entry.properties[kind];
    const items = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    out[kind] = items.map((v) => String(v).trim()).filter((v) => v !== '');
  }
  return out;
}

/**
 * The bundle sub-directory a concept sits in — `metrics`, `playbooks`,
 * `systems`. OKF §3 gives directories no meaning of their own, but the
 * bundle's own `index.md` lists them as sections, so they are the shape the
 * author already chose. Top level only: `knowledge/a/b/c.md` is in `a`.
 */
export function sectionOf(entry: Entry): string {
  return sectionOfPath(entry.path);
}

/**
 * `sectionOf` for a bare path (M52.3) — what the sidebar has when a concept
 * is open as a page: a `doc` selection carries a path, not an entry, and the
 * folder row it lights has to be the one `listSections` filed it under.
 */
export function sectionOfPath(path: string): string {
  const rest = path.slice(KNOWLEDGE_DIR.length + 1);
  const cut = rest.indexOf('/');
  return cut === -1 ? '' : rest.slice(0, cut);
}

export interface Section {
  /** Directory name; '' for concepts at the bundle root. */
  folder: string;
  label: string;
  count: number;
}

/** A bundle folder as its heading reads — `key-results` is "Key results". */
export const folderLabel = (folder: string): string =>
  folder === '' ? 'Ungrouped' : folder.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function listSections(concepts: Concept[]): Section[] {
  const counts = new Map<string, number>();
  for (const concept of concepts) {
    counts.set(concept.section, (counts.get(concept.section) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .map(([folder, count]) => ({ folder, label: folderLabel(folder), count }))
      // Root-level concepts sort last: they are the leftovers, not a section.
      .sort((a, b) => (a.folder === '' ? 1 : b.folder === '' ? -1 : a.label.localeCompare(b.label)))
  );
}

/** One entity and everything the bundle knows about it. */
export interface Subject {
  /** Grouping key: the resolved vault path, else the lowercased target. */
  key: string;
  /** The `about:` target as written, for concepts that resolve to nothing. */
  target: string;
  /** The vault entry it points at, or null — a dangling anchor is legitimate
   * (OKF §6.1), it may just be an entity nobody has created yet. */
  entry: Entry | null;
  /** What the thread's own source calls it — see `listSubjects` on casing. */
  label: string;
  concepts: Concept[];
}

/**
 * Groups concepts by what they are about. A concept with several anchors
 * appears under each of them: knowledge about a project is also knowledge
 * about the person who owns it, and hiding it from one of those is a lie of
 * omission.
 */
export function listSubjects(concepts: Concept[], entries: Entry[]): Subject[] {
  // M33a.3 / D8 — a thread keeps the casing its source gave it.
  //
  // `Entry.title` is the body H1 falling back to the humanized filename stem;
  // frontmatter `title:` is ignored for entries, app-wide and on purpose. The
  // CONCEPT model does read it (`toConcept`). So an anchor pointing into the
  // bundle — `about: "[[rq-84b-kestrel]]"` naming a concept file with no H1
  // and `title: RQ-84B KESTREL program` in its frontmatter — rendered as
  // `Rq 84b kestrel`, a name nothing in the vault had ever written down.
  // Where the anchor resolves to a concept, that concept's own title wins.
  const byPath = new Map(concepts.map((c) => [c.entry.path, c]));
  const subjects = new Map<string, Subject>();
  for (const concept of concepts) {
    for (const target of concept.about) {
      const entry = resolveTarget(target, entries);
      const key = entry?.path ?? target.toLowerCase();
      const existing = subjects.get(key);
      if (existing === undefined) {
        // A dangling target keeps its raw text: nobody has named this thing
        // yet, so what the agent typed IS its source casing.
        const named = entry === null ? undefined : byPath.get(entry.path)?.title;
        subjects.set(key, {
          key,
          target,
          entry,
          label: named ?? entry?.title ?? target,
          concepts: [concept],
        });
      } else {
        existing.concepts.push(concept);
      }
    }
  }
  // Heaviest thread first (D8), label breaking ties so the order is stable.
  // Alphabetical sorted by the one property of a thread nobody navigates by:
  // in a working vault it buried the two subjects carrying 13 and 8 concepts
  // among nineteen singletons, which is a sort answering a question nobody
  // asked.
  return [...subjects.values()].sort(
    (a, b) => b.concepts.length - a.concepts.length || a.label.localeCompare(b.label),
  );
}

/** Concepts anchored to a vault path — what a project page asks for. */
export function conceptsAbout(path: string, concepts: Concept[], entries: Entry[]): Concept[] {
  return concepts.filter((c) =>
    c.about.some((target) => resolveTarget(target, entries)?.path === path),
  );
}

// --- Committed to knowledge (M8.5) -----------------------------------------

/** `sources` may cite `/inbox/x.md` or `inbox/x.md`; both name the same note. */
const normalizeResource = (resource: string): string => resource.replace(/^\.?\//, '');

/**
 * The concepts distilled FROM this note — `sources` read backwards.
 *
 * `about` answers "what is this knowledge of"; `sources` answers "what was it
 * read from", and only the second can tell you whether a note has been
 * committed to the knowledge base yet. Derived rather than stamped on purpose:
 * a `distilled_at` in the note's frontmatter is a claim that survives the
 * concept being deleted, whereas this cannot say a thing was learned unless
 * the learning is still there to point at.
 */
export function conceptsFrom(path: string, concepts: readonly Concept[]): Concept[] {
  return concepts.filter((c) => c.sources.some((s) => normalizeResource(s.resource) === path));
}

/**
 * Everything Knowledge holds that bears on one page (M52.3): the concepts
 * ABOUT it (it is their subject) and the concepts learned FROM it (it is
 * their source), each concept once — a concept that both cites a page and
 * is anchored to it is about it, and counted there.
 *
 * One function because two readers ask it: the strip under a page's header
 * and the AI panel's context snapshot. The strip counted both directions and
 * the snapshot only `about`, so a capture the base had learned from said
 * "Knowledge · 1" on the page and nothing to the assistant reading it.
 *
 * Replaced concepts are left in: what a reader does with one differs (the
 * strip drops it, the snapshot carries it so the agent never quotes it as
 * current), and deciding that here would decide it for both.
 */
export function knowledgeOf(
  path: string,
  concepts: Concept[],
  entries: Entry[],
): { about: Concept[]; from: Concept[] } {
  const about = conceptsAbout(path, concepts, entries);
  const anchored = new Set(about.map((c) => c.entry.path));
  const from = conceptsFrom(path, concepts).filter((c) => !anchored.has(c.entry.path));
  return { about, from };
}

export type CommitState =
  /** Nothing in the bundle cites it. */
  | 'uncommitted'
  /** Committed, and the note has not changed since. */
  | 'committed'
  /** Committed, but edited afterwards — what was learned is behind the note. */
  | 'behind';

export interface Commit {
  concepts: Concept[];
  state: CommitState;
  /** Newest `generated.at` among them — when this note was last learned from. */
  at: string | null;
}

/**
 * Whether a note has been committed to the knowledge base, and whether that
 * commit is still current.
 *
 * `behind` is the state that makes the base feel alive: editing a note you
 * already distilled leaves the bundle holding an older reading of it, and
 * saying so is how re-distilling becomes an obvious act rather than a chore
 * nobody remembers. It never nags — the surfaces show it, they do not raise it.
 */
export function commitOf(entry: Entry, concepts: readonly Concept[]): Commit {
  const from = conceptsFrom(entry.path, concepts);
  if (from.length === 0) return { concepts: from, state: 'uncommitted', at: null };
  const at = from.reduce<string | null>((newest, c) => {
    const stamped = c.generated?.at ?? null;
    return stamped !== null && (newest === null || stamped > newest) ? stamped : newest;
  }, null);
  // An unstamped concept cannot be compared against, so it counts as current
  // rather than permanently behind — absent fields never manufacture work.
  const behind = at !== null && entry.modifiedAt > at;
  return { concepts: from, state: behind ? 'behind' : 'committed', at };
}

/**
 * What the bundle knows that bears on THIS note (M8.3).
 *
 * A concept is relevant to a note when they are about the same things, and a
 * note declares what it is about three ways: it can be the subject itself, it
 * can live inside a project, and it can link out to records. All three count —
 * a PRD sitting in `projects/phoenix/` is about Phoenix whether or not it ever
 * writes the word, and the whole point of this surface is to surface what you
 * did NOT think to reference.
 *
 * Ordered most-anchored first: a concept matching several of the note's
 * subjects is more likely to matter than one that clipped a single link.
 */
export function relatedConcepts(entry: Entry, concepts: Concept[], entries: Entry[]): Concept[] {
  const subjects = new Set<string>([entry.path]);
  if (entry.project !== null) subjects.add(entry.project);
  const linked = [...entry.outgoingLinks, ...Object.values(entry.relationships).flat()];
  for (const target of linked) {
    const resolved = resolveTarget(target, entries);
    if (resolved !== null) subjects.add(resolved.path);
  }

  const scored: { concept: Concept; hits: number }[] = [];
  for (const concept of concepts) {
    // A concept never counts as related to itself, and the bundle does not
    // recommend itself sideways: only knowledge ABOUT the note's subjects.
    if (concept.entry.path === entry.path) continue;
    const hits = concept.about.filter((target) => {
      const resolved = resolveTarget(target, entries);
      return resolved !== null && subjects.has(resolved.path);
    }).length;
    if (hits > 0) scored.push({ concept, hits });
  }

  return scored
    .sort((a, b) => b.hits - a.hits || a.concept.title.localeCompare(b.concept.title))
    .map((s) => s.concept);
}

// --- The concept view-model ------------------------------------------------

export interface Concept {
  entry: Entry;
  /** Path with `.md` dropped — the OKF concept ID (§2). */
  id: string;
  title: string;
  description: string | null;
  /**
   * OKF `type:`. Free-form per the format, but read through the vault's own
   * type catalog wherever one matches (M8.1) — the same word should mean the
   * same thing, and render the same way, on both sides of the bundle boundary.
   */
  conceptType: string;
  /** Bundle sub-directory — see `sectionOf`. */
  section: string;
  /** Raw `about:` targets — the entities this is knowledge of. */
  about: string[];
  resource: string | null;
  tags: string[];
  sources: Source[];
  generated: Stamp | null;
  verified: Stamp[];
  /** The predating-attestation notice the projection rendered, if any. */
  verifiedNotice: string | null;
  /** Does a review cover what this says NOW — D8 channel 1, never Support. */
  review: ReviewState;
  /** Who attested, when anybody did. Null when nobody has. */
  reviewedBy: 'human' | 'agent' | null;
  lastVerified: string | null;
  lifecycle: Lifecycle;
  staleAfter: string | null;
  stale: boolean;
  /** Raw relation targets by kind — resolved through `conceptEdges` (M8.7). */
  relations: Record<RelationKind, string[]>;
  /**
   * Path of the concept that replaced this one, filled by `listConcepts`.
   *
   * It lives on the model rather than being looked up at each call site
   * because a replaced concept must READ as replaced everywhere — in a
   * related list, on a project page, in the review queue — and a rule enforced
   * only where someone remembered to check it is not a rule.
   */
  supersededBy: string | null;
  /** A concept that CLAIMS to replace this one but cannot retire it (M49.8):
   * unreviewed against reviewed, or a mutual claim. This one stays current. */
  replacementProposedBy: string | null;
}

export function toConcept(entry: Entry, today: string): Concept {
  const tags = entry.properties.tags;
  return {
    entry,
    id: entry.path.replace(/\.md$/, ''),
    title: asString(entry.properties.title) ?? entry.title,
    description: asString(entry.properties.description),
    // Consumers MUST tolerate unknown types (§4.1); untyped falls back to
    // a generic label rather than being treated as malformed.
    conceptType: entry.type ?? 'Concept',
    section: sectionOf(entry),
    about: parseAbout(entry),
    resource: asString(entry.properties.resource),
    tags: Array.isArray(tags) ? tags.map((t) => String(t)) : [],
    sources: parseSources(entry),
    generated: parseGenerated(entry),
    verified: parseVerified(entry),
    verifiedNotice: verifiedNotice(entry),
    review: reviewStatus(entry),
    reviewedBy: reviewedBy(entry),
    lastVerified: lastVerifiedAt(entry),
    lifecycle: lifecycleOf(entry),
    staleAfter: staleAfter(entry),
    stale: isStale(entry, today),
    relations: parseRelations(entry),
    // Resolved by listConcepts, which is the only caller that can see the
    // rest of the bundle.
    supersededBy: null,
    replacementProposedBy: null,
  };
}

/**
 * When a concept last changed, as far as anything recorded it (M52.5): the
 * newest of its writing, its reviews and the file's own modification time.
 * The stamps are what the bundle says happened; the file time catches an
 * edit that wrote no stamp. An instant that cannot be read is skipped, so a
 * garbled stamp never outranks a real one — and the file time is always
 * there to fall back on.
 */
export function updatedAt(concept: Concept): string {
  let newest = concept.entry.modifiedAt;
  let newestMs = Date.parse(newest);
  for (const at of [concept.generated?.at ?? null, ...concept.verified.map((v) => v.at)]) {
    if (at === null) continue;
    const ms = Date.parse(at);
    if (!Number.isNaN(ms) && (Number.isNaN(newestMs) || ms > newestMs)) {
      newest = at;
      newestMs = ms;
    }
  }
  return newest;
}

/**
 * `quarantined` (M49.8, K21): the knowledge files that differ from their
 * recorded history (`LedgerStatus.quarantined`). A file that MATCHES its
 * projection carries exactly the review the ledger rendered into it, so
 * reading its stamp reads the ledger. One that does not can carry any stamp
 * at all — typed in another editor, planted by a tool — so a review it
 * claims reads `disputed`, and is never trusted as `current`.
 */
export function listConcepts(
  entries: Entry[],
  today: string,
  quarantined: Quarantine = NO_QUARANTINE,
  ledger: LedgerReviewView = NO_LEDGER_REVIEW,
): Concept[] {
  const concepts = entries
    .filter(isConcept)
    .map((e) => toConcept(e, today))
    .sort((a, b) => a.id.localeCompare(b.id));
  // Supersession is gated on the review as RECORDED — the ledger's answer
  // (`LedgerStatus.recorded_human`), as Rust's `about` reads it, and the
  // file's stamp only where no ledger answers. Gating on the disputed flag
  // would let an unreviewed concept retire a verified one just because its
  // file was edited elsewhere; gating on the file would let a stamp typed
  // into it shield a concept the ledger never saw a person review.
  const recordedHuman =
    ledger.recordedHuman ?? new Set(concepts.filter(humanReviewed).map((c) => c.entry.path));
  for (const concept of concepts) {
    if (
      concept.review !== 'unreviewed' &&
      (quarantined === 'unknown' || quarantined.has(concept.entry.path))
    ) {
      concept.review = 'disputed';
    }
  }

  // Second pass: supersession is declared by the replacement, so a concept
  // cannot know it has been retired from its own frontmatter alone.
  //
  // M49.8 (K22) — and a declaration RETIRES only when it could have passed
  // review: an unreviewed concept claiming to replace a human-reviewed one
  // PROPOSES (the verified claim stays current until a person agrees), and
  // two concepts that each claim to replace the other retire neither.
  // Mirrors `knowledge::about`, which agents read.
  const declared: [Concept, Concept][] = [];
  for (const concept of concepts) {
    for (const target of concept.relations.supersedes) {
      const replaced = resolveConcept(target, concepts, entries);
      if (replaced !== null && replaced.entry.path !== concept.entry.path) {
        declared.push([concept, replaced]);
      }
    }
  }
  for (const [by, replaced] of declared) {
    const mutual = declared.some(([a, b]) => a === replaced && b === by);
    // A person who approved the replacement on its card has agreed.
    const outranked =
      recordedHuman.has(replaced.entry.path) &&
      !recordedHuman.has(by.entry.path) &&
      !ledger.approved.has(supersessionKey(by.entry.path, replaced.entry.path));
    if (mutual || outranked) replaced.replacementProposedBy = by.entry.path;
    else replaced.supersededBy = by.entry.path;
  }
  return concepts;
}

/**
 * What the assistant has learned lately that nobody has looked at (M8.3).
 *
 * The one thing Home is allowed to volunteer. It is deliberately narrow —
 * recently WRITTEN and not yet human-reviewed — because the alternative is a
 * feed, and a feed on a home screen becomes something you learn to scroll
 * past. Dismissals are filtered by the caller and remembered, so an item you
 * decline never returns.
 */
export function recentlyLearned(
  concepts: Concept[],
  today: string,
  { days = 14, limit = 3 }: { days?: number; limit?: number } = {},
): Concept[] {
  // Takes the SAME `today` string `listConcepts` does (M26.3e). It used to
  // take a `Date` and its one caller passed a second, raw `new Date()`, so a
  // render that straddled local midnight could stage concepts against one day
  // and window them against another. Comparing calendar dates as strings also
  // means the fortnight does not slide by the hour, and there is no timezone
  // in the arithmetic to get wrong.
  const cutoff = addDays(today, -days);
  return concepts
    .filter((c) => {
      if (humanReviewed(c)) return false;
      // Never offer something that has already been replaced (M8.7) — Home
      // gets three slots and spending one on a retired claim is worse than
      // leaving it empty.
      if (c.supersededBy !== null) return false;
      const at = c.generated?.at ?? null;
      if (at === null) return false;
      const stamped = at.slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(stamped) && stamped >= cutoff;
    })
    .sort((a, b) => (b.generated?.at ?? '').localeCompare(a.generated?.at ?? ''))
    .slice(0, limit);
}

// --- Review queue ----------------------------------------------------------

export type ReviewReason = 'unverified' | 'stale' | 'deprecated';

/**
 * Why a concept wants a human's attention. This is the bridge to the Inbox
 * loop: an agent writes a concept, it arrives unverified, and reviewing it
 * is what earns the human-reviewed tier.
 */
export function reviewReasons(concept: Concept): ReviewReason[] {
  // A replaced concept is resolved, not outstanding (M8.7). Asking someone to
  // verify a claim that something newer has already overridden is busywork,
  // and it is how a review queue fills up with things nobody should read.
  if (concept.supersededBy !== null) return [];
  const reasons: ReviewReason[] = [];
  if (!humanReviewed(concept)) reasons.push('unverified');
  if (concept.stale && !recheckedByPerson(concept)) reasons.push('stale');
  // M51.2 — only until a person has looked at it retired. Nothing a reviewer
  // can do clears `lifecycle`, so a deprecated concept they had already
  // verified sat in the queue for good, and a queue that cannot empty is one
  // people learn to ignore.
  if (concept.lifecycle === 'deprecated' && !humanReviewed(concept)) reasons.push('deprecated');
  return reasons;
}

/**
 * Whether a person's review ALREADY covers the recheck (M52.3): the review is
 * current and a person's, and one of their stamps falls on or after the
 * concept's `stale_after` — they read it once it was due. The stamp's day is
 * taken on the reader's calendar (`localDayOf`), the one today is counted on;
 * a stamp whose `at` is no instant covers nothing.
 *
 * The queue asks this, and only the queue. `concept.stale` stays true, so the
 * lists and the review bar still say "Due a recheck": a person looking at the
 * claim is not the claim's horizon moving, and only `recheck_concept` (or an
 * edit to `stale_after`) moves that. What changes is whose move it is. A
 * verified stale concept used to stay in the queue forever — Verify was the
 * only thing on its page a person could press, and it could not clear the row
 * — so the Review count could never reach zero. Mirrors M51.2's deprecated
 * rule, for the same reason.
 *
 * Deliberately NOT the audit's "rank awaiting-recheck last": a row a person
 * cannot clear is still a row, and counted anywhere it keeps the queue from
 * ever emptying. A horizon nobody can read as a date is never covered — no
 * review date can be compared with it — so that concept stays queued until
 * the file is fixed.
 */
function recheckedByPerson(concept: Concept): boolean {
  const due = recheckDue(concept);
  if (due === null || !humanReviewed(concept)) return false;
  return concept.verified.some((stamp) => {
    if (stamp.by.kind !== 'human') return false;
    const day = stamp.at === null ? null : localDayOf(stamp.at);
    return day !== null && day >= due;
  });
}

/**
 * A concept's recheck date, when its file gives one that can be read — the
 * RAW `stale_after`, as `isStale` judges it, so a padded `" 2026-07-01"` the
 * trimmed `concept.staleAfter` would tidy up is unreadable here too. `null`
 * for an absent horizon and for one that is no date (M52.4).
 */
export function recheckDue(concept: Concept): string | null {
  const due = staleAfterOf(concept.entry.properties.stale_after);
  return due !== null && readableHorizon(due) ? due : null;
}

/** How far past its recheck date a concept is, in words: "2 days overdue".
 * Null when either day cannot be read, or the date is today or later. */
function overdue(due: string, today: string): string | null {
  const then = Date.parse(`${due}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  const days = Math.round((now - then) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return '1 day overdue';
  if (days < 60) return `${days} days overdue`;
  if (days < 730) return `${Math.floor(days / 30)} months overdue`;
  return `${Math.floor(days / 365)} years overdue`;
}

/**
 * The line a stale concept wears, wherever it is shown — the table's hover,
 * the review bar, a subject's thread (M52.4, one format since M52.5: the page
 * said "since 2026-07-26" where the table said "2 days overdue"). How late,
 * never the ISO date: the date itself is the line's hover where it is shown.
 *
 * An unreadable horizon is stale by the shared rule, and printing it as a
 * date said "Due a recheck since null" — or "since true" — about a file whose
 * date nobody can read; the sentence says that instead.
 */
export function recheckLine(concept: Concept, today: string): string {
  const due = recheckDue(concept);
  if (due === null) return "Due a recheck — its recheck date can't be read";
  const late = overdue(due, today);
  return late === null ? 'Due a recheck today' : `Due a recheck · ${late}`;
}

export function needsReview(concept: Concept): boolean {
  return reviewReasons(concept).length > 0;
}

/**
 * The ONE reason a queued concept leads with (M51.2) — what the row says and
 * what decides its place in the queue. A list of thirteen rows all reading
 * "Unreviewed" told a person nothing about where to start, and a deprecated
 * concept a person had already reviewed sat in "Needs review" with nothing on
 * the row saying why.
 *
 * Membership is `needsReview`'s, unchanged; this only ranks it. The order is
 * what a person would do first: a file that no longer matches its recorded
 * history, then a review that no longer covers the text, then a claim past
 * its recheck date, then what was retired, then what nobody has read, and
 * last what only a process has confirmed.
 *
 * A concept nobody has ever reviewed leads with that (M52.5), even when it is
 * also due a recheck or retired: its page leads with "Unreviewed", and a row
 * that said "Due a recheck" about it named a second state for one concept.
 * What else is outstanding is its reason's sentence (`reasonText`).
 */
export type QueueReason = 'disputed' | 'changed' | 'stale' | 'deprecated' | 'new' | 'agent-only';

const QUEUE_ORDER: readonly QueueReason[] = [
  'disputed',
  'changed',
  'stale',
  'deprecated',
  'new',
  'agent-only',
];

export function queueReason(concept: Concept): QueueReason | null {
  if (!needsReview(concept)) return null;
  if (concept.review === 'disputed') return 'disputed';
  if (concept.review === 'predates_current') return 'changed';
  if (concept.review === 'unreviewed') return 'new';
  if (concept.stale) return 'stale';
  if (concept.lifecycle === 'deprecated') return 'deprecated';
  return 'agent-only';
}

export interface QueuedConcept {
  concept: Concept;
  reason: QueueReason;
}

/**
 * The review queue, in the order it should be worked (M51.2). One function
 * because three surfaces walk it — the Review tab, the sidebar count and a
 * concept page's "3 of 13 · Next" — and a queue ordered twice is a Next
 * button that skips the row you expected.
 *
 * Within a reason: the newest writing first for `new` (what just arrived is
 * what the writer still remembers), the longest-overdue first for `stale`,
 * and the title otherwise, so the order is stable between renders.
 */
export function reviewQueue(concepts: readonly Concept[]): QueuedConcept[] {
  const queued: QueuedConcept[] = [];
  for (const concept of concepts) {
    const reason = queueReason(concept);
    if (reason !== null) queued.push({ concept, reason });
  }
  return queued.sort((a, b) => {
    const rank = QUEUE_ORDER.indexOf(a.reason) - QUEUE_ORDER.indexOf(b.reason);
    if (rank !== 0) return rank;
    if (a.reason === 'new') {
      const at = (b.concept.generated?.at ?? '').localeCompare(a.concept.generated?.at ?? '');
      if (at !== 0) return at;
    }
    if (a.reason === 'stale') {
      const due = (a.concept.staleAfter ?? '').localeCompare(b.concept.staleAfter ?? '');
      if (due !== 0) return due;
    }
    return a.concept.title.localeCompare(b.concept.title);
  });
}

// --- The concept graph (M8.7) ----------------------------------------------

/**
 * Resolve one relation target to a concept.
 *
 * Two spellings are accepted for the same reason `about:` accepts two: the
 * agent writes `[[pick-queue-drain]]` because that is what it writes
 * everywhere else, and `/systems/pick-queue-drain.md` is what OKF §6.1
 * recommends. Refusing either would lose a real edge over punctuation.
 */
export function resolveConcept(
  target: string,
  concepts: readonly Concept[],
  entries: Entry[],
): Concept | null {
  const byPath = (path: string) => concepts.find((c) => c.entry.path === path) ?? null;
  if (target.startsWith('/') || target.startsWith('./') || target.endsWith('.md')) {
    const link = resolveBundleLink(target, `${KNOWLEDGE_DIR}/x.md`);
    if ('internal' in link) {
      const hit = byPath(link.internal);
      if (hit !== null) return hit;
    }
  }
  const resolved = resolveTarget(target, entries);
  return resolved === null ? null : byPath(resolved.path);
}

export interface ConceptEdge {
  kind: RelationKind;
  /** 'out' — this concept declared it. 'in' — the other end did. */
  direction: 'out' | 'in';
  concept: Concept;
  label: string;
}

/**
 * Every edge touching this concept, both the ones it declared and the ones
 * pointing at it.
 *
 * Inbound matters more than outbound. A concept that has been replaced is not
 * rewritten to say so — the replacement is what knows — so without reading the
 * graph backwards a stale claim looks exactly like a current one.
 */
export function conceptEdges(
  concept: Concept,
  concepts: readonly Concept[],
  entries: Entry[],
): ConceptEdge[] {
  const edges: ConceptEdge[] = [];
  for (const kind of RELATION_KINDS) {
    for (const target of concept.relations[kind]) {
      const other = resolveConcept(target, concepts, entries);
      if (other !== null && other.entry.path !== concept.entry.path) {
        edges.push({ kind, direction: 'out', concept: other, label: RELATION_LABELS[kind].out });
      }
    }
  }
  for (const other of concepts) {
    if (other.entry.path === concept.entry.path) continue;
    for (const kind of RELATION_KINDS) {
      // A symmetric relation declared by the other end is already covered by
      // the outbound pass when both sides declare it; dedupe on the pair.
      if (edges.some((e) => e.concept.entry.path === other.entry.path && e.kind === kind)) continue;
      const hit = other.relations[kind].some(
        (t) => resolveConcept(t, concepts, entries)?.entry.path === concept.entry.path,
      );
      if (hit) {
        edges.push({ kind, direction: 'in', concept: other, label: RELATION_LABELS[kind].in });
      }
    }
  }
  return edges;
}

/** Words too common to make two titles about the same thing. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'what',
  'when',
  'which',
  'why',
  'with',
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard over meaningful title words. */
export function titleOverlap(a: string, b: string): number {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Two concepts this similar about the same thing are almost certainly one. */
const DUPLICATE_THRESHOLD = 0.5;

/**
 * Concepts that look like the same knowledge written twice (M8.7).
 *
 * A base that only ever appends ends up holding three versions of one fact,
 * and the reader has no way to tell which to believe. Detection is
 * deliberately conservative and needs BOTH signals — anchored to a common
 * entity AND overlapping titles — because "Pick queue drain time" and "Pick
 * list generation" share a word and nothing else.
 *
 * Nothing merges automatically. Deciding two statements are the same claim is
 * a judgement, and a wrong merge destroys a source; this surfaces the pair and
 * lets a person or the agent's next revision resolve it.
 */
export function nearDuplicates(
  concept: Concept,
  concepts: readonly Concept[],
  entries: Entry[],
): Concept[] {
  const anchors = new Set(concept.about.map((t) => resolveTarget(t, entries)?.path ?? t));
  if (anchors.size === 0) return [];
  // A pair that already declares a relation is resolved, not duplicated —
  // saying "this replaces that" is exactly the act of resolving it.
  const related = new Set(
    conceptEdges(concept, concepts, entries).map((e) => e.concept.entry.path),
  );
  return concepts
    .filter((other) => {
      if (other.entry.path === concept.entry.path) return false;
      if (related.has(other.entry.path)) return false;
      const shares = other.about.some((t) => anchors.has(resolveTarget(t, entries)?.path ?? t));
      return shares && titleOverlap(concept.title, other.title) >= DUPLICATE_THRESHOLD;
    })
    .sort((a, b) => titleOverlap(concept.title, b.title) - titleOverlap(concept.title, a.title));
}

// --- One thread, read as one thing (M33a.4) --------------------------------

/**
 * A concept in this thread the bundle does not settle on.
 *
 * Two shapes of dispute, kept apart because they ask the reader for different
 * things. A REPLACED concept has been decided against and what matters is what
 * won. A CONTRADICTED one is an open disagreement nothing has resolved —
 * `contradicts` is deliberately not self-resolving (see `RELATION_LABELS`), so
 * naming the other end is the whole of what can honestly be said.
 */
export interface ContestedConcept {
  concept: Concept;
  reason: 'replaced' | 'contradicted';
  /** The concepts at the other end. Empty only when the replacement names a
   * path this bundle does not hold — a fact, not a failure. */
  others: Concept[];
}

/** A concept and when it was written. Never null: see `ThreadReading.undated`. */
export interface ChangedConcept {
  concept: Concept;
  at: string;
}

export interface KnownGroup {
  conceptType: string;
  concepts: Concept[];
}

/** One cited artifact and how many concepts in the thread lean on it. */
export interface ThreadSource {
  resource: string;
  title: string | null;
  citedBy: number;
}

/**
 * One subject, read as one thing: what is contested, what is stale, what
 * changed, what is known, and where it came from.
 *
 * Every collection here is measured. The two things that could have been
 * quietly absorbed are carried out instead — `undated` holds the concepts no
 * timestamp could place, and `uncited` the ones citing nothing — because a
 * timeline that sorts an absent date to the bottom has invented a date, and a
 * reading list that omits the concepts resting on nothing has hidden the one
 * thing a reader most needs to know about them.
 */
export interface ThreadReading {
  contested: ContestedConcept[];
  stale: Concept[];
  /** Newest first. */
  changed: ChangedConcept[];
  /** Concepts carrying no `generated.at` — NOT the oldest, just unplaced. */
  undated: Concept[];
  /** The settled remainder — neither contested nor stale — by concept type. */
  known: KnownGroup[];
  /** Deduped by resource, most-cited first. */
  sources: ThreadSource[];
  /** Concepts in the thread citing no source at all. */
  uncited: Concept[];
}

export function readThread(
  subject: Subject,
  concepts: readonly Concept[],
  entries: Entry[],
): ThreadReading {
  const thread = subject.concepts;
  const byPath = new Map(concepts.map((c) => [c.entry.path, c]));

  // Edges are read against the WHOLE bundle, not just the thread: a concept
  // contradicted from outside the thread is contradicted, and scoping the
  // search to the subject would let a dispute hide by crossing a boundary.
  const contested: ContestedConcept[] = [];
  for (const concept of thread) {
    const edges = conceptEdges(concept, concepts, entries);
    const replacedBy = edges
      .filter((e) => e.kind === 'supersedes' && e.direction === 'in')
      .map((e) => e.concept);
    if (concept.supersededBy !== null || replacedBy.length > 0) {
      const declared = byPath.get(concept.supersededBy ?? '');
      contested.push({
        concept,
        reason: 'replaced',
        others: replacedBy.length > 0 ? replacedBy : declared === undefined ? [] : [declared],
      });
      // Replaced outranks contradicted: the bundle has already decided, and
      // listing the same concept twice would read as two separate disputes.
      continue;
    }
    const disputes = edges.filter((e) => e.kind === 'contradicts').map((e) => e.concept);
    if (disputes.length > 0) contested.push({ concept, reason: 'contradicted', others: disputes });
  }
  const REASON_ORDER: Record<ContestedConcept['reason'], number> = {
    replaced: 0,
    contradicted: 1,
  };
  contested.sort(
    (a, b) =>
      REASON_ORDER[a.reason] - REASON_ORDER[b.reason] ||
      a.concept.title.localeCompare(b.concept.title),
  );

  // Staleness is INDEPENDENT of dispute — a replaced concept can also be past
  // its recheck date, and folding one into the other loses a signal.
  const stale = thread.filter((c) => c.stale);

  const disputed = new Set(contested.map((c) => c.concept.entry.path));
  const groups = new Map<string, Concept[]>();
  for (const concept of thread) {
    if (disputed.has(concept.entry.path) || concept.stale) continue;
    const list = groups.get(concept.conceptType);
    if (list === undefined) groups.set(concept.conceptType, [concept]);
    else list.push(concept);
  }
  const known = [...groups.entries()]
    .map(([conceptType, list]) => ({
      conceptType,
      concepts: [...list].sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.conceptType.localeCompare(b.conceptType));

  const changed: ChangedConcept[] = [];
  const undated: Concept[] = [];
  for (const concept of thread) {
    const at = concept.generated?.at ?? null;
    if (at === null) undated.push(concept);
    else changed.push({ concept, at });
  }
  changed.sort(
    (a, b) => b.at.localeCompare(a.at) || a.concept.title.localeCompare(b.concept.title),
  );
  undated.sort((a, b) => a.title.localeCompare(b.title));

  const cited = new Map<string, ThreadSource>();
  const uncited: Concept[] = [];
  for (const concept of thread) {
    if (concept.sources.length === 0) {
      uncited.push(concept);
      continue;
    }
    // One concept citing the same artifact twice is one concept citing it.
    const seen = new Set<string>();
    for (const source of concept.sources) {
      const key = normalizeResource(source.resource);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = cited.get(key);
      if (existing === undefined) {
        cited.set(key, { resource: source.resource, title: source.title, citedBy: 1 });
      } else {
        existing.citedBy += 1;
        // A later citation may be the one that bothered to name it.
        if (existing.title === null) existing.title = source.title;
      }
    }
  }
  const sources = [...cited.values()].sort(
    (a, b) => b.citedBy - a.citedBy || (a.title ?? a.resource).localeCompare(b.title ?? b.resource),
  );

  return { contested, stale, changed, undated, known, sources, uncited };
}

/** Frontmatter patch that records a human verification (§5.2). Appends —
 * multiple entries capture independent checks, so it never overwrites. */
export function verifyPatch(entry: Entry, actor: string, at: string): Record<string, unknown> {
  const existing = entry.properties.verified;
  const list =
    existing === undefined || existing === null
      ? []
      : Array.isArray(existing)
        ? [...existing]
        : [existing];
  return { verified: [...list, { by: actor, at }] };
}

// --- Agent provenance on ordinary notes (M7) -------------------------------

/**
 * True when a NON-human actor wrote this note. Provenance is not a knowledge-
 * bundle privilege: an agent that creates a work item or a capture stamps
 * `generated` there too, which is what makes "show me what the AI wrote"
 * answerable and the review gate meaningful.
 */
export function isAgentWritten(entry: Entry): boolean {
  const generated = parseGenerated(entry);
  return generated !== null && generated.by.kind !== 'human';
}

// --- Footnote attribution (§5.1) -------------------------------------------

/**
 * Claims are attributed with markdown footnotes whose label is a
 * `sources[].id`. Labels are keyed rather than positional because agents
 * constantly rewrite these documents — a positional index misattributes
 * silently the moment the list is reordered.
 */
export function footnoteRefs(body: string): string[] {
  const found = new Set<string>();
  // A reference is `[^id]`; a DEFINITION is `[^id]:` at line start, which
  // is not itself a citation and must not be collected.
  for (const match of body.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

// --- Bundle links (§6.1) ---------------------------------------------------

/**
 * `/tables/x.md` is bundle-relative (recommended — it survives moves),
 * `./x.md` is relative to the concept holding it, and anything carrying a
 * scheme is external.
 */
export function resolveBundleLink(
  href: string,
  fromPath: string,
): { internal: string } | { external: string } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { external: href };
  if (href.startsWith('/')) return { internal: `${KNOWLEDGE_DIR}${href}` };
  const dir = fromPath.slice(0, fromPath.lastIndexOf('/'));
  const stack: string[] = [];
  for (const segment of `${dir}/${href}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  return { internal: stack.join('/') };
}

// --- The update log (M8.1) -------------------------------------------------

/**
 * `knowledge/log.md` is the bundle's changelog — what the agent learned, when,
 * and from what. OKF reserves the filename (§3.1) but leaves the contents to
 * the producer, so this reads the shape the bundle already uses: `## <date>`
 * headings over `* **Kind**: prose` bullets.
 *
 * It is parsed rather than rendered as prose because it is the only honest
 * answer to "is this thing actually getting smarter" — and that question is
 * asked by date, by kind, and by which concept moved.
 */
export type LogKind = 'creation' | 'update' | 'deprecation' | 'verification' | 'note';

export interface LogLink {
  label: string;
  /** Vault-relative path when the link points inside the bundle, else null. */
  path: string | null;
  /** Set instead of `path` for an external URL. */
  url: string | null;
}

export interface LogEntry {
  kind: LogKind;
  /** The bolded lead as written — `kind` is the normalized form of this. */
  label: string | null;
  text: string;
  links: LogLink[];
}

export interface LogDay {
  date: string;
  entries: LogEntry[];
}

const LOG_KINDS: LogKind[] = ['creation', 'update', 'deprecation', 'verification'];

function classifyLogKind(label: string | null): LogKind {
  if (label === null) return 'note';
  const needle = label.toLowerCase();
  return LOG_KINDS.find((kind) => needle.startsWith(kind.slice(0, 6))) ?? 'note';
}

/** `[label](/playbooks/x.md)` → a followable concept reference. */
function parseLogLinks(text: string): LogLink[] {
  const links: LogLink[] = [];
  for (const match of text.matchAll(/\[([^\]^]+)\]\(([^)]+)\)/g)) {
    const target = resolveBundleLink(match[2], `${KNOWLEDGE_DIR}/log.md`);
    links.push(
      'internal' in target
        ? { label: match[1], path: target.internal, url: null }
        : { label: match[1], path: null, url: target.external },
    );
  }
  return links;
}

export function parseLog(markdown: string): LogDay[] {
  const days: LogDay[] = [];
  let current: LogDay | null = null;
  // A bullet may wrap across lines, so entries are flushed on the NEXT
  // structural line rather than when their first line is read.
  let pending: string | null = null;

  const flush = () => {
    if (pending === null || current === null) return;
    const lead = /^\*\*([^*]+)\*\*:?\s*/.exec(pending);
    const label = lead === null ? null : lead[1].trim();
    const text = lead === null ? pending : pending.slice(lead[0].length);
    current.entries.push({
      kind: classifyLogKind(label),
      label,
      text: text.trim(),
      links: parseLogLinks(text),
    });
    pending = null;
  };

  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      flush();
      current = { date: heading[1], entries: [] };
      days.push(current);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flush();
      pending = bullet[1].trim();
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    // An indented continuation belongs to the bullet above it.
    if (pending !== null) pending = `${pending} ${line.trim()}`;
  }
  flush();

  return days.filter((day) => day.entries.length > 0);
}
