import { isKnowledgePath } from '@/engine/okf';
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

export interface RecordSummary {
  path: string;
  title: string;
  type: string | null;
  properties: Record<string, unknown>;
}

export interface ContextSnapshot {
  selection: Record<string, unknown>;
  activeNote?: RecordSummary & { body?: string };
  linkedNotes?: { path: string; title: string; type: string | null }[];
  visibleRecords?: RecordSummary[];
  visibleRecordsTruncated?: { shown: number; total: number };
  visibleFilters?: unknown;
  referencedNotes?: (RecordSummary & { body?: string })[];
  vault: { types: string[]; projects: number; notes: number };
}

function summarize(entry: Entry, schema: Schema, fields?: string[]): RecordSummary {
  const properties: Record<string, unknown> = {};
  const names =
    fields ?? (entry.type === null ? [] : (schema.types.get(entry.type)?.fields ?? []).map((f) => f.name));
  for (const name of names) {
    const resolved = schema.resolveField(entry, name);
    if (resolved.display !== '') properties[name] = resolved.display;
  }
  return { path: entry.path, title: entry.title, type: entry.type, properties };
}

function describeSelection(selection: Selection): Record<string, unknown> {
  switch (selection.kind) {
    case 'doc':
    case 'project':
      return { kind: selection.kind, path: selection.path };
    case 'list':
      return { kind: 'list', id: selection.id };
    case 'type':
      return { kind: 'type', name: selection.name };
    default:
      return { kind: selection.kind };
  }
}

export interface SnapshotInput {
  selection: Selection;
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
}

export function buildSnapshot(input: SnapshotInput): ContextSnapshot {
  const { selection, entries, schema, activePath, activeBody, visible, filters, references } = input;

  const snapshot: ContextSnapshot = {
    selection: describeSelection(selection),
    vault: {
      types: [...schema.types.keys()],
      projects: entries.filter((e) => e.type === 'Project').length,
      // The knowledge bundle is the agent's own corpus; counting it here
      // would report its output back to it as if it were the user's work.
      notes: entries.filter((e) => !isKnowledgePath(e.path)).length,
    },
  };

  const active = activePath == null ? null : entries.find((e) => e.path === activePath) ?? null;
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

  if (references !== undefined && references.length > 0) {
    const resolved = references
      .map((target) => resolveTarget(target, entries))
      .filter((e): e is Entry => e !== null)
      .map((e) => ({ ...summarize(e, schema), body: e.snippet }));
    if (resolved.length > 0) snapshot.referencedNotes = resolved;
  }

  return snapshot;
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
