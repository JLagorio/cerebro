import type { Entry } from './types';

/**
 * Knowledge (M5) — the AI knowledge base, modelled on the Open Knowledge
 * Format v0.2 (docs/knowledge-catalog-main/okf/SPEC.md).
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

// --- The concept view-model ------------------------------------------------

export interface Concept {
  entry: Entry;
  /** Path with `.md` dropped — the OKF concept ID (§2). */
  id: string;
  title: string;
  description: string | null;
  /** OKF `type:`, free-form and NOT one of cerebro's declared types. */
  conceptType: string;
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
