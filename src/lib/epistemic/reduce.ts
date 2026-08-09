/**
 * The minimal TS reducer (M22.4) — a fold-for-fold port of
 * `src-tauri/src/ledger/reduce.rs`, replayed against the shared conformance
 * vectors. State and refusal identity must match the Rust reference
 * exactly; refusal identity is `(seq, event_id, batch_id, code)`.
 */

import type { Json } from './ids';
import { attestedContentHash, canonicalJson } from './ids';
import { sha256Hex } from '../sha256';
import { normalizeAliasV1 } from './normalize';
import { project } from './project';
import {
  decodeBody,
  deriveAuthority,
  RefusedError,
  SchemaError,
  validateBody,
  validateObservation,
  type Decoded,
  type JsonObject,
} from './schema';

export interface VectorFrame {
  v: number;
  seq: number;
  event_id: string;
  prev: string;
  hash: string;
  ingested_at: string;
  wall_clock_anomaly: boolean;
  kind: string;
  body: Json;
}

export interface Anomaly {
  seq: number;
  event_id: string;
  batch_id: string | null;
  code: string;
}

interface SourceState {
  sourceId: string;
  registrationEventId: string;
  registration: JsonObject;
  canonical: string;
}

interface ObservationState {
  eventId: string;
  seq: number;
  kind: string;
  sourceId: string;
  sourceRegistrationEventId: string;
  subject: JsonObject;
  effectiveEntity: string | null;
  effectiveResolutionEvent: string | null;
  authority: string | null;
  assertionBasis: string | null;
  actor: string;
  lineage: [string, string][];
}

interface RevisionState {
  revision: number;
  eventId: string;
  content: string;
  fields: JsonObject;
  basis: JsonObject;
}

interface BeliefState {
  beliefId: string;
  entityId: string;
  createdEventId: string;
  revisions: RevisionState[];
  attested: [string, string] | null;
}

interface RelationState {
  relationId: string;
  from: string;
  to: string;
  relation: string;
  live: boolean;
  lastAddEventId: string;
  lastEventId: string;
}

interface ResolutionRow {
  seq: number;
  eventId: string;
  observationEventId: string;
  action: string;
  fromEntityId: string | null;
  toEntityId: string;
  resolverTier: string;
}

interface BatchRow {
  batchId: string;
  state: string;
  memberCount: number;
}

interface MigrationEpoch {
  storeUuid: string;
  sourceDigest: string;
  plannedOutputCount: number;
  completed: boolean;
}

export interface EpistemicState {
  sources: Map<string, SourceState>;
  sourceKeys: Map<string, string>;
  registrationsByEvent: Map<string, string>;
  entities: Map<string, string>; // entity id → registering event
  aliasRegistry: Map<string, { alias: string; entityId: string; eventId: string }>;
  aliasEvents: Map<string, [string, string]>; // event → [entity, normalized]
  observations: Map<string, ObservationState>;
  entityRegistrations: Map<string, [string, string[]]>;
  beliefs: Map<string, BeliefState>;
  beliefRevisionEvents: Map<string, [string, number]>;
  relations: Map<string, RelationState>;
  relationAddEvents: Map<string, string>;
  resolutions: ResolutionRow[];
  independence: Map<string, { eventId: string; proofKind: string }>; // "left|right"
  derivedBeliefSources: [string, string][];
  versions: Map<string, number>; // "class:id"
  versionEvents: Map<string, string>;
  batches: BatchRow[];
  anomalies: Anomaly[];
  migration: MigrationEpoch | null;
}

function emptyState(): EpistemicState {
  return {
    sources: new Map(),
    sourceKeys: new Map(),
    registrationsByEvent: new Map(),
    entities: new Map(),
    aliasRegistry: new Map(),
    aliasEvents: new Map(),
    observations: new Map(),
    entityRegistrations: new Map(),
    beliefs: new Map(),
    beliefRevisionEvents: new Map(),
    relations: new Map(),
    relationAddEvents: new Map(),
    resolutions: [],
    independence: new Map(),
    derivedBeliefSources: [],
    versions: new Map(),
    versionEvents: new Map(),
    batches: [],
    anomalies: [],
    migration: null,
  };
}

function cloneState(state: EpistemicState): EpistemicState {
  // structuredClone handles the Maps and plain JSON inside them.
  return structuredClone(state);
}

const createVersion = (s: EpistemicState, klass: string, id: string, event: string): void => {
  s.versions.set(`${klass}:${id}`, 1);
  s.versionEvents.set(`${klass}:${id}`, event);
};
const bumpVersion = (s: EpistemicState, klass: string, id: string, event: string): void => {
  s.versions.set(`${klass}:${id}`, (s.versions.get(`${klass}:${id}`) ?? 0) + 1);
  s.versionEvents.set(`${klass}:${id}`, event);
};

/** Fold every frame; refusals become anomaly rows, never throws. */
export function reduce(frames: VectorFrame[], storeId: string): EpistemicState {
  let state = emptyState();
  const pending = new Map<string, { frame: VectorFrame; decoded: Decoded }[]>();
  const committedBatches = new Set<string>();

  for (const frame of frames) {
    let decoded: Decoded | null;
    try {
      decoded = decodeBody(frame.kind, frame.body);
    } catch (error) {
      if (error instanceof SchemaError) {
        state.anomalies.push({
          seq: frame.seq,
          event_id: frame.event_id,
          batch_id: null,
          code: 'schema',
        });
        continue;
      }
      throw error;
    }
    if (decoded === null) continue; // plumbing

    const batchId = decoded.body.batch_id as string | null;
    if (batchId !== null && decoded.kind === 'batch.committed') {
      const members = pending.get(batchId) ?? [];
      pending.delete(batchId);
      state = commitBatch(state, storeId, frame, batchId, decoded, members, committedBatches);
    } else if (batchId !== null) {
      const buffer = pending.get(batchId) ?? [];
      buffer.push({ frame, decoded });
      pending.set(batchId, buffer);
    } else {
      try {
        apply(state, storeId, frame, decoded, new Set(), []);
      } catch (error) {
        state.anomalies.push({
          seq: frame.seq,
          event_id: frame.event_id,
          batch_id: null,
          code: classify(error),
        });
      }
    }
  }

  // Orphans, in batch-id order (matching the Rust BTreeMap drain).
  for (const [batchId, members] of [...pending.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const first = members[0].frame;
    state.anomalies.push({
      seq: first.seq,
      event_id: first.event_id,
      batch_id: batchId,
      code: 'batch',
    });
    state.batches.push({ batchId, state: 'orphaned', memberCount: members.length });
  }
  return state;
}

function classify(error: unknown): string {
  if (error instanceof RefusedError) return 'refused';
  if (error instanceof SchemaError) return 'schema';
  throw error;
}

function commitBatch(
  state: EpistemicState,
  storeId: string,
  markerFrame: VectorFrame,
  batchId: string,
  marker: Decoded,
  members: { frame: VectorFrame; decoded: Decoded }[],
  committedBatches: Set<string>,
): EpistemicState {
  const refuse = (): void => {
    state.anomalies.push({
      seq: markerFrame.seq,
      event_id: markerFrame.event_id,
      batch_id: batchId,
      code: 'batch',
    });
    state.batches.push({ batchId, state: 'refused', memberCount: members.length });
  };

  if (committedBatches.has(batchId)) {
    refuse();
    return state;
  }
  try {
    validateBody(marker, storeId);
  } catch {
    refuse();
    return state;
  }
  const markerIds = marker.body.member_event_ids as string[];
  const idsMatch =
    members.length === markerIds.length &&
    members.every(({ frame }, i) => frame.event_id === markerIds[i]);
  if (!idsMatch) {
    refuse();
    return state;
  }
  const contiguous =
    members.every(({ frame }, i) => i === 0 || frame.seq === members[i - 1].frame.seq + 1) &&
    members.length > 0 &&
    members[members.length - 1].frame.seq + 1 === markerFrame.seq;
  if (!contiguous) {
    refuse();
    return state;
  }
  const digest = membersDigest(members.map(({ frame }) => frame));
  if (digest !== marker.body.members_digest) {
    refuse();
    return state;
  }

  const scratch = cloneState(state);
  const staged = new Set(members.map(({ frame }) => frame.event_id));
  for (const [ordinal, { frame, decoded }] of members.entries()) {
    try {
      apply(scratch, storeId, frame, decoded, staged, members);
    } catch (error) {
      state.anomalies.push({
        seq: frame.seq,
        event_id: frame.event_id,
        batch_id: batchId,
        code: classify(error),
      });
      void ordinal;
      refuse();
      return state;
    }
  }
  scratch.batches.push({ batchId, state: 'committed', memberCount: members.length });
  committedBatches.add(batchId);
  return scratch;
}

function membersDigest(frames: VectorFrame[]): string {
  // The canonical member frame lines, newline-terminated — JSON.parse +
  // JSON.stringify preserves the exact serde bytes for these frames.
  let text = '';
  for (const frame of frames) text += `${canonicalJson(frame as unknown as Json)}\n`;
  // Reuse the string-input sha over raw text.
  return sha256Hex(text);
}

function apply(
  state: EpistemicState,
  storeId: string,
  frame: VectorFrame,
  decoded: Decoded,
  staged: Set<string>,
  members: { frame: VectorFrame; decoded: Decoded }[],
): void {
  validateBody(decoded, storeId);
  const body = decoded.body;
  switch (decoded.kind) {
    case 'batch.committed':
      throw new RefusedError('a marker cannot be applied as a member');
    case 'source.registered':
      return applySource(state, frame, body);
    case 'observation.recorded':
      return applyObservation(state, frame, body, staged, members);
    case 'observation.subject_resolved':
      return applyResolution(state, frame, body, staged);
    case 'observation.independence_recorded':
      return applyIndependence(state, frame, body);
    case 'belief.created':
      return applyBeliefCreated(state, frame, body);
    case 'belief.revised':
      return applyBeliefRevised(state, frame, body);
    case 'belief.relation':
      return applyRelation(state, frame, body);
    case 'belief.attested':
      return applyAttested(state, frame, body, staged);
    case 'entity.alias_added':
      return applyAlias(state, frame, body);
    case 'migration.started':
      return applyMigrationStarted(state, body);
    case 'migration.completed':
      return applyMigrationCompleted(state, body);
    default:
      throw new SchemaError(`unhandled kind ${decoded.kind}`);
  }
}

function applySource(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const sourceId = body.source_id as string;
  if (state.sources.has(sourceId)) throw new RefusedError('source already registered');
  const registration = body.registration as JsonObject;
  const key = registration.source_key as string;
  if (state.sourceKeys.has(key)) throw new RefusedError('source key already registered');
  state.sources.set(sourceId, {
    sourceId,
    registrationEventId: frame.event_id,
    registration,
    canonical: canonicalJson(frame.body),
  });
  state.sourceKeys.set(key, sourceId);
  state.registrationsByEvent.set(frame.event_id, sourceId);
  createVersion(state, 'source', sourceId, frame.event_id);
}

function applyObservation(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
  members: { frame: VectorFrame; decoded: Decoded }[],
): void {
  const info = validateObservation(body);
  if (info.humanForm) verifyHumanFormPairing(state, frame, info.humanForm, members);
  const pinned = state.registrationsByEvent.get(body.source_registration_event_id as string);
  if (pinned === undefined) {
    throw new RefusedError('source_registration_event_id names no committed registration');
  }
  if (pinned !== body.source_id) {
    throw new RefusedError('registration event registers a different source');
  }
  const source = state.sources.get(body.source_id as string);
  if (!source) throw new RefusedError('pinned source missing');

  let authority: string | null = null;
  let assertionBasis: string | null = null;
  if (info.assertion) {
    const derived = deriveAuthority(
      source.registration,
      (body.actor as JsonObject).id as string,
      info.kind,
    );
    if (info.assertion.authority_provenance !== derived) {
      throw new RefusedError('authority_provenance disagrees with the derivation');
    }
    authority = derived;
    assertionBasis = info.assertion.assertion_basis as string;
  }

  let prevSeq = -1;
  const lineage: [string, string][] = [];
  for (const edge of body.lineage as JsonObject[]) {
    const parentId = edge.parent_observation_event_id as string;
    const parent = state.observations.get(parentId);
    if (!parent) throw new RefusedError('lineage parent is not an Observation');
    if (parent.seq <= prevSeq) throw new RefusedError('lineage edges out of canonical order');
    prevSeq = parent.seq;
    lineage.push([edge.edge as string, parentId]);
  }

  for (const id of info.derivedBeliefSources) {
    if (staged.has(id)) throw new RefusedError('belief-revision source is staged — committed only');
    if (!state.beliefRevisionEvents.has(id)) {
      throw new RefusedError('belief-revision source names no committed revision');
    }
    state.derivedBeliefSources.push([frame.event_id, id]);
  }

  const subject = body.subject as JsonObject;
  let effectiveEntity: string | null = null;
  if (subject.resolution === 'resolved') {
    const entityId = subject.entity_id as string;
    if (!state.entities.has(entityId)) {
      state.entities.set(entityId, frame.event_id);
      createVersion(state, 'entity', entityId, frame.event_id);
    }
    state.entityRegistrations.set(frame.event_id, [entityId, subject.aliases as string[]]);
    effectiveEntity = entityId;
  }

  state.observations.set(frame.event_id, {
    eventId: frame.event_id,
    seq: frame.seq,
    kind: info.kind,
    sourceId: body.source_id as string,
    sourceRegistrationEventId: body.source_registration_event_id as string,
    subject,
    effectiveEntity,
    effectiveResolutionEvent: null,
    authority,
    assertionBasis,
    actor: (body.actor as JsonObject).id as string,
    lineage,
  });
  createVersion(state, 'observation', frame.event_id, frame.event_id);
  bumpVersion(state, 'source', body.source_id as string, frame.event_id);
}

/**
 * Human EFFECT forms pair one-to-one with the exact event that realizes
 * them, in the SAME logical batch; standalone stays free but a same-batch
 * basis use must agree with its intended Belief.
 */
function verifyHumanFormPairing(
  state: EpistemicState,
  frame: VectorFrame,
  form: JsonObject,
  members: { frame: VectorFrame; decoded: Decoded }[],
): void {
  const kind = form.assertion_form as string;
  if (kind === 'field_change') {
    const paired = members.some(({ decoded }) => {
      if (decoded.kind !== 'belief.revised') return false;
      if (decoded.body.belief_id !== form.target_belief_id) return false;
      return (decoded.body.patch as JsonObject[]).some(
        (op) =>
          op.field_path === form.field_path &&
          canonicalJson(op.before as Json) === canonicalJson(form.before as Json) &&
          canonicalJson(op.after as Json) === canonicalJson(form.after as Json),
      );
    });
    if (!paired) {
      throw new RefusedError('field_change requires its paired belief.revised patch');
    }
  } else if (kind === 'relation_change') {
    const paired = members.some(({ decoded }) => {
      if (decoded.kind !== 'belief.relation') return false;
      const b = decoded.body;
      return (
        b.relation_id === form.relation_id &&
        b.action === form.action &&
        b.from === form.from &&
        b.to === form.to &&
        b.relation === form.relation
      );
    });
    if (!paired) {
      throw new RefusedError('relation_change requires its paired belief.relation event');
    }
  } else if (kind === 'alias_add') {
    const belief = state.beliefs.get(form.target_belief_id as string);
    if (!belief) throw new RefusedError('alias_add target Belief does not exist');
    if (belief.entityId !== form.entity_id) {
      throw new RefusedError('alias_add entity must be the subject Entity of the target Belief');
    }
    const paired = members.some(({ decoded }) => {
      if (decoded.kind !== 'entity.alias_added') return false;
      const b = decoded.body;
      return (
        b.entity_id === form.entity_id &&
        b.alias === form.alias &&
        b.normalized_alias === form.normalized_alias
      );
    });
    if (!paired) {
      throw new RefusedError('alias_add requires its paired entity.alias_added event');
    }
  } else if (form.intended_belief_id !== null && form.intended_belief_id !== undefined) {
    for (const { decoded } of members) {
      if (decoded.kind !== 'belief.created' && decoded.kind !== 'belief.revised') continue;
      const basis = decoded.body.basis as JsonObject;
      if (basis.state !== 'linked') continue;
      const links = basis.links as JsonObject[];
      if (
        links.some((l) => l.observation_event_id === frame.event_id) &&
        decoded.body.belief_id !== form.intended_belief_id
      ) {
        throw new RefusedError('a same-batch basis use must name the intended Belief');
      }
    }
  }
}

function applyResolution(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const target = body.observation_event_id as string;
  if (staged.has(target)) throw new RefusedError('resolution targets a same-batch Observation');
  const observation = state.observations.get(target);
  if (!observation) throw new RefusedError('resolution targets no committed Observation');
  if (observation.subject.resolution !== 'unresolved') {
    throw new RefusedError('only an originally unresolved Observation can be attached');
  }
  const rawRef = observation.subject.raw_ref as string;

  const change = body.change as JsonObject;
  let toEntity: string;
  let fromEntity: string | null = null;
  const tier = change.resolver_tier as string;
  const basis = change.basis_event_ids as string[];
  const correcting = change.action === 'correct';
  if (!correcting) {
    if (observation.effectiveResolutionEvent !== null) {
      throw new RefusedError('attach on an already attached Observation');
    }
    toEntity = change.entity_id as string;
  } else {
    const current = observation.effectiveResolutionEvent;
    if (current === null) throw new RefusedError('correction before any attachment');
    if (current !== change.prior_resolution_event_id) {
      throw new RefusedError('stale prior resolution');
    }
    if (observation.effectiveEntity !== change.from_entity_id) {
      throw new RefusedError('correction from_entity does not match');
    }
    toEntity = change.to_entity_id as string;
    fromEntity = change.from_entity_id as string;
  }

  if (!state.entities.has(toEntity)) throw new RefusedError('target Entity does not exist');
  for (const id of basis) {
    if (staged.has(id)) throw new RefusedError('same-batch basis events are not permitted');
  }
  verifyTierProof(state, tier, basis, rawRef, toEntity, correcting);

  observation.effectiveEntity = toEntity;
  observation.effectiveResolutionEvent = frame.event_id;
  state.resolutions.push({
    seq: frame.seq,
    eventId: frame.event_id,
    observationEventId: target,
    action: correcting ? 'correct' : 'attach',
    fromEntityId: fromEntity,
    toEntityId: toEntity,
    resolverTier: tier,
  });
  bumpVersion(state, 'observation', target, frame.event_id);
}

function verifyTierProof(
  state: EpistemicState,
  tier: string,
  basis: string[],
  rawRef: string,
  targetEntity: string,
  correcting: boolean,
): void {
  if (tier === 'exact_id') {
    if (correcting) {
      const registration = state.entityRegistrations.get(basis[0]);
      if (!registration) throw new RefusedError('exact_id correction basis is not registering');
      if (registration[0] !== targetEntity) {
        throw new RefusedError('exact_id correction basis registers a different Entity');
      }
    } else if (rawRef !== targetEntity) {
      throw new RefusedError('exact_id attach requires raw_ref to equal the entity id');
    }
  } else if (tier === 'known_alias') {
    const alias = state.aliasEvents.get(basis[0]);
    if (!alias) throw new RefusedError('known_alias basis is not an alias event');
    if (alias[1] !== normalizeAliasV1(rawRef)) {
      throw new RefusedError('known_alias basis does not match the normalized mention');
    }
    if (alias[0] !== targetEntity) throw new RefusedError('known_alias names a different Entity');
  } else if (tier === 'explicit_relation') {
    let prevTo: string | null = null;
    for (const event of basis) {
      const relationId = state.relationAddEvents.get(event);
      if (!relationId) throw new RefusedError('explicit_relation basis is not a relation add');
      const relation = state.relations.get(relationId);
      if (!relation || !relation.live || relation.lastAddEventId !== event) {
        throw new RefusedError('explicit_relation basis relation is not currently live');
      }
      if (prevTo !== null && relation.from !== prevTo) {
        throw new RefusedError('explicit_relation path is not continuous');
      }
      prevTo = relation.to;
    }
    const belief = prevTo === null ? undefined : state.beliefs.get(prevTo);
    if (!belief) throw new RefusedError('explicit_relation path ends at no committed Belief');
    if (belief.entityId !== targetEntity) {
      throw new RefusedError('explicit_relation path does not end at the target Entity');
    }
  } else {
    const registration = state.entityRegistrations.get(basis[0]);
    if (!registration) throw new RefusedError('normalized_match basis is not registering');
    if (registration[0] !== targetEntity) {
      throw new RefusedError('normalized_match basis registers a different Entity');
    }
    const mention = normalizeAliasV1(rawRef);
    if (!registration[1].some((alias) => normalizeAliasV1(alias) === mention)) {
      throw new RefusedError('no preserved source alias normalizes to the mention');
    }
  }
}

function ancestors(state: EpistemicState, eventId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [eventId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const observation = state.observations.get(id);
    if (observation) for (const [, parent] of observation.lineage) stack.push(parent);
  }
  return seen;
}

function applyIndependence(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const left = state.observations.get(body.left_observation_event_id as string);
  const right = state.observations.get(body.right_observation_event_id as string);
  if (!left) throw new RefusedError('left independence endpoint is not an Observation');
  if (!right) throw new RefusedError('right independence endpoint is not an Observation');
  const proof = body.proof as JsonObject;
  if (
    proof.left_source_registration_event_id !== left.sourceRegistrationEventId ||
    proof.right_source_registration_event_id !== right.sourceRegistrationEventId
  ) {
    throw new RefusedError('proof registration refs do not match the endpoints');
  }
  const leftAncestors = ancestors(state, left.eventId);
  const rightAncestors = ancestors(state, right.eventId);
  for (const id of leftAncestors) {
    if (rightAncestors.has(id)) {
      throw new RefusedError('endpoints share lineage ancestry');
    }
  }
  const pair =
    left.eventId <= right.eventId
      ? `${left.eventId}|${right.eventId}`
      : `${right.eventId}|${left.eventId}`;
  if (state.independence.has(pair)) throw new RefusedError('pair already recorded');

  let proofKind: string;
  if (proof.kind === 'distinct_firsthand_origin') {
    for (const endpoint of [left, right]) {
      if (endpoint.authority !== 'trusted_human_capture') {
        throw new RefusedError('distinct_firsthand_origin requires trusted human captures');
      }
      if (endpoint.assertionBasis !== 'firsthand') {
        throw new RefusedError('distinct_firsthand_origin requires firsthand basis');
      }
    }
    const leftActor = registeredActor(state, left.sourceId);
    const rightActor = registeredActor(state, right.sourceId);
    if (leftActor === null || rightActor === null || leftActor === rightActor) {
      throw new RefusedError('distinct_firsthand_origin requires two different actors');
    }
    proofKind = 'distinct_firsthand_origin';
  } else {
    for (const endpoint of [left, right]) {
      if (endpoint.authority !== 'registered_direct_artifact') {
        throw new RefusedError('independent_system_artifact requires direct artifacts');
      }
    }
    const leftDomain = registeredDomain(state, left.sourceId);
    const rightDomain = registeredDomain(state, right.sourceId);
    if (leftDomain === null || rightDomain === null || leftDomain === rightDomain) {
      throw new RefusedError('independent_system_artifact requires different domains');
    }
    proofKind = 'independent_system_artifact';
  }
  state.independence.set(pair, { eventId: frame.event_id, proofKind });
  bumpVersion(state, 'observation', left.eventId, frame.event_id);
  bumpVersion(state, 'observation', right.eventId, frame.event_id);
}

function registeredActor(state: EpistemicState, sourceId: string): string | null {
  const source = state.sources.get(sourceId);
  if (!source || source.registration.kind !== 'human_actor') return null;
  return source.registration.actor_id as string;
}

function registeredDomain(state: EpistemicState, sourceId: string): string | null {
  const source = state.sources.get(sourceId);
  if (!source) return null;
  return (source.registration.independence_domain_id as string | null) ?? null;
}

function validateBasisLinks(state: EpistemicState, basis: JsonObject): void {
  if (basis.state !== 'linked') return;
  for (const link of basis.links as JsonObject[]) {
    const observation = state.observations.get(link.observation_event_id as string);
    if (!observation) throw new RefusedError('basis link is not an Observation');
    const isAssertion = ['extracted_assertion', 'derived_content', 'human_assertion'].includes(
      observation.kind,
    );
    if ((link.role === 'supports' || link.role === 'opposes') && !isAssertion) {
      throw new RefusedError('supports/opposes may target only assertion Observations');
    }
  }
}

function applyBeliefCreated(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const beliefId = body.belief_id as string;
  if (state.beliefs.has(beliefId)) throw new RefusedError('belief already exists');
  validateBasisLinks(state, body.basis as JsonObject);
  const subject = body.subject as JsonObject;
  const entityId = subject.entity_id as string;
  if (!state.entities.has(entityId)) {
    state.entities.set(entityId, frame.event_id);
    createVersion(state, 'entity', entityId, frame.event_id);
  }
  state.entityRegistrations.set(frame.event_id, [entityId, subject.aliases as string[]]);
  state.beliefs.set(beliefId, {
    beliefId,
    entityId,
    createdEventId: frame.event_id,
    revisions: [
      {
        revision: 1,
        eventId: frame.event_id,
        content: body.content as string,
        fields: body.fields as JsonObject,
        basis: body.basis as JsonObject,
      },
    ],
    attested: null,
  });
  state.beliefRevisionEvents.set(frame.event_id, [beliefId, 1]);
  createVersion(state, 'belief', beliefId, frame.event_id);
}

function applyBeliefRevised(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  validateBasisLinks(state, body.basis as JsonObject);
  const belief = state.beliefs.get(body.belief_id as string);
  if (!belief) throw new RefusedError('belief does not exist');
  const prior = belief.revisions[belief.revisions.length - 1];

  let content = prior.content;
  const fields = structuredClone(prior.fields);
  let changed = false;
  for (const op of body.patch as JsonObject[]) {
    const path = op.field_path as string;
    if (path === '/body') {
      if (canonicalJson(op.before as Json) !== canonicalJson(typedString(content))) {
        throw new RefusedError('patch before-value does not match the prior body');
      }
      const after = op.after as JsonObject;
      if (after.type !== 'string') throw new RefusedError('the body is a string');
      if ((after.value as string) !== content) changed = true;
      content = after.value as string;
      continue;
    }
    const tokens = path
      .slice('/fields/'.length)
      .split('/')
      .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    const current = typedAt(fields, tokens);
    if (canonicalJson(op.before as Json) !== canonicalJson(current)) {
      throw new RefusedError('patch before-value does not match prior state');
    }
    if (canonicalJson(op.before as Json) !== canonicalJson(op.after as Json)) changed = true;
    setTypedAt(fields, tokens, op.after as JsonObject);
  }
  const basisChanged = canonicalJson(body.basis as Json) !== canonicalJson(prior.basis as Json);
  if (!changed && !basisChanged) throw new RefusedError('total no-op revision');

  const revision = prior.revision + 1;
  belief.revisions.push({
    revision,
    eventId: frame.event_id,
    content,
    fields,
    basis: body.basis as JsonObject,
  });
  state.beliefRevisionEvents.set(frame.event_id, [belief.beliefId, revision]);
  bumpVersion(state, 'belief', belief.beliefId, frame.event_id);
}

const typedString = (value: string): Json => ({ type: 'string', value });

function typedAt(fields: JsonObject, tokens: string[]): Json {
  let cursor: Json = fields;
  for (const token of tokens) {
    if (typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor)) {
      if (!(token in cursor)) return { type: 'missing' };
      cursor = cursor[token];
    } else if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return { type: 'missing' };
      }
      cursor = cursor[index];
    } else {
      return { type: 'missing' };
    }
  }
  return typedFromValue(cursor);
}

function typedFromValue(value: Json): Json {
  if (value === null) return { type: 'null', value: null };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') return { type: 'number', value };
  if (typeof value === 'string') return { type: 'string', value };
  if (Array.isArray(value)) return { type: 'array', value: value.map(typedFromValue) };
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) out[k] = typedFromValue(v);
  return { type: 'object', value: out };
}

function valueFromTyped(typed: JsonObject): Json {
  switch (typed.type) {
    case 'null':
      return null;
    case 'boolean':
    case 'number':
    case 'string':
      return typed.value as Json;
    case 'array':
      return (typed.value as JsonObject[]).map((v) => valueFromTyped(v));
    default: {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(typed.value as JsonObject)) {
        out[k] = valueFromTyped(v as JsonObject);
      }
      return out;
    }
  }
}

function setTypedAt(fields: JsonObject, tokens: string[], after: JsonObject): void {
  const last = tokens[tokens.length - 1];
  let cursor: Json = fields;
  for (const token of tokens.slice(0, -1)) {
    if (typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor)) {
      if (!(token in cursor)) throw new RefusedError('patch parent does not exist');
      cursor = cursor[token];
    } else if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        throw new RefusedError('patch parent index does not exist');
      }
      cursor = cursor[index];
    } else {
      throw new RefusedError('patch parent is not a container');
    }
  }
  if (typeof cursor === 'object' && cursor !== null && !Array.isArray(cursor)) {
    if (after.type === 'missing') delete cursor[last];
    else cursor[last] = valueFromTyped(after);
  } else if (Array.isArray(cursor)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
      throw new RefusedError('patch index is out of range');
    }
    if (after.type === 'missing') cursor.splice(index, 1);
    else cursor[index] = valueFromTyped(after);
  } else {
    throw new RefusedError('patch target parent is not a container');
  }
}

function applyRelation(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  for (const endpoint of [body.from as string, body.to as string]) {
    if (!state.beliefs.has(endpoint)) {
      throw new RefusedError('relation endpoint names no committed Belief');
    }
  }
  const relationId = body.relation_id as string;
  if (body.action === 'add') {
    const existing = state.relations.get(relationId);
    if (existing) {
      if (existing.live) throw new RefusedError('relation is already live — duplicate add');
      existing.live = true;
      existing.lastAddEventId = frame.event_id;
      existing.lastEventId = frame.event_id;
      state.relationAddEvents.set(frame.event_id, relationId);
      bumpVersion(state, 'relation', relationId, frame.event_id);
    } else {
      state.relations.set(relationId, {
        relationId,
        from: body.from as string,
        to: body.to as string,
        relation: body.relation as string,
        live: true,
        lastAddEventId: frame.event_id,
        lastEventId: frame.event_id,
      });
      state.relationAddEvents.set(frame.event_id, relationId);
      createVersion(state, 'relation', relationId, frame.event_id);
    }
  } else {
    const existing = state.relations.get(relationId);
    if (!existing || !existing.live) {
      throw new RefusedError('remove requires the matching LIVE relation');
    }
    existing.live = false;
    existing.lastEventId = frame.event_id;
    bumpVersion(state, 'relation', relationId, frame.event_id);
  }
}

function applyAttested(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const revisionEvent = body.attested_belief_revision_event_id as string;
  if (staged.has(revisionEvent)) {
    throw new RefusedError('attestation must pin a COMMITTED revision');
  }
  const pinned = state.beliefRevisionEvents.get(revisionEvent);
  if (!pinned) throw new RefusedError('attested revision names no committed revision');
  const [beliefId, revisionNo] = pinned;
  if (beliefId !== body.belief_id) {
    throw new RefusedError('the pinned revision belongs to a different Belief');
  }
  const belief = state.beliefs.get(beliefId) as BeliefState;
  const revision = belief.revisions.find((r) => r.revision === revisionNo) as RevisionState;
  const projected = project(revision.content, revision.fields as Json);
  if (body.attested_content_hash !== attestedContentHash(projected)) {
    throw new RefusedError('attested_content_hash does not match the projection');
  }
  belief.attested = [frame.event_id, revisionEvent];
  bumpVersion(state, 'belief', beliefId, frame.event_id);
}

function applyAlias(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const entityId = body.entity_id as string;
  if (!state.entities.has(entityId)) throw new RefusedError('alias names unknown Entity');
  const normalized = body.normalized_alias as string;
  if (state.aliasRegistry.has(normalized)) {
    throw new RefusedError('alias key is already registered');
  }
  state.aliasRegistry.set(normalized, {
    alias: body.alias as string,
    entityId,
    eventId: frame.event_id,
  });
  state.aliasEvents.set(frame.event_id, [entityId, normalized]);
  bumpVersion(state, 'entity', entityId, frame.event_id);
}

function applyMigrationStarted(state: EpistemicState, body: JsonObject): void {
  if (state.migration) {
    if (!state.migration.completed && state.migration.sourceDigest !== body.source_digest) {
      throw new RefusedError('migration source digest changed mid-epoch');
    }
    if (state.migration.sourceDigest === body.source_digest) {
      throw new RefusedError('migration already started for this corpus');
    }
  }
  state.migration = {
    storeUuid: body.store_uuid as string,
    sourceDigest: body.source_digest as string,
    plannedOutputCount: body.planned_output_count as number,
    completed: false,
  };
}

function applyMigrationCompleted(state: EpistemicState, body: JsonObject): void {
  const epoch = state.migration;
  if (!epoch) throw new RefusedError('migration.completed without migration.started');
  if (epoch.storeUuid !== body.store_uuid || epoch.sourceDigest !== body.source_digest) {
    throw new RefusedError('migration.completed does not agree with the started identity');
  }
  if (body.output_count !== epoch.plannedOutputCount) {
    throw new RefusedError('migration.completed output_count disagrees with the plan');
  }
  epoch.completed = true;
}

// --- the vector-state view (must match Rust's `vector_state`) --------------

const sorted = <T>(entries: [string, T][]): [string, T][] =>
  [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function vectorState(state: EpistemicState): Json {
  const sources: JsonObject = {};
  for (const [id, s] of sorted([...state.sources.entries()])) {
    sources[id] = {
      source_key: s.registration.source_key as string,
      kind: s.registration.kind as string,
      capability: s.registration.authority_capability as string,
      independence_domain_id: (s.registration.independence_domain_id as string | null) ?? null,
      registration_event_id: s.registrationEventId,
    };
  }
  const entities: JsonObject = {};
  for (const [id, event] of sorted([...state.entities.entries()])) entities[id] = event;
  const aliases: JsonObject = {};
  for (const [normalized, a] of sorted([...state.aliasRegistry.entries()])) {
    aliases[normalized] = { alias: a.alias, entity_id: a.entityId, event_id: a.eventId };
  }
  const observations: JsonObject = {};
  for (const [id, o] of sorted([...state.observations.entries()])) {
    observations[id] = {
      seq: o.seq,
      kind: o.kind,
      source_id: o.sourceId,
      subject:
        o.subject.resolution === 'resolved'
          ? ['resolved', o.subject.entity_id as string]
          : o.subject.resolution === 'unresolved'
            ? ['unresolved', o.subject.raw_ref as string]
            : ['none'],
      effective_entity: o.effectiveEntity,
      effective_resolution_event: o.effectiveResolutionEvent,
      authority: o.authority,
      lineage: o.lineage.map(([edge, parent]) => [edge, parent] as Json[]),
    };
  }
  const beliefs: JsonObject = {};
  for (const [id, b] of sorted([...state.beliefs.entries()])) {
    const current = b.revisions[b.revisions.length - 1];
    beliefs[id] = {
      entity_id: b.entityId,
      revision: current.revision,
      content: current.content,
      fields: current.fields,
      basis: current.basis,
      attested: b.attested ? [b.attested[0], b.attested[1]] : null,
      revision_events: b.revisions.map((r) => r.eventId),
    };
  }
  const relations: JsonObject = {};
  for (const [id, r] of sorted([...state.relations.entries()])) {
    relations[id] = { from: r.from, to: r.to, relation: r.relation, live: r.live };
  }
  const versions: JsonObject = {};
  for (const [key, version] of sorted([...state.versions.entries()])) versions[key] = version;
  return {
    sources,
    entities,
    aliases,
    observations,
    beliefs,
    relations,
    resolutions: state.resolutions.map((r) => [
      r.eventId,
      r.observationEventId,
      r.action,
      r.fromEntityId,
      r.toEntityId,
      r.resolverTier,
    ]),
    independence: sorted([...state.independence.entries()]).map(([pair, row]) => {
      const [left, right] = pair.split('|');
      return [left, right, row.proofKind] as Json[];
    }),
    derived_belief_sources: state.derivedBeliefSources.map(([o, r]) => [o, r] as Json[]),
    versions,
    batches: state.batches.map((b) => [b.batchId, b.state, b.memberCount] as Json[]),
  };
}
