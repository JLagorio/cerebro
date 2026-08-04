import { conceptsAbout, isKnowledgePath, type Concept, type TrustTier } from '@/engine/okf';
import type { Entry, Schema, Selection } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';

/**
 * The structured context snapshot (M9.5).
 *
 * Replaces a single line of prose ("the user is looking at X"). The agent
 * cannot answer "what is at risk" well from a view id — it has to re-derive
 * the query, and it will guess differently than the view does.
 *
 * `visibleRecords` is the cerebro-specific addition and the valuable one:
 * when you ask about what is on screen, the agent should see what is on
 * screen. It travels with the view's filters so the agent knows the list is
 * a filtered subset rather than the whole type — without that, a follow-up
 * question gets answered against the wrong population.
 */

/** Caps. A snapshot that fills the context window starves the actual turn. */
const MAX_RECORDS = 40;
const MAX_LINKED = 12;
const MAX_BODY = 4000;
/** Concepts per turn (M17.20). Small on purpose: this is the precise,
 * anchor-reached subset, and a turn that spends its budget on background
 * belief has less room for the question. The agent can always read more with
 * its own tools — which is the tier-two half of the same idea as skills. */
const MAX_CONCEPTS = 8;

export interface RecordSummary {
  path: string;
  title: string;
  type: string | null;
  properties: Record<string, unknown>;
}

export interface ContextSnapshot {
  /** Omitted when the user removed the place chip (M17.6) — "do not tell it
   * where I am standing" is a thing they are allowed to say, and an empty
   * object here would say it badly. */
  selection?: Record<string, unknown>;
  /**
   * Where this conversation started, when the user has since moved.
   *
   * A fact, not a UI decision. The panel briefly answered "you walked away" by
   * asking the user to start a new thread — the app making its own bookkeeping
   * their problem, and unnecessary, because the model can hold two facts at
   * once. Tell it where the conversation began and where the user is now, and
   * it reconciles them the way a person would.
   */
  startedIn?: string;
  activeNote?: RecordSummary & { body?: string };
  linkedNotes?: { path: string; title: string; type: string | null }[];
  visibleRecords?: RecordSummary[];
  visibleRecordsTruncated?: { shown: number; total: number };
  visibleFilters?: unknown;
  referencedNotes?: (RecordSummary & { body?: string })[];
  /** Records the user attached as context chips (M17.6). Separate from
   * `referencedNotes` because those are `[[links]]` found in the prompt — a
   * guess about what was meant — while these were put there on purpose. */
  attachedNotes?: (RecordSummary & { body?: string })[];
  /**
   * What the knowledge bundle believes about the records already in context
   * (M17.20).
   *
   * Reached by `about:` ANCHOR, never by similarity. That is the whole design
   * decision: retrieval by embedding would hand the turn semantically-adjacent
   * distractors, which hurt an answer more than sheer length does, while an
   * anchor is a claim someone made that this concept is knowledge OF this
   * record. Every `about:` wikilink written since M8 pays off here and nowhere
   * else — until now the bundle was mentioned to the agent and never shown to
   * it, so a conversation about a project could not see what the base had
   * already concluded about that project.
   *
   * Contradictions and unverified claims lead, because the useful thing to
   * say is rarely the settled thing.
   */
  knowledge?: KnowledgeNote[];
  vault: { types: string[]; projects: number; notes: number };
}

export interface KnowledgeNote {
  path: string;
  title: string;
  /** The claim itself — a concept's description is the whole of its content
   * for this purpose; the body is elaboration. */
  claim: string;
  /** unverified | machine-confirmed | human-reviewed. The agent must be able
   * to weight a claim by whether a person has actually stood behind it. */
  trust: TrustTier;
  /** Which record in context this is knowledge OF. */
  about: string;
  /** Set when another concept contradicts this one — the single most useful
   * thing the bundle can say, and useless if it does not travel. */
  contradictedBy?: string[];
  /** Set when this claim has been replaced. Carried so the agent does not
   * quote a retired belief as current. */
  supersededBy?: string;
  stale?: boolean;
}

function summarize(entry: Entry, schema: Schema, fields?: string[]): RecordSummary {
  const properties: Record<string, unknown> = {};
  const names =
    fields ??
    (entry.type === null ? [] : (schema.types.get(entry.type)?.fields ?? []).map((f) => f.name));
  for (const name of names) {
    const resolved = schema.resolveField(entry, name);
    if (resolved.display !== '') properties[name] = resolved.display;
  }
  return { path: entry.path, title: entry.title, type: entry.type, properties };
}

function describeSelection(selection: Selection): Record<string, unknown> {
  switch (selection.kind) {
    case 'doc':
      return { kind: selection.kind, path: selection.path };
    case 'collection':
      return { kind: 'collection', folder: selection.folder };
    case 'list':
      return { kind: 'list', id: selection.id };
    case 'type':
      return { kind: 'type', name: selection.name };
    default:
      return { kind: selection.kind };
  }
}

export interface SnapshotInput {
  /** Absent when the place chip was removed. */
  selection?: Selection;
  entries: Entry[];
  schema: Schema;
  /** The record open in the detail panel or doc page. */
  activePath?: string | null;
  /** Its raw body, when the editor has it loaded. */
  activeBody?: string | null;
  /** The rows the current surface is showing. */
  visible?: Entry[];
  /** The active view's filters, so a subset is not mistaken for the whole. */
  filters?: unknown;
  /** `[[wikilinks]]` the user typed into the prompt. */
  references?: string[];
  /** Vault paths attached as context chips (M17.6). Resolved by exact path,
   * unlike `references`, which are wikilink targets matched by stem or title. */
  attached?: string[];
  /** Where the conversation began, when that is not where the user is now. */
  startedIn?: string | null;
  /** The knowledge bundle, for the `about:` lookup (M17.20). Absent means the
   * caller has not derived it — the snapshot then carries no knowledge at all
   * rather than silently claiming the base is empty. */
  concepts?: Concept[];
}

export function buildSnapshot(input: SnapshotInput): ContextSnapshot {
  const {
    selection,
    entries,
    schema,
    activePath,
    activeBody,
    visible,
    filters,
    references,
    attached,
    startedIn,
  } = input;

  const snapshot: ContextSnapshot = {
    ...(selection === undefined ? {} : { selection: describeSelection(selection) }),
    ...(startedIn == null ? {} : { startedIn }),
    vault: {
      types: [...schema.types.keys()],
      projects: entries.filter((e) => e.type === 'Project').length,
      // The knowledge bundle is the agent's own corpus; counting it here
      // would report its output back to it as if it were the user's work.
      notes: entries.filter((e) => !isKnowledgePath(e.path)).length,
    },
  };

  const active = activePath == null ? null : (entries.find((e) => e.path === activePath) ?? null);
  if (active !== null) {
    snapshot.activeNote = {
      ...summarize(active, schema),
      ...(activeBody != null && activeBody.trim() !== ''
        ? { body: activeBody.slice(0, MAX_BODY) }
        : {}),
    };

    const linked: { path: string; title: string; type: string | null }[] = [];
    const seen = new Set<string>([active.path]);
    const add = (target: string) => {
      if (linked.length >= MAX_LINKED) return;
      const entry = resolveTarget(target, entries);
      if (entry === null || seen.has(entry.path)) return;
      seen.add(entry.path);
      linked.push({ path: entry.path, title: entry.title, type: entry.type });
    };
    for (const target of active.outgoingLinks) add(target);
    for (const targets of Object.values(active.relationships)) for (const t of targets) add(t);
    if (linked.length > 0) snapshot.linkedNotes = linked;
  }

  if (visible !== undefined && visible.length > 0) {
    snapshot.visibleRecords = visible.slice(0, MAX_RECORDS).map((e) => summarize(e, schema));
    if (visible.length > MAX_RECORDS) {
      // Say what was dropped. A silently truncated list reads as the whole
      // population, and the agent will reason about it as one.
      snapshot.visibleRecordsTruncated = { shown: MAX_RECORDS, total: visible.length };
    }
    if (filters != null) snapshot.visibleFilters = filters;
  }

  if (attached !== undefined && attached.length > 0) {
    const resolved = attached
      // The active note is already in the snapshot in full, with its links —
      // repeating it here would spend context saying the same thing twice.
      .filter((path) => path !== activePath)
      .map((path) => entries.find((e) => e.path === path))
      .filter((e): e is Entry => e !== undefined)
      .map((e) => ({ ...summarize(e, schema), body: e.snippet }));
    if (resolved.length > 0) snapshot.attachedNotes = resolved;
  }

  // M17.20 — what the base believes about what is already in context.
  const subjects = [
    ...(active === null ? [] : [active.path]),
    ...(attached ?? []),
    ...(visible ?? []).slice(0, MAX_RECORDS).map((e) => e.path),
  ];
  const knowledge = knowledgeFor(subjects, input.concepts ?? [], entries);
  if (knowledge.length > 0) snapshot.knowledge = knowledge;

  if (references !== undefined && references.length > 0) {
    const resolved = references
      .map((target) => resolveTarget(target, entries))
      .filter((e): e is Entry => e !== null)
      .map((e) => ({ ...summarize(e, schema), body: e.snippet }));
    if (resolved.length > 0) snapshot.referencedNotes = resolved;
  }

  return snapshot;
}

/**
 * What the base believes about the records in context (M17.20).
 *
 * Ordered by how much the agent needs to know it, not by how confident the
 * base is: a contradiction is the single most useful thing a knowledge base
 * can say, and a superseded claim is the most dangerous thing to quote as
 * current. Verified-and-settled sorts last precisely because it is least
 * likely to change an answer.
 */
function knowledgeFor(
  subjects: readonly string[],
  concepts: readonly Concept[],
  entries: Entry[],
): KnowledgeNote[] {
  if (concepts.length === 0 || subjects.length === 0) return [];
  const seen = new Set<string>();
  const notes: KnowledgeNote[] = [];
  // Deduped across subjects: one concept anchored to three records in the same
  // view is one belief, not three.
  for (const path of [...new Set(subjects)]) {
    for (const concept of conceptsAbout(path, concepts as Concept[], entries)) {
      if (seen.has(concept.entry.path)) continue;
      seen.add(concept.entry.path);
      const contradicted = concept.relations.contradicts;
      notes.push({
        path: concept.entry.path,
        title: concept.title,
        claim: concept.description ?? concept.entry.snippet,
        trust: concept.trust,
        about: path,
        ...(contradicted.length > 0 ? { contradictedBy: contradicted } : {}),
        ...(concept.supersededBy === null ? {} : { supersededBy: concept.supersededBy }),
        ...(concept.stale ? { stale: true } : {}),
      });
    }
  }
  const weight = (n: KnowledgeNote): number => {
    if (n.supersededBy !== undefined) return 0;
    if (n.contradictedBy !== undefined) return 1;
    if (n.stale === true) return 2;
    if (n.trust === 'unverified') return 3;
    if (n.trust === 'machine-confirmed') return 4;
    return 5;
  };
  return notes.sort((a, b) => weight(a) - weight(b)).slice(0, MAX_CONCEPTS);
}

/** The snapshot as a system-prompt suffix. */
export function renderSnapshot(snapshot: ContextSnapshot): string {
  return [
    '',
    '## Context snapshot',
    'What the user is looking at right now. Prefer these records over re-deriving the query.',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
  ].join('\n');
}

/** Extract `[[wikilink]]` targets the user typed. */
export function extractReferences(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const [target] = match[1].split('|');
    const trimmed = target.trim();
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
