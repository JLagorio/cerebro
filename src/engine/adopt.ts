import { isTemplate } from '@/lib/templates';
import { isKnowledgePath } from './okf';
import { coerceValueToKind, isSystemProperty, validateValue } from './properties';
import type { Entry, FieldKind, Schema } from './types';
import { resolveTarget } from './wikilink';

/**
 * Vault adoption (M12.6) — the schema doctor.
 *
 * Opening an existing Obsidian vault means opening years of frontmatter that
 * grew without a schema: `type: risks` on thirty notes with no Type doc,
 * `severity` that is "high" on some notes and 3 on others, dates written as
 * prose. Tolaria's answer is "types are lenses, no validation"; ours is the
 * opposite — records belong to types with declared fields — so the gap has
 * to be CROSSED, not ignored.
 *
 * This module is the read side: it clusters records by `type:`, infers a
 * field kind per frontmatter key from the values actually stored, and
 * computes the exact writes that would make every record fit — a Type doc
 * declaration per cluster, and a value conversion (or clearance) per record
 * that disagrees. Nothing here writes; the wizard shows the plan and
 * `applyAdoption` (app layer) executes exactly what was approved. Running it
 * on an already-adopted vault proposes nothing — the Repair Vault rule:
 * idempotent, count what changed.
 */

export interface FieldProposal {
  name: string;
  kind: FieldKind;
  /** Already declared on the Type doc (proposal only repairs values). */
  declared: boolean;
  /** Records of the type carrying this key / records of the type. */
  coverage: number;
  /** Up to three raw values, stringified, for the wizard's preview. */
  samples: string[];
  /** Option ids seeded from distinct values (select/multiselect/status). */
  options: string[] | null;
  /** Majority type of resolved link targets (relation). */
  target: string | null;
  /** Per-record writes needed to fit the kind; null value clears the key. */
  convert: { path: string; value: unknown }[];
}

export interface TypeProposal {
  name: string;
  /** The declaring Type doc, or null for a ghost type (one will be created). */
  docPath: string | null;
  records: number;
  fields: FieldProposal[];
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** Adoptable records: content with a type, minus schema/scaffolding/corpus. */
function isAdoptable(e: Entry): boolean {
  return (
    e.type !== null &&
    e.type !== '' &&
    e.type !== 'Type' &&
    !isTemplate(e) &&
    !isKnowledgePath(e.path)
  );
}

/**
 * Infer a kind from the values a key actually holds across a cluster.
 *
 * Majority-based on purpose: a vault where `likelihood` is 3 on most notes
 * and "unknown" on one should read as a NUMBER with one straggler to clear —
 * drift is the reason this doctor exists, so unanimity can't be the bar.
 */
export function inferKind(keyName: string, values: unknown[]): FieldKind {
  const flat = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (flat.length === 0) return 'text';
  const share = (pred: (v: unknown) => boolean) =>
    flat.filter(pred).length / flat.length;
  if (flat.some((v) => Array.isArray(v))) return 'multiselect';
  if (share((v) => typeof v === 'boolean') >= 2 / 3) return 'checkbox';
  if (share((v) => typeof v === 'number') >= 2 / 3) return 'number';
  if (share((v) => typeof v === 'string' && ISO_DATE_PREFIX.test(v)) >= 2 / 3) return 'date';
  if (keyName.toLowerCase() === 'status') return 'status';
  // A small vocabulary of short scalar values reads as a select — the
  // Tolaria display-mode heuristic, hardened to need real repetition.
  const strings = flat.filter((v): v is string => typeof v === 'string');
  const distinct = new Set(strings.map((s) => s.trim().toLowerCase()));
  if (
    strings.length === flat.length &&
    flat.length >= 3 &&
    distinct.size <= 8 &&
    distinct.size < flat.length &&
    strings.every((s) => s.length <= 24)
  ) {
    return 'select';
  }
  return 'text';
}

/** Majority type among what a relation key's raw targets resolve to. */
function inferTarget(rawTargets: string[], entries: Entry[]): string | null {
  const counts = new Map<string, number>();
  for (const raw of rawTargets) {
    const resolved = resolveTarget(raw, entries);
    if (resolved === null || resolved.type === null || resolved.type === '') continue;
    counts.set(resolved.type, (counts.get(resolved.type) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

function sample(values: unknown[]): string[] {
  return values
    .filter((v) => v !== null && v !== undefined && v !== '')
    .slice(0, 3)
    .map((v) => (Array.isArray(v) ? v.map(String).join(', ') : String(v)));
}

/**
 * The full plan for one vault: a proposal per type that needs anything —
 * a ghost type needing declaration, or a declared type whose records carry
 * undeclared keys or ill-fitting values. Fully adopted vaults yield [].
 */
export function analyzeVault(entries: Entry[], schema: Schema): TypeProposal[] {
  const clusters = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!isAdoptable(e)) continue;
    const bucket = clusters.get(e.type as string);
    if (bucket === undefined) clusters.set(e.type as string, [e]);
    else bucket.push(e);
  }

  const proposals: TypeProposal[] = [];
  for (const [typeName, records] of clusters) {
    const typeDef = schema.types.get(typeName);
    const declared = new Map((typeDef?.fields ?? []).map((f) => [f.name, f]));
    const doc = entries.find((e) => e.type === 'Type' && e.title === typeName) ?? null;

    // Every key the cluster's records actually carry.
    const keys = new Map<string, { scalar: unknown[]; rel: string[][]; carriers: number }>();
    for (const record of records) {
      const seen = new Set<string>();
      for (const [key, value] of Object.entries(record.properties)) {
        if (isSystemProperty(key) || key === 'type' || key === 'key') continue;
        const slot = keys.get(key) ?? { scalar: [], rel: [], carriers: 0 };
        slot.scalar.push(value);
        if (!seen.has(key)) {
          slot.carriers += 1;
          seen.add(key);
        }
        keys.set(key, slot);
      }
      for (const [key, targets] of Object.entries(record.relationships)) {
        if (isSystemProperty(key)) continue;
        const slot = keys.get(key) ?? { scalar: [], rel: [], carriers: 0 };
        slot.rel.push(targets);
        if (!seen.has(key)) {
          slot.carriers += 1;
          seen.add(key);
        }
        keys.set(key, slot);
      }
    }

    const fields: FieldProposal[] = [];
    for (const [key, slot] of keys) {
      const existing = declared.get(key);
      const isRelationKey = slot.rel.length > 0 && slot.scalar.length === 0;
      const kind: FieldKind =
        existing !== undefined
          ? existing.kind
          : isRelationKey
            ? 'relation'
            : inferKind(key, slot.scalar);

      // What each record would need to store to fit the kind.
      const convert: { path: string; value: unknown }[] = [];
      const probe = { name: key, kind } as const;
      const finalValues: unknown[] = [];
      for (const record of records) {
        const stored =
          record.relationships[key] !== undefined
            ? record.relationships[key]
            : record.properties[key];
        if (stored === undefined || stored === null || stored === '') continue;
        if (validateValue(probe, stored) === null) {
          finalValues.push(stored);
          continue;
        }
        const coerced = coerceValueToKind(stored, kind);
        convert.push({ path: record.path, value: coerced });
        if (coerced !== null) finalValues.push(coerced);
      }

      // Nothing to do for a declared field whose values all fit.
      if (existing !== undefined && convert.length === 0) continue;

      const optionKinds: FieldKind[] = ['select', 'multiselect', 'status'];
      const options = optionKinds.includes(kind)
        ? [
            ...new Set(
              finalValues
                .flatMap((v) => (Array.isArray(v) ? v : [v]))
                .filter((v): v is string => typeof v === 'string' && v !== ''),
            ),
          ].slice(0, 24)
        : null;

      fields.push({
        name: key,
        kind,
        declared: existing !== undefined,
        coverage: records.length === 0 ? 0 : slot.carriers / records.length,
        samples: sample([...slot.scalar, ...slot.rel]),
        options: options !== null && options.length > 0 ? options : null,
        target:
          kind === 'relation' && existing?.target === undefined
            ? inferTarget(
                slot.rel.flat(),
                entries,
              )
            : (existing?.target ?? null),
        convert,
      });
    }

    // A cluster earns a proposal when anything is missing: no Type doc at
    // all, or at least one undeclared key or ill-fitting value.
    if (doc === null || fields.length > 0) {
      fields.sort((a, b) => b.coverage - a.coverage || a.name.localeCompare(b.name));
      proposals.push({ name: typeName, docPath: doc?.path ?? null, records: records.length, fields });
    }
  }

  return proposals.sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));
}
