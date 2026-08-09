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
import { canonicalJson, deriveRelationId, deriveSourceId, deriveSourceKey } from './ids';
import { normalizeAliasV1 } from './normalize';

export class SchemaError extends Error {}
export class RefusedError extends Error {}

export type JsonObject = { [key: string]: Json };

export const RESERVED_KINDS = [
  'belief.tombstoned',
  'proposal.submitted',
  'proposal.queued',
  'proposal.decision_recorded',
  'proposal.applied',
  'proposal.rejected',
  'proposal.reverted',
];

export const ACTOR_LEDGER = 'system:ledger';
export const ACTOR_SOURCE_REGISTRY = 'system:source-registry';
export const ACTOR_MIGRATOR = 'system:migrator';

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

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

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
    if (stamp !== null && !RFC3339.test(stamp as string)) {
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
    relation: oneOf(obj.relation, ['supersedes', 'refines', 'contradicts'], 'relation'),
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
};

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
const SUBJECT_ROLES = ['project_owner', 'team_member', 'adjacent', 'unknown'];

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
        relation: oneOf(obj.relation, ['supersedes', 'refines', 'contradicts'], 'relation'),
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
      if (proof.kind === 'human_confirmed') {
        throw new RefusedError('human_confirmed independence is reserved until M24');
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
    default:
      throw new SchemaError(`unhandled kind ${decoded.kind}`);
  }
}
