/**
 * The closed `TriggerEvaluation` record (M28.0) — TS side.
 *
 * The second interpreter over `shared/policy/trigger-registry.v1.json`, rule
 * for rule with `src-tauri/src/trigger/evaluation.rs`, and the parity
 * mechanism is the shared goldens in `shared/policy/goldens-trigger/` —
 * replayed by both suites from the same bytes. Refusal CODES are the
 * contract; details are prose.
 *
 * `parseEvaluation` builds a normalized record holding only the fields the
 * Rust types hold, so the byte-equal alias comparison downstream is a deep
 * equality over exactly what Rust compares — an extra key an author sneaked
 * into a metric cannot make the two languages disagree about sameness.
 */

import { isRfc3339 } from '../epistemic/schema';
import { sha256Hex } from '../sha256';
import { resolveGate, type ParentRule, type Registry, type Variant } from './registry';

export type TriggerResult = 'not_ready' | 'not_fired' | 'fired';

export interface GateKey {
  registry_id: string;
  subcapability: string;
}

export type EvaluationScope =
  'subscription_global' | { vault_store: { vault_id: string; store_uuid: string } };

export interface Window {
  start: string;
  end: string;
  timezone: string;
}

export type InputSnapshotRef =
  { evidence: { path: string } } | { runtime: { snapshot_id: string } };

export type MetricSeriesKey =
  | 'aggregate'
  | 'high_stakes_daily_load'
  | { sample: { run_id: string } }
  | { source: { store_uuid: string; source_id: string } }
  | { day: { local_date: string } }
  | { bucket: { ordinal: number; start_date: string; end_date: string } }
  | { statistic: { quantile: 'p50' | 'p90' } };

export type QuantityName = string | { projected_component: { component: string } };

export type TriggerMetric =
  | { count: { name: string; series: MetricSeriesKey; value: number } }
  | {
      ratio_ppm: {
        name: string;
        numerator: number;
        denominator: number;
        value_ppm: number;
        series: MetricSeriesKey;
      };
    }
  | { quantity: { name: QuantityName; value: number; unit: string; series: MetricSeriesKey } };

export interface TriggerEvaluation {
  variant: Variant;
  evaluation_id: string;
  gate_key: GateKey;
  scope: EvaluationScope;
  evaluated_at: string;
  window: Window | null;
  input_snapshot_refs: InputSnapshotRef[];
  input_snapshot_hash: string;
  metrics: TriggerMetric[];
  evidence_pack_path: string | null;
  result: TriggerResult;
  rule_version: string;
  approving_owner: string | null;
  parent_evaluation_id: string | null;
}

/** A refusal: a closed code the goldens pin, and prose they do not. */
export class Refused extends Error {
  constructor(
    public readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

function refuse(code: string, detail: string): never {
  throw new Refused(code, detail);
}

const schemaInvalid = (detail: string): never => refuse('schema_invalid', detail);

// --- parsing (serde-equivalent) -------------------------------------------

const RECORD_KEYS = new Set([
  'variant',
  'evaluation_id',
  'gate_key',
  'scope',
  'evaluated_at',
  'window',
  'input_snapshot_refs',
  'input_snapshot_hash',
  'metrics',
  'evidence_pack_path',
  'result',
  'rule_version',
  'approving_owner',
  'parent_evaluation_id',
]);

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    schemaInvalid(`${what} is not an object`);
  return v as Record<string, unknown>;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string') schemaInvalid(`${what} is not a string`);
  return v as string;
}

function asU64(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    schemaInvalid(`${what} is not a non-negative integer`);
  }
  return v as number;
}

function asOptString(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  return asString(v, what);
}

function oneTag(v: unknown, what: string): [string, unknown] {
  const obj = asObject(v, what);
  const keys = Object.keys(obj);
  if (keys.length !== 1) schemaInvalid(`${what} carries exactly one tag`);
  return [keys[0], obj[keys[0]]];
}

function parseSeries(v: unknown): MetricSeriesKey {
  if (v === 'aggregate' || v === 'high_stakes_daily_load') return v;
  const [tag, body] = oneTag(v, 'series');
  const obj = asObject(body, `series.${tag}`);
  switch (tag) {
    case 'sample':
      return { sample: { run_id: asString(obj.run_id, 'run_id') } };
    case 'source':
      return {
        source: {
          store_uuid: asString(obj.store_uuid, 'store_uuid'),
          source_id: asString(obj.source_id, 'source_id'),
        },
      };
    case 'day':
      return { day: { local_date: asString(obj.local_date, 'local_date') } };
    case 'bucket':
      return {
        bucket: {
          ordinal: asU64(obj.ordinal, 'ordinal'),
          start_date: asString(obj.start_date, 'start_date'),
          end_date: asString(obj.end_date, 'end_date'),
        },
      };
    case 'statistic': {
      const quantile = asString(obj.quantile, 'quantile');
      if (quantile !== 'p50' && quantile !== 'p90') schemaInvalid('quantile is p50 or p90');
      return { statistic: { quantile: quantile as 'p50' | 'p90' } };
    }
    default:
      return schemaInvalid(`series tag ${tag} is not closed`);
  }
}

function parseMetric(v: unknown): TriggerMetric {
  const [tag, body] = oneTag(v, 'metric');
  const obj = asObject(body, `metric.${tag}`);
  switch (tag) {
    case 'count':
      return {
        count: {
          name: asString(obj.name, 'name'),
          series: parseSeries(obj.series),
          value: asU64(obj.value, 'value'),
        },
      };
    case 'ratio_ppm':
      return {
        ratio_ppm: {
          name: asString(obj.name, 'name'),
          numerator: asU64(obj.numerator, 'numerator'),
          denominator: asU64(obj.denominator, 'denominator'),
          value_ppm: asU64(obj.value_ppm, 'value_ppm'),
          series: parseSeries(obj.series),
        },
      };
    case 'quantity': {
      let name: QuantityName;
      if (typeof obj.name === 'string') {
        name = obj.name;
      } else {
        const inner = asObject(
          asObject(obj.name, 'quantity name').projected_component,
          'projected_component',
        );
        const innerKeys = Object.keys(inner);
        if (innerKeys.length !== 1 || innerKeys[0] !== 'component') {
          schemaInvalid('projected_component carries exactly a component');
        }
        name = { projected_component: { component: asString(inner.component, 'component') } };
      }
      return {
        quantity: {
          name,
          value: asU64(obj.value, 'value'),
          unit: asString(obj.unit, 'unit'),
          series: parseSeries(obj.series),
        },
      };
    }
    default:
      return schemaInvalid(`metric tag ${tag} is not closed`);
  }
}

/** Parse a raw JSON value into the normalized record, serde-equivalently. */
export function parseEvaluation(value: unknown): TriggerEvaluation {
  const obj = asObject(value, 'record');
  for (const key of Object.keys(obj)) {
    if (!RECORD_KEYS.has(key)) schemaInvalid(`unknown field ${key}`);
  }
  const variant = asString(obj.variant, 'variant');
  if (variant !== 'measurable' && variant !== 'discretionary' && variant !== 'hybrid') {
    schemaInvalid('variant is not closed');
  }
  const gateKey = asObject(obj.gate_key, 'gate_key');
  for (const key of Object.keys(gateKey)) {
    if (key !== 'registry_id' && key !== 'subcapability') schemaInvalid(`gate_key.${key}`);
  }
  let scope: EvaluationScope;
  if (obj.scope === 'subscription_global') {
    scope = 'subscription_global';
  } else {
    const [tag, body] = oneTag(obj.scope, 'scope');
    if (tag !== 'vault_store') schemaInvalid(`scope tag ${tag} is not closed`);
    const inner = asObject(body, 'vault_store');
    scope = {
      vault_store: {
        vault_id: asString(inner.vault_id, 'vault_id'),
        store_uuid: asString(inner.store_uuid, 'store_uuid'),
      },
    };
  }
  let window: Window | null = null;
  if (obj.window !== null && obj.window !== undefined) {
    const w = asObject(obj.window, 'window');
    for (const key of Object.keys(w)) {
      if (key !== 'start' && key !== 'end' && key !== 'timezone') schemaInvalid(`window.${key}`);
    }
    window = {
      start: asString(w.start, 'window.start'),
      end: asString(w.end, 'window.end'),
      timezone: asString(w.timezone, 'window.timezone'),
    };
  }
  if (!Array.isArray(obj.input_snapshot_refs)) schemaInvalid('input_snapshot_refs is a list');
  const refs = (obj.input_snapshot_refs as unknown[]).map((ref): InputSnapshotRef => {
    const [tag, body] = oneTag(ref, 'input snapshot ref');
    const inner = asObject(body, `ref.${tag}`);
    if (tag === 'evidence') return { evidence: { path: asString(inner.path, 'path') } };
    if (tag === 'runtime') {
      return { runtime: { snapshot_id: asString(inner.snapshot_id, 'snapshot_id') } };
    }
    return schemaInvalid(`ref tag ${tag} is not closed`);
  });
  const rawMetrics = obj.metrics === undefined ? [] : obj.metrics;
  if (!Array.isArray(rawMetrics)) schemaInvalid('metrics is a list');
  const result = asString(obj.result, 'result');
  if (result !== 'not_ready' && result !== 'not_fired' && result !== 'fired') {
    schemaInvalid('result is not closed');
  }
  return {
    variant: variant as Variant,
    evaluation_id: asString(obj.evaluation_id, 'evaluation_id'),
    gate_key: {
      registry_id: asString(gateKey.registry_id, 'registry_id'),
      subcapability: asString(gateKey.subcapability, 'subcapability'),
    },
    scope,
    evaluated_at: asString(obj.evaluated_at, 'evaluated_at'),
    window,
    input_snapshot_refs: refs,
    input_snapshot_hash: asString(obj.input_snapshot_hash, 'input_snapshot_hash'),
    metrics: (rawMetrics as unknown[]).map(parseMetric),
    evidence_pack_path: asOptString(obj.evidence_pack_path, 'evidence_pack_path'),
    result: result as TriggerResult,
    rule_version: asString(obj.rule_version, 'rule_version'),
    approving_owner: asOptString(obj.approving_owner, 'approving_owner'),
    parent_evaluation_id: asOptString(obj.parent_evaluation_id, 'parent_evaluation_id'),
  };
}

// --- derivations -----------------------------------------------------------

export function canonicalGateKey(gate: GateKey): string {
  return `${gate.registry_id}:${gate.subcapability}`;
}

export function canonicalScope(scope: EvaluationScope): string {
  if (scope === 'subscription_global') return 'subscription_global';
  return `vault_store:${scope.vault_store.vault_id}:${scope.vault_store.store_uuid}`;
}

/** The design's formula, verbatim — byte-pinned against the Rust twin. */
export function deriveEvaluationId(
  domain: string,
  gateKey: GateKey,
  scope: EvaluationScope,
  ruleVersion: string,
  inputSnapshotHash: string,
): string {
  return sha256Hex(
    `${domain}\0${canonicalGateKey(gateKey)}\0${canonicalScope(scope)}\0${ruleVersion}\0${inputSnapshotHash}`,
  );
}

/**
 * The domain-separated hash of the resolved canonical payloads in tag/key
 * order. `parts` is `[tag, key, canonicalPayload]`; sorted here, so a
 * caller's collection order cannot mint a second hash.
 */
export function deriveInputSnapshotHash(domain: string, parts: [string, string, string][]): string {
  const sorted = [...parts].sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  });
  let raw = domain;
  for (const [tag, key, payload] of sorted) {
    raw += `\0${tag}\0${key}\0${payload}`;
  }
  return sha256Hex(raw);
}

// --- validation ------------------------------------------------------------

const HASH = /^[0-9a-f]{64}$/;

function isLocalDate(v: string): boolean {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= last;
}

function isIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function refRank(ref: InputSnapshotRef): [number, string] {
  return 'evidence' in ref ? [0, ref.evidence.path] : [1, ref.runtime.snapshot_id];
}

/** Validate a record against the registry, without its parent. */
export function validate(record: TriggerEvaluation, registry: Registry): void {
  const gate = resolveGate(registry, record.gate_key.registry_id, record.gate_key.subcapability);
  if (gate === null) {
    refuse(
      'gate_unknown',
      `${canonicalGateKey(record.gate_key)} is not a gate the registry declares`,
    );
  }
  if (record.variant !== gate.variant) {
    refuse(
      'variant_mismatch',
      `${canonicalGateKey(record.gate_key)} must be evaluated as ${gate.variant}`,
    );
  }
  const scopeKind = record.scope === 'subscription_global' ? 'subscription_global' : 'vault_store';
  if (scopeKind !== gate.scope) {
    refuse(
      'scope_mismatch',
      `${canonicalGateKey(record.gate_key)} evaluations are ${gate.scope}-scoped`,
    );
  }
  if (record.scope !== 'subscription_global') {
    const { vault_id, store_uuid } = record.scope.vault_store;
    if (vault_id === '' || store_uuid === '') {
      refuse('scope_mismatch', 'a vault_store scope names both halves');
    }
  }

  const owner = record.approving_owner;
  if (record.variant === 'measurable') {
    if (record.window === null) refuse('variant_shape', 'a measurable record carries a window');
    if (record.metrics.length === 0) {
      refuse('variant_shape', 'a measurable record carries at least one metric');
    }
    if (record.evidence_pack_path !== null) {
      refuse('variant_shape', 'a measurable record carries no evidence pack');
    }
    if (owner !== null) refuse('variant_shape', 'a measurable record has no approving owner');
  } else if (record.variant === 'discretionary') {
    if (record.window !== null) refuse('variant_shape', 'a discretionary record carries no window');
    if (record.metrics.length !== 0) {
      refuse('variant_shape', 'a discretionary record carries no metrics');
    }
    if (record.evidence_pack_path === null) {
      refuse('variant_shape', 'a discretionary record names its evidence pack');
    }
    if (owner === null || owner === '') {
      refuse('variant_shape', 'a discretionary record names its approving owner');
    }
  } else {
    if (record.window === null || record.metrics.length === 0) {
      refuse('variant_shape', 'a hybrid record carries the whole measurable half');
    }
    if (record.evidence_pack_path === null || owner === null || owner === '') {
      refuse('variant_shape', 'a hybrid record carries the whole discretionary half');
    }
  }

  if (!isRfc3339(record.evaluated_at)) refuse('window_invalid', 'evaluated_at is not RFC3339');
  if (record.window !== null) {
    if (!isRfc3339(record.window.start) || !isRfc3339(record.window.end)) {
      refuse('window_invalid', 'window stamps are not RFC3339');
    }
    if (new Date(record.window.end).getTime() < new Date(record.window.start).getTime()) {
      refuse('window_invalid', 'a window ends no earlier than it starts');
    }
    if (!isIanaTimezone(record.window.timezone)) {
      refuse('window_invalid', `${record.window.timezone} is not an IANA timezone`);
    }
  }

  validateRefs(record, registry);
  validateMetrics(record, registry);

  if (record.rule_version !== registry.ruleVersion) {
    refuse(
      'rule_version_mismatch',
      `the record claims ${record.rule_version} and the registry is ${registry.ruleVersion}`,
    );
  }

  if (gate.parent === null && record.parent_evaluation_id !== null) {
    refuse('parent_invalid', `${canonicalGateKey(record.gate_key)} takes no parent evaluation`);
  }
  if (gate.parent !== null && record.parent_evaluation_id === null) {
    refuse('parent_invalid', `${canonicalGateKey(record.gate_key)} requires a fired parent`);
  }
  if (record.parent_evaluation_id !== null) {
    if (!HASH.test(record.parent_evaluation_id)) {
      refuse('parent_invalid', 'parent_evaluation_id is not a sha256');
    }
    if (record.parent_evaluation_id === record.evaluation_id) {
      refuse('parent_invalid', 'an evaluation cannot parent itself');
    }
  }

  if (!HASH.test(record.input_snapshot_hash)) {
    refuse('refs_invalid', 'input_snapshot_hash is not a sha256');
  }
  const expected = deriveEvaluationId(
    registry.evaluationIdDomain,
    record.gate_key,
    record.scope,
    record.rule_version,
    record.input_snapshot_hash,
  );
  if (record.evaluation_id !== expected) {
    refuse('evaluation_id_mismatch', `claimed ${record.evaluation_id}, derived ${expected}`);
  }
}

function validateRefs(record: TriggerEvaluation, registry: Registry): void {
  if (record.input_snapshot_refs.length === 0) {
    refuse('refs_invalid', 'input_snapshot_refs is never empty');
  }
  const ranks = record.input_snapshot_refs.map(refRank);
  for (let i = 1; i < ranks.length; i += 1) {
    const [tagA, keyA] = ranks[i - 1];
    const [tagB, keyB] = ranks[i];
    if (tagA > tagB || (tagA === tagB && keyA > keyB)) {
      refuse('refs_invalid', 'input_snapshot_refs must be sorted');
    }
  }
  const runtime = record.input_snapshot_refs.filter((r) => 'runtime' in r);
  const evidence = record.input_snapshot_refs.filter((r) => 'evidence' in r);
  const wantRuntime = record.variant === 'discretionary' ? 0 : 1;
  const wantEvidence = record.variant === 'measurable' ? 0 : 1;
  if (runtime.length !== wantRuntime || evidence.length !== wantEvidence) {
    refuse(
      'refs_invalid',
      `a ${record.variant} record carries exactly ${wantRuntime} runtime and ${wantEvidence} ` +
        `evidence refs; found ${runtime.length} and ${evidence.length}`,
    );
  }
  for (const ref of runtime) {
    if (!HASH.test((ref as { runtime: { snapshot_id: string } }).runtime.snapshot_id)) {
      refuse('refs_invalid', 'a runtime ref names a sha256 snapshot id');
    }
  }
  const first = evidence[0];
  if (first !== undefined) {
    const path = (first as { evidence: { path: string } }).evidence.path;
    if (record.evidence_pack_path !== path) {
      refuse('refs_invalid', 'the evidence ref and evidence_pack_path name the same file');
    }
    const root = `${registry.evidenceRoot}/${record.gate_key.registry_id}/`;
    if (!path.startsWith(root)) {
      refuse(
        'evidence_path_invalid',
        `an ${record.gate_key.registry_id} evidence pack lives under ${root}`,
      );
    }
    const name = path.slice(root.length);
    const dated =
      name.length > 14 &&
      isLocalDate(name.slice(0, 10)) &&
      name[10] === '-' &&
      name.endsWith('.md');
    if (!dated) refuse('evidence_path_invalid', `${name} is not <date>-<slug>.md`);
  }
}

function validateSeries(series: MetricSeriesKey): void {
  if (series === 'aggregate' || series === 'high_stakes_daily_load') return;
  if ('sample' in series) {
    if (series.sample.run_id === '') refuse('metrics_invalid', 'a sample series names its run');
    return;
  }
  if ('source' in series) {
    if (series.source.store_uuid === '' || series.source.source_id === '') {
      refuse('metrics_invalid', 'a source series names both halves');
    }
    return;
  }
  if ('day' in series) {
    if (!isLocalDate(series.day.local_date))
      refuse('metrics_invalid', 'a day series is YYYY-MM-DD');
    return;
  }
  if ('bucket' in series) {
    const { ordinal, start_date, end_date } = series.bucket;
    if (ordinal < 1 || ordinal > 4) refuse('metrics_invalid', 'bucket ordinals run 1..4');
    if (!isLocalDate(start_date) || !isLocalDate(end_date) || end_date < start_date) {
      refuse('metrics_invalid', "a bucket's dates are ordered YYYY-MM-DD");
    }
  }
}

function validateMetrics(record: TriggerEvaluation, registry: Registry): void {
  const { metrics } = registry;
  for (const metric of record.metrics) {
    if ('count' in metric) {
      if (!metrics.count_names.includes(metric.count.name)) {
        refuse('metrics_invalid', `${metric.count.name} is not a count metric`);
      }
      validateSeries(metric.count.series);
    } else if ('ratio_ppm' in metric) {
      const { name, numerator, denominator, value_ppm, series } = metric.ratio_ppm;
      if (!metrics.ratio_names.includes(name)) {
        refuse('metrics_invalid', `${name} is not a ratio metric`);
      }
      if (denominator === 0) refuse('metrics_invalid', 'a ratio has a positive denominator');
      const recomputed = Number((BigInt(numerator) * 1_000_000n) / BigInt(denominator));
      if (recomputed !== value_ppm || value_ppm > 1_000_000) {
        refuse(
          'metrics_invalid',
          `${name}: ${numerator}/${denominator} recomputes to ${recomputed} ppm, not ${value_ppm}`,
        );
      }
      validateSeries(series);
    } else {
      const { name, unit, series } = metric.quantity;
      const expected =
        typeof name === 'string'
          ? metrics.quantity_units[name]
          : metrics.component_units[name.projected_component.component];
      if (expected === undefined) {
        refuse('metrics_invalid', `${JSON.stringify(name)} is not a quantity metric`);
      }
      if (unit !== expected) {
        refuse(
          'metrics_invalid',
          `${JSON.stringify(name)} is measured in ${expected}, not ${unit}`,
        );
      }
      validateSeries(series);
    }
  }
}

// --- the parent half -------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function fieldOf(record: TriggerEvaluation, field: string): unknown {
  switch (field) {
    case 'window':
      return record.window;
    case 'input_snapshot_refs':
      return record.input_snapshot_refs;
    case 'input_snapshot_hash':
      return record.input_snapshot_hash;
    case 'metrics':
      return record.metrics;
    case 'result':
      return record.result;
    default:
      return refuse('parent_invalid', `byte_equal names ${field}, which this build cannot compare`);
  }
}

function parentAllowed(rule: ParentRule, parentKey: GateKey, registry: Registry): boolean {
  const canonical = canonicalGateKey(parentKey);
  return rule.allowed.some((allowed) => {
    if (allowed.endsWith('*')) {
      return (
        canonical.startsWith(allowed.slice(0, -1)) &&
        resolveGate(registry, parentKey.registry_id, parentKey.subcapability) !== null
      );
    }
    return canonical === allowed;
  });
}

/** Validate the parent half: allowed gate, FIRED result, byte-equal alias. */
export function validateParent(
  record: TriggerEvaluation,
  parent: TriggerEvaluation,
  registry: Registry,
): void {
  const gate = resolveGate(registry, record.gate_key.registry_id, record.gate_key.subcapability);
  if (gate === null) refuse('gate_unknown', canonicalGateKey(record.gate_key));
  const rule = gate.parent;
  if (rule === null) {
    refuse('parent_invalid', `${canonicalGateKey(record.gate_key)} takes no parent evaluation`);
  }
  if (record.parent_evaluation_id !== parent.evaluation_id) {
    refuse('parent_invalid', 'the record does not name this parent');
  }
  if (!parentAllowed(rule, parent.gate_key, registry)) {
    refuse(
      'parent_invalid',
      `${canonicalGateKey(parent.gate_key)} is not an allowed parent for ` +
        canonicalGateKey(record.gate_key),
    );
  }
  if (parent.result !== 'fired') {
    refuse('parent_invalid', `the parent evaluation is ${parent.result}, and only FIRED counts`);
  }
  if (!deepEqual(record.scope, parent.scope)) {
    refuse('parent_invalid', "a parent evaluation must share the record's scope");
  }
  if (rule.kind === 'measurable_alias') {
    for (const field of rule.byte_equal) {
      if (!deepEqual(fieldOf(record, field), fieldOf(parent, field))) {
        refuse(
          'parent_invalid',
          `an alias is byte-equal to its parent on ${field}, and this is not`,
        );
      }
    }
  }
}

/** Every code the golden runner may see — the Rust twin's list, verbatim. */
export const ALL_CODES = [
  'gate_unknown',
  'variant_mismatch',
  'variant_shape',
  'scope_mismatch',
  'refs_invalid',
  'metrics_invalid',
  'window_invalid',
  'parent_invalid',
  'evidence_path_invalid',
  'rule_version_mismatch',
  'evaluation_id_mismatch',
  'schema_invalid',
] as const;
