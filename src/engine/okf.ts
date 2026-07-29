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

export function isKnowledgePath(path: string): boolean {
  return path === KNOWLEDGE_DIR || path.startsWith(`${KNOWLEDGE_DIR}/`);
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

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

export const TRUST_LABELS: Record<TrustTier, string> = {
  unverified: 'Unverified',
  'machine-confirmed': 'Machine-confirmed',
  'human-reviewed': 'Human-reviewed',
};

/** §5.3, lowest to highest. Advisory signal — never access control. */
export function trustTier(entry: Entry): TrustTier {
  const verified = parseVerified(entry);
  if (verified.length === 0) return 'unverified';
  return verified.some((v) => v.by.kind === 'human') ? 'human-reviewed' : 'machine-confirmed';
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
  return asString(entry.properties.stale_after);
}

export function isStale(entry: Entry, today: string): boolean {
  const after = staleAfter(entry);
  return after !== null && today >= after;
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

/**
 * The bundle sub-directory a concept sits in — `metrics`, `playbooks`,
 * `systems`. OKF §3 gives directories no meaning of their own, but the
 * bundle's own `index.md` lists them as sections, so they are the shape the
 * author already chose. Top level only: `knowledge/a/b/c.md` is in `a`.
 */
export function sectionOf(entry: Entry): string {
  const rest = entry.path.slice(KNOWLEDGE_DIR.length + 1);
  const cut = rest.indexOf('/');
  return cut === -1 ? '' : rest.slice(0, cut);
}

export interface Section {
  /** Directory name; '' for concepts at the bundle root. */
  folder: string;
  label: string;
  count: number;
}

const humanizeFolder = (folder: string): string =>
  folder === ''
    ? 'Ungrouped'
    : folder.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function listSections(concepts: Concept[]): Section[] {
  const counts = new Map<string, number>();
  for (const concept of concepts) {
    counts.set(concept.section, (counts.get(concept.section) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, label: humanizeFolder(folder), count }))
    // Root-level concepts sort last: they are the leftovers, not a section.
    .sort((a, b) => (a.folder === '' ? 1 : b.folder === '' ? -1 : a.label.localeCompare(b.label)));
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
  const subjects = new Map<string, Subject>();
  for (const concept of concepts) {
    for (const target of concept.about) {
      const entry = resolveTarget(target, entries);
      const key = entry?.path ?? target.toLowerCase();
      const existing = subjects.get(key);
      if (existing === undefined) {
        subjects.set(key, {
          key,
          target,
          entry,
          label: entry?.title ?? target,
          concepts: [concept],
        });
      } else {
        existing.concepts.push(concept);
      }
    }
  }
  return [...subjects.values()].sort((a, b) => a.label.localeCompare(b.label));
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
export function conceptsFrom(path: string, concepts: Concept[]): Concept[] {
  return concepts.filter((c) => c.sources.some((s) => normalizeResource(s.resource) === path));
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
export function commitOf(entry: Entry, concepts: Concept[]): Commit {
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
  const linked = [
    ...entry.outgoingLinks,
    ...Object.values(entry.relationships).flat(),
  ];
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
  trust: TrustTier;
  lastVerified: string | null;
  lifecycle: Lifecycle;
  staleAfter: string | null;
  stale: boolean;
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
    trust: trustTier(entry),
    lastVerified: lastVerifiedAt(entry),
    lifecycle: lifecycleOf(entry),
    staleAfter: staleAfter(entry),
    stale: isStale(entry, today),
  };
}

export function listConcepts(entries: Entry[], today: string): Concept[] {
  return entries
    .filter(isConcept)
    .map((e) => toConcept(e, today))
    .sort((a, b) => a.id.localeCompare(b.id));
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
  now: Date,
  { days = 14, limit = 3 }: { days?: number; limit?: number } = {},
): Concept[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return concepts
    .filter((c) => {
      if (c.trust === 'human-reviewed') return false;
      const at = c.generated?.at ?? null;
      if (at === null) return false;
      const stamped = Date.parse(at);
      return !Number.isNaN(stamped) && stamped >= cutoff;
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
  const reasons: ReviewReason[] = [];
  if (concept.trust !== 'human-reviewed') reasons.push('unverified');
  if (concept.stale) reasons.push('stale');
  if (concept.lifecycle === 'deprecated') reasons.push('deprecated');
  return reasons;
}

export function needsReview(concept: Concept): boolean {
  return reviewReasons(concept).length > 0;
}

/** Frontmatter patch that records a human verification (§5.2). Appends —
 * multiple entries capture independent checks, so it never overwrites. */
export function verifyPatch(entry: Entry, actor: string, at: string): Record<string, unknown> {
  const existing = entry.properties.verified;
  const list = existing === undefined || existing === null
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
