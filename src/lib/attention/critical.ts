/**
 * `shared/policy/critical-attention.v1.json` — §8's bypass, TS side (M27.7).
 *
 * The SAME FILE the Rust core compiles in with `include_str!`, imported
 * verbatim by vite. Nothing here restates a rule: no trigger id, no field
 * name, no duration and no operator is written in TypeScript. What lives in
 * this module is the generic machinery that reads the artifact — and the
 * parity mechanism is the shared goldens in `shared/policy/goldens-critical/`,
 * replayed by `cargo test` and by `pnpm test:run` from the same bytes.
 *
 * **It is not a Risk model.** No score, no severity, no threshold anybody can
 * tune. A trigger matches its typed fields exactly or it does not fire.
 *
 * **Silence is the default.** Missing and unparseable are the same answer:
 * not enough to interrupt anybody. A bypass that fired on malformed input
 * would teach people to ignore it, and that is the one failure a bypass
 * cannot survive.
 *
 * @see src-tauri/src/attention/critical.rs — the Rust interpreter, rule for rule.
 */

import raw from '../../../shared/policy/critical-attention.v1.json';

export const CRITICAL_PATH = 'shared/policy/critical-attention.v1.json';

/** The format this build ships. */
export const FORMAT = 1;

export type FieldKind = 'string' | 'timestamp';
export type Operator = 'lte' | 'gt';

export interface RequiredField {
  field: string;
  type: FieldKind;
  equals?: string;
}

export interface Condition {
  field: string;
  operator: Operator;
  of: string;
  plus_seconds: number;
}

export interface Trigger {
  id: string;
  copy_key: string;
  required_fields: RequiredField[];
  conditions: Condition[];
}

export interface Replacement {
  relation: string;
  direction: string;
}

export interface Triggers {
  artifactVersion: number;
  ruleVersion: string;
  replacement: Replacement;
  triggers: Trigger[];
}

/** One thing a trigger might be about: its typed fields, as recorded. */
export interface Candidate {
  id: string;
  fields: Record<string, string>;
  active: boolean;
}

/** One replacement edge: `from` replaces `to`. */
export interface ReplacementEdge {
  from: string;
  to: string;
  relation: string;
  active: boolean;
}

export interface Firing {
  trigger_id: string;
  candidate_id: string;
  copy_key: string;
  rule_version: string;
}

/**
 * Parse and validate, the same checks the Rust loader performs — so a
 * malformed artifact fails on both sides rather than on whichever one runs
 * first.
 *
 * The digest is NOT checked here. Rust hashes the bytes it compiled in; vite
 * hands this module the parsed value, and a second hash over a re-serialized
 * object would assert a different thing while looking like the same one.
 */
export function parseTriggers(value: unknown): Triggers {
  const artifact = value as {
    format?: number;
    artifact_version?: number;
    rule_version?: string;
    replacement?: Replacement;
    triggers?: Trigger[];
  };
  if (artifact.format !== FORMAT) {
    throw new Error(`critical-attention format ${artifact.format} is not one this build speaks`);
  }
  if (typeof artifact.rule_version !== 'string' || artifact.rule_version === '') {
    throw new Error('rule_version must be non-empty');
  }
  const replacement = artifact.replacement;
  if (replacement === undefined || replacement.direction !== 'replacement_from_candidate_to') {
    throw new Error(
      `replacement direction ${String(replacement?.direction)} is not one this build speaks — ` +
        'reading a supersedes backwards would silence exactly the candidates that still need ' +
        'attention',
    );
  }
  const triggers = artifact.triggers ?? [];
  if (triggers.length === 0) {
    throw new Error(
      'critical-attention.v1.json declares no triggers — an empty bypass and a failed load are ' +
        'indistinguishable, and both are silence',
    );
  }
  const ids = new Set<string>();
  for (const trigger of triggers) {
    if (ids.has(trigger.id)) throw new Error(`trigger ${trigger.id} is declared twice`);
    ids.add(trigger.id);
    if (trigger.copy_key === '') throw new Error(`trigger ${trigger.id} has no copy key`);
    if (trigger.required_fields.length === 0) {
      throw new Error(
        `trigger ${trigger.id} requires no fields — a trigger that matches anything is not ` +
          'conservative, it is an alarm',
      );
    }
    if (trigger.conditions.length === 0) {
      throw new Error(`trigger ${trigger.id} declares no conditions`);
    }
    const declared = new Set(trigger.required_fields.map((f) => f.field));
    for (const condition of trigger.conditions) {
      if (condition.of !== 'as_of') {
        throw new Error(
          `trigger ${trigger.id} compares against ${condition.of}; this build only compares ` +
            'against as_of',
        );
      }
      if (!declared.has(condition.field)) {
        throw new Error(
          `trigger ${trigger.id} compares ${condition.field}, which it does not require`,
        );
      }
    }
  }
  return {
    artifactVersion: artifact.artifact_version ?? 0,
    ruleVersion: artifact.rule_version,
    replacement,
    triggers,
  };
}

export const CRITICAL: Triggers = parseTriggers(raw);

/** RFC3339 to epoch milliseconds, or null when it will not read. */
function instant(value: string): number | null {
  // `Date.parse` accepts a great deal that RFC3339 does not ("last tuesday"
  // is NaN, but "2026-08-20" is not a timestamp this artifact means). The
  // shape is pinned so the two interpreters agree on what "unparseable" is.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function fires(trigger: Trigger, candidate: Candidate, asOf: number): boolean {
  const times = new Map<string, number>();
  for (const required of trigger.required_fields) {
    const value = candidate.fields[required.field];
    if (value === undefined) return false;
    if (required.equals !== undefined && value !== required.equals) return false;
    if (required.type === 'timestamp') {
      const parsed = instant(value);
      // Unparseable is missing. Guessing here would let one malformed string
      // decide an interruption.
      if (parsed === null) return false;
      times.set(required.field, parsed);
    }
  }
  for (const condition of trigger.conditions) {
    const actual = times.get(condition.field);
    if (actual === undefined) return false;
    const boundary = asOf + condition.plus_seconds * 1000;
    const holds = condition.operator === 'lte' ? actual <= boundary : actual > boundary;
    if (!holds) return false;
  }
  return true;
}

/**
 * Evaluate every trigger against every candidate, as of an explicit instant.
 *
 * `asOf` is an argument for the reason the Rust side gives: an evaluator that
 * read the clock would answer differently about a base that had not moved,
 * and the golden replay would be unrepeatable.
 */
export function evaluate(
  triggers: Triggers,
  candidates: Candidate[],
  replacements: ReplacementEdge[],
  asOf: number,
): Firing[] {
  const replaced = new Set(
    replacements
      .filter((edge) => edge.active && edge.relation === triggers.replacement.relation)
      .map((edge) => edge.to),
  );
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Firing[] = [];
  for (const trigger of triggers.triggers) {
    for (const candidate of sorted) {
      if (!candidate.active || replaced.has(candidate.id)) continue;
      if (fires(trigger, candidate, asOf)) {
        out.push({
          trigger_id: trigger.id,
          candidate_id: candidate.id,
          copy_key: trigger.copy_key,
          rule_version: triggers.ruleVersion,
        });
      }
    }
  }
  return out;
}
