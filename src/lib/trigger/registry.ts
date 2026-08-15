/**
 * `shared/policy/trigger-registry.v1.json` — the closed gate table, TS side
 * (M28.0).
 *
 * The SAME FILE the Rust core compiles in with `include_str!`, imported
 * verbatim by vite. Nothing here restates a rule: no gate key, variant,
 * parent, threshold, or unit is written in TypeScript. What lives in this
 * module is the generic machinery that reads the artifact, plus the same
 * strict load-time validation the Rust loader performs, so a malformed
 * registry fails on both sides rather than on whichever one runs first.
 *
 * The digest is NOT checked here. Rust hashes the bytes it compiled in; vite
 * hands this module the parsed value, and a second hash over a re-serialized
 * object would assert a different thing while looking like the same one.
 *
 * One asymmetry, deliberate: the Rust loader additionally refuses an
 * artifact whose `metrics.component_units` disagrees with
 * `runtime::governance::Component`, because Rust owns the code that writes
 * those rows. This side has no such enum to drift from — the artifact IS its
 * authority.
 *
 * @see src-tauri/src/trigger/registry.rs — the Rust interpreter, rule for rule.
 */

import raw from '../../../shared/policy/trigger-registry.v1.json';

export const REGISTRY_PATH = 'shared/policy/trigger-registry.v1.json';
export const REGISTRY_DIGEST_PATH = 'shared/policy/trigger-registry.v1.sha256';

/** The format this build ships. */
export const FORMAT = 1;

/**
 * The registry ids the v1 ARTIFACT declares, closed at fourteen. Growing this
 * list is a format bump. The M28 spec registers three more — R15–R17 (M31.8) —
 * deliberately absent here: an id this list does not name resolves to
 * `gate_unknown`, so a registered-but-unevaluatable deferral cannot fire in any
 * shipped build. Their keys enter a successor revision with their first
 * evaluator, never before it.
 */
export const REGISTRY_IDS = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
] as const;

export type Variant = 'measurable' | 'discretionary' | 'hybrid';
export type ScopeKind = 'subscription_global' | 'vault_store';

const VARIANTS: Variant[] = ['measurable', 'discretionary', 'hybrid'];
const SCOPES: ScopeKind[] = ['subscription_global', 'vault_store'];
const UNITS = ['tokens', 'calls', 'bytes', 'micros', 'seconds'];

export interface MeasurableAlias {
  kind: 'measurable_alias';
  allowed: string[];
  requires_result: string;
  byte_equal: string[];
}

export interface FiredParent {
  kind: 'fired_parent';
  allowed: string[];
}

export type ParentRule = MeasurableAlias | FiredParent;

export interface Subcapability {
  key: string;
  variant: Variant;
  parent: ParentRule | null;
}

export interface SubcapabilityPattern {
  prefix: string;
  variant: Variant;
  parent: ParentRule | null;
  registered_connectors: string[];
}

export interface Entry {
  id: string;
  capability: string;
  scope: ScopeKind;
  subcapabilities: Subcapability[];
  subcapability_pattern?: SubcapabilityPattern;
}

export interface Metrics {
  count_names: string[];
  ratio_names: string[];
  quantity_units: Record<string, string>;
  component_units: Record<string, string>;
}

export type ProtocolConstants = Record<string, number | string>;

export interface Registry {
  artifactVersion: number;
  ruleVersion: string;
  evaluationIdDomain: string;
  snapshotHashDomain: string;
  evidenceRoot: string;
  protectedNames: string[];
  entries: Entry[];
  metrics: Metrics;
  protocols: Record<string, ProtocolConstants>;
}

/** One resolved gate key: what an evaluation of it must look like. */
export interface ResolvedGate {
  registryId: string;
  subkey: string;
  scope: ScopeKind;
  variant: Variant;
  parent: ParentRule | null;
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Parse and validate — the same checks the Rust loader performs, in the same
 * order, refusing with the same vocabulary.
 */
export function parseRegistry(value: unknown): Registry {
  const artifact = value as {
    format?: number;
    artifact_version?: number;
    rule_version?: string;
    evaluation_id_domain?: string;
    snapshot_hash_domain?: string;
    evidence_root?: string;
    protected_names?: string[];
    entries?: Entry[];
    metrics?: Metrics;
    protocols?: Record<string, Record<string, unknown>>;
  };
  if (artifact.format !== FORMAT) {
    fail(`trigger-registry format ${artifact.format} is not one this build speaks`);
  }
  for (const [field, v] of [
    ['rule_version', artifact.rule_version],
    ['evaluation_id_domain', artifact.evaluation_id_domain],
    ['snapshot_hash_domain', artifact.snapshot_hash_domain],
    ['evidence_root', artifact.evidence_root],
  ] as const) {
    if (typeof v !== 'string' || v === '') fail(`${field} must be non-empty`);
  }
  const protectedNames = artifact.protected_names ?? [];
  if (protectedNames.length === 0) {
    fail('protected_names is empty — a glossary that protects nothing is a comment');
  }
  if (new Set(protectedNames).size !== protectedNames.length || protectedNames.includes('')) {
    fail('a protected name is empty or declared twice');
  }

  const entries = artifact.entries ?? [];
  const ids = entries.map((e) => e.id);
  if (ids.length !== REGISTRY_IDS.length || ids.some((id, i) => id !== REGISTRY_IDS[i])) {
    fail(
      `the registry must declare exactly ${JSON.stringify(REGISTRY_IDS)} in order; found ` +
        `${JSON.stringify(ids)} — the fourteen entries are closed by the v1 ARTIFACT (the ` +
        'design defers seventeen; R15–R17 are spec-registered and unevaluatable on purpose), ' +
        'and growing them is a format bump',
    );
  }
  const capabilities = new Set<string>();
  for (const entry of entries) {
    if (entry.capability === '' || capabilities.has(entry.capability)) {
      fail(
        `entry ${entry.id} capability ${JSON.stringify(entry.capability)} is empty or declared twice`,
      );
    }
    capabilities.add(entry.capability);
    if (!SCOPES.includes(entry.scope)) {
      fail(`entry ${entry.id} scope ${JSON.stringify(entry.scope)} is not closed`);
    }
    if (entry.subcapabilities.length === 0 && entry.subcapability_pattern === undefined) {
      fail(
        `entry ${entry.id} declares no subcapabilities and no pattern — an entry nothing can ` +
          'key is not deferred, it is absent',
      );
    }
    const keys = new Set<string>();
    for (const sub of entry.subcapabilities) {
      if (sub.key === '' || keys.has(sub.key)) {
        fail(
          `entry ${entry.id} subcapability ${JSON.stringify(sub.key)} is empty or declared twice`,
        );
      }
      keys.add(sub.key);
      checkVariantParentShape(entry.id, sub.key, sub.variant, sub.parent);
    }
    const pattern = entry.subcapability_pattern;
    if (pattern !== undefined) {
      if (pattern.prefix === '') fail(`entry ${entry.id} pattern prefix is empty`);
      for (const sub of entry.subcapabilities) {
        if (sub.key.startsWith(pattern.prefix)) {
          fail(
            `entry ${entry.id} subcapability ${JSON.stringify(sub.key)} collides with the ` +
              `pattern prefix ${JSON.stringify(pattern.prefix)} — one key must not resolve two ways`,
          );
        }
      }
      const connectors = new Set(pattern.registered_connectors);
      if (
        connectors.size !== pattern.registered_connectors.length ||
        pattern.registered_connectors.includes('')
      ) {
        fail(`entry ${entry.id} has a registered connector that is empty or declared twice`);
      }
      checkVariantParentShape(entry.id, `${pattern.prefix}*`, pattern.variant, pattern.parent);
    }
  }

  for (const entry of entries) {
    const parents: [string, ParentRule][] = entry.subcapabilities
      .filter((s) => s.parent !== null)
      .map((s) => [s.key, s.parent as ParentRule]);
    if (entry.subcapability_pattern?.parent != null) {
      parents.push(['<pattern>', entry.subcapability_pattern.parent]);
    }
    for (const [key, parent] of parents) {
      if (parent.allowed.length === 0) {
        fail(
          `entry ${entry.id} subcapability ${JSON.stringify(key)} declares a parent rule allowing nothing`,
        );
      }
      for (const gateKey of parent.allowed) {
        if (!parentKeyResolves(entries, gateKey)) {
          fail(
            `entry ${entry.id} subcapability ${JSON.stringify(key)} allows parent ` +
              `${JSON.stringify(gateKey)}, which the registry does not declare`,
          );
        }
      }
      if (parent.kind === 'measurable_alias') {
        if (parent.requires_result !== 'fired') {
          fail(
            `entry ${entry.id} subcapability ${JSON.stringify(key)}: a measurable alias of a ` +
              'parent that has not fired would let the alias assert what the parent never did',
          );
        }
        if (parent.byte_equal.length === 0) {
          fail(
            `entry ${entry.id} subcapability ${JSON.stringify(key)}: a byte-equal alias ` +
              'comparing no fields is not an alias',
          );
        }
        for (const gateKey of parent.allowed) {
          const target = plainSubcapability(entries, gateKey);
          if (target === null || target.variant !== 'measurable' || target.parent !== null) {
            fail(
              `alias parent ${JSON.stringify(gateKey)} must be an unaliased measurable gate — ` +
                'an alias of an alias has no protocol anywhere in its ancestry',
            );
          }
        }
      }
    }
  }

  const metrics = artifact.metrics ?? fail('metrics is missing');
  checkMetrics(metrics);
  const protocols = checkProtocols(entries, artifact.protocols ?? {});

  return {
    artifactVersion: artifact.artifact_version ?? 0,
    ruleVersion: artifact.rule_version as string,
    evaluationIdDomain: artifact.evaluation_id_domain as string,
    snapshotHashDomain: artifact.snapshot_hash_domain as string,
    evidenceRoot: artifact.evidence_root as string,
    protectedNames,
    entries,
    metrics,
    protocols,
  };
}

function checkVariantParentShape(
  entryId: string,
  key: string,
  variant: Variant,
  parent: ParentRule | null,
): void {
  if (!VARIANTS.includes(variant)) {
    fail(
      `entry ${entryId} subcapability ${JSON.stringify(key)} variant ${JSON.stringify(variant)} is not closed`,
    );
  }
  if (parent === null) return;
  const legal =
    (variant === 'measurable' && parent.kind === 'measurable_alias') ||
    (variant === 'discretionary' && parent.kind === 'fired_parent');
  if (!legal) {
    fail(
      `entry ${entryId} subcapability ${JSON.stringify(key)}: variant ${variant} cannot carry ` +
        `a ${parent.kind} parent rule`,
    );
  }
}

function plainSubcapability(entries: Entry[], gateKey: string): Subcapability | null {
  const split = gateKey.indexOf(':');
  if (split < 0) return null;
  const entry = entries.find((e) => e.id === gateKey.slice(0, split));
  return entry?.subcapabilities.find((s) => s.key === gateKey.slice(split + 1)) ?? null;
}

function parentKeyResolves(entries: Entry[], gateKey: string): boolean {
  if (plainSubcapability(entries, gateKey) !== null) return true;
  const split = gateKey.indexOf(':');
  if (split < 0) return false;
  const entry = entries.find((e) => e.id === gateKey.slice(0, split));
  const pattern = entry?.subcapability_pattern;
  return pattern !== undefined && gateKey.slice(split + 1) === `${pattern.prefix}*`;
}

function checkMetrics(metrics: Metrics): void {
  for (const [name, list] of [
    ['count_names', metrics.count_names],
    ['ratio_names', metrics.ratio_names],
  ] as const) {
    if (list.length === 0) fail(`metrics.${name} is empty`);
    if (new Set(list).size !== list.length || list.includes('')) {
      fail(`a metrics.${name} entry is empty or declared twice`);
    }
  }
  if (Object.keys(metrics.quantity_units).length === 0) fail('metrics.quantity_units is empty');
  for (const [name, unit] of [
    ...Object.entries(metrics.quantity_units),
    ...Object.entries(metrics.component_units),
  ]) {
    if (name === '') fail('a metric unit row names nothing');
    if (!UNITS.includes(unit)) {
      fail(
        `metric ${JSON.stringify(name)} declares unit ${JSON.stringify(unit)}, which is not closed`,
      );
    }
  }
}

function checkProtocols(
  entries: Entry[],
  protocols: Record<string, Record<string, unknown>>,
): Record<string, ProtocolConstants> {
  const owed = new Set<string>();
  for (const entry of entries) {
    for (const sub of entry.subcapabilities) {
      if ((sub.variant === 'measurable' || sub.variant === 'hybrid') && sub.parent === null) {
        owed.add(`${entry.id}:${sub.key}`);
      }
    }
  }
  const declared = new Set(Object.keys(protocols));
  if (owed.size !== declared.size || [...owed].some((k) => !declared.has(k))) {
    fail(
      'protocols must cover exactly the unaliased measurable/hybrid gates — owed ' +
        `${JSON.stringify([...owed].sort())}, declared ${JSON.stringify([...declared].sort())}`,
    );
  }
  const out: Record<string, ProtocolConstants> = {};
  for (const [gateKey, constants] of Object.entries(protocols)) {
    const rows = Object.entries(constants);
    if (rows.length === 0) fail(`protocol ${JSON.stringify(gateKey)} declares no constants`);
    const typed: ProtocolConstants = {};
    for (const [name, v] of rows) {
      if (typeof v === 'number') {
        if (!Number.isInteger(v) || v < 0) {
          fail(
            `protocol ${JSON.stringify(gateKey)} constant ${JSON.stringify(name)} must be a ` +
              `non-negative integer, found ${v}`,
          );
        }
        if (v === 0) {
          fail(
            `protocol ${JSON.stringify(gateKey)} constant ${JSON.stringify(name)} is zero — a ` +
              'floor of nothing is not a floor',
          );
        }
        if (name.endsWith('_ppm') && v > 1_000_000) {
          fail(
            `protocol ${JSON.stringify(gateKey)} constant ${JSON.stringify(name)} exceeds 1_000_000 ppm`,
          );
        }
        typed[name] = v;
      } else if (typeof v === 'string') {
        if (v === '')
          fail(`protocol ${JSON.stringify(gateKey)} constant ${JSON.stringify(name)} is empty`);
        typed[name] = v;
      } else {
        fail(
          `protocol ${JSON.stringify(gateKey)} constant ${JSON.stringify(name)} must be an ` +
            'integer or string',
        );
      }
    }
    out[gateKey] = typed;
  }
  return out;
}

/**
 * Resolve `registryId` + `subkey` against the closed table. `null` IS the
 * refusal: a combination the artifact does not name has no variant, no
 * scope, and no rules to evaluate under.
 */
export function resolveGate(
  registry: Registry,
  registryId: string,
  subkey: string,
): ResolvedGate | null {
  const entry = registry.entries.find((e) => e.id === registryId);
  if (entry === undefined) return null;
  const sub = entry.subcapabilities.find((s) => s.key === subkey);
  if (sub !== undefined) {
    return {
      registryId: entry.id,
      subkey: sub.key,
      scope: entry.scope,
      variant: sub.variant,
      parent: sub.parent,
    };
  }
  const pattern = entry.subcapability_pattern;
  if (pattern === undefined || !subkey.startsWith(pattern.prefix)) return null;
  const connector = subkey.slice(pattern.prefix.length);
  if (!pattern.registered_connectors.includes(connector)) return null;
  return {
    registryId: entry.id,
    subkey,
    scope: entry.scope,
    variant: pattern.variant,
    parent: pattern.parent,
  };
}

/** Resolve a `"R4:issue"`-style gate-key string. */
export function resolveGateKey(registry: Registry, gateKey: string): ResolvedGate | null {
  const split = gateKey.indexOf(':');
  if (split < 0) return null;
  return resolveGate(registry, gateKey.slice(0, split), gateKey.slice(split + 1));
}

let cached: Registry | null = null;

/** The shipped registry, parsed once. */
export function loadRegistry(): Registry {
  cached ??= parseRegistry(raw);
  return cached;
}
