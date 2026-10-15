/**
 * What an organize proposal would write, checked before anything is written
 * (M64.7).
 *
 * `propose_organize` hands the card a type, a title and free-form properties
 * from the agent. The card used to write them as given, so a person field
 * could be filed with a name that has no page, or a relation with a page of
 * the wrong type. The plan checks every proposed value against the field it
 * would land in and keeps only what resolves to a page that field allows.
 * The rest is listed on the card as not filed, with why, and never written.
 *
 * Gates read field kinds, `ingest_format` and `speakers` only, never a type
 * name (CV-08).
 */

import { isKnowledgePath } from './okf';
import { agentFieldsOf } from './assignment';
import { relationFieldTargeting, resolveViewTab } from './viewTab';
import { personCandidates } from './properties';
import { matchSpeakers, transcriptFacts } from './transcripts';
import type { Entry, FieldDef, ListFile, Schema, TabDef } from './types';
import {
  formatWikilink,
  linkTargetOf,
  linkTargetsFor,
  parseWikilinks,
  resolveTarget,
} from './wikilink';

/** The parts of an organize proposal a plan reads (agent/types' OrganizeProposal
 * fits it). Typed loosely: every field is the agent's JSON. */
export interface OrganizeAsk {
  type?: unknown;
  title?: unknown;
  properties?: Record<string, unknown>;
}

/** Why a proposed link target was not filed. */
export type UnfiledWhy = 'no page' | 'not allowed here' | 'over the limit';

export interface UnfiledTarget {
  field: string;
  target: string;
  why: UnfiledWhy;
}

/** A link field the plan writes, with the pages it reaches. */
export interface FilingLinks {
  field: string;
  pages: Entry[];
}

/** Why matched speakers did not join a person field. */
export type SpeakersWhy = 'no person field' | 'several person fields';

export interface TranscriptFiling {
  /** The trimmed summary, or null when there is nothing to summarize (no key is written). */
  summary: string | null;
  /** The person field the matched speakers joined, or null with `why`. */
  field: string | null;
  /** Matched speakers' pages that the plan added to `field`. */
  joined: Entry[];
  /** Set when matched speakers had nowhere to go; null when they joined or none matched. */
  why: SpeakersWhy | null;
}

export interface FilingPlan {
  /** The proposed type, or null when the proposal sets none. */
  type: string | null;
  /** The proposed H1 on one line, or '' when it proposes none. */
  title: string;
  /** Exactly what Apply writes to the frontmatter. */
  patch: Record<string, unknown>;
  links: FilingLinks[];
  unfiled: UnfiledTarget[];
  /** Null unless the capture is a transcript. */
  transcript: TranscriptFiling | null;
}

/**
 * The H1 a proposal names, on one line: a newline in the agent's title would
 * write body lines the card never displayed. `typeof`, since the title is the
 * agent's JSON and a number must not throw mid-render.
 */
function oneLineTitle(title: unknown): string {
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
}

/** A proposed value's link targets: wikilinks bracket-stripped, plain names as written. */
function targetsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((v) => {
    if (typeof v !== 'string' && typeof v !== 'number') return [];
    const links = parseWikilinks(v);
    if (links !== null) return links;
    const name = String(v).trim();
    return name === '' ? [] : [name];
  });
}

const isLinkKind = (def: FieldDef): boolean => def.kind === 'person' || def.kind === 'relation';

/**
 * Plan one organize proposal against the capture, the schema and the vault.
 *
 * Each property is checked against the proposed type's field, or the
 * capture's own type's when none is proposed:
 * - a person field keeps targets, plain names included, that resolve to one
 *   of the field's `personCandidates`;
 * - a relation keeps pages of its `target` type, and an untargeted one any
 *   page that is not a Type doc or under knowledge/;
 * - a derived two-way field is never written;
 * - an undeclared key keeps only the links that resolve, and plain values.
 * Kept links are written as the name that reaches their page, a `limit: 1`
 * field keeps the first, and a field left empty is omitted.
 *
 * For a transcript, the summary is trimmed (blank writes no key), and its
 * matched speakers join the one person field the proposal fills.
 */
export function filingPlan(
  proposal: OrganizeAsk,
  entry: Entry,
  schema: Schema,
  entries: Entry[],
): FilingPlan {
  const type = typeof proposal.type === 'string' ? proposal.type : null;
  const title = oneLineTitle(proposal.title);
  const typeName = type ?? entry.type;
  const typeDef = typeName === null ? undefined : schema.types.get(typeName);
  const owner: Entry = { ...entry, type: typeName };
  const nameOf = linkTargetsFor(entries);
  const linkOf = (page: Entry) => formatWikilink(nameOf(page) ?? linkTargetOf(page));

  const facts = transcriptFacts(entry);
  const patch: Record<string, unknown> = {};
  const links: FilingLinks[] = [];
  const unfiled: UnfiledTarget[] = [];
  // Link fields' kept pages, written once speakers have had their turn.
  const linkFields: { field: string; def: FieldDef | null; pages: Entry[] }[] = [];

  const allowed = (def: FieldDef, page: Entry): boolean => {
    if (def.kind === 'person') {
      return personCandidates(def, schema, entries, owner).some((c) => c.path === page.path);
    }
    if (def.target !== undefined && def.target !== '') return page.type === def.target;
    return page.type !== 'Type' && !isKnowledgePath(page.path);
  };

  let summary: string | null = null;
  for (const [key, value] of Object.entries(proposal.properties ?? {})) {
    if (value === null || value === undefined) continue;
    if (facts !== null && key === 'summary') {
      const text = typeof value === 'string' ? value.trim() : '';
      summary = text === '' ? null : text;
      continue;
    }
    const def = typeDef?.fields.find((f) => f.name === key) ?? null;
    if (def !== null && isLinkKind(def)) {
      if (def.from !== undefined) {
        for (const target of targetsOf(value)) {
          unfiled.push({ field: key, target, why: 'not allowed here' });
        }
        continue;
      }
      const pages: Entry[] = [];
      for (const target of targetsOf(value)) {
        const page = resolveTarget(target, entries);
        if (page === null) unfiled.push({ field: key, target, why: 'no page' });
        else if (!allowed(def, page)) unfiled.push({ field: key, target, why: 'not allowed here' });
        else if (!pages.some((p) => p.path === page.path)) pages.push(page);
      }
      linkFields.push({ field: key, def, pages });
      continue;
    }
    if (def === null && parseWikilinks(value) !== null) {
      const pages: Entry[] = [];
      for (const target of targetsOf(value)) {
        const page = resolveTarget(target, entries);
        if (page === null) unfiled.push({ field: key, target, why: 'no page' });
        else if (!pages.some((p) => p.path === page.path)) pages.push(page);
      }
      linkFields.push({ field: key, def: null, pages });
      continue;
    }
    patch[key] = value;
  }

  let transcript: TranscriptFiling | null = null;
  if (facts !== null) {
    if (summary !== null) patch.summary = summary;
    const matched = matchSpeakers(facts.speakers ?? [], schema, entries).flatMap((m) =>
      m.kind === 'matched' ? [m.page] : [],
    );
    const personFields = linkFields.filter((f) => f.def?.kind === 'person');
    transcript = { summary, field: null, joined: [], why: null };
    if (matched.length > 0) {
      if (personFields.length === 1) {
        const [target] = personFields;
        const joined = matched.filter((page) => !target.pages.some((p) => p.path === page.path));
        target.pages.push(...joined);
        transcript = { summary, field: target.field, joined, why: null };
      } else {
        transcript = {
          summary,
          field: null,
          joined: [],
          why: personFields.length === 0 ? 'no person field' : 'several person fields',
        };
      }
    }
  }

  for (const { field, def, pages } of linkFields) {
    const kept = def?.limit === 1 ? pages.slice(0, 1) : pages;
    for (const page of pages.slice(kept.length)) {
      unfiled.push({ field, target: page.title, why: 'over the limit' });
    }
    if (kept.length === 0) continue;
    patch[field] = kept.map(linkOf);
    links.push({ field, pages: kept });
  }

  if (type !== null) patch.type = type;
  return { type, title, patch, links, unfiled, transcript };
}

/** A stored relation files records only when the host's related tab lists them. */
export function filingFields(
  recordType: string,
  schema: Schema,
): { hostType: string; field: string }[] {
  const result: { hostType: string; field: string }[] = [];
  for (const [hostType, definition] of schema.types) {
    if (
      !definition.tabs.some(
        (tab) =>
          tab.content === 'view' &&
          tab.scope === 'related' &&
          tab.source != null &&
          'type' in tab.source &&
          tab.source.type === recordType,
      )
    )
      continue;
    const field = relationFieldTargeting(recordType, hostType, schema);
    if (field !== null) result.push({ hostType, field: field.name });
  }
  return result;
}

/** Resolved filing hosts, in path order; a dependency link is never a host. */
export function hostsOf(entry: Entry, entries: readonly Entry[], schema: Schema): Entry[] {
  if (entry.type === null || entry.parseError !== null) return [];
  const hosts = new Map<string, Entry>();
  for (const { hostType, field } of filingFields(entry.type, schema)) {
    for (const target of entry.relationships[field] ?? []) {
      const host = resolveTarget(target, entries);
      if (host !== null && host.type === hostType && host.parseError === null)
        hosts.set(host.path, host);
    }
  }
  return [...hosts.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface FiledType {
  tab: TabDef;
  recordType: string;
  field: string;
  receiving: string | null;
}

/** Related tabs declare which stored fields file records under this host. */
export function filedTypesOf(hostType: string | null, schema: Schema): FiledType[] {
  if (hostType === null) return [];
  return (schema.types.get(hostType)?.tabs ?? []).flatMap((tab) => {
    if (
      tab.content !== 'view' ||
      tab.scope !== 'related' ||
      tab.source == null ||
      !('type' in tab.source)
    )
      return [];
    const recordType = tab.source.type;
    const field = relationFieldTargeting(recordType, hostType, schema);
    if (field === null) return [];
    const receiving = agentFieldsOf(recordType, schema);
    return [
      {
        tab,
        recordType,
        field: field.name,
        receiving: receiving.length === 1 ? receiving[0].name : null,
      },
    ];
  });
}

/** The page and the records its related tabs actually list, once in path order. */
export function pagesFiledUnder(
  host: Entry,
  entries: Entry[],
  schema: Schema,
  views: ListFile[] = [],
): string[] {
  const paths = new Set([host.path]);
  for (const tab of host.type === null ? [] : (schema.types.get(host.type)?.tabs ?? [])) {
    if (tab.content !== 'view' || tab.scope !== 'related') continue;
    const resolution = resolveViewTab(tab, host, entries, schema, views);
    if (resolution.kind === 'ok')
      for (const entry of resolution.surface.entries) paths.add(entry.path);
  }
  return [...paths].sort();
}
