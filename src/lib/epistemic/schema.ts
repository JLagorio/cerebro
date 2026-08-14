/**
 * Schema v1 decode + structural validation (M22.4) — the TS half of
 * `src-tauri/src/ledger/schema/`, replayed against the shared conformance
 * vectors so no rule is ever hand-mirrored a third time in mockIpc.
 *
 * Error classification mirrors Rust exactly, because refusal parity is
 * `(seq, event_id, batch_id, code)`:
 * - `SchemaError` ("schema"): body-level parse/tag/canonical-gate failures
 *   (what serde + the byte round-trip gate refuse at decode time);
 * - `RefusedError` ("refused"): structural and state rules (what
 *   `validate()` and the reducer refuse).
 *
 * The canonical gate is the same idea as Rust's: rebuild the body from ONLY
 * the known fields in declaration order and byte-compare the JSON — unknown
 * fields, reordered keys, and non-canonical spellings all fail loudly.
 */

import type { Json } from './ids';
import {
  canonicalJson,
  compareUtf8,
  deriveComparisonId,
  deriveDeclaredComparisonId,
  deriveEdgeId,
  deriveFreshnessDedupeKey,
  deriveRelationId,
  deriveSourceId,
  deriveSourceKey,
  orderedEndpoints,
} from './ids';
import { normalizeAliasV1 } from './normalize';

export class SchemaError extends Error {}
export class RefusedError extends Error {}

export type JsonObject = { [key: string]: Json };

/**
 * Names claimed with deliberately undefined bodies, so nothing else ever
 * takes them and no build guesses at their shape.
 *
 * M22 reserved seven; M24.3 defined `belief.tombstoned` and the six
 * `proposal.*` kinds, so the list is empty and the mechanism stands ready
 * for M27's conflict vocabulary. Mirrors `RESERVED_KINDS` in
 * `src-tauri/src/ledger/schema/mod.rs`.
 */
export const RESERVED_KINDS: string[] = [];

export const ACTOR_LEDGER = 'system:ledger';
export const ACTOR_SOURCE_REGISTRY = 'system:source-registry';
export const ACTOR_MIGRATOR = 'system:migrator';
export const ACTOR_RECONCILIATION = 'system:reconciliation';

/** Frontmatter fields declared presentation-only — the ONLY legal override
 * targets besides `/body` (mirrors `schema/projection.rs`). */
export const PRESENTATION_ONLY_FIELDS = ['title', 'tags'];

/** The CLOSED divergence signal list, in canonical (declaration) order. */
export const DIVERGENCE_SIGNALS = [
  'git_anchor_regression',
  'remembered_head_regression',
  'manifest_reducer_disagreement',
  'mass_projection_mismatch',
  'migration_source_changed',
  'migration_idempotency_conflict',
];

export const isId128 = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);
export const isSha256 = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

// --- typed getters (throw SchemaError, the serde-equivalent) ---------------

const asObject = (v: Json | undefined, what: string): JsonObject => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SchemaError(`${what} must be an object`);
  }
  return v;
};
const asString = (v: Json | undefined, what: string): string => {
  if (typeof v !== 'string') throw new SchemaError(`${what} must be a string`);
  return v;
};
const asStringOrNull = (v: Json | undefined, what: string): string | null => {
  if (v === null) return null;
  return asString(v, what);
};
const asU64 = (v: Json | undefined, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new SchemaError(`${what} must be an unsigned integer`);
  }
  return v;
};
const asArray = (v: Json | undefined, what: string): Json[] => {
  if (!Array.isArray(v)) throw new SchemaError(`${what} must be an array`);
  return v;
};
const oneOf = (v: Json | undefined, allowed: string[], what: string): string => {
  const s = asString(v, what);
  if (!allowed.includes(s)) throw new SchemaError(`${what}: unknown variant ${s}`);
  return s;
};

// --- shared unions ---------------------------------------------------------

/** M24 closed vocabularies. Mirrors `ledger/schema/{risk,lifecycle}.rs`. */
export const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const QUALIFICATIONS = ['draft', 'qualified'];
export const RELATION_KINDS = ['supersedes', 'refines', 'contradicts'];
export const LIFECYCLES = ['active', 'superseded', 'archived'];
export const TARGET_CLASSES = [
  'belief',
  'comparison',
  'entity',
  'observation',
  'proposal',
  'relation',
  'source',
];
export const FIELD_ROLES = [
  'failure_condition',
  'impact',
  'evidence',
  'trigger',
  'completion_condition',
  'owner',
  'verb',
];
const TRANSITION_CAUSES = [
  'new_evidence',
  'human_correction',
  'qualification_met',
  'conflict_resolution',
  'maintenance',
  'revert',
  'elapsed_time',
  'absence_of_observations',
];
const INTENDED_USE_KINDS = [
  'draft_note',
  'reversible_work',
  'operational_decision',
  'production_release',
  'safety_or_compliance',
];

function canonQualificationProfile(v: Json | undefined): JsonObject {
  const p = asObject(v, 'qualification_profile');
  return {
    type_id: asString(p.type_id, 'type_id'),
    type_schema_hash: asString(p.type_schema_hash, 'type_schema_hash'),
    required_roles: asArray(p.required_roles, 'required_roles').map((r) =>
      oneOf(r, FIELD_ROLES, 'field role'),
    ),
  };
}

function canonReassignmentPlan(v: Json | undefined): JsonObject {
  const p = asObject(v, 'reassignment_plan');
  return {
    survivor_id: asString(p.survivor_id, 'survivor_id'),
    merged_ids: asArray(p.merged_ids, 'merged_ids').map((id) => asString(id, 'merged id')),
    affected_belief_ids: asArray(p.affected_belief_ids, 'affected beliefs').map((id) =>
      asString(id, 'affected belief id'),
    ),
    live_aliases: asArray(p.live_aliases, 'live_aliases').map((a) => {
      const alias = asObject(a, 'live alias');
      return {
        normalized_alias: asString(alias.normalized_alias, 'normalized_alias'),
        alias_event_id: asString(alias.alias_event_id, 'alias_event_id'),
        from_entity_id: asString(alias.from_entity_id, 'from_entity_id'),
      };
    }),
    affected_relation_ids: asArray(p.affected_relation_ids, 'affected relations').map((id) =>
      asString(id, 'affected relation id'),
    ),
    plan_digest: asString(p.plan_digest, 'plan_digest'),
  };
}

function canonTargetVersions(v: Json | undefined): JsonObject[] {
  return asArray(v, 'target_versions').map((entry) => {
    const t = asObject(entry, 'target version');
    return {
      target_class: oneOf(t.target_class, TARGET_CLASSES, 'target_class'),
      target_id: asString(t.target_id, 'target_id'),
      version: asU64(t.version, 'version'),
    };
  });
}

function canonRevertPlan(v: Json | undefined): JsonObject {
  const plan = asObject(v, 'revert_plan');
  return {
    source_operation_digest: asString(plan.source_operation_digest, 'source_operation_digest'),
    expected_post_versions: canonTargetVersions(plan.expected_post_versions),
    steps: asArray(plan.steps, 'revert steps').map((raw): JsonObject => {
      const step = asObject(raw, 'revert step');
      const kind = oneOf(
        step.kind,
        [
          'belief_revised',
          'lifecycle_restored',
          'qualification_restored',
          'relation_restored',
          'contest_closed',
        ],
        'revert step kind',
      );
      switch (kind) {
        case 'belief_revised':
          return {
            kind,
            belief_id: asString(step.belief_id, 'belief_id'),
            patch: asArray(step.patch, 'patch').map((op) => {
              const o = asObject(op, 'patch op');
              return {
                field_path: asString(o.field_path, 'field_path'),
                before: canonTypedValue(o.before),
                after: canonTypedValue(o.after),
              };
            }),
            basis: canonBasis(step.basis),
          };
        case 'lifecycle_restored':
          return {
            kind,
            belief_id: asString(step.belief_id, 'belief_id'),
            from: oneOf(step.from, LIFECYCLES, 'from'),
            to: oneOf(step.to, LIFECYCLES, 'to'),
            relation_id: asString(step.relation_id, 'relation_id'),
            successor_id: asString(step.successor_id, 'successor_id'),
          };
        case 'qualification_restored':
          return {
            kind,
            belief_id: asString(step.belief_id, 'belief_id'),
            from: oneOf(step.from, QUALIFICATIONS, 'from'),
            to: oneOf(step.to, QUALIFICATIONS, 'to'),
            qualification_profile: canonQualificationProfile(step.qualification_profile),
          };
        case 'relation_restored':
          return {
            kind,
            relation_id: asString(step.relation_id, 'relation_id'),
            action: oneOf(step.action, ['add', 'remove'], 'action'),
            from: asString(step.from, 'from'),
            to: asString(step.to, 'to'),
            relation: oneOf(step.relation, RELATION_KINDS, 'relation'),
          };
        default:
          return {
            kind,
            belief_id: asString(step.belief_id, 'belief_id'),
            open_contest_event_id: asString(step.open_contest_event_id, 'open_contest_event_id'),
            addressed_by: oneOf(step.addressed_by, ['revert_application'], 'addressed_by'),
          };
      }
    }),
  };
}

/**
 * `ProposalV1`, stored whole inside `proposal.submitted`.
 *
 * The op payload is passed through as an opaque canonical value: the
 * proposal is a RECORD here, and the closed op union is validated where it
 * is constructed and interpreted (Rust). Re-deriving twenty payload shapes
 * in TypeScript would be exactly the twin-code defect M24 forbids — the
 * mock never constructs a proposal, it only replays ones the vectors carry.
 */
function canonProposal(v: Json | undefined): JsonObject {
  const p = asObject(v, 'proposal');
  const op = asObject(p.op, 'op');
  const basis = asObject(p.basis, 'basis');
  const use = asObject(p.intended_use, 'intended_use');
  return {
    schema: asU64(p.schema, 'proposal schema'),
    proposal_id: asString(p.proposal_id, 'proposal_id'),
    run_id: asString(p.run_id, 'run_id'),
    targets: asArray(p.targets, 'targets').map((entry) => {
      const t = asObject(entry, 'target');
      return {
        target_id: asString(t.target_id, 'target_id'),
        target_class: oneOf(t.target_class, TARGET_CLASSES, 'target_class'),
        expected_version:
          t.expected_version === null ? null : asU64(t.expected_version, 'expected_version'),
      };
    }),
    op: { kind: asString(op.kind, 'op kind'), payload: op.payload as Json },
    intended_use: {
      kind: oneOf(use.kind, INTENDED_USE_KINDS, 'intended use kind'),
      stakes: oneOf(use.stakes, RISKS, 'stakes'),
      predicate_class: asStringOrNull(use.predicate_class, 'predicate_class'),
    },
    basis: {
      transition_cause: oneOf(basis.transition_cause, TRANSITION_CAUSES, 'transition_cause'),
      evidence_refs: asArray(basis.evidence_refs, 'evidence_refs').map((r) =>
        asString(r, 'evidence ref'),
      ),
      coverage_refs: asArray(basis.coverage_refs, 'coverage_refs').map((r) =>
        asString(r, 'coverage ref'),
      ),
      authority_refs: asArray(basis.authority_refs, 'authority_refs').map((r) =>
        asString(r, 'authority ref'),
      ),
      authority_route_refs: asArray(basis.authority_route_refs, 'authority_route_refs').map((r) => {
        const route = asObject(r, 'authority route ref');
        return {
          authority_route_id: asString(route.authority_route_id, 'authority_route_id'),
          authority_rule_version: asU64(route.authority_rule_version, 'authority_rule_version'),
          artifact_hash: asString(route.artifact_hash, 'artifact_hash'),
        };
      }),
      addressed_contradictions: asArray(
        basis.addressed_contradictions,
        'addressed_contradictions',
      ).map((c) => {
        const edge = asObject(c, 'addressed contradiction');
        return {
          edge_id: asString(edge.edge_id, 'edge_id'),
          comparison_id: asString(edge.comparison_id, 'comparison_id'),
          disposition: oneOf(
            edge.disposition,
            ['resolved_with_evidence', 'superseded_with_addressing'],
            'disposition',
          ),
          evidence_refs: asArray(edge.evidence_refs, 'edge evidence').map((r) =>
            asString(r, 'edge evidence ref'),
          ),
        };
      }),
      absence_claim: (() => {
        if (typeof basis.absence_claim !== 'boolean') {
          throw new SchemaError('absence_claim is not a boolean');
        }
        return basis.absence_claim;
      })(),
    },
    declared_risk: oneOf(p.declared_risk, RISKS, 'declared_risk'),
    reason: asString(p.reason, 'reason'),
    candidate_search_receipt: p.candidate_search_receipt as Json,
  };
}

/** TypedValue: tag-checked canonical rebuild (recursive). */
export function canonTypedValue(v: Json | undefined): JsonObject {
  const obj = asObject(v, 'TypedValue');
  const type = asString(obj.type, 'TypedValue.type');
  switch (type) {
    case 'missing':
      return { type };
    case 'null':
      if (obj.value !== null) throw new SchemaError('null TypedValue carries null');
      return { type, value: null };
    case 'boolean':
      if (typeof obj.value !== 'boolean') throw new SchemaError('boolean TypedValue');
      return { type, value: obj.value };
    case 'number':
      if (typeof obj.value !== 'number') throw new SchemaError('number TypedValue');
      return { type, value: obj.value };
    case 'string':
      return { type, value: asString(obj.value, 'string TypedValue') };
    case 'array':
      return { type, value: asArray(obj.value, 'array TypedValue').map(canonTypedValue) };
    case 'object': {
      const map = asObject(obj.value, 'object TypedValue');
      const out: JsonObject = {};
      for (const [k, item] of Object.entries(map)) out[k] = canonTypedValue(item);
      return { type, value: out };
    }
    default:
      throw new SchemaError(`TypedValue: unknown type ${type}`);
  }
}

export function validateTypedValue(v: Json): void {
  const obj = v as JsonObject;
  if (obj.type === 'number' && typeof obj.value === 'number' && !Number.isFinite(obj.value)) {
    throw new RefusedError('non-finite number in TypedValue');
  }
  if (obj.type === 'array') for (const item of obj.value as Json[]) validateTypedValue(item);
  if (obj.type === 'object') {
    for (const item of Object.values(obj.value as JsonObject)) validateTypedValue(item);
  }
}

export function typedEquals(a: Json, b: Json): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonSubject(v: Json | undefined): JsonObject {
  const obj = asObject(v, 'subject');
  const resolution = oneOf(obj.resolution, ['resolved', 'unresolved', 'none'], 'resolution');
  if (resolution === 'resolved') {
    return {
      resolution,
      entity_id: asString(obj.entity_id, 'entity_id'),
      aliases: asArray(obj.aliases, 'aliases').map((a) => asString(a, 'alias')),
    };
  }
  if (resolution === 'unresolved') {
    return {
      resolution,
      raw_ref: asString(obj.raw_ref, 'raw_ref'),
      aliases: asArray(obj.aliases, 'aliases').map((a) => asString(a, 'alias')),
    };
  }
  return { resolution };
}

function validateSubject(subject: JsonObject): void {
  if (subject.resolution === 'resolved' && !isId128(subject.entity_id)) {
    throw new RefusedError('subject entity_id is not a 128-bit hex id');
  }
  if (subject.resolution === 'unresolved' && (subject.raw_ref as string).length === 0) {
    throw new RefusedError('unresolved subject raw_ref must be non-empty');
  }
  const aliases = (subject.aliases as string[] | undefined) ?? [];
  if (aliases.some((a) => a.length === 0)) {
    throw new RefusedError('subject aliases must be non-empty source spellings');
  }
}

const LINEAGE_KINDS = ['reported_by', 'derived_from', 'copied_from', 'summarized_from'];

function canonLineage(v: Json | undefined): JsonObject[] {
  return asArray(v, 'lineage').map((edge) => {
    const obj = asObject(edge, 'lineage edge');
    return {
      edge: oneOf(obj.edge, LINEAGE_KINDS, 'lineage edge kind'),
      parent_observation_event_id: asString(obj.parent_observation_event_id, 'lineage parent'),
    };
  });
}

function validateLineage(lineage: JsonObject[]): void {
  const seen = new Set<string>();
  for (const edge of lineage) {
    const parent = edge.parent_observation_event_id as string;
    if (!isId128(parent)) throw new RefusedError('lineage parent is not a 128-bit hex event id');
    if (seen.has(parent)) throw new RefusedError(`duplicate lineage parent ${parent}`);
    seen.add(parent);
  }
}

const CAPABILITIES = ['content_only', 'human_assertion', 'direct_system_artifact'];

function canonRegistration(v: Json | undefined): JsonObject {
  const obj = asObject(v, 'registration');
  const kind = oneOf(
    obj.kind,
    ['human_actor', 'connector', 'builtin', 'cerebro_runtime', 'legacy_reference'],
    'registration kind',
  );
  const shared = {
    source_key: asString(obj.source_key, 'source_key'),
    authority_capability: oneOf(obj.authority_capability, CAPABILITIES, 'capability'),
    independence_domain_id: asStringOrNull(obj.independence_domain_id, 'independence domain'),
  };
  if (kind === 'human_actor') {
    return {
      kind,
      source_key: shared.source_key,
      actor_id: asString(obj.actor_id, 'actor_id'),
      authority_capability: shared.authority_capability,
      independence_domain_id: shared.independence_domain_id,
    };
  }
  if (kind === 'connector') {
    return {
      kind,
      source_key: shared.source_key,
      connector_instance_id: asString(obj.connector_instance_id, 'connector_instance_id'),
      logical_scope_id: asString(obj.logical_scope_id, 'logical_scope_id'),
      authority_capability: shared.authority_capability,
      independence_domain_id: shared.independence_domain_id,
    };
  }
  if (kind === 'legacy_reference') {
    return {
      kind,
      source_key: shared.source_key,
      resource: asString(obj.resource, 'resource'),
      authority_capability: shared.authority_capability,
      independence_domain_id: shared.independence_domain_id,
    };
  }
  return {
    kind,
    source_key: shared.source_key,
    service_id: asString(obj.service_id, 'service_id'),
    authority_capability: shared.authority_capability,
    independence_domain_id: shared.independence_domain_id,
  };
}

export function registrationIdentity(registration: JsonObject): JsonObject {
  switch (registration.kind) {
    case 'human_actor':
      return { actor_id: registration.actor_id as string };
    case 'connector':
      return {
        connector_instance_id: registration.connector_instance_id as string,
        logical_scope_id: registration.logical_scope_id as string,
      };
    case 'legacy_reference':
      return { resource: registration.resource as string };
    default:
      return { service_id: registration.service_id as string };
  }
}

function validateRegistration(registration: JsonObject): void {
  const kind = registration.kind as string;
  const capability = registration.authority_capability as string;
  const domain = registration.independence_domain_id as string | null;
  if (kind === 'human_actor') {
    if ((registration.actor_id as string).length === 0) {
      throw new RefusedError('human_actor registration needs a non-empty actor_id');
    }
    if (capability !== 'human_assertion') {
      throw new RefusedError('human_actor capability is exactly human_assertion');
    }
  } else if (kind === 'connector') {
    if (
      (registration.connector_instance_id as string).length === 0 ||
      (registration.logical_scope_id as string).length === 0
    ) {
      throw new RefusedError('connector registration needs instance and scope ids');
    }
    if (capability === 'human_assertion') {
      throw new RefusedError('a connector can never carry human_assertion capability');
    }
  } else if (kind === 'legacy_reference') {
    const resource = registration.resource as string;
    if (resource.length === 0 || resource !== resource.trim()) {
      throw new RefusedError('legacy_reference resource must be trimmed and non-empty');
    }
    if (capability !== 'content_only') {
      throw new RefusedError('legacy_reference capability is exactly content_only');
    }
  } else {
    if ((registration.service_id as string).length === 0) {
      throw new RefusedError(`${kind} registration needs a non-empty service_id`);
    }
    if (kind === 'cerebro_runtime' && capability !== 'content_only') {
      throw new RefusedError('cerebro_runtime capability is exactly content_only');
    }
    if (capability === 'human_assertion') {
      throw new RefusedError('a builtin can never carry human_assertion capability');
    }
  }
  if (capability === 'direct_system_artifact') {
    if (domain === null || domain.length === 0) {
      throw new RefusedError('a direct-system registration requires an independence_domain_id');
    }
  } else if (domain !== null) {
    throw new RefusedError('independence_domain_id is non-null exactly for direct artifacts');
  }
  const identity = registrationIdentity(registration);
  if (registration.source_key !== deriveSourceKey(kind, identity)) {
    throw new RefusedError('source_key does not match its identity derivation');
  }
}

function canonBasis(v: Json | undefined): JsonObject {
  const obj = asObject(v, 'basis');
  const state = oneOf(obj.state, ['unsupported', 'linked'], 'basis state');
  if (state === 'unsupported') return { state, reason: asString(obj.reason, 'basis reason') };
  return {
    state,
    links: asArray(obj.links, 'basis links').map((link) => {
      const l = asObject(link, 'basis link');
      return {
        observation_event_id: asString(l.observation_event_id, 'basis observation'),
        role: oneOf(l.role, ['supports', 'opposes', 'context'], 'basis role'),
      };
    }),
  };
}

function validateBasis(basis: JsonObject): void {
  if (basis.state === 'unsupported') {
    if ((basis.reason as string).length === 0) {
      throw new RefusedError('unsupported basis requires a non-empty reason');
    }
    return;
  }
  const links = basis.links as JsonObject[];
  if (links.length === 0) throw new RefusedError('linked basis requires links');
  const seen = new Set<string>();
  for (const link of links) {
    const id = link.observation_event_id as string;
    if (!isId128(id)) throw new RefusedError('basis link is not an event id');
    if (seen.has(id)) throw new RefusedError(`duplicate basis link ${id}`);
    seen.add(id);
  }
}

// --- common metadata -------------------------------------------------------

function canonCommon(obj: JsonObject): JsonObject {
  const actor = asObject(obj.actor, 'actor');
  return {
    schema: asU64(obj.schema, 'schema'),
    batch_id: asStringOrNull(obj.batch_id, 'batch_id'),
    idempotency_key: asStringOrNull(obj.idempotency_key, 'idempotency_key'),
    actor: { id: asString(actor.id, 'actor id') },
    occurred_at: asStringOrNull(obj.occurred_at, 'occurred_at'),
    valid_from: asStringOrNull(obj.valid_from, 'valid_from'),
    valid_to: asStringOrNull(obj.valid_to, 'valid_to'),
  };
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * The shape gate AND the calendar gate (M27.11b). Rust validates every stamp
 * with chrono, which refuses impossible values — a February 30th, a 25th
 * hour, a `+99:00` offset. The regex alone accepted all of those, so the
 * mock could apply history the real reducer refuses. Ranges are matched to
 * `chrono::DateTime::parse_from_rfc3339`: seconds run to 60 (a leap
 * second), offsets to ±23:59.
 */
function isRfc3339(v: Json): boolean {
  if (typeof v !== 'string') return false;
  const m = v.match(RFC3339);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > last) return false;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 60) return false;
  const offset = m[8];
  if (offset !== 'Z' && offset !== 'z') {
    if (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59) return false;
  }
  return true;
}

export function validateCommon(body: JsonObject): void {
  if (body.schema !== 1) throw new RefusedError(`unsupported body schema ${body.schema}`);
  if (body.batch_id !== null && !isId128(body.batch_id)) {
    throw new RefusedError('batch_id is not a 128-bit hex id');
  }
  if (body.idempotency_key === '') {
    throw new RefusedError('idempotency_key must be null or non-empty');
  }
  if (((body.actor as JsonObject).id as string).length === 0) {
    throw new RefusedError('actor.id must be non-empty');
  }
  for (const key of ['occurred_at', 'valid_from', 'valid_to']) {
    const stamp = body[key];
    if (stamp !== null && !isRfc3339(stamp as string)) {
      throw new RefusedError(`${key} is not RFC3339`);
    }
  }
}

// --- per-kind canonicalizers (decode-time, serde-equivalent) ---------------

const OBSERVATION_KINDS = [
  'source_snapshot',
  'system_event',
  'extracted_assertion',
  'derived_content',
  'human_assertion',
];

// M25.3's closed vocabularies. Sorted the way Rust's enums declare them, so
// a value either matches exactly or is refused — never coerced.
const PREFILTER_VERDICTS = [
  'no_change',
  'non_material_change',
  'material_candidate',
  'needs_semantic_judgment',
];
const MATERIAL_DIMENSIONS = ['attention', 'belief_state', 'evidence_state', 'world_state'];
const INDEPENDENCE_STATES = ['independence_unknown', 'known_independent', 'known_same_lineage'];
const INGEST_ROUTES = [
  'closed_no_change',
  'closed_non_material',
  'deterministic_proposal_applied',
  'deterministic_proposal_queued',
  'deterministic_proposal_rejected',
  'm26_queued',
  'm26_completed',
  'failed_visible',
];

/// Which verdicts each route may carry, and which refs it requires or
/// forbids. The twin of `Route::allows` / `Route::proposals` etc. in
/// `ledger/schema/ingest.rs`, proven equal by the shared vectors.
const ROUTE_RULES: {
  [route: string]: {
    verdicts: string[];
    observations: 'required' | 'free';
    proposals: 'required' | 'forbidden' | 'free';
    batchKey: 'required' | 'forbidden';
    outcome: 'required' | 'forbidden';
    supersedes: 'required' | 'forbidden';
  };
} = {
  closed_no_change: {
    verdicts: ['no_change'],
    observations: 'free',
    proposals: 'forbidden',
    batchKey: 'forbidden',
    outcome: 'forbidden',
    supersedes: 'forbidden',
  },
  closed_non_material: {
    verdicts: ['non_material_change'],
    observations: 'required',
    proposals: 'forbidden',
    batchKey: 'forbidden',
    outcome: 'forbidden',
    supersedes: 'forbidden',
  },
  deterministic_proposal_applied: {
    verdicts: ['material_candidate'],
    observations: 'required',
    proposals: 'required',
    batchKey: 'forbidden',
    outcome: 'forbidden',
    supersedes: 'forbidden',
  },
  deterministic_proposal_queued: {
    verdicts: ['material_candidate'],
    observations: 'required',
    proposals: 'required',
    batchKey: 'forbidden',
    outcome: 'forbidden',
    supersedes: 'forbidden',
  },
  deterministic_proposal_rejected: {
    verdicts: ['material_candidate'],
    observations: 'required',
    proposals: 'required',
    batchKey: 'forbidden',
    outcome: 'forbidden',
    supersedes: 'forbidden',
  },
  m26_queued: {
    verdicts: ['material_candidate', 'needs_semantic_judgment'],
    observations: 'required',
    proposals: 'forbidden',
    batchKey: 'required',
    outcome: 'forbidden',
    supersedes: 'forbidden',
  },
  m26_completed: {
    verdicts: ['material_candidate', 'needs_semantic_judgment'],
    observations: 'required',
    proposals: 'free',
    batchKey: 'required',
    outcome: 'required',
    supersedes: 'required',
  },
  failed_visible: {
    verdicts: ['material_candidate', 'needs_semantic_judgment'],
    observations: 'required',
    proposals: 'forbidden',
    batchKey: 'required',
    outcome: 'required',
    supersedes: 'required',
  },
};

// --- M26.4 the semantic disposition -----------------------------------------

const SEMANTIC_OUTCOMES = ['material', 'non_material', 'undetermined'];
const SEMANTIC_DISPOSITIONS = ['proposals_submitted', 'closed_non_material', 'blocked_visible'];
const BLOCKED_REASONS = [
  'batch_input_incomplete',
  'policy_dependency_unavailable',
  'runtime_unavailable',
  'semantic_validation_failed',
  'source_access_lost',
];
const CONTENT_LABELS = ['agent_supplied'];

/// The ceiling on agent prose in the vault ledger. The twin of
/// `MAX_EXPLANATION_BYTES` in `ledger/schema/semantic.rs`.
const MAX_EXPLANATION_BYTES = 2000;

/// Bytes, not UTF-16 code units. Rust bounds `explanation.len()`, which is a
/// byte count — measuring characters here would let an emoji-heavy
/// explanation pass on one side and refuse on the other.
function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/// What each outcome pins. The twin of `SemanticOutcome::disposition` and its
/// sibling methods in `ledger/schema/semantic.rs`, proven equal by the shared
/// vectors. One disposition per outcome is the closed table: six of the nine
/// pairings do not exist.
const OUTCOME_RULES: {
  [outcome: string]: {
    disposition: string;
    evaluated: 'required' | 'free';
    material: 'required' | 'forbidden';
    proposals: 'required' | 'forbidden';
    blocked: 'required' | 'forbidden';
  };
} = {
  material: {
    disposition: 'proposals_submitted',
    evaluated: 'required',
    material: 'required',
    proposals: 'required',
    blocked: 'forbidden',
  },
  non_material: {
    disposition: 'closed_non_material',
    evaluated: 'required',
    material: 'forbidden',
    proposals: 'forbidden',
    blocked: 'forbidden',
  },
  undetermined: {
    disposition: 'blocked_visible',
    evaluated: 'free',
    material: 'forbidden',
    proposals: 'forbidden',
    blocked: 'required',
  },
};

/// Where M25 puts a window's items once this outcome closed it.
export const OUTCOME_SCHEDULER_STATE: { [outcome: string]: string } = {
  material: 'consumed',
  non_material: 'consumed',
  undetermined: 'recovery_held',
};

/// Where recovery puts an item whose latest receipt took this route.
export const ROUTE_SCHEDULER_STATE: { [route: string]: string } = {
  closed_no_change: 'consumed',
  closed_non_material: 'consumed',
  deterministic_proposal_applied: 'consumed',
  deterministic_proposal_queued: 'pending_review',
  deterministic_proposal_rejected: 'consumed',
  m26_queued: 'pending',
  m26_completed: 'consumed',
  failed_visible: 'recovery_held',
};

// --- M25.4 coverage ---------------------------------------------------------

const COVERAGE_DIMENSIONS = [
  'source_connected',
  'source_healthy',
  'scope_known',
  'scope_accessible',
  'retention_known',
  'index_current',
  'retrieval_attempted',
];
const DIMENSION_STATES = ['yes', 'no', 'unknown', 'not_applicable'];
const PRODUCER_KINDS = [
  'connector_adapter',
  'builtin_adapter',
  'vault_indexer',
  'retrieval_engine',
];
export const ACTOR_VAULT_INDEXER = 'system:vault-indexer';
export const ACTOR_RETRIEVAL_ENGINE = 'system:retrieval-engine';

/** Which dimension each fact variant establishes, and which state it means. */
const FACT_VARIANTS: {
  [kind: string]: { dimension: string; yes: string; no: string; producers: string[] };
} = {
  connection_probe: {
    dimension: 'source_connected',
    yes: 'connected',
    no: 'disconnected',
    producers: ['connector_adapter', 'builtin_adapter'],
  },
  health_probe: {
    dimension: 'source_healthy',
    yes: 'healthy',
    no: 'unhealthy',
    producers: ['connector_adapter', 'builtin_adapter'],
  },
  scope_discovery: {
    dimension: 'scope_known',
    yes: 'known',
    no: 'unknown',
    producers: ['connector_adapter', 'builtin_adapter'],
  },
  access_probe: {
    dimension: 'scope_accessible',
    yes: 'accessible',
    no: 'denied',
    producers: ['connector_adapter', 'builtin_adapter'],
  },
  retention_discovery: {
    dimension: 'retention_known',
    yes: 'known',
    no: 'unknown',
    producers: ['connector_adapter', 'builtin_adapter'],
  },
  index_checkpoint: {
    dimension: 'index_current',
    yes: 'current',
    no: 'stale',
    producers: ['vault_indexer'],
  },
  retrieval_execution: {
    dimension: 'retrieval_attempted',
    yes: '',
    no: '',
    producers: ['retrieval_engine'],
  },
  retrieval_window_closed_without_attempt: {
    dimension: 'retrieval_attempted',
    yes: '',
    no: '',
    producers: ['retrieval_engine'],
  },
};

/** A runtime failure may affect processing; it never speaks for the source. */
const RUNTIME_AFFECTABLE = ['scope_accessible', 'index_current', 'retrieval_attempted'];

/**
 * M26.7's conflict-candidate endpoint. Declared in Rust field order, because
 * the round-trip gate compares bytes and a reordered rebuild reads as a
 * non-canonical body rather than as a TS bug.
 */
function canonConflictEndpoint(v: Json | undefined, side: string): JsonObject {
  const e = asObject(v, side);
  const validTime = asObject(e.valid_time, `${side}.valid_time`);
  return {
    assertion_event_id: asString(e.assertion_event_id, `${side}.assertion_event_id`),
    belief_id: asString(e.belief_id, `${side}.belief_id`),
    belief_revision_event_id: asString(
      e.belief_revision_event_id,
      `${side}.belief_revision_event_id`,
    ),
    subject_id: asString(e.subject_id, `${side}.subject_id`),
    predicate: asString(e.predicate, `${side}.predicate`),
    value_hash: asString(e.value_hash, `${side}.value_hash`),
    scope: canonScopeObject(e.scope),
    state_stage: oneOf(e.state_stage, STATE_STAGES, `${side}.state_stage`),
    valid_time: {
      from: asStringOrNull(validTime.from, `${side}.valid_time.from`),
      to: asStringOrNull(validTime.to, `${side}.valid_time.to`),
    },
  };
}

function canonScopeObject(v: Json | undefined): JsonObject {
  const scope = asObject(v, 'scope');
  return {
    stage:
      scope.stage === null || scope.stage === undefined
        ? null
        : oneOf(scope.stage, STAGES, 'stage'),
    revision: asStringOrNull(scope.revision, 'scope.revision'),
    environment: asStringOrNull(scope.environment, 'scope.environment'),
    geography: asStringOrNull(scope.geography, 'scope.geography'),
  };
}

function canonCoverageSubject(v: Json | undefined): JsonObject {
  const subject = asObject(v, 'subject');
  return {
    entity_id: asStringOrNull(subject.entity_id, 'entity_id'),
    predicate_class: asStringOrNull(subject.predicate_class, 'predicate_class'),
    scope: canonScopeObject(subject.scope),
  };
}

function canonRetrievalReceipt(v: Json | undefined): JsonObject {
  const r = asObject(v, 'retrieval_receipt');
  return {
    strategy_version: asString(r.strategy_version, 'strategy_version'),
    query_strategy: asString(r.query_strategy, 'query_strategy'),
    query_fingerprint: asString(r.query_fingerprint, 'query_fingerprint'),
    attempted_at: asString(r.attempted_at, 'attempted_at'),
    searched_domain: asString(r.searched_domain, 'searched_domain'),
    search_scope: asString(r.search_scope, 'search_scope'),
    observation_window: asString(r.observation_window, 'observation_window'),
    searched_aliases: asArray(r.searched_aliases, 'searched_aliases').map((a) =>
      asString(a, 'alias'),
    ),
    searched_scopes: asArray(r.searched_scopes, 'searched_scopes').map(canonScopeObject),
  };
}

function canonFact(v: Json | undefined): JsonObject {
  const f = asObject(v, 'fact');
  const kind = oneOf(f.kind, Object.keys(FACT_VARIANTS), 'fact kind');
  switch (kind) {
    case 'connection_probe':
      return { kind, result: oneOf(f.result, ['connected', 'disconnected'], 'result') };
    case 'health_probe':
      return { kind, result: oneOf(f.result, ['healthy', 'unhealthy'], 'result') };
    case 'scope_discovery':
      return {
        kind,
        scope_digest: asString(f.scope_digest, 'scope_digest'),
        result: oneOf(f.result, ['known', 'unknown'], 'result'),
      };
    case 'access_probe':
      return {
        kind,
        scope_digest: asString(f.scope_digest, 'scope_digest'),
        result: oneOf(f.result, ['accessible', 'denied'], 'result'),
      };
    case 'retention_discovery':
      return {
        kind,
        result: oneOf(f.result, ['known', 'unknown'], 'result'),
        retention_seconds:
          f.retention_seconds === null ? null : asU64(f.retention_seconds, 'retention_seconds'),
      };
    case 'index_checkpoint':
      return {
        kind,
        index_head: asString(f.index_head, 'index_head'),
        source_revision: asString(f.source_revision, 'source_revision'),
        result: oneOf(f.result, ['current', 'stale'], 'result'),
      };
    case 'retrieval_execution':
      return { kind, retrieval_receipt: canonRetrievalReceipt(f.retrieval_receipt) };
    default:
      return {
        kind,
        window_start: asString(f.window_start, 'window_start'),
        window_end: asString(f.window_end, 'window_end'),
      };
  }
}

function canonDimension(v: Json | undefined, what: string): JsonObject {
  const d = asObject(v, what);
  return {
    state: oneOf(d.state, DIMENSION_STATES, `${what}.state`),
    basis_event_ids: asArray(d.basis_event_ids, `${what}.basis`).map((id) =>
      asString(id, 'basis id'),
    ),
    as_of: asString(d.as_of, `${what}.as_of`),
  };
}

function canonDimensions(v: Json | undefined): JsonObject {
  const d = asObject(v, 'dimensions');
  const out: JsonObject = {};
  for (const name of COVERAGE_DIMENSIONS) out[name] = canonDimension(d[name], name);
  return out;
}

type Canonicalizer = (obj: JsonObject) => JsonObject;

const CANONICALIZERS: { [kind: string]: Canonicalizer } = {
  'batch.committed': (obj) => ({
    ...canonCommon(obj),
    member_event_ids: asArray(obj.member_event_ids, 'member ids').map((id) =>
      asString(id, 'member id'),
    ),
    member_count: asU64(obj.member_count, 'member_count'),
    members_digest: asString(obj.members_digest, 'members_digest'),
    operation_digest: asString(obj.operation_digest, 'operation_digest'),
  }),
  'source.registered': (obj) => ({
    ...canonCommon(obj),
    source_id: asString(obj.source_id, 'source_id'),
    registration: canonRegistration(obj.registration),
  }),
  'observation.recorded': (obj) => ({
    ...canonCommon(obj),
    observation_kind: oneOf(obj.observation_kind, OBSERVATION_KINDS, 'observation_kind'),
    source_id: asString(obj.source_id, 'source_id'),
    source_registration_event_id: asString(obj.source_registration_event_id, 'registration pin'),
    subject: canonSubject(obj.subject),
    lineage: canonLineage(obj.lineage),
    provenance: (() => {
      const p = asObject(obj.provenance, 'provenance');
      return {
        source_system: asStringOrNull(p.source_system, 'source_system'),
        source_location: asStringOrNull(p.source_location, 'source_location'),
        source_record_id: asStringOrNull(p.source_record_id, 'source_record_id'),
        source_revision: asStringOrNull(p.source_revision, 'source_revision'),
        source_author: asStringOrNull(p.source_author, 'source_author'),
        source_workflow_state: asStringOrNull(p.source_workflow_state, 'source_workflow_state'),
      };
    })(),
    // The payload stays RAW at decode time (Rust keeps serde_json::Value);
    // its per-kind gate runs in validateObservation.
    payload: obj.payload as Json,
  }),
  'observation.subject_resolved': (obj) => {
    const change = asObject(obj.change, 'change');
    const action = oneOf(change.action, ['attach', 'correct'], 'action');
    const tier = oneOf(
      change.resolver_tier,
      ['exact_id', 'known_alias', 'explicit_relation', 'normalized_match'],
      'resolver_tier',
    );
    const basis = asArray(change.basis_event_ids, 'basis').map((id) => asString(id, 'basis id'));
    const canonChange: JsonObject =
      action === 'attach'
        ? {
            action,
            entity_id: asString(change.entity_id, 'entity_id'),
            resolver_tier: tier,
            basis_event_ids: basis,
          }
        : {
            action,
            prior_resolution_event_id: asString(change.prior_resolution_event_id, 'prior'),
            from_entity_id: asString(change.from_entity_id, 'from_entity_id'),
            to_entity_id: asString(change.to_entity_id, 'to_entity_id'),
            resolver_tier: tier,
            basis_event_ids: basis,
            reason: asString(change.reason, 'reason'),
          };
    return {
      ...canonCommon(obj),
      observation_event_id: asString(obj.observation_event_id, 'observation_event_id'),
      change: canonChange,
    };
  },
  'observation.independence_recorded': (obj) => {
    const proof = asObject(obj.proof, 'proof');
    const kind = oneOf(
      proof.kind,
      ['distinct_firsthand_origin', 'independent_system_artifact', 'human_confirmed'],
      'proof kind',
    );
    const refs = {
      left_source_registration_event_id: asString(
        proof.left_source_registration_event_id,
        'left registration',
      ),
      right_source_registration_event_id: asString(
        proof.right_source_registration_event_id,
        'right registration',
      ),
    };
    const canonProof: JsonObject =
      kind === 'human_confirmed'
        ? {
            kind,
            ...refs,
            proposal_id: asString(proof.proposal_id, 'proposal_id'),
            decision_event_id: asString(proof.decision_event_id, 'decision_event_id'),
          }
        : { kind, ...refs, rule_version: asString(proof.rule_version, 'rule_version') };
    return {
      ...canonCommon(obj),
      left_observation_event_id: asString(obj.left_observation_event_id, 'left endpoint'),
      right_observation_event_id: asString(obj.right_observation_event_id, 'right endpoint'),
      proof: canonProof,
      reason: asString(obj.reason, 'reason'),
    };
  },
  'belief.created': (obj) => ({
    ...canonCommon(obj),
    belief_id: asString(obj.belief_id, 'belief_id'),
    subject: canonSubject(obj.subject),
    content: asString(obj.content, 'content'),
    fields: asObject(obj.fields, 'fields') as Json,
    basis: canonBasis(obj.basis),
  }),
  'belief.revised': (obj) => ({
    ...canonCommon(obj),
    belief_id: asString(obj.belief_id, 'belief_id'),
    patch: asArray(obj.patch, 'patch').map((op) => {
      const o = asObject(op, 'patch op');
      return {
        field_path: asString(o.field_path, 'field_path'),
        before: canonTypedValue(o.before),
        after: canonTypedValue(o.after),
      };
    }),
    basis: canonBasis(obj.basis),
  }),
  'belief.relation': (obj) => ({
    ...canonCommon(obj),
    relation_id: asString(obj.relation_id, 'relation_id'),
    action: oneOf(obj.action, ['add', 'remove'], 'action'),
    from: asString(obj.from, 'from'),
    to: asString(obj.to, 'to'),
    relation: oneOf(obj.relation, RELATION_KINDS, 'relation'),
  }),
  'belief.attested': (obj) => ({
    ...canonCommon(obj),
    belief_id: asString(obj.belief_id, 'belief_id'),
    attested_belief_revision_event_id: asString(
      obj.attested_belief_revision_event_id,
      'attested revision',
    ),
    attested_content_hash: asString(obj.attested_content_hash, 'attested hash'),
  }),
  'entity.alias_added': (obj) => ({
    ...canonCommon(obj),
    entity_id: asString(obj.entity_id, 'entity_id'),
    alias: asString(obj.alias, 'alias'),
    normalized_alias: asString(obj.normalized_alias, 'normalized_alias'),
  }),
  'migration.started': (obj) => ({
    ...canonCommon(obj),
    store_uuid: asString(obj.store_uuid, 'store_uuid'),
    migration_schema: asU64(obj.migration_schema, 'migration_schema'),
    source_digest: asString(obj.source_digest, 'source_digest'),
    planned_output_count: asU64(obj.planned_output_count, 'planned_output_count'),
  }),
  'migration.completed': (obj) => ({
    ...canonCommon(obj),
    store_uuid: asString(obj.store_uuid, 'store_uuid'),
    migration_schema: asU64(obj.migration_schema, 'migration_schema'),
    source_digest: asString(obj.source_digest, 'source_digest'),
    output_count: asU64(obj.output_count, 'output_count'),
    output_keys_digest: asString(obj.output_keys_digest, 'output_keys_digest'),
  }),
  'projection.overridden': (obj) => {
    const change = asObject(obj.change, 'change');
    const action = oneOf(change.action, ['set', 'clear'], 'override action');
    const canonChange: JsonObject =
      action === 'set'
        ? {
            action,
            patch: asArray(change.patch, 'override patch').map((op) => {
              const o = asObject(op, 'override op');
              return {
                field_path: asString(o.field_path, 'field_path'),
                before: canonTypedValue(o.before),
                after: canonTypedValue(o.after),
              };
            }),
            supersedes_override_event_ids: asArray(
              change.supersedes_override_event_ids,
              'supersedes',
            ).map((id) => asString(id, 'superseded override ref')),
          }
        : {
            action,
            override_event_ids: asArray(change.override_event_ids, 'cleared overrides').map((id) =>
              asString(id, 'cleared override ref'),
            ),
            reason: asString(change.reason, 'clear reason'),
          };
    return {
      ...canonCommon(obj),
      belief_id: asString(obj.belief_id, 'belief_id'),
      path: asString(obj.path, 'path'),
      base_belief_revision: asU64(obj.base_belief_revision, 'base_belief_revision'),
      base_belief_revision_event: asString(obj.base_belief_revision_event, 'base revision event'),
      base_generating_event: asString(obj.base_generating_event, 'base generating event'),
      before_projection_hash: asString(obj.before_projection_hash, 'before hash'),
      after_projection_hash: asString(obj.after_projection_hash, 'after hash'),
      origin: oneOf(obj.origin, ['in_app', 'out_of_band', 'reconciliation_adoption'], 'origin'),
      change: canonChange,
    };
  },
  'ledger.divergence': (obj) => ({
    ...canonCommon(obj),
    detection_key: asString(obj.detection_key, 'detection_key'),
    signals: asArray(obj.signals, 'signals').map((s) =>
      oneOf(s, DIVERGENCE_SIGNALS, 'divergence signal'),
    ),
    ledger_head: asString(obj.ledger_head, 'ledger_head'),
    git_anchored_head: asStringOrNull(obj.git_anchored_head, 'git_anchored_head'),
    remembered_head: asStringOrNull(obj.remembered_head, 'remembered_head'),
    manifest_digest: asString(obj.manifest_digest, 'manifest_digest'),
    reducer_projection_digest: asString(obj.reducer_projection_digest, 'reducer digest'),
    mismatch_count: asU64(obj.mismatch_count, 'mismatch_count'),
    projection_count: asU64(obj.projection_count, 'projection_count'),
    sample_paths: asArray(obj.sample_paths, 'sample_paths').map((p) => asString(p, 'sample path')),
  }),
  'ledger.reconciliation_resolved': (obj) => ({
    ...canonCommon(obj),
    divergence_event_id: asString(obj.divergence_event_id, 'divergence_event_id'),
    action: oneOf(obj.action, ['accept_current_files', 'restore_ledger_authority'], 'action'),
    affected_paths: asArray(obj.affected_paths, 'affected_paths').map((p) =>
      asString(p, 'affected path'),
    ),
    capture_batch_ids: asArray(obj.capture_batch_ids, 'capture_batch_ids').map((id) =>
      asString(id, 'capture batch id'),
    ),
    accepted_files_digest: asStringOrNull(obj.accepted_files_digest, 'accepted digest'),
    resulting_projection_digest: asString(obj.resulting_projection_digest, 'resulting digest'),
  }),

  // --- M24.3: governed mutations -----------------------------------------
  'belief.qualification_changed': (obj) => ({
    ...canonCommon(obj),
    belief_id: asString(obj.belief_id, 'belief_id'),
    from: oneOf(obj.from, QUALIFICATIONS, 'from'),
    to: oneOf(obj.to, QUALIFICATIONS, 'to'),
    qualification_profile: canonQualificationProfile(obj.qualification_profile),
    cause: oneOf(obj.cause, ['promoted', 'reverted'], 'cause'),
  }),
  'belief.lifecycle_changed': (obj) => ({
    ...canonCommon(obj),
    belief_id: asString(obj.belief_id, 'belief_id'),
    from: oneOf(obj.from, LIFECYCLES, 'from'),
    to: oneOf(obj.to, LIFECYCLES, 'to'),
    cause: oneOf(obj.cause, ['superseded', 'archived', 'deprecated', 'reverted'], 'cause'),
    replacement_id: asStringOrNull(obj.replacement_id, 'replacement_id'),
  }),
  'belief.tombstoned': (obj) => ({
    ...canonCommon(obj),
    belief_id: asString(obj.belief_id, 'belief_id'),
    replacement_id: asStringOrNull(obj.replacement_id, 'replacement_id'),
    reason_code: oneOf(
      obj.reason_code,
      ['duplicate', 'superseded', 'invalid', 'owner_requested'],
      'reason_code',
    ),
  }),
  'belief.contested': (obj) => ({
    ...canonCommon(obj),
    belief_id: asString(obj.belief_id, 'belief_id'),
    action: oneOf(obj.action, ['open', 'close'], 'action'),
    counterevidence_refs: asArray(obj.counterevidence_refs, 'counterevidence').map((r) =>
      asString(r, 'counterevidence ref'),
    ),
    addressed_by_event_id: asStringOrNull(obj.addressed_by_event_id, 'addressed_by_event_id'),
  }),
  'entity.merged': (obj) => ({
    ...canonCommon(obj),
    survivor_id: asString(obj.survivor_id, 'survivor_id'),
    merged_ids: asArray(obj.merged_ids, 'merged_ids').map((id) => asString(id, 'merged id')),
    reassignment_plan: canonReassignmentPlan(obj.reassignment_plan),
    reassignment_digest: asString(obj.reassignment_digest, 'reassignment_digest'),
  }),

  // --- M24.3: the proposal lifecycle --------------------------------------
  'proposal.submitted': (obj) => ({
    ...canonCommon(obj),
    proposal: canonProposal(obj.proposal),
  }),
  'proposal.queued': (obj) => ({
    ...canonCommon(obj),
    proposal_id: asString(obj.proposal_id, 'proposal_id'),
    commit_set_id: asString(obj.commit_set_id, 'commit_set_id'),
    member_proposal_ids: asArray(obj.member_proposal_ids, 'members').map((id) =>
      asString(id, 'member id'),
    ),
    effective_risk: oneOf(obj.effective_risk, RISKS, 'effective_risk'),
    policy_version: asU64(obj.policy_version, 'policy_version'),
    target_versions: canonTargetVersions(obj.target_versions),
    queued_at: asString(obj.queued_at, 'queued_at'),
    // M24.8: why policy is holding this, beyond the risk ladder. Defaulted
    // so events written before the field still canonicalize.
    queued_for: asArray(obj.queued_for ?? [], 'queued_for').map((code) =>
      asString(code, 'queued reason'),
    ),
  }),
  'proposal.decision_recorded': (obj) => ({
    ...canonCommon(obj),
    decision_id: asString(obj.decision_id, 'decision_id'),
    proposal_id: asString(obj.proposal_id, 'proposal_id'),
    decision: oneOf(obj.decision, ['approve', 'reject'], 'decision'),
    reviewer: asString(obj.reviewer, 'reviewer'),
    decided_at: asString(obj.decided_at, 'decided_at'),
    reason: asStringOrNull(obj.reason, 'reason'),
    reviewed_target_versions: canonTargetVersions(obj.reviewed_target_versions),
  }),
  'proposal.applied': (obj) => ({
    ...canonCommon(obj),
    proposal_id: asString(obj.proposal_id, 'proposal_id'),
    commit_set_id: asString(obj.commit_set_id, 'commit_set_id'),
    effective_risk: oneOf(obj.effective_risk, RISKS, 'effective_risk'),
    decision_id: asStringOrNull(obj.decision_id, 'decision_id'),
    mutation_event_ids: asArray(obj.mutation_event_ids, 'mutation ids').map((id) =>
      asString(id, 'mutation event id'),
    ),
    resulting_versions: canonTargetVersions(obj.resulting_versions),
    revert_plan: obj.revert_plan === null ? null : canonRevertPlan(obj.revert_plan),
  }),
  'proposal.rejected': (obj) => ({
    ...canonCommon(obj),
    proposal_id: asString(obj.proposal_id, 'proposal_id'),
    commit_set_id: asString(obj.commit_set_id, 'commit_set_id'),
    code: asString(obj.code, 'code'),
    rule: asString(obj.rule, 'rule'),
    expected: canonTypedValue(obj.expected),
    actual: canonTypedValue(obj.actual),
    decision_id: asStringOrNull(obj.decision_id, 'decision_id'),
    refused_by_proposal_id: asStringOrNull(obj.refused_by_proposal_id, 'refused_by'),
  }),
  'proposal.reverted': (obj) => ({
    ...canonCommon(obj),
    proposal_id: asString(obj.proposal_id, 'proposal_id'),
    reverted_by_proposal_id: asString(obj.reverted_by_proposal_id, 'reverted_by_proposal_id'),
    prior_applied_event_ids: asArray(obj.prior_applied_event_ids, 'prior applied').map((id) =>
      asString(id, 'prior applied event id'),
    ),
    forward_event_ids: asArray(obj.forward_event_ids, 'forward events').map((id) =>
      asString(id, 'forward event id'),
    ),
    resulting_versions: canonTargetVersions(obj.resulting_versions),
  }),
  'coverage.fact_recorded': (obj) => ({
    ...canonCommon(obj),
    fact_id: asString(obj.fact_id, 'fact_id'),
    source_id: asString(obj.source_id, 'source_id'),
    source_registration_event_id: asString(obj.source_registration_event_id, 'registration pin'),
    subject: canonCoverageSubject(obj.subject),
    dimension: oneOf(obj.dimension, COVERAGE_DIMENSIONS, 'dimension'),
    state: oneOf(obj.state, DIMENSION_STATES, 'state'),
    as_of: asString(obj.as_of, 'as_of'),
    producer: (() => {
      const p = asObject(obj.producer, 'producer');
      return {
        kind: oneOf(p.kind, PRODUCER_KINDS, 'producer kind'),
        producer_version: asString(p.producer_version, 'producer_version'),
      };
    })(),
    fact: canonFact(obj.fact),
  }),
  'coverage.assessed': (obj) => ({
    ...canonCommon(obj),
    assessment_id: asString(obj.assessment_id, 'assessment_id'),
    subject: canonCoverageSubject(obj.subject),
    source_id: asString(obj.source_id, 'source_id'),
    dimensions: canonDimensions(obj.dimensions),
    retrieval_receipt:
      obj.retrieval_receipt === null ? null : canonRetrievalReceipt(obj.retrieval_receipt),
    limitations: asArray(obj.limitations, 'limitations').map((l) => {
      const limitation = asObject(l, 'limitation');
      return {
        dimension: oneOf(limitation.dimension, COVERAGE_DIMENSIONS, 'limitation dimension'),
        reason: asString(limitation.reason, 'limitation reason'),
      };
    }),
    supersedes_assessment_id: asStringOrNull(obj.supersedes_assessment_id, 'supersedes'),
  }),
  'coverage.gap': (obj) => ({
    ...canonCommon(obj),
    gap_id: asString(obj.gap_id, 'gap_id'),
    subject: canonCoverageSubject(obj.subject),
    source_id: asStringOrNull(obj.source_id, 'source_id'),
    responsibility_id: asStringOrNull(obj.responsibility_id, 'responsibility_id'),
    contract_version:
      obj.contract_version === null ? null : asU64(obj.contract_version, 'contract_version'),
    contract_digest: asStringOrNull(obj.contract_digest, 'contract_digest'),
    cause: (() => {
      const cause = asObject(obj.cause, 'cause');
      return {
        kind: oneOf(cause.kind, ['source', 'reasoning_runtime'], 'cause kind'),
        component: asStringOrNull(cause.component, 'component'),
      };
    })(),
    opened_at: asString(obj.opened_at, 'opened_at'),
    assessment_id: asStringOrNull(obj.assessment_id, 'assessment_id'),
    affected_dimensions: asArray(obj.affected_dimensions, 'affected').map((d) =>
      oneOf(d, COVERAGE_DIMENSIONS, 'affected dimension'),
    ),
    pending_count_at_open: asU64(obj.pending_count_at_open, 'pending_count_at_open'),
    reason: asString(obj.reason, 'reason'),
  }),
  'coverage.restored': (obj) => ({
    ...canonCommon(obj),
    gap_id: asString(obj.gap_id, 'gap_id'),
    restored_at: asString(obj.restored_at, 'restored_at'),
    assessment_id: asStringOrNull(obj.assessment_id, 'assessment_id'),
    restored_dimensions: asArray(obj.restored_dimensions, 'restored').map((d) =>
      oneOf(d, COVERAGE_DIMENSIONS, 'restored dimension'),
    ),
    reason: asString(obj.reason, 'reason'),
  }),
  // M25.3 — the portable processing receipt. Field order IS the canonical
  // byte order, so this list mirrors `IngestAssessed`'s declaration exactly.
  'ingest.assessed': (obj) => ({
    ...canonCommon(obj),
    receipt_id: asString(obj.receipt_id, 'receipt_id'),
    item_id: asString(obj.item_id, 'item_id'),
    source_id: asString(obj.source_id, 'source_id'),
    source_record_id: asStringOrNull(obj.source_record_id, 'source_record_id'),
    artifact_hash: asString(obj.artifact_hash, 'artifact_hash'),
    normalized_snapshot_hash: asString(obj.normalized_snapshot_hash, 'normalized_snapshot_hash'),
    normalizer_version: asString(obj.normalizer_version, 'normalizer_version'),
    processing_epoch: asU64(obj.processing_epoch, 'processing_epoch'),
    assessed_against_chain_head: asString(
      obj.assessed_against_chain_head,
      'assessed_against_chain_head',
    ),
    prefilter_verdict: oneOf(obj.prefilter_verdict, PREFILTER_VERDICTS, 'prefilter_verdict'),
    material_dimensions: asArray(obj.material_dimensions, 'material_dimensions').map((d) =>
      oneOf(d, MATERIAL_DIMENSIONS, 'material dimension'),
    ),
    independence: oneOf(obj.independence, INDEPENDENCE_STATES, 'independence'),
    route: oneOf(obj.route, INGEST_ROUTES, 'route'),
    observation_event_ids: asArray(obj.observation_event_ids, 'observations').map((id) =>
      asString(id, 'observation event id'),
    ),
    proposal_ids: asArray(obj.proposal_ids, 'proposals').map((id) => asString(id, 'proposal id')),
    m26_batch_key: asStringOrNull(obj.m26_batch_key, 'm26_batch_key'),
    m26_outcome_event_id: asStringOrNull(obj.m26_outcome_event_id, 'm26_outcome_event_id'),
    supersedes_receipt_id: asStringOrNull(obj.supersedes_receipt_id, 'supersedes_receipt_id'),
  }),
  // M26.4 — the semantic disposition. Field order IS the canonical byte
  // order, so this list mirrors `IngestSemanticAssessed`'s declaration.
  'ingest.semantic_assessed': (obj) => ({
    ...canonCommon(obj),
    semantic_assessment_id: asString(obj.semantic_assessment_id, 'semantic_assessment_id'),
    m26_batch_key: asString(obj.m26_batch_key, 'm26_batch_key'),
    input_receipt_ids: asArray(obj.input_receipt_ids, 'input_receipt_ids').map((id) =>
      asString(id, 'input receipt id'),
    ),
    outcome: oneOf(obj.outcome, SEMANTIC_OUTCOMES, 'outcome'),
    disposition: oneOf(obj.disposition, SEMANTIC_DISPOSITIONS, 'disposition'),
    evaluated_dimensions: asArray(obj.evaluated_dimensions, 'evaluated_dimensions').map((d) =>
      oneOf(d, MATERIAL_DIMENSIONS, 'evaluated dimension'),
    ),
    material_dimensions: asArray(obj.material_dimensions, 'material_dimensions').map((d) =>
      oneOf(d, MATERIAL_DIMENSIONS, 'material dimension'),
    ),
    proposal_ids: asArray(obj.proposal_ids, 'proposals').map((id) => asString(id, 'proposal id')),
    blocked_reason:
      obj.blocked_reason === null
        ? null
        : oneOf(obj.blocked_reason, BLOCKED_REASONS, 'blocked_reason'),
    explanation: asString(obj.explanation, 'explanation'),
    content_label: oneOf(obj.content_label, CONTENT_LABELS, 'content_label'),
  }),
  'conflict.candidate_detected': (obj) => ({
    ...canonCommon(obj),
    comparison_id: asString(obj.comparison_id, 'comparison_id'),
    left: canonConflictEndpoint(obj.left, 'left'),
    right: canonConflictEndpoint(obj.right, 'right'),
    detector_version: asString(obj.detector_version, 'detector_version'),
    reason_codes: asArray(obj.reason_codes, 'reason_codes').map((r) =>
      oneOf(r, CONFLICT_CANDIDATE_REASONS, 'reason code'),
    ),
  }),
  'freshness.transitioned': (obj) => ({
    ...canonCommon(obj),
    facet: canonBeliefFacetKey(obj.facet),
    from: oneOf(obj.from, FRESHNESS_VALUES, 'from'),
    to: oneOf(obj.to, FRESHNESS_VALUES, 'to'),
    effective_at: asString(obj.effective_at, 'effective_at'),
    rule_version: asString(obj.rule_version, 'rule_version'),
    dedupe_key: asString(obj.dedupe_key, 'dedupe_key'),
  }),
  // M27.3 — the resolution pipeline. Field order IS the canonical byte order,
  // so each list mirrors its Rust struct's declaration exactly.
  'conflict.comparison_registered': (obj) => ({
    ...canonCommon(obj),
    comparison_id: asString(obj.comparison_id, 'comparison_id'),
    left: canonDeclaredEndpoint(obj.left, 'left'),
    right: canonDeclaredEndpoint(obj.right, 'right'),
    source_relation_event_id: asString(obj.source_relation_event_id, 'source_relation_event_id'),
    reason: oneOf(obj.reason, CONFLICT_REASON_CODES, 'reason'),
    rule_version: asString(obj.rule_version, 'rule_version'),
  }),
  'conflict.classified': (obj) => ({
    ...canonCommon(obj),
    comparison_id: asString(obj.comparison_id, 'comparison_id'),
    left: canonTaggedEndpoint(obj.left, 'left'),
    right: canonTaggedEndpoint(obj.right, 'right'),
    outcome: oneOf(obj.outcome, CONFLICT_OUTCOMES, 'outcome'),
    classification: canonClassification(obj.classification),
    evidence_event_ids: asArray(obj.evidence_event_ids, 'evidence_event_ids').map((id) =>
      asString(id, 'evidence event id'),
    ),
    reason_codes: asArray(obj.reason_codes, 'reason_codes').map((r) =>
      oneOf(r, CONFLICT_REASON_CODES, 'reason code'),
    ),
    classified_at: asString(obj.classified_at, 'classified_at'),
  }),
  'contradiction.opened': (obj) => ({
    ...canonCommon(obj),
    edge_id: asString(obj.edge_id, 'edge_id'),
    comparison_id: asString(obj.comparison_id, 'comparison_id'),
    left: canonTaggedEndpoint(obj.left, 'left'),
    right: canonTaggedEndpoint(obj.right, 'right'),
    kind: oneOf(obj.kind, EDGE_KINDS, 'kind'),
    classified_event_id: asString(obj.classified_event_id, 'classified_event_id'),
  }),
  'contradiction.closed': (obj) => ({
    ...canonCommon(obj),
    edge_id: asString(obj.edge_id, 'edge_id'),
    comparison_id: asString(obj.comparison_id, 'comparison_id'),
    left_belief_id: asString(obj.left_belief_id, 'left_belief_id'),
    right_belief_id: asString(obj.right_belief_id, 'right_belief_id'),
    addressed_by_event_id: asString(obj.addressed_by_event_id, 'addressed_by_event_id'),
    evidence_event_ids: asArray(obj.evidence_event_ids, 'evidence_event_ids').map((id) =>
      asString(id, 'evidence event id'),
    ),
    disposition: oneOf(obj.disposition, CLOSE_DISPOSITIONS, 'disposition'),
  }),
  'contradiction.backfill_completed': (obj) => ({
    ...canonCommon(obj),
    through_event_id: asString(obj.through_event_id, 'through_event_id'),
    source_relation_count: asU64(obj.source_relation_count, 'source_relation_count'),
    resolved_count: asU64(obj.resolved_count, 'resolved_count'),
    opened_count: asU64(obj.opened_count, 'opened_count'),
    rule_version: asString(obj.rule_version, 'rule_version'),
  }),
};

/**
 * A declared-relation endpoint (M27.3): no assertion, because there is none.
 * Its qualifiers are TAGGED rather than nullable — "the relation did not say"
 * and "the relation said planned" are different inputs to the gauntlet.
 */
function canonDeclaredEndpoint(v: Json | undefined, side: string): JsonObject {
  const e = asObject(v, side);
  const scope = asObject(e.scope, `${side}.scope`);
  const stage = asObject(e.state_stage, `${side}.state_stage`);
  const validTime = asObject(e.valid_time, `${side}.valid_time`);
  const scopeKind = oneOf(scope.kind, ['known', 'unknown'], `${side}.scope.kind`);
  const stageKind = oneOf(stage.kind, ['known', 'unknown'], `${side}.state_stage.kind`);
  const timeKind = oneOf(validTime.kind, ['known', 'unknown'], `${side}.valid_time.kind`);
  return {
    relation_event_id: asString(e.relation_event_id, `${side}.relation_event_id`),
    belief_id: asString(e.belief_id, `${side}.belief_id`),
    belief_revision_event_id: asString(
      e.belief_revision_event_id,
      `${side}.belief_revision_event_id`,
    ),
    relation_origin: oneOf(e.relation_origin, RELATION_ORIGINS, `${side}.relation_origin`),
    subject_id: asString(e.subject_id, `${side}.subject_id`),
    content_hash: asString(e.content_hash, `${side}.content_hash`),
    scope:
      scopeKind === 'known'
        ? { kind: scopeKind, value: canonScopeObject(scope.value) }
        : { kind: scopeKind },
    state_stage:
      stageKind === 'known'
        ? { kind: stageKind, value: oneOf(stage.value, STAGES, `${side}.state_stage.value`) }
        : { kind: stageKind },
    valid_time:
      timeKind === 'known'
        ? {
            kind: timeKind,
            value: (() => {
              const value = asObject(validTime.value, `${side}.valid_time.value`);
              return {
                from: asStringOrNull(value.from, `${side}.valid_time.from`),
                to: asStringOrNull(value.to, `${side}.valid_time.to`),
              };
            })(),
          }
        : { kind: timeKind },
  };
}

/**
 * The tagged endpoint union (M27.3). `asserted` FLATTENS M26's endpoint — the
 * design says it wraps the exact candidate endpoint, and a nesting level would
 * make the two shapes different bytes for the same facts.
 */
function canonTaggedEndpoint(v: Json | undefined, side: string): JsonObject {
  const e = asObject(v, side);
  const kind = oneOf(e.kind, ['asserted', 'declared_relation'], `${side}.kind`);
  return kind === 'asserted'
    ? { kind, ...canonConflictEndpoint(e, side) }
    : { kind, ...canonDeclaredEndpoint(e, side) };
}

function canonClassification(v: Json | undefined): JsonObject {
  const c = asObject(v, 'classification');
  const kind = oneOf(c.kind, ['deterministic', 'agent_supplied'], 'classification.kind');
  return kind === 'deterministic'
    ? { kind, rule_version: asString(c.rule_version, 'rule_version') }
    : {
        kind,
        proposal_id: asString(c.proposal_id, 'proposal_id'),
        model_id: asString(c.model_id, 'model_id'),
        prompt_version: asString(c.prompt_version, 'prompt_version'),
      };
}

/**
 * The facet key, rebuilt in the Rust struct's declaration order (M27.1).
 *
 * `predicate` is a TAGGED union rather than a nullable string, for the reason
 * `state_stage` is total: "no predicate was recorded" and "the predicate is
 * `ci_status`" are different keys, and a null makes a reader decide which one
 * an absence meant.
 */
function canonBeliefFacetKey(v: Json | undefined): JsonObject {
  const facet = asObject(v, 'facet');
  const predicate = asObject(facet.predicate, 'facet.predicate');
  const kind = oneOf(predicate.kind, ['known', 'unknown'], 'facet.predicate.kind');
  return {
    belief_id: asString(facet.belief_id, 'facet.belief_id'),
    belief_revision_event_id: asString(
      facet.belief_revision_event_id,
      'facet.belief_revision_event_id',
    ),
    predicate:
      kind === 'known'
        ? { kind, value: asString(predicate.value, 'facet.predicate.value') }
        : { kind },
    state_stage: oneOf(facet.state_stage, STATE_STAGES, 'facet.state_stage'),
  };
}

export interface Decoded {
  kind: string;
  body: JsonObject;
}

/** Null = plumbing. Throws SchemaError for bodies that claim membership. */
export function decodeBody(kind: string, body: Json): Decoded | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const obj = body as JsonObject;
  if (!('schema' in obj)) return null;
  if (obj.schema !== 1) throw new SchemaError(`unsupported body schema ${String(obj.schema)}`);
  if (RESERVED_KINDS.includes(kind)) {
    throw new SchemaError(`kind ${kind} is reserved vocabulary`);
  }
  const canonicalize = CANONICALIZERS[kind];
  if (!canonicalize) {
    throw new SchemaError(`kind ${kind} carries a schema-v1 body but is not in the vocabulary`);
  }
  const canon = canonicalize(obj);
  if (canonicalJson(canon) !== canonicalJson(obj)) {
    throw new SchemaError(`${kind}: body is not canonical schema-v1`);
  }
  return { kind, body: canon };
}

// --- structural validation (refused-class) ---------------------------------

const AUTHORITIES = ['trusted_human_capture', 'registered_direct_artifact', 'agent_inferred'];
const ASSERTION_BASES = ['firsthand', 'responsible_owner', 'reported', 'inferred', 'unknown'];
const STAGES = ['planned', 'approved', 'implemented', 'validated', 'deployed', 'shipping'];
/** `scope.stage` made total (M26.7) — "unknown" is a member, not an absence. */
const STATE_STAGES = [...STAGES, 'unknown'];
/** Declared in string-sorted order, the same as the Rust enum. */
const CONFLICT_CANDIDATE_REASONS = [
  'declared_contradicts_relation',
  'incompatible_value_hash',
  'overlapping_scope',
  'overlapping_valid_time',
  'same_subject_predicate',
  'stage_requires_classification',
];
const SUBJECT_ROLES = ['project_owner', 'team_member', 'adjacent', 'unknown'];
/** D9's freshness axis (M27.1) — `unknown` is a member, not an absence. */
const FRESHNESS_VALUES = ['fresh', 'stale', 'unknown'];
/** M27.3's reason codes, declared in string-sorted order like the Rust enum. */
const CONFLICT_REASON_CODES = [
  'conditional_context',
  'declared_contradicts_relation',
  'granularity_mismatch',
  'incompatible_values',
  'relation_missing_assertion',
  'relation_missing_scope',
  'relation_missing_stage',
  'relation_missing_valid_time',
  'scope_disjoint',
  'semantic_same_meaning',
  'stage_disjoint',
  'temporal_disjoint',
];
/** The ONE closed outcome set — M24's proposal op and M27's event share it. */
const CONFLICT_OUTCOMES = [
  'same_meaning',
  'resolved_temporally',
  'resolved_by_scope',
  'resolved_by_stage',
  'resolved_by_granularity',
  'genuine_direct',
  'partial',
  'conditional',
];
const EDGE_KINDS = ['genuine_direct', 'partial', 'conditional'];
const RELATION_ORIGINS = [
  'legacy_migration',
  'pre_activation_declared',
  'post_activation_declared',
];
const CLOSE_DISPOSITIONS = ['resolved_with_evidence', 'superseded_with_addressing'];

/** Assertion fields: canonical rebuild for the flattened payload unions. */
function canonAssertionFields(obj: JsonObject): JsonObject {
  const scope = asObject(obj.scope, 'scope');
  const relationship = asObject(obj.relationship_to_subject, 'relationship_to_subject');
  const stage = scope.stage === null ? null : oneOf(scope.stage, STAGES, 'stage');
  const absence =
    obj.absence === null
      ? null
      : (() => {
          const a = asObject(obj.absence, 'absence');
          return {
            searched_domain: asString(a.searched_domain, 'searched_domain'),
            search_scope: asString(a.search_scope, 'search_scope'),
            coverage_basis: asString(a.coverage_basis, 'coverage_basis'),
            observation_window: asString(a.observation_window, 'observation_window'),
            query_strategy: asString(a.query_strategy, 'query_strategy'),
            limitations: asString(a.limitations, 'limitations'),
          };
        })();
  return {
    assertion_kind: oneOf(obj.assertion_kind, ['presence', 'absence'], 'assertion_kind'),
    predicate: asString(obj.predicate, 'predicate'),
    value: canonTypedValue(obj.value),
    scope: {
      stage,
      revision: asStringOrNull(scope.revision, 'scope.revision'),
      environment: asStringOrNull(scope.environment, 'scope.environment'),
      geography: asStringOrNull(scope.geography, 'scope.geography'),
    },
    relationship_to_subject: { role: oneOf(relationship.role, SUBJECT_ROLES, 'role') },
    assertion_basis: oneOf(obj.assertion_basis, ASSERTION_BASES, 'assertion_basis'),
    authority_provenance: oneOf(obj.authority_provenance, AUTHORITIES, 'authority_provenance'),
    absence,
  };
}

function validateAssertionFields(assertion: JsonObject): void {
  if ((assertion.predicate as string).length === 0) {
    throw new RefusedError('assertion predicate must be non-empty');
  }
  validateTypedValue(assertion.value as Json);
  const absence = assertion.absence as JsonObject | null;
  if (assertion.assertion_kind === 'absence') {
    if (absence === null) {
      throw new RefusedError('absence assertion lacks its structural absence record');
    }
    for (const value of Object.values(absence)) {
      if ((value as string).length === 0) {
        throw new RefusedError('absence assertion needs a complete structural record');
      }
    }
  } else if (absence !== null) {
    throw new RefusedError('presence assertion cannot carry an absence record');
  }
}

function canonHumanForm(obj: JsonObject): JsonObject {
  const form = oneOf(
    obj.assertion_form,
    ['field_change', 'relation_change', 'alias_add', 'standalone'],
    'assertion_form',
  );
  const trail = {
    corrects: asStringOrNull(obj.corrects, 'corrects'),
    reason: asStringOrNull(obj.reason, 'reason'),
  };
  switch (form) {
    case 'field_change':
      return {
        assertion_form: form,
        target_belief_id: asString(obj.target_belief_id, 'target_belief_id'),
        field_path: asString(obj.field_path, 'field_path'),
        before: canonTypedValue(obj.before),
        after: canonTypedValue(obj.after),
        ...trail,
      };
    case 'relation_change':
      return {
        assertion_form: form,
        target_belief_id: asString(obj.target_belief_id, 'target_belief_id'),
        relation_id: asString(obj.relation_id, 'relation_id'),
        action: oneOf(obj.action, ['add', 'remove'], 'action'),
        from: asString(obj.from, 'from'),
        to: asString(obj.to, 'to'),
        relation: oneOf(obj.relation, RELATION_KINDS, 'relation'),
        ...trail,
      };
    case 'alias_add':
      return {
        assertion_form: form,
        target_belief_id: asString(obj.target_belief_id, 'target_belief_id'),
        entity_id: asString(obj.entity_id, 'entity_id'),
        alias: asString(obj.alias, 'alias'),
        normalized_alias: asString(obj.normalized_alias, 'normalized_alias'),
        ...trail,
      };
    default:
      return {
        assertion_form: form,
        intended_belief_id: asStringOrNull(obj.intended_belief_id, 'intended_belief_id'),
        ...trail,
      };
  }
}

export interface ObservationInfo {
  kind: string;
  assertion: JsonObject | null;
  humanForm: JsonObject | null;
  derivedBeliefSources: string[];
}

/**
 * The Rust `ObservationRecorded::validate` port: payload parsed for the
 * declared kind and re-gated canonically, then every structural rule.
 * Throws RefusedError (validation-class) on every failure.
 */
export function validateObservation(body: JsonObject): ObservationInfo {
  validateCommon(body);
  if (!isId128(body.source_id)) throw new RefusedError('source_id is not stable-form hex128');
  if (!isId128(body.source_registration_event_id)) {
    throw new RefusedError('source_registration_event_id is not a 128-bit hex event id');
  }
  const subject = body.subject as JsonObject;
  validateSubject(subject);
  const lineage = body.lineage as JsonObject[];
  validateLineage(lineage);

  const kind = body.observation_kind as string;
  const raw = body.payload;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RefusedError('payload must be an object');
  }
  const payload = raw as JsonObject;
  let canon: JsonObject;
  let assertion: JsonObject | null = null;
  let humanForm: JsonObject | null = null;
  let derivedBeliefSources: string[] = [];
  try {
    if (kind === 'source_snapshot') {
      canon = {
        source_artifact_hash: asStringOrNull(payload.source_artifact_hash, 'artifact hash'),
        raw_pointer: asString(payload.raw_pointer, 'raw_pointer'),
      };
    } else if (kind === 'system_event') {
      canon = {
        event_type: asString(payload.event_type, 'event_type'),
        detail: canonTypedValue(payload.detail),
      };
    } else if (kind === 'extracted_assertion') {
      assertion = canonAssertionFields(payload);
      canon = {
        ...assertion,
        extracted_text: asString(payload.extracted_text, 'extracted_text'),
        source_artifact_hash: asString(payload.source_artifact_hash, 'artifact hash'),
        extractor_version: asString(payload.extractor_version, 'extractor_version'),
        raw_pointer: asString(payload.raw_pointer, 'raw_pointer'),
      };
    } else if (kind === 'derived_content') {
      assertion = canonAssertionFields(payload);
      canon = {
        ...assertion,
        rendered_text: asString(payload.rendered_text, 'rendered_text'),
        generator_version: asString(payload.generator_version, 'generator_version'),
      };
      if ('source_belief_revision_event_ids' in payload) {
        derivedBeliefSources = asArray(payload.source_belief_revision_event_ids, 'sources').map(
          (id) => asString(id, 'source id'),
        );
        canon.source_belief_revision_event_ids = derivedBeliefSources;
      }
    } else {
      assertion = canonAssertionFields(payload);
      humanForm = canonHumanForm(payload);
      canon = { ...assertion, ...humanForm };
      // Canonical order is assertion fields THEN form fields — the spread
      // above emits `absence` before `assertion_form`, matching Rust.
    }
  } catch (error) {
    // Payload parse failures at validate time are refusals, like Rust's
    // payload gate inside validate().
    throw new RefusedError(`payload: ${(error as Error).message}`);
  }
  if (canonicalJson(canon) !== canonicalJson(payload)) {
    throw new RefusedError('payload is not canonical for its observation_kind');
  }

  // Subject boundaries and per-kind rules.
  const isAssertion = assertion !== null;
  if (isAssertion && subject.resolution === 'none') {
    throw new RefusedError('assertion subject cannot be none');
  }
  if (kind === 'source_snapshot') {
    const hash = canon.source_artifact_hash as string | null;
    if (hash !== null && !isSha256(hash)) throw new RefusedError('artifact hash is not SHA-256');
    if ((canon.raw_pointer as string).length === 0) {
      throw new RefusedError('snapshot raw_pointer must be non-empty');
    }
  }
  if (kind === 'system_event') {
    if ((canon.event_type as string).length === 0) {
      throw new RefusedError('system_event event_type must be non-empty');
    }
    validateTypedValue(canon.detail as Json);
  }
  if (assertion) validateAssertionFields(assertion);
  if (kind === 'extracted_assertion') {
    if (lineage.length === 0) throw new RefusedError('extracted_assertion requires lineage');
    if (!isSha256(canon.source_artifact_hash)) {
      throw new RefusedError('extracted_assertion source_artifact_hash is not SHA-256');
    }
    if (
      (canon.extractor_version as string).length === 0 ||
      (canon.raw_pointer as string).length === 0
    ) {
      throw new RefusedError('extracted_assertion needs extractor_version and raw_pointer');
    }
  }
  if (kind === 'derived_content') {
    if ((canon.generator_version as string).length === 0) {
      throw new RefusedError('derived_content needs a generator_version');
    }
    if (lineage.length === 0 && derivedBeliefSources.length === 0) {
      throw new RefusedError('derived_content needs at least one parent');
    }
    if ('source_belief_revision_event_ids' in canon && derivedBeliefSources.length === 0) {
      throw new RefusedError('source_belief_revision_event_ids present means non-empty');
    }
    for (let i = 1; i < derivedBeliefSources.length; i += 1) {
      if (derivedBeliefSources[i - 1] >= derivedBeliefSources[i]) {
        throw new RefusedError('source_belief_revision_event_ids must be sorted and unique');
      }
    }
    if (derivedBeliefSources.some((id) => !isId128(id))) {
      throw new RefusedError('belief-revision source is not an event id');
    }
  }
  if (humanForm) validateHumanForm(assertion as JsonObject, humanForm);
  if (assertion) {
    const authority = assertion.authority_provenance as string;
    if (authority === 'trusted_human_capture' && kind !== 'human_assertion') {
      throw new RefusedError('trusted_human_capture exists only on human_assertion observations');
    }
    if (authority === 'registered_direct_artifact' && kind !== 'extracted_assertion') {
      throw new RefusedError(
        'registered_direct_artifact exists only on extracted_assertion observations',
      );
    }
  }
  return { kind, assertion, humanForm, derivedBeliefSources };
}

function validateHumanForm(assertion: JsonObject, form: JsonObject): void {
  const corrects = form.corrects as string | null;
  const reason = form.reason as string | null;
  if (corrects !== null) {
    if (!isId128(corrects)) throw new RefusedError('corrects must name an Observation event id');
    if (reason === null || reason.length === 0) {
      throw new RefusedError('a correction requires a non-empty reason');
    }
  }
  if (reason === '') throw new RefusedError('reason must be null or non-empty');
  const kind = form.assertion_form as string;
  if (kind === 'field_change') {
    if (!isId128(form.target_belief_id)) throw new RefusedError('field_change target');
    validateFieldPath(form.field_path as string);
    validateTypedValue(form.before as Json);
    validateTypedValue(form.after as Json);
  } else if (kind === 'relation_change') {
    for (const key of ['target_belief_id', 'relation_id', 'from', 'to']) {
      if (!isId128(form[key])) throw new RefusedError(`relation_change ${key} is not a stable id`);
    }
    if (form.target_belief_id !== form.from) {
      throw new RefusedError('relation_change targets the from Belief');
    }
    if (assertion.predicate !== 'belief_relation') {
      throw new RefusedError('relation_change predicate must be belief_relation');
    }
    const want = typedObject([
      ['relation_id', form.relation_id as string],
      ['action', form.action as string],
      ['from', form.from as string],
      ['to', form.to as string],
      ['relation', form.relation as string],
    ]);
    if (canonicalJson(assertion.value as Json) !== canonicalJson(want)) {
      throw new RefusedError('relation_change value must be the canonical relation object');
    }
  } else if (kind === 'alias_add') {
    if (!isId128(form.target_belief_id) || !isId128(form.entity_id)) {
      throw new RefusedError('alias_add needs stable belief and entity ids');
    }
    const alias = form.alias as string;
    if (alias.length === 0) throw new RefusedError('alias_add alias must be non-empty');
    if (form.normalized_alias !== normalizeAliasV1(alias)) {
      throw new RefusedError('alias_add normalized_alias does not match normalize_alias_v1');
    }
    if (assertion.predicate !== 'entity_alias') {
      throw new RefusedError('alias_add predicate must be entity_alias');
    }
    const want = typedObject([
      ['entity_id', form.entity_id as string],
      ['alias', alias],
      ['normalized_alias', form.normalized_alias as string],
    ]);
    if (canonicalJson(assertion.value as Json) !== canonicalJson(want)) {
      throw new RefusedError('alias_add value must be the canonical alias object');
    }
  } else if (form.intended_belief_id !== null && !isId128(form.intended_belief_id)) {
    throw new RefusedError('standalone intended_belief_id is not a stable id');
  }
}

function typedObject(pairs: [string, string][]): Json {
  const value: JsonObject = {};
  for (const [k, v] of pairs) value[k] = { type: 'string', value: v };
  return { type: 'object', value };
}

export function validateFieldPath(path: string): void {
  for (let i = 0; i < path.length; i += 1) {
    if (path[i] === '~') {
      const next = path[i + 1];
      if (next !== '0' && next !== '1') {
        throw new RefusedError(`field_path ${path} has a bare '~'`);
      }
      i += 1;
    }
  }
  if (path !== '/body' && !path.startsWith('/fields/')) {
    throw new RefusedError(`field_path ${path} must be /body or /fields/...`);
  }
}

/** `/body`, or a declared presentation-only field (or a subpath in one). */
export function validateOverridePointer(path: string): void {
  validateFieldPath(path);
  if (path === '/body') return;
  const field = path.slice('/fields/'.length);
  const head = field.split('/')[0];
  if (!PRESENTATION_ONLY_FIELDS.includes(head)) {
    throw new RefusedError(`override pointer ${path} targets an epistemic or provenance field`);
  }
}

/** A knowledge-relative projection path: relative, markdown, non-escaping. */
export function validateProjectionPath(path: string): void {
  if (path.length === 0 || !path.endsWith('.md')) {
    throw new RefusedError(`projection path ${path} must be a .md file`);
  }
  if (path.startsWith('/') || path.includes('\\')) {
    throw new RefusedError(`projection path ${path} must be knowledge-relative`);
  }
  if (path.split('/').some((seg) => seg.length === 0 || seg === '..')) {
    throw new RefusedError(`projection path ${path} must not escape or double-slash`);
  }
}

/** A chain head hash: a frame hash (64 hex) or the store id anchor (32). */
const isHeadHash = (s: unknown): boolean => isSha256(s) || isId128(s);

/** The Rust `derive_authority` port — exact and closed. */
export function deriveAuthority(
  registration: JsonObject,
  observationActor: string,
  observationKind: string,
): string {
  if (
    registration.kind === 'human_actor' &&
    registration.authority_capability === 'human_assertion' &&
    registration.actor_id === observationActor &&
    observationKind === 'human_assertion'
  ) {
    return 'trusted_human_capture';
  }
  if (
    registration.authority_capability === 'direct_system_artifact' &&
    observationKind === 'extracted_assertion'
  ) {
    return 'registered_direct_artifact';
  }
  return 'agent_inferred';
}

/** Structural validation entry — the Rust `EventBody::validate` port. */
export function validateBody(decoded: Decoded, storeUuid: string): void {
  const body = decoded.body;
  validateCommon(body);
  switch (decoded.kind) {
    case 'batch.committed': {
      if ((body.actor as JsonObject).id !== ACTOR_LEDGER) {
        throw new RefusedError('batch.committed is stamped only by system:ledger');
      }
      if (body.batch_id === null) throw new RefusedError('batch.committed must carry batch_id');
      const ids = body.member_event_ids as string[];
      if (ids.length === 0) throw new RefusedError('a batch with no members is not a batch');
      const seen = new Set<string>();
      for (const id of ids) {
        if (!isId128(id)) throw new RefusedError('member event id is not hex128');
        if (seen.has(id)) throw new RefusedError('duplicate member event id');
        seen.add(id);
      }
      if (body.member_count !== ids.length) {
        throw new RefusedError('member_count disagrees with member ids');
      }
      if (!isSha256(body.members_digest) || !isSha256(body.operation_digest)) {
        throw new RefusedError('batch digests must be SHA-256 hex');
      }
      break;
    }
    case 'source.registered': {
      if ((body.actor as JsonObject).id !== ACTOR_SOURCE_REGISTRY) {
        throw new RefusedError('source.registered is appended only by the registration API');
      }
      if (!isId128(body.source_id)) throw new RefusedError('source_id is not stable-form hex128');
      const registration = body.registration as JsonObject;
      validateRegistration(registration);
      const derived = deriveSourceId(storeUuid, registration.source_key as string);
      if (body.source_id !== derived) {
        throw new RefusedError('source_id does not match the store-scoped derivation');
      }
      break;
    }
    case 'observation.recorded':
      validateObservation(body);
      break;
    case 'observation.subject_resolved': {
      if (!isId128(body.observation_event_id)) {
        throw new RefusedError('observation_event_id is not an event id');
      }
      const change = body.change as JsonObject;
      const basis = change.basis_event_ids as string[];
      const seen = new Set<string>();
      for (const id of basis) {
        if (!isId128(id)) throw new RefusedError('basis event id is not hex128');
        if (seen.has(id)) throw new RefusedError('duplicate basis event id');
        seen.add(id);
      }
      const tier = change.resolver_tier as string;
      const correcting = change.action === 'correct';
      if (correcting) {
        if (!isId128(change.prior_resolution_event_id)) {
          throw new RefusedError('correction must pin its prior resolution event');
        }
        if (!isId128(change.from_entity_id) || !isId128(change.to_entity_id)) {
          throw new RefusedError('correction entity ids must be stable ids');
        }
        if (change.from_entity_id === change.to_entity_id) {
          throw new RefusedError('a correction to the same Entity is a refused no-op');
        }
        if ((change.reason as string).length === 0) {
          throw new RefusedError('correction reason must be non-empty');
        }
        if (basis.length === 0) throw new RefusedError('correction basis must be non-empty');
      } else if (!isId128(change.entity_id)) {
        throw new RefusedError('attach entity_id is not a stable id');
      }
      const ok =
        tier === 'exact_id'
          ? correcting
            ? basis.length === 1
            : basis.length === 0
          : tier === 'explicit_relation'
            ? basis.length >= 1
            : basis.length === 1;
      if (!ok) throw new RefusedError(`resolver tier ${tier} basis cardinality is not canonical`);
      break;
    }
    case 'observation.independence_recorded': {
      if (!isId128(body.left_observation_event_id) || !isId128(body.right_observation_event_id)) {
        throw new RefusedError('independence endpoints must be event ids');
      }
      if (body.left_observation_event_id === body.right_observation_event_id) {
        throw new RefusedError('an Observation cannot be independent of itself');
      }
      if ((body.reason as string).length === 0) {
        throw new RefusedError('independence reason must be non-empty');
      }
      const proof = body.proof as JsonObject;
      if (
        !isId128(proof.left_source_registration_event_id) ||
        !isId128(proof.right_source_registration_event_id)
      ) {
        throw new RefusedError('proof registration refs must be event ids');
      }
      // `human_confirmed` used to be refused here outright, on a premise
      // that stopped being true when M24 shipped. M27.2c moves the decision
      // to the reducer, where the proposal it names can actually be checked
      // — a structural stage has no state to check it against.
      if (proof.kind === 'human_confirmed') {
        for (const [name, id] of [
          ['proposal_id', proof.proposal_id],
          ['decision_event_id', proof.decision_event_id],
        ] as [string, Json][]) {
          if (!isId128(id)) throw new RefusedError(`${name} must be a 128-bit hex id`);
        }
        break;
      }
      if ((proof.rule_version as string).length === 0) {
        throw new RefusedError('independence proof needs a non-empty rule_version');
      }
      break;
    }
    case 'belief.created': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      const subject = body.subject as JsonObject;
      if (subject.resolution !== 'resolved') {
        throw new RefusedError('belief.created subject must be resolved');
      }
      validateSubject(subject);
      validateBasis(body.basis as JsonObject);
      break;
    }
    case 'belief.revised': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      const seen = new Set<string>();
      for (const op of body.patch as JsonObject[]) {
        validateFieldPath(op.field_path as string);
        if (seen.has(op.field_path as string)) {
          throw new RefusedError(`duplicate patch pointer ${op.field_path}`);
        }
        seen.add(op.field_path as string);
        validateTypedValue(op.before as Json);
        validateTypedValue(op.after as Json);
      }
      validateBasis(body.basis as JsonObject);
      break;
    }
    case 'belief.relation': {
      if (!isId128(body.from) || !isId128(body.to)) {
        throw new RefusedError('relation endpoints must be stable belief ids');
      }
      const derived = deriveRelationId(
        body.from as string,
        body.to as string,
        body.relation as string,
      );
      if (body.relation_id !== derived) {
        throw new RefusedError('relation_id does not match its derivation');
      }
      break;
    }
    case 'belief.attested': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      if (!isId128(body.attested_belief_revision_event_id)) {
        throw new RefusedError('attested_belief_revision_event_id is not an event id');
      }
      if (!isSha256(body.attested_content_hash)) {
        throw new RefusedError('attested_content_hash is not SHA-256 hex');
      }
      break;
    }
    case 'entity.alias_added': {
      if (!isId128(body.entity_id)) throw new RefusedError('entity_id is not a stable id');
      const alias = body.alias as string;
      if (alias.length === 0) throw new RefusedError('alias must be non-empty');
      const computed = normalizeAliasV1(alias);
      if (computed.length === 0) throw new RefusedError('alias normalizes to empty');
      if (body.normalized_alias !== computed) {
        throw new RefusedError('normalized_alias does not equal normalize_alias_v1(alias)');
      }
      break;
    }
    case 'migration.started':
    case 'migration.completed': {
      if ((body.actor as JsonObject).id !== ACTOR_MIGRATOR) {
        throw new RefusedError('migration brackets are written only by system:migrator');
      }
      if (!isId128(body.store_uuid)) throw new RefusedError('store_uuid must be the store id');
      if (body.migration_schema !== 1) throw new RefusedError('unsupported migration schema');
      if (!isSha256(body.source_digest)) throw new RefusedError('source_digest is not SHA-256');
      if (decoded.kind === 'migration.completed' && !isSha256(body.output_keys_digest)) {
        throw new RefusedError('output_keys_digest is not SHA-256');
      }
      break;
    }
    case 'projection.overridden': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      validateProjectionPath(body.path as string);
      if ((body.base_belief_revision as number) === 0) {
        throw new RefusedError('base_belief_revision starts at 1');
      }
      if (!isId128(body.base_belief_revision_event) || !isId128(body.base_generating_event)) {
        throw new RefusedError('override base events must be event ids');
      }
      if (!isSha256(body.before_projection_hash) || !isSha256(body.after_projection_hash)) {
        throw new RefusedError('projection hashes must be SHA-256 hex');
      }
      const change = body.change as JsonObject;
      if (change.action === 'set') {
        const patch = change.patch as JsonObject[];
        if (patch.length === 0) throw new RefusedError('an override set requires a patch');
        const seen = new Set<string>();
        for (const op of patch) {
          validateOverridePointer(op.field_path as string);
          if (seen.has(op.field_path as string)) {
            throw new RefusedError(`duplicate override pointer ${op.field_path}`);
          }
          seen.add(op.field_path as string);
          validateTypedValue(op.before as Json);
          validateTypedValue(op.after as Json);
        }
        const ids = new Set<string>();
        for (const id of change.supersedes_override_event_ids as string[]) {
          if (!isId128(id)) throw new RefusedError('superseded override ref is not an event id');
          if (ids.has(id)) throw new RefusedError(`duplicate superseded override ${id}`);
          ids.add(id);
        }
      } else {
        const ids = change.override_event_ids as string[];
        if (ids.length === 0) {
          throw new RefusedError('an override clear must name the overrides it retires');
        }
        const seen = new Set<string>();
        for (const id of ids) {
          if (!isId128(id)) throw new RefusedError('cleared override ref is not an event id');
          if (seen.has(id)) throw new RefusedError(`duplicate cleared override ${id}`);
          seen.add(id);
        }
        if ((change.reason as string).length === 0) {
          throw new RefusedError('an override clear requires a non-empty reason');
        }
      }
      break;
    }
    case 'ledger.divergence': {
      if ((body.actor as JsonObject).id !== ACTOR_RECONCILIATION) {
        throw new RefusedError('ledger.divergence is recorded only by system:reconciliation');
      }
      if (!isSha256(body.detection_key)) {
        throw new RefusedError('detection_key must be a SHA-256 condition hash');
      }
      const signals = body.signals as string[];
      if (signals.length === 0) throw new RefusedError('a divergence names at least one signal');
      let prevIndex = -1;
      for (const signal of signals) {
        const index = DIVERGENCE_SIGNALS.indexOf(signal);
        if (index <= prevIndex) {
          throw new RefusedError('signals must be unique and in canonical order');
        }
        prevIndex = index;
      }
      if (!isHeadHash(body.ledger_head)) {
        throw new RefusedError('ledger_head is not a chain head hash');
      }
      for (const key of ['git_anchored_head', 'remembered_head']) {
        if (body[key] !== null && !isHeadHash(body[key])) {
          throw new RefusedError(`${key} is not a chain head hash`);
        }
      }
      if (!isSha256(body.manifest_digest) || !isSha256(body.reducer_projection_digest)) {
        throw new RefusedError('manifest/reducer digests must be SHA-256 hex');
      }
      if ((body.mismatch_count as number) > (body.projection_count as number)) {
        throw new RefusedError('mismatch_count cannot exceed projection_count');
      }
      const samples = body.sample_paths as string[];
      if (samples.length > 32) throw new RefusedError('sample_paths is bounded at 32');
      let prev: string | null = null;
      for (const path of samples) {
        validateProjectionPath(path);
        if (prev !== null && prev >= path) {
          throw new RefusedError('sample_paths must be sorted and duplicate-free');
        }
        prev = path;
      }
      break;
    }
    case 'ledger.reconciliation_resolved': {
      if ((body.actor as JsonObject).id !== ACTOR_RECONCILIATION) {
        throw new RefusedError(
          'ledger.reconciliation_resolved is recorded only by system:reconciliation',
        );
      }
      if (!isId128(body.divergence_event_id)) {
        throw new RefusedError('divergence_event_id is not an event id');
      }
      const affected = body.affected_paths as string[];
      if (affected.length === 0) throw new RefusedError('a resolution names its affected paths');
      let prev: string | null = null;
      for (const path of affected) {
        validateProjectionPath(path);
        if (prev !== null && prev >= path) {
          throw new RefusedError('affected_paths must be sorted and duplicate-free');
        }
        prev = path;
      }
      if (!isSha256(body.resulting_projection_digest)) {
        throw new RefusedError('resulting_projection_digest must be SHA-256 hex');
      }
      const captures = body.capture_batch_ids as string[];
      if (body.action === 'accept_current_files') {
        const batchId = body.batch_id as string | null;
        if (batchId === null) {
          throw new RefusedError('accept_current_files commits inside its adoption batch');
        }
        if (captures.length !== 1 || captures[0] !== batchId) {
          throw new RefusedError('capture_batch_ids is exactly the singleton own batch id');
        }
        const accepted = body.accepted_files_digest as string | null;
        if (accepted === null || !isSha256(accepted)) {
          throw new RefusedError('accept_current_files requires the accepted-files digest');
        }
        if (accepted !== body.resulting_projection_digest) {
          throw new RefusedError('accepted and resulting digests must match');
        }
      } else {
        if (body.batch_id !== null) {
          throw new RefusedError('restore_ledger_authority is appended unbatched');
        }
        if (captures.length !== 0) throw new RefusedError('restore captures nothing');
        if (body.accepted_files_digest !== null) {
          throw new RefusedError('restore accepted_files_digest is null');
        }
      }
      break;
    }

    // --- M24.3: governed mutations ---------------------------------------
    case 'belief.qualification_changed': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      validateQualificationProfile(body.qualification_profile as JsonObject);
      const edge = `${body.from as string}->${body.to as string}:${body.cause as string}`;
      // The two legal edges: promotion and its stored inverse. A same-state
      // transition is the shape a buggy retry produces.
      if (edge !== 'draft->qualified:promoted' && edge !== 'qualified->draft:reverted') {
        throw new RefusedError(`illegal_transition: qualification ${edge}`);
      }
      break;
    }
    case 'belief.lifecycle_changed': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      const replacement = body.replacement_id as string | null;
      if (replacement !== null) {
        if (!isId128(replacement)) throw new RefusedError('replacement_id is not a stable id');
        if (replacement === body.belief_id) {
          throw new RefusedError('illegal_transition: a Belief cannot replace itself');
        }
      }
      const edge = `${body.from as string}->${body.to as string}:${body.cause as string}`;
      const has = replacement !== null;
      const legal =
        // Supersede names its successor; without one, "superseded by what?"
        // has no answer and the lineage edge has no other end.
        (edge === 'active->superseded:superseded' && has) ||
        // Archive is the deliberate no-replacement retirement.
        (edge === 'active->archived:archived' && !has) ||
        // Deprecation may or may not point at what to use instead.
        edge === 'active->archived:deprecated' ||
        // The stored one-click inverse of a supersede.
        (edge === 'superseded->active:reverted' && !has);
      if (!legal) throw new RefusedError(`illegal_transition: lifecycle ${edge}`);
      break;
    }
    case 'belief.tombstoned': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      const replacement = body.replacement_id as string | null;
      if (replacement !== null) {
        if (!isId128(replacement)) throw new RefusedError('replacement_id is not a stable id');
        if (replacement === body.belief_id) {
          throw new RefusedError('illegal_transition: a Belief cannot replace itself');
        }
      }
      break;
    }
    case 'belief.contested': {
      if (!isId128(body.belief_id)) throw new RefusedError('belief_id is not a stable id');
      sortedUniqueIds(body.counterevidence_refs as string[], 'counterevidence refs');
      if (body.action === 'open') {
        if ((body.counterevidence_refs as string[]).length === 0) {
          throw new RefusedError('a contest with no counterevidence is an opinion');
        }
        if (body.addressed_by_event_id !== null) {
          throw new RefusedError('an opening contest cannot already be addressed');
        }
      } else if (!isId128(body.addressed_by_event_id)) {
        throw new RefusedError('closing a contest requires the event that addressed it');
      }
      break;
    }
    case 'entity.merged': {
      const plan = body.reassignment_plan as JsonObject;
      if (!isId128(plan.survivor_id)) throw new RefusedError('survivor_id is not a stable id');
      const merged = plan.merged_ids as string[];
      if (merged.length === 0) throw new RefusedError('a merge with nothing to merge');
      sortedUniqueIds(merged, 'merged_ids');
      if (merged.includes(plan.survivor_id as string)) {
        throw new RefusedError('an entity cannot absorb itself');
      }
      sortedUniqueIds(plan.affected_belief_ids as string[], 'affected_belief_ids');
      sortedUniqueIds(plan.affected_relation_ids as string[], 'affected_relation_ids');
      if (body.survivor_id !== plan.survivor_id) {
        throw new RefusedError('entity.merged survivor_id disagrees with its plan');
      }
      if ((body.merged_ids as string[]).join('|') !== merged.join('|')) {
        throw new RefusedError('entity.merged merged_ids disagree with its plan');
      }
      if (body.reassignment_digest !== plan.plan_digest) {
        throw new RefusedError("reassignment_digest disagrees with the plan's own seal");
      }
      break;
    }

    // --- M24.3: the proposal lifecycle ------------------------------------
    case 'proposal.submitted': {
      const proposal = body.proposal as JsonObject;
      if (!isId128(proposal.proposal_id) || !isId128(proposal.run_id)) {
        throw new RefusedError('proposal ids are not stable ids');
      }
      if ((proposal.targets as JsonObject[]).length === 0) {
        throw new RefusedError('a proposal with no targets mutates nothing');
      }
      break;
    }
    case 'proposal.queued': {
      if (!isId128(body.proposal_id) || !isId128(body.commit_set_id)) {
        throw new RefusedError('proposal/commit set ids are not stable ids');
      }
      const members = body.member_proposal_ids as string[];
      uniqueIds(members, 'member_proposal_ids');
      if (!members.includes(body.proposal_id as string)) {
        throw new RefusedError('a queued proposal must be a member of its own commit set');
      }
      const queuedFor = body.queued_for as string[];
      if (queuedFor.some((code) => code.trim() === '')) {
        throw new RefusedError('queued_for holds an empty reason');
      }
      const sortedReasons = [...queuedFor].sort();
      if (
        sortedReasons.join('\u0000') !== queuedFor.join('\u0000') ||
        new Set(queuedFor).size !== queuedFor.length
      ) {
        throw new RefusedError('queued_for is not sorted and unique');
      }
      if ((body.policy_version as number) === 0) {
        throw new RefusedError('policy_version must be positive');
      }
      break;
    }
    case 'proposal.decision_recorded': {
      if (!isId128(body.decision_id) || !isId128(body.proposal_id)) {
        throw new RefusedError('decision/proposal ids are not stable ids');
      }
      if ((body.reviewer as string).trim() === '') {
        throw new RefusedError('a decision with no reviewer is not a decision');
      }
      const reason = body.reason as string | null;
      if (body.decision === 'reject') {
        // Saying no is a claim about the proposal; it owes a sentence.
        if (reason === null || reason.trim() === '') {
          throw new RefusedError('a rejection requires a reason');
        }
      } else if (reason !== null) {
        // Saying yes agrees with what is already written; a second
        // free-text field is just somewhere else to look.
        throw new RefusedError('an approval carries no reason');
      }
      break;
    }
    case 'proposal.applied': {
      if (!isId128(body.proposal_id) || !isId128(body.commit_set_id)) {
        throw new RefusedError('proposal/commit set ids are not stable ids');
      }
      if (body.decision_id !== null && !isId128(body.decision_id)) {
        throw new RefusedError('decision_id is not a stable id');
      }
      uniqueIds(body.mutation_event_ids as string[], 'mutation_event_ids');
      if ((body.mutation_event_ids as string[]).length === 0) {
        throw new RefusedError('an application that changed nothing is not an application');
      }
      break;
    }
    case 'proposal.rejected': {
      if (!isId128(body.proposal_id) || !isId128(body.commit_set_id)) {
        throw new RefusedError('proposal/commit set ids are not stable ids');
      }
      for (const value of [body.code as string, body.rule as string]) {
        if (value === '' || !/^[a-z0-9_]+$/.test(value)) {
          throw new RefusedError('code/rule is not a lower_snake_case code');
        }
      }
      const peer = body.refused_by_proposal_id as string | null;
      if (peer !== null) {
        if (!isId128(peer)) throw new RefusedError('refused_by_proposal_id is not a stable id');
        if (peer === body.proposal_id) {
          throw new RefusedError('a proposal cannot be refused by itself');
        }
      }
      break;
    }
    case 'proposal.reverted': {
      if (!isId128(body.proposal_id) || !isId128(body.reverted_by_proposal_id)) {
        throw new RefusedError('proposal ids are not stable ids');
      }
      if (body.proposal_id === body.reverted_by_proposal_id) {
        throw new RefusedError('a proposal cannot revert itself');
      }
      uniqueIds(body.prior_applied_event_ids as string[], 'prior_applied_event_ids');
      uniqueIds(body.forward_event_ids as string[], 'forward_event_ids');
      break;
    }
    case 'ingest.assessed': {
      for (const [name, id] of [
        ['receipt_id', body.receipt_id],
        ['item_id', body.item_id],
        ['source_id', body.source_id],
      ] as [string, Json][]) {
        if (!isId128(id)) throw new RefusedError(`${name} must be a 128-bit hex id`);
      }
      for (const [name, hash] of [
        ['artifact_hash', body.artifact_hash],
        ['normalized_snapshot_hash', body.normalized_snapshot_hash],
      ] as [string, Json][]) {
        if (!isSha256(hash)) throw new RefusedError(`${name} must be a lowercase SHA-256`);
      }
      if ((body.normalizer_version as string) === '') {
        throw new RefusedError('normalizer_version must be non-empty');
      }
      if ((body.assessed_against_chain_head as string) === '') {
        throw new RefusedError('assessed_against_chain_head must be non-empty');
      }
      if (body.source_record_id === '') {
        throw new RefusedError('source_record_id is null or a value, never empty');
      }
      const route = body.route as string;
      const verdict = body.prefilter_verdict as string;
      const rules = ROUTE_RULES[route];
      if (!rules.verdicts.includes(verdict)) {
        throw new RefusedError(
          `route ${route} cannot carry verdict ${verdict} — the route matrix is closed`,
        );
      }
      const dimensions = body.material_dimensions as string[];
      const sorted = [...dimensions].sort();
      if (
        sorted.join('\u0000') !== dimensions.join('\u0000') ||
        new Set(dimensions).size !== dimensions.length
      ) {
        throw new RefusedError('material_dimensions must be sorted and duplicate-free');
      }
      if ((verdict === 'no_change' || verdict === 'non_material_change') && dimensions.length > 0) {
        throw new RefusedError(`verdict ${verdict} names no material dimensions`);
      }
      // A SUCCESSOR is governed by the outcome it names, exactly as its
      // proposal list is (`m26_completed` allows any count). It restates the
      // verdict of the receipt it supersedes but not the deterministic
      // FINDING, which is already on that receipt while the semantic one is
      // on the outcome. Without this, a `material_candidate` could never be
      // closed — and with no deterministic mapper in this build, every
      // material candidate queues, so that is the common case.
      const governedByOutcome = route === 'm26_completed' || route === 'failed_visible';
      if (verdict === 'material_candidate' && dimensions.length === 0 && !governedByOutcome) {
        throw new RefusedError('material_candidate must name at least one material dimension');
      }
      if (
        dimensions.includes('evidence_state') &&
        body.independence === 'independence_unknown' &&
        verdict === 'material_candidate'
      ) {
        throw new RefusedError(
          'evidence-state materiality on a deterministic candidate needs a recorded independence fact',
        );
      }
      for (const [name, ids] of [
        ['observation_event_ids', body.observation_event_ids],
        ['proposal_ids', body.proposal_ids],
      ] as [string, string[]][]) {
        sortedUniqueIds(ids, name);
      }
      const listRule = (rule: string, ids: string[], name: string) => {
        if (rule === 'required' && ids.length === 0) {
          throw new RefusedError(`route ${route} requires at least one ${name}`);
        }
        if (rule === 'forbidden' && ids.length > 0) {
          throw new RefusedError(`route ${route} forbids ${name}`);
        }
      };
      listRule(rules.observations, body.observation_event_ids as string[], 'observation_event_ids');
      listRule(rules.proposals, body.proposal_ids as string[], 'proposal_ids');
      const optionRule = (rule: string, value: Json, name: string) => {
        if (rule === 'required' && value === null) {
          throw new RefusedError(`route ${route} requires ${name}`);
        }
        if (rule === 'forbidden' && value !== null) {
          throw new RefusedError(`route ${route} requires ${name} to be null`);
        }
      };
      optionRule(rules.batchKey, body.m26_batch_key, 'm26_batch_key');
      optionRule(rules.outcome, body.m26_outcome_event_id, 'm26_outcome_event_id');
      optionRule(rules.supersedes, body.supersedes_receipt_id, 'supersedes_receipt_id');
      for (const [name, id] of [
        ['m26_outcome_event_id', body.m26_outcome_event_id],
        ['supersedes_receipt_id', body.supersedes_receipt_id],
      ] as [string, Json][]) {
        if (id !== null && !isId128(id)) {
          throw new RefusedError(`${name} must be a 128-bit hex id`);
        }
      }
      if (body.m26_batch_key === '') {
        throw new RefusedError('m26_batch_key is null or a value, never empty');
      }
      // NOTE: "failed_visible carries no proposal refs" is deliberately NOT a
      // separate check here either. It is `proposals: 'forbidden'` in
      // ROUTE_RULES, enforced by listRule above — and a second copy is a
      // second chance for the table and the special case to disagree. This
      // one existed until M26.4a; the Rust side never had it.
      break;
    }
    case 'ingest.semantic_assessed': {
      if (!isId128(body.semantic_assessment_id)) {
        throw new RefusedError('semantic_assessment_id must be a 128-bit hex id');
      }
      if ((body.m26_batch_key as string) === '') {
        throw new RefusedError('m26_batch_key must be non-empty');
      }
      const explanation = body.explanation as string;
      if (explanation === '') {
        throw new RefusedError('explanation must be non-empty — a disposition states its reason');
      }
      if (utf8Length(explanation) > MAX_EXPLANATION_BYTES) {
        throw new RefusedError(`explanation is bounded at ${MAX_EXPLANATION_BYTES} bytes`);
      }
      const outcome = body.outcome as string;
      const rules = OUTCOME_RULES[outcome];
      if (body.disposition !== rules.disposition) {
        throw new RefusedError(
          `outcome ${outcome} carries disposition ${rules.disposition}, never ` +
            `${String(body.disposition)} — the table is closed`,
        );
      }
      for (const [name, dims] of [
        ['evaluated_dimensions', body.evaluated_dimensions],
        ['material_dimensions', body.material_dimensions],
      ] as [string, string[]][]) {
        const sorted = [...dims].sort();
        if (sorted.join('\0') !== dims.join('\0') || new Set(dims).size !== dims.length) {
          throw new RefusedError(`${name} must be sorted and duplicate-free`);
        }
      }
      const evaluated = body.evaluated_dimensions as string[];
      const material = body.material_dimensions as string[];
      const dimensionRule = (rule: string, dims: string[], name: string) => {
        if (rule === 'required' && dims.length === 0) {
          throw new RefusedError(`outcome ${outcome} requires at least one ${name}`);
        }
        if (rule === 'forbidden' && dims.length > 0) {
          throw new RefusedError(`outcome ${outcome} names no ${name}`);
        }
      };
      dimensionRule(rules.evaluated, evaluated, 'evaluated_dimensions');
      dimensionRule(rules.material, material, 'material_dimensions');
      const unevaluated = material.find((d) => !evaluated.includes(d));
      if (unevaluated !== undefined) {
        throw new RefusedError(
          `material dimension ${unevaluated} was never evaluated — materiality is a subset ` +
            'of what the run looked at',
        );
      }
      for (const [name, ids] of [
        ['input_receipt_ids', body.input_receipt_ids],
        ['proposal_ids', body.proposal_ids],
      ] as [string, string[]][]) {
        sortedUniqueIds(ids, name);
      }
      if ((body.input_receipt_ids as string[]).length === 0) {
        throw new RefusedError(
          'input_receipt_ids must be non-empty — a run with no inputs assessed nothing',
        );
      }
      const proposals = body.proposal_ids as string[];
      if (rules.proposals === 'required' && proposals.length === 0) {
        throw new RefusedError(`outcome ${outcome} requires at least one proposal_ids entry`);
      }
      if (rules.proposals === 'forbidden' && proposals.length > 0) {
        throw new RefusedError(`outcome ${outcome} carries no proposal_ids`);
      }
      if (rules.blocked === 'required' && body.blocked_reason === null) {
        throw new RefusedError(`outcome ${outcome} names one blocked reason`);
      }
      if (rules.blocked === 'forbidden' && body.blocked_reason !== null) {
        throw new RefusedError(
          `outcome ${outcome} is not blocked, and names ${String(body.blocked_reason)}`,
        );
      }
      break;
    }
    case 'conflict.candidate_detected': {
      if (!isId128(body.comparison_id)) {
        throw new RefusedError('comparison_id must be a 128-bit hex id');
      }
      if ((body.detector_version as string) === '') {
        throw new RefusedError('detector_version must be non-empty');
      }
      validateConflictEndpoint(body.left as JsonObject, 'left');
      validateConflictEndpoint(body.right as JsonObject, 'right');
      const reasons = body.reason_codes as string[];
      if (reasons.length === 0) {
        throw new RefusedError(
          'reason_codes must name at least one reason — a candidate that cannot say why it ' +
            'was raised is not a signal',
        );
      }
      if (!reasons.every((r, i) => i === 0 || compareUtf8(reasons[i - 1], r) < 0)) {
        throw new RefusedError('reason_codes must be sorted and duplicate-free');
      }
      const [first, second] = orderedEndpoints(body.left as Json, body.right as Json);
      if (first === second) {
        throw new RefusedError(
          'left and right are the same endpoint — a claim does not need classifying against ' +
            'itself',
        );
      }
      if (canonicalJson(body.left as Json) !== first) {
        throw new RefusedError(
          'left must be the lexicographically-first endpoint — the body is a function of the ' +
            'pair, so an exact retry is exactly a retry',
        );
      }
      const derived = deriveComparisonId(body.left as Json, body.right as Json);
      if (derived !== body.comparison_id) {
        throw new RefusedError(
          `comparison_id ${String(body.comparison_id)} does not follow from these endpoints ` +
            `(expected ${derived})`,
        );
      }
      break;
    }
    case 'freshness.transitioned': {
      const facet = body.facet as JsonObject;
      for (const [name, id] of [
        ['belief_id', facet.belief_id],
        ['belief_revision_event_id', facet.belief_revision_event_id],
      ] as [string, Json][]) {
        if (!isId128(id)) throw new RefusedError(`facet.${name} is not a 128-bit hex id`);
      }
      const predicate = facet.predicate as JsonObject;
      if (predicate.kind === 'known' && predicate.value === '') {
        throw new RefusedError(
          'facet.predicate.known carries an empty value — an empty string is the unknown ' +
            'variant mis-spelled',
        );
      }
      if (body.from === body.to) {
        throw new RefusedError(
          `from and to are both ${String(body.to)} — a transition that changed nothing is not ` +
            'a transition, and recording one would put a crossing in history that never happened',
        );
      }
      if (!isRfc3339(body.effective_at as string)) {
        throw new RefusedError(`effective_at ${JSON.stringify(body.effective_at)} is not RFC3339`);
      }
      if ((body.rule_version as string) === '') {
        throw new RefusedError(
          'rule_version must be non-empty — a transition nobody can read against the rules ' +
            'that produced it is unreadable history',
        );
      }
      const derived = deriveFreshnessDedupeKey(
        facet.belief_revision_event_id as string,
        facet.predicate as Json,
        facet.state_stage as string,
        body.effective_at as string,
        body.rule_version as string,
      );
      if (derived !== body.dedupe_key) {
        throw new RefusedError(
          `dedupe_key ${String(body.dedupe_key)} does not follow from this transition ` +
            `(expected ${derived})`,
        );
      }
      break;
    }
    case 'conflict.comparison_registered': {
      for (const name of ['comparison_id', 'source_relation_event_id']) {
        if (!isId128(body[name])) throw new RefusedError(`${name} must be a 128-bit hex id`);
      }
      if ((body.rule_version as string) === '') {
        throw new RefusedError('rule_version must be non-empty');
      }
      if (body.reason !== 'declared_contradicts_relation') {
        throw new RefusedError(
          `a declared-relation registration is raised for declared_contradicts_relation, and ` +
            `this says ${String(body.reason)} — the registration records that somebody DECLARED ` +
            'a conflict, which is the only reason it exists',
        );
      }
      validateDeclaredEndpoint(body.left as JsonObject, 'left');
      validateDeclaredEndpoint(body.right as JsonObject, 'right');
      for (const [side, endpoint] of [
        ['left', body.left as JsonObject],
        ['right', body.right as JsonObject],
      ] as [string, JsonObject][]) {
        if (endpoint.relation_event_id !== body.source_relation_event_id) {
          throw new RefusedError(
            `${side}.relation_event_id is ${String(endpoint.relation_event_id)}, and ` +
              `source_relation_event_id is ${String(body.source_relation_event_id)} — both ` +
              'endpoints come from the ONE relation this registration is about',
          );
        }
      }
      const [first, second] = orderedEndpoints(body.left as Json, body.right as Json);
      if (first === second) {
        throw new RefusedError(
          'left and right are the same endpoint — a belief does not contradict itself through a ' +
            'relation to itself',
        );
      }
      if (canonicalJson(body.left as Json) !== first) {
        throw new RefusedError(
          'left must be the lexicographically-first endpoint — the body is a function of the ' +
            'pair, so an exact retry is exactly a retry',
        );
      }
      const derived = deriveDeclaredComparisonId(
        body.source_relation_event_id as string,
        body.left as Json,
        body.right as Json,
      );
      if (derived !== body.comparison_id) {
        throw new RefusedError(
          `comparison_id ${String(body.comparison_id)} does not follow from this relation and ` +
            `these endpoints (expected ${derived})`,
        );
      }
      break;
    }
    case 'conflict.classified': {
      if (!isId128(body.comparison_id)) {
        throw new RefusedError('comparison_id must be a 128-bit hex id');
      }
      validateTaggedEndpoint(body.left as JsonObject, 'left');
      validateTaggedEndpoint(body.right as JsonObject, 'right');
      if (!isRfc3339(body.classified_at as string)) {
        throw new RefusedError(
          `classified_at ${JSON.stringify(body.classified_at)} is not RFC3339`,
        );
      }
      const reasons = body.reason_codes as string[];
      if (reasons.length === 0) {
        throw new RefusedError(
          'reason_codes must name at least one reason — a classification that cannot say why is ' +
            'not one',
        );
      }
      if (!reasons.every((r, i) => i === 0 || compareUtf8(reasons[i - 1], r) < 0)) {
        throw new RefusedError('reason_codes must be sorted and duplicate-free');
      }
      const evidence = body.evidence_event_ids as string[];
      for (const id of evidence) {
        if (!isId128(id)) {
          throw new RefusedError(
            `evidence_event_ids names ${JSON.stringify(id)}, which is not an id`,
          );
        }
      }
      if (!evidence.every((id, i) => i === 0 || compareUtf8(evidence[i - 1], id) < 0)) {
        throw new RefusedError('evidence_event_ids must be sorted and duplicate-free');
      }
      const classification = body.classification as JsonObject;
      if (classification.kind === 'deterministic') {
        if ((classification.rule_version as string) === '') {
          throw new RefusedError('a deterministic classification carries its rule version');
        }
      } else {
        if (!isId128(classification.proposal_id)) {
          throw new RefusedError('agent_supplied.proposal_id must be a 128-bit hex id');
        }
        if (
          (classification.model_id as string) === '' ||
          (classification.prompt_version as string) === ''
        ) {
          throw new RefusedError(
            'an agent-supplied classification names the model and the prompt version it came from',
          );
        }
        if (evidence.length === 0) {
          throw new RefusedError(
            'an agent-supplied classification requires evidence — a semantic judgement with ' +
              'nothing behind it is an opinion',
          );
        }
      }
      checkConflictMatrix(body.outcome as string, classification, reasons);
      break;
    }
    case 'contradiction.opened': {
      for (const name of ['edge_id', 'comparison_id', 'classified_event_id']) {
        if (!isId128(body[name])) throw new RefusedError(`${name} must be a 128-bit hex id`);
      }
      validateTaggedEndpoint(body.left as JsonObject, 'left');
      validateTaggedEndpoint(body.right as JsonObject, 'right');
      const derived = deriveEdgeId(body.comparison_id as string, body.kind as string);
      if (derived !== body.edge_id) {
        throw new RefusedError(
          `edge_id ${String(body.edge_id)} does not follow from comparison ` +
            `${String(body.comparison_id)} and kind ${String(body.kind)} (expected ${derived})`,
        );
      }
      break;
    }
    case 'contradiction.closed': {
      for (const name of [
        'edge_id',
        'comparison_id',
        'left_belief_id',
        'right_belief_id',
        'addressed_by_event_id',
      ]) {
        if (!isId128(body[name])) throw new RefusedError(`${name} must be a 128-bit hex id`);
      }
      // NO distinctness check on the endpoint Beliefs, deliberately: one
      // Belief revision can rest on two incompatible assertions at once, and
      // that edge has to be closable.
      const evidence = body.evidence_event_ids as string[];
      if (evidence.length === 0) {
        throw new RefusedError(
          'a close carries the evidence that addressed it — silence and elapsed time cannot ' +
            'close an edge',
        );
      }
      for (const id of evidence) {
        if (!isId128(id)) {
          throw new RefusedError(
            `evidence_event_ids names ${JSON.stringify(id)}, which is not an id`,
          );
        }
      }
      if (!evidence.every((id, i) => i === 0 || compareUtf8(evidence[i - 1], id) < 0)) {
        throw new RefusedError('evidence_event_ids must be sorted and duplicate-free');
      }
      break;
    }
    case 'contradiction.backfill_completed': {
      if (!isId128(body.through_event_id)) {
        throw new RefusedError('through_event_id must be a 128-bit hex id');
      }
      if ((body.rule_version as string) === '') {
        throw new RefusedError('rule_version must be non-empty');
      }
      const seen = body.source_relation_count as number;
      const accounted = (body.resolved_count as number) + (body.opened_count as number);
      if (accounted !== seen) {
        throw new RefusedError(
          `the backfill saw ${seen} relations and accounts for ${accounted} — every relation it ` +
            'read is either resolved apart or has an open edge, and a marker that does not add ' +
            'up is a marker that stopped early',
        );
      }
      break;
    }
    case 'coverage.fact_recorded': {
      for (const [name, id] of [
        ['fact_id', body.fact_id],
        ['source_id', body.source_id],
        ['source_registration_event_id', body.source_registration_event_id],
      ] as [string, Json][]) {
        if (!isId128(id)) throw new RefusedError(`${name} must be a 128-bit hex id`);
      }
      if (!isRfc3339(body.as_of as string)) throw new RefusedError('as_of must be RFC3339');
      const producer = body.producer as JsonObject;
      if ((producer.producer_version as string) === '') {
        throw new RefusedError('producer_version must be non-empty');
      }
      const fact = body.fact as JsonObject;
      const variant = FACT_VARIANTS[fact.kind as string];
      if (variant.dimension !== body.dimension) {
        throw new RefusedError(
          `a ${fact.kind} fact establishes ${variant.dimension}, not ${body.dimension}`,
        );
      }
      const yes =
        fact.kind === 'retrieval_execution'
          ? true
          : fact.kind === 'retrieval_window_closed_without_attempt'
            ? false
            : fact.result === variant.yes;
      const state = yes ? 'yes' : 'no';
      if (body.state !== state) {
        throw new RefusedError(`this fact's result is ${state}, and the body says ${body.state}`);
      }
      if (!variant.producers.includes(producer.kind as string)) {
        throw new RefusedError(`a ${fact.kind} fact is not stamped by ${producer.kind}`);
      }
      const actorId = (body.actor as JsonObject).id;
      if (producer.kind === 'vault_indexer' && actorId !== ACTOR_VAULT_INDEXER) {
        throw new RefusedError(`an index fact is appended only by ${ACTOR_VAULT_INDEXER}`);
      }
      if (producer.kind === 'retrieval_engine' && actorId !== ACTOR_RETRIEVAL_ENGINE) {
        throw new RefusedError(`a retrieval fact is appended only by ${ACTOR_RETRIEVAL_ENGINE}`);
      }
      if (fact.kind === 'scope_discovery' || fact.kind === 'access_probe') {
        if (!isSha256(fact.scope_digest)) {
          throw new RefusedError('scope_digest must be a lowercase SHA-256');
        }
      }
      if (fact.kind === 'retention_discovery') {
        const known = fact.result === 'known';
        if (known && fact.retention_seconds === null) {
          throw new RefusedError('a known retention fact carries its value');
        }
        if (!known && fact.retention_seconds !== null) {
          throw new RefusedError('an unknown retention fact carries no value');
        }
      }
      if (fact.kind === 'index_checkpoint') {
        if ((fact.index_head as string) === '' || (fact.source_revision as string) === '') {
          throw new RefusedError('an index checkpoint names its head and the source revision');
        }
      }
      if (fact.kind === 'retrieval_execution') {
        validateRetrievalReceipt(fact.retrieval_receipt as JsonObject);
      }
      if (fact.kind === 'retrieval_window_closed_without_attempt') {
        for (const [name, value] of [
          ['window_start', fact.window_start],
          ['window_end', fact.window_end],
        ] as [string, string][]) {
          if (!isRfc3339(value)) throw new RefusedError(`${name} must be RFC3339`);
        }
        if ((fact.window_end as string) <= (fact.window_start as string)) {
          throw new RefusedError('a closed window ends after it starts');
        }
      }
      break;
    }
    case 'coverage.assessed': {
      if (!isId128(body.assessment_id) || !isId128(body.source_id)) {
        throw new RefusedError('an assessment pins its id and its source by id');
      }
      const supersedes = body.supersedes_assessment_id as string | null;
      if (supersedes !== null) {
        if (!isId128(supersedes)) {
          throw new RefusedError('supersedes_assessment_id must be a 128-bit hex id');
        }
        if (supersedes === body.assessment_id) {
          throw new RefusedError('an assessment cannot supersede itself');
        }
      }
      const limitations = body.limitations as JsonObject[];
      const limited = new Set(limitations.map((l) => l.dimension as string));
      if (limited.size !== limitations.length) {
        throw new RefusedError('one limitation per dimension, at most');
      }
      for (const limitation of limitations) {
        if ((limitation.reason as string) === '') {
          throw new RefusedError('a limitation without a reason explains nothing');
        }
      }
      const dimensions = body.dimensions as JsonObject;
      for (const name of COVERAGE_DIMENSIONS) {
        const d = dimensions[name] as JsonObject;
        if (!isRfc3339(d.as_of as string)) {
          throw new RefusedError(`${name}: as_of must be RFC3339`);
        }
        const basis = d.basis_event_ids as string[];
        sortedUniqueIds(basis, `${name}: basis_event_ids`);
        if (basis.includes(body.assessment_id as string)) {
          throw new RefusedError(
            `${name}: an assessment id is never a basis id — no assessment bootstraps itself`,
          );
        }
        const needsBasis = d.state === 'yes' || d.state === 'no';
        if (needsBasis) {
          if (basis.length === 0) {
            throw new RefusedError(
              `${name}: a ${d.state} needs at least one committed fact behind it`,
            );
          }
          if (limited.has(name)) {
            throw new RefusedError(
              `${name}: a dimension carried by facts does not also carry a limitation`,
            );
          }
        } else {
          if (basis.length > 0) {
            throw new RefusedError(
              `${name}: ${d.state} cites nothing — a basis would contradict it`,
            );
          }
          if (!limited.has(name)) {
            throw new RefusedError(`${name}: ${d.state} requires a limitation saying why`);
          }
        }
      }
      const attempted = (dimensions.retrieval_attempted as JsonObject).state;
      const receipt = body.retrieval_receipt as JsonObject | null;
      if (attempted === 'yes') {
        if (receipt === null)
          throw new RefusedError('a claimed retrieval attempt carries its receipt');
        validateRetrievalReceipt(receipt);
      } else if (receipt !== null) {
        throw new RefusedError('only a retrieval that happened carries a retrieval receipt');
      }
      break;
    }
    case 'coverage.gap': {
      if (!isId128(body.gap_id)) throw new RefusedError('gap_id must be a 128-bit hex id');
      if (!isRfc3339(body.opened_at as string)) {
        throw new RefusedError('opened_at must be RFC3339');
      }
      if ((body.reason as string) === '') {
        throw new RefusedError('a gap without a reason explains nothing');
      }
      sortedUniqueDimensions(body.affected_dimensions as string[], 'affected_dimensions');
      const cause = body.cause as JsonObject;
      if (cause.kind === 'source') {
        if (body.source_id === null) throw new RefusedError('a source-caused gap names its source');
        if (!isId128(body.source_id)) throw new RefusedError('source_id must be a 128-bit hex id');
        if (cause.component !== null) {
          throw new RefusedError('a source-caused gap names a source, not a component');
        }
        if (body.assessment_id === null) {
          throw new RefusedError('a source-caused gap cites the assessment that established it');
        }
        if (!isId128(body.assessment_id)) {
          throw new RefusedError('assessment_id must be a 128-bit hex id');
        }
      } else {
        if (body.source_id !== null) {
          throw new RefusedError('a runtime-caused gap carries no source');
        }
        if (cause.component === null || cause.component === '') {
          throw new RefusedError('a runtime-caused gap names the component that failed');
        }
        for (const dimension of body.affected_dimensions as string[]) {
          if (!RUNTIME_AFFECTABLE.includes(dimension)) {
            throw new RefusedError(
              `the reasoning runtime cannot affect ${dimension} — that is a claim about the source, and a runtime failure has no standing to make it`,
            );
          }
        }
      }
      const pinned = [
        body.responsibility_id !== null,
        body.contract_version !== null,
        body.contract_digest !== null,
      ];
      if (pinned.some(Boolean) && !pinned.every(Boolean)) {
        throw new RefusedError(
          'a declared responsibility is pinned by id, version, AND digest, or not at all',
        );
      }
      if (body.contract_digest !== null && !isSha256(body.contract_digest)) {
        throw new RefusedError('contract_digest must be a lowercase SHA-256');
      }
      break;
    }
    case 'coverage.restored': {
      if (!isId128(body.gap_id)) throw new RefusedError('gap_id must be a 128-bit hex id');
      if (!isRfc3339(body.restored_at as string)) {
        throw new RefusedError('restored_at must be RFC3339');
      }
      if ((body.reason as string) === '') {
        throw new RefusedError('a restoration without a reason demonstrates nothing');
      }
      if (body.assessment_id !== null && !isId128(body.assessment_id)) {
        throw new RefusedError('assessment_id must be a 128-bit hex id');
      }
      sortedUniqueDimensions(body.restored_dimensions as string[], 'restored_dimensions');
      break;
    }
    default:
      throw new SchemaError(`unhandled kind ${decoded.kind}`);
  }
}

/**
 * Non-empty, duplicate-free ids in THEIR OWN ORDER.
 *
 * Deliberately not `sortedUniqueIds`. Two different orders here are two
 * different things: a batch's members have a plan order the marker also
 * preserves, and a commit set's members have the frozen order its id was
 * derived from. Physical event ids are minted fresh at preallocation, so
 * requiring those sorted would demand an ordering the writer cannot produce.
 */
function uniqueIds(ids: string[], what: string): void {
  if (ids.length === 0) throw new RefusedError(`${what}: empty`);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId128(id)) throw new RefusedError(`${what}: not a stable id`);
    if (seen.has(id)) throw new RefusedError(`${what}: duplicate`);
    seen.add(id);
  }
}

/** Sorted, unique, all event ids — the shape every plural id list has. */

/** Non-empty, sorted, duplicate-free dimensions in DECLARATION order. */
function sortedUniqueDimensions(dimensions: string[], what: string): void {
  if (dimensions.length === 0) {
    throw new RefusedError(`${what} must name at least one dimension`);
  }
  const order = (d: string) => COVERAGE_DIMENSIONS.indexOf(d);
  for (let i = 1; i < dimensions.length; i += 1) {
    if (order(dimensions[i - 1]) >= order(dimensions[i])) {
      throw new RefusedError(`${what} must be sorted and duplicate-free`);
    }
  }
}

function validateRetrievalReceipt(receipt: JsonObject): void {
  for (const name of [
    'strategy_version',
    'query_strategy',
    'attempted_at',
    'searched_domain',
    'search_scope',
    'observation_window',
  ]) {
    if ((receipt[name] as string) === '') {
      throw new RefusedError(`retrieval receipt ${name} must be non-empty`);
    }
  }
  if (!isSha256(receipt.query_fingerprint)) {
    throw new RefusedError('query_fingerprint must be a lowercase SHA-256');
  }
  if (!isRfc3339(receipt.attempted_at as string)) {
    throw new RefusedError('retrieval receipt attempted_at must be RFC3339');
  }
  for (const alias of receipt.searched_aliases as string[]) {
    if (alias === '') throw new RefusedError('a searched alias cannot be empty');
  }
}

function sortedUniqueIds(ids: string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId128(id)) throw new RefusedError(`${what}: not a stable id`);
    if (seen.has(id)) throw new RefusedError(`${what}: duplicate`);
    seen.add(id);
  }
  if ([...seen].sort().join('|') !== ids.join('|')) {
    throw new RefusedError(`${what}: not sorted`);
  }
}

/**
 * One conflict-candidate endpoint (M26.7). The stage check is the one worth
 * reading: `state_stage` is a denormalization of `scope.stage`, and this is
 * what stops it becoming a second opinion about it.
 */
function validateConflictEndpoint(endpoint: JsonObject, side: string): void {
  for (const name of [
    'assertion_event_id',
    'belief_id',
    'belief_revision_event_id',
    'subject_id',
  ]) {
    if (!isId128(endpoint[name])) {
      throw new RefusedError(`${side}.${name} is not a 128-bit hex id`);
    }
  }
  if ((endpoint.predicate as string) === '') {
    throw new RefusedError(`${side}.predicate must be non-empty`);
  }
  if (!isSha256(endpoint.value_hash)) {
    throw new RefusedError(`${side}.value_hash is not a sha256 digest`);
  }
  const scope = endpoint.scope as JsonObject;
  const expected = scope.stage === null ? 'unknown' : (scope.stage as string);
  if (endpoint.state_stage !== expected) {
    throw new RefusedError(
      `${side}.state_stage is ${String(endpoint.state_stage)}, but its own scope says ` +
        `${expected} — the stage is a denormalization of the scope, never a second opinion ` +
        'about it',
    );
  }
  const validTime = endpoint.valid_time as JsonObject;
  for (const name of ['from', 'to']) {
    const stamp = validTime[name];
    if (stamp !== null && !isRfc3339(stamp as string)) {
      throw new RefusedError(`${side}.valid_time.${name} ${JSON.stringify(stamp)} is not RFC3339`);
    }
  }
  const from = validTime.from as string | null;
  const to = validTime.to as string | null;
  if (from !== null && to !== null && from > to) {
    throw new RefusedError(`${side}.valid_time ends before it starts`);
  }
}

/**
 * A declared endpoint answers for its own shape only (M27.3): four real ids,
 * a real digest, and a valid time that does not end before it starts. Whether
 * the relation it names exists is reducer state.
 */
function validateDeclaredEndpoint(endpoint: JsonObject, side: string): void {
  for (const name of ['relation_event_id', 'belief_id', 'belief_revision_event_id', 'subject_id']) {
    if (!isId128(endpoint[name])) {
      throw new RefusedError(`${side}.${name} is not a 128-bit hex id`);
    }
  }
  if (!isSha256(endpoint.content_hash)) {
    throw new RefusedError(`${side}.content_hash is not a sha256 digest`);
  }
  const validTime = endpoint.valid_time as JsonObject;
  if (validTime.kind === 'known') {
    const value = validTime.value as JsonObject;
    for (const name of ['from', 'to']) {
      const stamp = value[name];
      if (stamp !== null && !isRfc3339(stamp as string)) {
        throw new RefusedError(
          `${side}.valid_time.${name} ${JSON.stringify(stamp)} is not RFC3339`,
        );
      }
    }
    const from = value.from as string | null;
    const to = value.to as string | null;
    if (from !== null && to !== null && from > to) {
      throw new RefusedError(`${side}.valid_time ends before it starts`);
    }
  }
}

function validateTaggedEndpoint(endpoint: JsonObject, side: string): void {
  if (endpoint.kind === 'asserted') validateConflictEndpoint(endpoint, side);
  else validateDeclaredEndpoint(endpoint, side);
}

/**
 * The closed outcome/provenance/reason matrix (M27.3), mirroring
 * `contradiction::check_matrix`. Every rule stops one specific lie: typed
 * comparisons may never be agent-supplied, semantic judgements may never be
 * deterministic, `partial` splits by provenance, and mixed reason sets refuse.
 */
function checkConflictMatrix(outcome: string, classification: JsonObject, reasons: string[]): void {
  const deterministic = classification.kind === 'deterministic';
  const list = reasons.join(', ');
  const exactly = (code: string): void => {
    if (reasons.length !== 1 || reasons[0] !== code) {
      throw new RefusedError(
        `outcome ${outcome} carries exactly [${code}], and this carries [${list}]`,
      );
    }
  };
  const deterministicOnly = (): void => {
    if (!deterministic) {
      throw new RefusedError(
        `outcome ${outcome} is a typed comparison over recorded qualifiers and is ` +
          'deterministic only — a model that could decide it could resolve a real conflict away ' +
          'by being confident about arithmetic',
      );
    }
  };
  const agentOnly = (): void => {
    if (deterministic) {
      throw new RefusedError(
        `outcome ${outcome} is a semantic judgement and arrives only through an applied ` +
          "classify_conflict proposal — a deterministic rule claiming it would put a model's " +
          'job in the reducer with none of the review',
      );
    }
  };
  switch (outcome) {
    case 'resolved_temporally':
      deterministicOnly();
      return exactly('temporal_disjoint');
    case 'resolved_by_scope':
      deterministicOnly();
      return exactly('scope_disjoint');
    case 'resolved_by_stage':
      deterministicOnly();
      return exactly('stage_disjoint');
    case 'resolved_by_granularity':
      return exactly('granularity_mismatch');
    case 'same_meaning':
      agentOnly();
      return exactly('semantic_same_meaning');
    case 'genuine_direct':
      return exactly('incompatible_values');
    case 'conditional':
      agentOnly();
      return exactly('conditional_context');
    case 'partial': {
      if (!deterministic) return exactly('incompatible_values');
      // The declared-relation expansion, and nothing else.
      if (reasons.length === 1 && reasons[0] === 'declared_contradicts_relation') return;
      if (reasons.length > 0 && reasons.every((r) => r.startsWith('relation_missing_'))) return;
      throw new RefusedError(
        'a deterministic `partial` is the declared-relation expansion only: either exactly ' +
          `[declared_contradicts_relation] or one or more relation_missing_* codes, and this ` +
          `carries [${list}]`,
      );
    }
    default:
      throw new RefusedError(`unknown outcome ${outcome}`);
  }
}

function validateQualificationProfile(profile: JsonObject): void {
  if ((profile.type_id as string) === '') throw new RefusedError('type_id is empty');
  if (!isSha256(profile.type_schema_hash)) {
    throw new RefusedError('type_schema_hash is not a sha256');
  }
  const roles = profile.required_roles as string[];
  if (roles.length === 0) {
    throw new RefusedError('a profile requiring no roles is a gate that never gates');
  }
  const canonical = FIELD_ROLES.filter((role) => roles.includes(role));
  if (canonical.join('|') !== roles.join('|')) {
    throw new RefusedError('required roles are not unique and in canonical order');
  }
}
