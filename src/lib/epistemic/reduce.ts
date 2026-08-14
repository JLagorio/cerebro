/**
 * The minimal TS reducer (M22.4) — a fold-for-fold port of
 * `src-tauri/src/ledger/reduce.rs`, replayed against the shared conformance
 * vectors. State and refusal identity must match the Rust reference
 * exactly; refusal identity is `(seq, event_id, batch_id, code)`.
 */

import type { Json } from './ids';
import { attestedContentHash, beliefFacetId, canonicalJson } from './ids';
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

interface OverrideState {
  eventId: string;
  baseBeliefRevision: number;
  patch: JsonObject[];
  stale: boolean;
}

interface BeliefState {
  beliefId: string;
  entityId: string;
  createdEventId: string;
  revisions: RevisionState[];
  attested: [string, string] | null;
  /** Every APPLIED attestation event, fold order. */
  attestationEvents: string[];
  /** The knowledge-relative projection path claimed at creation. */
  path: string | null;
  /** Active editorial overlays in application order. */
  overrides: OverrideState[];
  /** The latest override set/supersede/clear event, clear included. */
  overrideHeadEvent: string | null;
  /** The highest-seq projection-state transition event. */
  projectionHeadEvent: string;
  // --- M24 governed state -------------------------------------------------
  qualification: string;
  lifecycle: string;
  /** Set once, never cleared: a tombstone is terminal by construction. */
  tombstonedBy: string | null;
  openContestEvent: string | null;
  qualificationHeadEvent: string | null;
  lifecycleHeadEvent: string | null;
  contestHeadEvent: string | null;
  entityMergeEventIds: string[];
}

/** The durable proposal lifecycle — reducer state, never runtime cache. */
interface ProposalRow {
  proposalId: string;
  /**
   * The submitted proposal, WHOLE. The review card, the pre-append
   * revalidation, and the revert all read this record rather than a summary
   * of it — which is also what makes run accumulation durable.
   */
  proposal: Json;
  /** WHO proposed it: mutations are attributed to the proposer, not to the
   * policy layer that authorized them. */
  actor: string;
  state: string;
  commitSetId: string | null;
  /** The frozen ordered member list the set's id was derived from. */
  queuedMembers: string[];
  /** The effective risk the CARD SAID when a human was asked. */
  queuedRisk: string | null;
  /** Why policy is holding it, beyond the risk ladder (M24.8). */
  queuedFor: string[];
  decision: [string, string] | null;
  appliedEventId: string | null;
  revertPlan: Json | null;
  submittedEventId: string;
  /**
   * When the STORE received it — the submission frame's own stamp, the only
   * durable time a proposal has, and so the one an expansion may date a
   * generated body by (M27.4c).
   */
  submittedAt: string;
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

interface ReconciliationLogRow {
  eventId: string;
  divergenceEventId: string;
  action: string;
}

/** One committed `coverage.fact_recorded` (M25.4). */
export interface CoverageFactRow {
  factId: string;
  sourceId: string;
  subjectId: string | null;
  predicateClass: string | null;
  dimension: string;
  state: string;
  asOf: string;
}

/** One `coverage.assessed`, uncollapsed. */
export interface CoverageAssessmentRow {
  assessmentId: string;
  sourceId: string;
  subjectId: string | null;
  predicateClass: string | null;
  dimensions: JsonObject;
  hasRetrievalReceipt: boolean;
  superseded: boolean;
}

/** One coverage gap. Open until the LAST affected dimension is restored. */
export interface CoverageGapRow {
  gapId: string;
  cause: string;
  component: string | null;
  sourceId: string | null;
  remaining: string[];
  closed: boolean;
}

/** One committed `ingest.assessed` receipt (M25.3). */
export interface IngestReceiptRow {
  receiptId: string;
  itemId: string;
  sourceId: string;
  artifactHash: string;
  normalizerVersion: string;
  processingEpoch: number;
  route: string;
  superseded: boolean;
  m26BatchKey: string | null;
}

/** One committed `ingest.semantic_assessed` outcome (M26.4). */
export interface SemanticAssessmentRow {
  semanticAssessmentId: string;
  m26BatchKey: string;
  inputReceiptIds: string[];
  outcome: string;
  proposalIds: string[];
}

/**
 * One comparison (M26.7, widened by M27.3) — a pair that needs classifying.
 *
 * ONE map, two ways in: M26's detector creates comparisons from evidence, and
 * a declared `contradicts` relation creates one with no evidence at all. Two
 * maps keyed by comparison id would be two places to ask "is this registered".
 */
export interface ComparisonRow {
  comparisonId: string;
  eventId: string;
  /** The tagged endpoint — `asserted` or `declared_relation`, as it arrived. */
  left: JsonObject;
  right: JsonObject;
  origin: ComparisonOrigin;
}

/**
 * Where a comparison came from, with the facts only that path has. A declared
 * comparison has no detector and no candidate reason codes, and spelling that
 * as an empty list would make "nothing detected it" indistinguishable from a
 * detector that gave no reason — which M26 refuses outright.
 */
export type ComparisonOrigin =
  | { kind: 'detected'; detectorVersion: string; reasonCodes: string[] }
  | { kind: 'declared'; sourceRelationEventId: string; ruleVersion: string };

/** What the gauntlet concluded about one comparison (M27.3). One, ever. */
export interface ClassificationRow {
  comparisonId: string;
  eventId: string;
  outcome: string;
  classification: JsonObject;
  reasonCodes: string[];
  evidenceEventIds: string[];
}

/**
 * One contradiction edge (M27.3) — the protected thing. `closed` is a field
 * rather than a deletion: M27.4's preservation gate reads these, and an edge
 * that vanished would leave a hole where a disagreement used to be.
 */
export interface ContradictionEdgeRow {
  edgeId: string;
  comparisonId: string;
  kind: string;
  leftBeliefId: string;
  rightBeliefId: string;
  openedEventId: string;
  classifiedEventId: string;
  closed: EdgeClosure | null;
}

export interface EdgeClosure {
  eventId: string;
  addressedByEventId: string;
  disposition: string;
  evidenceEventIds: string[];
}

/** The backfill's checkpoint (M27.3) — activation is gated on one. */
export interface BackfillCheckpoint {
  eventId: string;
  throughEventId: string;
  sourceRelationCount: number;
  resolvedCount: number;
  openedCount: number;
  ruleVersion: string;
}

/**
 * One facet's recorded freshness, folded from its transitions (M27.1).
 *
 * `folded` is the idempotency ledger the design's append_once semantics need:
 * the timer and launch catch-up both emit every DUE transition, so the same
 * `dedupe_key` arriving twice must change nothing at all — including
 * versions. It is deliberately not projected into the vector state; what a
 * vector proves about a duplicate is the observable consequence.
 */
export interface FreshnessRow {
  facetId: string;
  facet: JsonObject;
  state: string;
  effectiveAt: string;
  ruleVersion: string;
  eventId: string;
  /** dedupe key -> [event, from, to]. */
  folded: Map<string, [string, string, string]>;
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
  /** The M24 proposal lifecycle — portable, not a runtime cache. */
  proposals: Map<string, ProposalRow>;
  /**
   * M25.3's portable processing receipts, keyed by receipt id.
   *
   * Structurally outside every evidence structure: a receipt id lives here
   * and nowhere else, so it can never resolve as a basis link, a lineage
   * parent, or a derived-content source.
   */
  ingestReceipts: Map<string, IngestReceiptRow>;
  /**
   * M26.4's semantic dispositions, keyed by assessment id — one per settled
   * window. Holding an id IS the "already assessed, do not spend again" fact,
   * because the id is derived from the window.
   */
  semanticAssessments: Map<string, SemanticAssessmentRow>;
  /** Event id → assessment id: a successor receipt names the EVENT. */
  semanticByEvent: Map<string, string>;
  /**
   * M26.7's detected comparisons, keyed by comparison id. Portable, because
   * M27 targets these ids: losing the runtime DB must not erase which
   * disagreements the app already noticed.
   */
  comparisons: Map<string, ComparisonRow>;
  /** M27.3's classifications, keyed by comparison id — resolutions included. */
  conflictClassifications: Map<string, ClassificationRow>;
  /**
   * M27.3's contradiction edges, keyed by edge id, closed ones included. A
   * rebuild that lost an open edge would silently un-protect a merge the user
   * was told was blocked.
   */
  contradictionEdges: Map<string, ContradictionEdgeRow>;
  /** The latest backfill checkpoint, or null. */
  contradictionBackfill: BackfillCheckpoint | null;
  /**
   * M27.1's recorded freshness crossings, keyed by facet id. Portable
   * epistemic history: a rebuild that lost these would forget when a claim
   * stopped being current.
   */
  freshness: Map<string, FreshnessRow>;
  /** M25.4's coverage record — facts, assessments, and gaps, uncollapsed. */
  coverageFacts: Map<string, CoverageFactRow>;
  coverageAssessments: Map<string, CoverageAssessmentRow>;
  coverageGaps: Map<string, CoverageGapRow>;
  resolutions: ResolutionRow[];
  independence: Map<string, { eventId: string; proofKind: string }>; // "left|right"
  derivedBeliefSources: [string, string][];
  versions: Map<string, number>; // "class:id"
  versionEvents: Map<string, string>;
  batches: BatchRow[];
  anomalies: Anomaly[];
  migration: MigrationEpoch | null;
  /** knowledge-relative projection path → Belief id. */
  projectionPaths: Map<string, string>;
  /** Active divergences: detection_key → divergence event id. */
  reconciliationDivergences: Map<string, string>;
  reconciliationLog: ReconciliationLogRow[];
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
    proposals: new Map(),
    ingestReceipts: new Map(),
    semanticAssessments: new Map(),
    semanticByEvent: new Map(),
    comparisons: new Map(),
    conflictClassifications: new Map(),
    contradictionEdges: new Map(),
    contradictionBackfill: null,
    freshness: new Map(),
    coverageFacts: new Map(),
    coverageAssessments: new Map(),
    coverageGaps: new Map(),
    resolutions: [],
    independence: new Map(),
    derivedBeliefSources: [],
    versions: new Map(),
    versionEvents: new Map(),
    batches: [],
    anomalies: [],
    migration: null,
    projectionPaths: new Map(),
    reconciliationDivergences: new Map(),
    reconciliationLog: [],
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
    case 'projection.overridden':
      return applyOverride(state, frame, body);
    case 'ledger.divergence':
      return applyDivergence(state, frame, body);
    case 'ledger.reconciliation_resolved':
      return applyReconciliationResolved(state, frame, body);
    case 'belief.qualification_changed':
      return applyQualification(state, frame, body);
    case 'belief.lifecycle_changed':
      return applyLifecycle(state, frame, body);
    case 'belief.tombstoned':
      return applyTombstone(state, frame, body);
    case 'belief.contested':
      return applyContest(state, frame, body, staged);
    case 'entity.merged':
      return applyEntityMerge(state, frame, body);
    case 'proposal.submitted':
      return applyProposalSubmitted(state, frame, body);
    case 'proposal.queued':
      return applyProposalQueued(state, frame, body);
    case 'proposal.decision_recorded':
      return applyProposalDecision(state, frame, body);
    case 'proposal.applied':
      return applyProposalApplied(state, frame, body);
    case 'proposal.rejected':
      return applyProposalRejected(state, frame, body);
    case 'proposal.reverted':
      return applyProposalReverted(state, frame, body);
    case 'ingest.assessed':
      return applyIngestAssessed(state, frame, body, staged);
    case 'ingest.semantic_assessed':
      return applyIngestSemanticAssessed(state, frame, body);
    case 'coverage.fact_recorded':
      return applyCoverageFact(state, frame, body);
    case 'coverage.assessed':
      return applyCoverageAssessed(state, frame, body, staged);
    case 'coverage.gap':
      return applyCoverageGap(state, frame, body, staged);
    case 'coverage.restored':
      return applyCoverageRestored(state, frame, body, staged);
    case 'conflict.candidate_detected':
      return applyConflictCandidate(state, frame, body, staged);
    case 'freshness.transitioned':
      return applyFreshnessTransitioned(state, frame, body, staged);
    case 'conflict.comparison_registered':
      return applyComparisonRegistered(state, frame, body, staged);
    case 'conflict.classified':
      return applyConflictClassified(state, frame, body);
    case 'contradiction.opened':
      return applyContradictionOpened(state, frame, body);
    case 'contradiction.closed':
      return applyContradictionClosed(state, frame, body, staged);
    case 'contradiction.backfill_completed':
      return applyBackfillCompleted(state, frame, body, staged);
    default:
      throw new SchemaError(`unhandled kind ${decoded.kind}`);
  }
}

/**
 * `ingest.assessed` (M25.3) — the portable processing receipt.
 *
 * Every check is about ASSOCIATION, never about truth: does the source
 * exist, do the Observations exist, does the proposal's state match the
 * route the receipt claims, and does a successor supersede something that
 * was really queued.
 */
function applyIngestAssessed(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const receiptId = body.receipt_id as string;
  if (state.ingestReceipts.has(receiptId)) {
    throw new RefusedError(
      `receipt ${receiptId} is already recorded — identical bytes append once, never twice`,
    );
  }
  const sourceId = body.source_id as string;
  if (!state.sources.has(sourceId)) {
    throw new RefusedError(`receipt names source ${sourceId} which has no committed registration`);
  }
  for (const id of body.observation_event_ids as string[]) {
    if (!staged.has(id) && !state.observations.has(id)) {
      throw new RefusedError(
        `receipt names Observation ${id} which is neither committed nor a member of this batch`,
      );
    }
  }
  const route = body.route as string;
  const expected: { [route: string]: string } = {
    deterministic_proposal_applied: 'applied',
    deterministic_proposal_queued: 'queued',
    deterministic_proposal_rejected: 'rejected',
  };
  for (const id of body.proposal_ids as string[]) {
    const row = state.proposals.get(id);
    if (row === undefined) {
      throw new RefusedError(`receipt names proposal ${id} which was never submitted`);
    }
    const want = expected[route];
    if (want !== undefined && row.state !== want) {
      throw new RefusedError(
        `route ${route} claims proposal ${id} is ${want}, and it is ${row.state}`,
      );
    }
  }
  const supersedes = body.supersedes_receipt_id as string | null;
  if (supersedes !== null) {
    const prior = state.ingestReceipts.get(supersedes);
    if (prior === undefined) {
      throw new RefusedError(`receipt supersedes ${supersedes}, which is not a committed receipt`);
    }
    if (prior.route !== 'm26_queued') {
      throw new RefusedError(
        `only a queued M26 receipt can be superseded; ${supersedes} is ${prior.route}`,
      );
    }
    if (prior.superseded) {
      throw new RefusedError(
        `receipt ${supersedes} is already superseded — one successor, not a chain of them`,
      );
    }
    if (prior.processingEpoch !== (body.processing_epoch as number)) {
      throw new RefusedError("a successor shares its queued receipt's processing epoch");
    }
    if (prior.itemId !== (body.item_id as string) || prior.sourceId !== sourceId) {
      throw new RefusedError('a successor receipt must describe the same source item');
    }
  }
  checkReceiptAgainstOutcome(state, body);
  if (body.independence === 'known_independent' && state.independence.size === 0) {
    throw new RefusedError(
      'a receipt claims known_independent and this store holds no independence record',
    );
  }

  if (supersedes !== null) {
    const prior = state.ingestReceipts.get(supersedes);
    if (prior !== undefined) prior.superseded = true;
    bumpVersion(state, 'ingest_receipt', supersedes, frame.event_id);
  }
  state.ingestReceipts.set(receiptId, {
    receiptId,
    itemId: body.item_id as string,
    sourceId,
    artifactHash: body.artifact_hash as string,
    normalizerVersion: body.normalizer_version as string,
    processingEpoch: body.processing_epoch as number,
    route,
    superseded: false,
    m26BatchKey: body.m26_batch_key as string | null,
  });
  createVersion(state, 'ingest_receipt', receiptId, frame.event_id);
}

/**
 * The successor half of the receipt (M26.4): an `m26_completed` or
 * `failed_visible` receipt names the semantic outcome that closed it, and the
 * two have to agree about what happened. The twin of
 * `check_receipt_against_outcome` in `ledger/reduce.rs`.
 */
function checkReceiptAgainstOutcome(state: EpistemicState, body: JsonObject): void {
  const eventId = body.m26_outcome_event_id as string | null;
  if (eventId === null) return;
  const assessmentId = state.semanticByEvent.get(eventId);
  if (assessmentId === undefined) {
    throw new RefusedError(
      `receipt names outcome event ${eventId}, which is not a committed semantic assessment — ` +
        'an outcome is applied before the receipts it closes, including inside its own batch',
    );
  }
  const outcome = state.semanticAssessments.get(assessmentId) as SemanticAssessmentRow;
  const routeExpectsBlock = body.route === 'failed_visible';
  if (routeExpectsBlock !== (outcome.outcome === 'undetermined')) {
    throw new RefusedError(
      `route ${String(body.route)} cannot close on outcome ${outcome.outcome} — a blocked ` +
        'window closes as failed_visible and a decided one as m26_completed',
    );
  }
  if (body.m26_batch_key !== outcome.m26BatchKey) {
    throw new RefusedError(
      `receipt is on window ${JSON.stringify(body.m26_batch_key)} and the outcome it names ` +
        `decided window ${JSON.stringify(outcome.m26BatchKey)}`,
    );
  }
  const supersedes = body.supersedes_receipt_id as string | null;
  if (supersedes !== null && !outcome.inputReceiptIds.includes(supersedes)) {
    throw new RefusedError(
      `receipt supersedes ${supersedes}, which was not an input to the outcome it names — ` +
        'a window closes only the items it read',
    );
  }
  const extra = (body.proposal_ids as string[]).find((id) => !outcome.proposalIds.includes(id));
  if (extra !== undefined) {
    throw new RefusedError(
      `receipt claims proposal ${extra}, which its semantic outcome did not submit`,
    );
  }
}

/**
 * `ingest.semantic_assessed` (M26.4) — what one semantic run concluded about
 * one settled window.
 *
 * Association only, exactly like the receipt it succeeds. Note what is NOT
 * here: no version is created or bumped. `semantic_assessment_id` is an
 * idempotent history key, not a CAS target, and being mentioned by history is
 * not a state change.
 */
function applyIngestSemanticAssessed(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
): void {
  const assessmentId = body.semantic_assessment_id as string;
  const window = body.m26_batch_key as string;
  if (state.semanticAssessments.has(assessmentId)) {
    throw new RefusedError(
      `window ${window} has already been assessed — one semantic run per settled window, and ` +
        'the assessment id is derived from the window so a second run cannot pretend otherwise',
    );
  }
  for (const id of body.input_receipt_ids as string[]) {
    const receipt = state.ingestReceipts.get(id);
    if (receipt === undefined) {
      throw new RefusedError(`outcome names input receipt ${id}, which was never committed`);
    }
    if (receipt.route !== 'm26_queued') {
      throw new RefusedError(
        `input receipt ${id} is ${receipt.route}, and only a queued receipt is waiting on a ` +
          'semantic run',
      );
    }
    if (receipt.superseded) {
      throw new RefusedError(`input receipt ${id} was already closed out by an earlier successor`);
    }
    if (receipt.m26BatchKey !== window) {
      throw new RefusedError(
        `input receipt ${id} is parked on window ${JSON.stringify(receipt.m26BatchKey)}, not ` +
          `on ${window}`,
      );
    }
  }
  for (const id of body.proposal_ids as string[]) {
    if (!state.proposals.has(id)) {
      throw new RefusedError(`outcome names proposal ${id}, which was never submitted`);
    }
  }
  state.semanticAssessments.set(assessmentId, {
    semanticAssessmentId: assessmentId,
    m26BatchKey: window,
    inputReceiptIds: body.input_receipt_ids as string[],
    outcome: body.outcome as string,
    proposalIds: body.proposal_ids as string[],
  });
  state.semanticByEvent.set(frame.event_id, assessmentId);
}

/**
 * `conflict.candidate_detected` (M26.7) — a pair put forward for
 * classification.
 *
 * Every check is about ANCHORING. The body already proved it is internally
 * honest; what it cannot know alone is whether the things it pins exist. An
 * endpoint claims three references — the assertion was recorded, the revision
 * belongs to the Belief named, and that revision's basis used the assertion —
 * and the third is the one that matters: without it, any assertion could be
 * pinned to any Belief and the resulting comparison id would be perfectly
 * stable and completely meaningless.
 *
 * Unlike the semantic assessment, this DOES create a version: the comparison
 * is a CAS target because M27 proposes against it.
 */
function applyConflictCandidate(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const comparisonId = body.comparison_id as string;
  const existing = state.comparisons.get(comparisonId);
  if (existing !== undefined) {
    throw new RefusedError(
      `comparison ${comparisonId} was already detected by event ${existing.eventId} — an ` +
        'exact retry is deduplicated at the door by its idempotency key, so a second event ' +
        'reaching the reducer is a duplicate append, not a retry',
    );
  }
  for (const [side, endpoint] of [
    ['left', body.left as JsonObject],
    ['right', body.right as JsonObject],
  ] as [string, JsonObject][]) {
    anchorConflictEndpoint(state, staged, side, endpoint);
  }
  state.comparisons.set(comparisonId, {
    comparisonId,
    eventId: frame.event_id,
    // Wrapped into the tagged endpoint M27 classifies against: a relabelling,
    // not a reshaping, because `asserted` flattens M26's endpoint.
    left: { kind: 'asserted', ...(body.left as JsonObject) },
    right: { kind: 'asserted', ...(body.right as JsonObject) },
    origin: {
      kind: 'detected',
      detectorVersion: body.detector_version as string,
      reasonCodes: body.reason_codes as string[],
    },
  });
  createVersion(state, 'comparison', comparisonId, frame.event_id);
}

/**
 * `freshness.transitioned` (M27.1) — one facet crossing a boundary.
 *
 * The reducer FOLDS and derives nothing. Freshness is a pure function of
 * pinned evidence, a versioned rule, and an explicit `as_of`; re-deriving it
 * here would need the rules artifact, every assertion's predicate, and a
 * clock, and this reducer has none of the three.
 *
 * Three checks, and the interesting one is the third:
 *
 * 1. the facet's revision is committed and belongs to the belief it names;
 * 2. a repeated `dedupe_key` carrying the SAME transition is an idempotent
 *    no-op — nothing moves, no version advances — because the timer and
 *    launch catch-up both emit every due transition and either may win. A
 *    repeated key carrying a DIFFERENT `from`/`to` is a hard conflict: those
 *    two fields are the only content the key does not cover;
 * 3. continuity — `from` must equal what the facet's last transition said it
 *    became. A facet with no history is checked against nothing, because the
 *    initial state is derived and the reducer is precisely what does not
 *    derive.
 *
 * There is deliberately NO monotonicity check on `effective_at`: a facet goes
 * stale at `anchor + duration` and becomes fresh again AT the newer anchor,
 * so a retroactively-stamped source can legitimately order those backwards.
 */
function applyFreshnessTransitioned(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const facet = body.facet as JsonObject;
  const beliefId = facet.belief_id as string;
  const revisionId = facet.belief_revision_event_id as string;
  if (staged.has(revisionId)) {
    throw new RefusedError(
      'facet.belief_revision_event_id pins a STAGED event — a freshness transition is about ' +
        'what the store already holds, not about what this batch is still writing',
    );
  }
  const belief = state.beliefs.get(beliefId);
  if (belief === undefined) {
    throw new RefusedError(`facet.belief_id ${beliefId} does not exist`);
  }
  if (belief.tombstonedBy !== null) {
    throw new RefusedError(
      `belief ${beliefId} is tombstoned — a tombstone is terminal, and a claim nobody may act ` +
        'on does not go stale',
    );
  }
  const indexed = state.beliefRevisionEvents.get(revisionId);
  if (indexed === undefined) {
    throw new RefusedError(
      `facet.belief_revision_event_id ${revisionId} names no committed revision`,
    );
  }
  if (indexed[0] !== beliefId) {
    throw new RefusedError(
      `facet.belief_revision_event_id belongs to belief ${indexed[0]}, not to ${beliefId}`,
    );
  }

  const facetId = beliefFacetId(facet as Json);
  const from = body.from as string;
  const to = body.to as string;
  const dedupeKey = body.dedupe_key as string;
  const row = state.freshness.get(facetId);
  const folded = row === undefined ? new Map<string, [string, string, string]>() : row.folded;
  const seen = folded.get(dedupeKey);
  if (seen !== undefined) {
    if (seen[1] === from && seen[2] === to) return;
    throw new RefusedError(
      `dedupe key ${dedupeKey} was already folded by event ${seen[0]} as ${seen[1]}→${seen[2]}, ` +
        `and this event says ${from}→${to} — the key covers the transition that was DUE, so a ` +
        'disagreement about what happened is two producers disagreeing, not a retry',
    );
  }
  if (row !== undefined && row.state !== from) {
    throw new RefusedError(
      `this facet is ${row.state} (event ${row.eventId}), and the transition says it was ` +
        `${from} — a chain whose links do not meet is not a history`,
    );
  }

  folded.set(dedupeKey, [frame.event_id, from, to]);
  state.freshness.set(facetId, {
    facetId,
    facet,
    state: to,
    effectiveAt: body.effective_at as string,
    ruleVersion: body.rule_version as string,
    eventId: frame.event_id,
    folded,
  });
  bumpVersion(state, 'belief', beliefId, frame.event_id);
}

// --- M27.3 the resolution pipeline ------------------------------------------

/**
 * `conflict.comparison_registered` (M27.3) — the ONLY declared-endpoint
 * creation event.
 *
 * The anchoring is about the RELATION, because there is no assertion to point
 * at: it was really added, it really is a `contradicts`, it is the relation's
 * current add, and its endpoints are the two Beliefs named.
 *
 * The relation event may be in this very batch, and normally is — the
 * declared path commits relation, registration, classification, and edge
 * together — so a staged relation is deliberately NOT refused here.
 */
function applyComparisonRegistered(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const comparisonId = body.comparison_id as string;
  const existing = state.comparisons.get(comparisonId);
  if (existing !== undefined) {
    throw new RefusedError(
      `comparison ${comparisonId} already exists (event ${existing.eventId}) — registration is ` +
        'the one creation, and an exact retry is deduplicated at the door by its idempotency key',
    );
  }
  const relationEvent = body.source_relation_event_id as string;
  const relationId = state.relationAddEvents.get(relationEvent);
  if (relationId === undefined) {
    throw new RefusedError(
      `source_relation_event_id ${relationEvent} names no relation ADD event — a declared ` +
        'comparison is registered because somebody declared a relation, and this names none',
    );
  }
  const relation = state.relations.get(relationId);
  if (relation === undefined) {
    throw new RefusedError(
      `relation ${relationId} is indexed by its add event but absent from state`,
    );
  }
  if (relation.relation !== 'contradicts') {
    throw new RefusedError(
      `relation ${relationId} is a ${relation.relation}, not a contradicts — registering a ` +
        'comparison from it would put a conflict in the ledger that nobody declared',
    );
  }
  if (!relation.live || relation.lastAddEventId !== relationEvent) {
    throw new RefusedError(
      `relation ${relationId} is not live at add event ${relationEvent} — a comparison pinned ` +
        'to a withdrawn declaration would keep a conflict alive that its author took back',
    );
  }
  const left = body.left as JsonObject;
  const right = body.right as JsonObject;
  const declaredEnds = [left.belief_id as string, right.belief_id as string].sort();
  const relationEnds = [relation.from, relation.to].sort();
  if (declaredEnds[0] !== relationEnds[0] || declaredEnds[1] !== relationEnds[1]) {
    throw new RefusedError(
      `the registration names beliefs ${JSON.stringify(declaredEnds)} and relation ` +
        `${relationId} joins ${JSON.stringify(relationEnds)} — a comparison about a different ` +
        'pair than the one declared',
    );
  }
  for (const [side, endpoint] of [
    ['left', left],
    ['right', right],
  ] as [string, JsonObject][]) {
    anchorDeclaredEndpoint(state, staged, side, endpoint);
  }

  state.comparisons.set(comparisonId, {
    comparisonId,
    eventId: frame.event_id,
    left: { kind: 'declared_relation', ...left },
    right: { kind: 'declared_relation', ...right },
    origin: {
      kind: 'declared',
      sourceRelationEventId: relationEvent,
      ruleVersion: body.rule_version as string,
    },
  });
  createVersion(state, 'comparison', comparisonId, frame.event_id);
}

/**
 * What one declared endpoint has to earn. Fewer references than an asserted
 * one, because there is no assertion and no basis link — the missing third
 * check is exactly what the `declared_relation` variant exists to admit. The
 * `content_hash` is not recomputed, for the reason M26 never recomputes
 * `value_hash`: the reducer anchors REFERENCES.
 */
function anchorDeclaredEndpoint(
  state: EpistemicState,
  staged: Set<string>,
  side: string,
  endpoint: JsonObject,
): void {
  const revisionEvent = endpoint.belief_revision_event_id as string;
  if (staged.has(revisionEvent)) {
    throw new RefusedError(
      `${side}.belief_revision_event_id pins a STAGED event — the endpoint pins the revision ` +
        'current AT the relation, which is something the store already holds',
    );
  }
  const beliefId = endpoint.belief_id as string;
  const belief = state.beliefs.get(beliefId);
  if (belief === undefined) throw new RefusedError(`${side}.belief_id ${beliefId} does not exist`);
  if (belief.entityId !== endpoint.subject_id) {
    throw new RefusedError(
      `${side}.subject_id ${String(endpoint.subject_id)} is not the entity belief ${beliefId} ` +
        `is about (${belief.entityId})`,
    );
  }
  const revision = state.beliefRevisionEvents.get(revisionEvent);
  if (revision === undefined) {
    throw new RefusedError(
      `${side}.belief_revision_event_id ${revisionEvent} names no committed revision`,
    );
  }
  if (revision[0] !== beliefId) {
    throw new RefusedError(
      `${side}.belief_revision_event_id belongs to belief ${revision[0]}, not to ${beliefId}`,
    );
  }
}

/**
 * `conflict.classified` (M27.3) — what the gauntlet concluded.
 *
 * One classification per comparison, and a second refuses: the version matrix
 * assumes it, and `edge_id` carries the kind, so a reclassification would mint
 * a SECOND edge over one pair rather than amend the first.
 */
function applyConflictClassified(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
): void {
  const comparisonId = body.comparison_id as string;
  const comparison = state.comparisons.get(comparisonId);
  if (comparison === undefined) {
    throw new RefusedError(
      `comparison ${comparisonId} was never detected or registered — a classification of a pair ` +
        'nobody put forward is a verdict with no case',
    );
  }
  const existing = state.conflictClassifications.get(comparisonId);
  if (existing !== undefined) {
    throw new RefusedError(
      `comparison ${comparisonId} was already classified ${existing.outcome} by event ` +
        `${existing.eventId} — one classification per comparison, because the edge id carries ` +
        'the kind and a second verdict would open a second edge rather than amend the first',
    );
  }
  if (!sameEndpoints(body, comparison)) {
    throw new RefusedError(
      `the classification's endpoints are not the tuple comparison ${comparisonId} was minted ` +
        'from — side for side, because both bodies order left as the canonically-first endpoint',
    );
  }
  const classification = body.classification as JsonObject;
  if (classification.kind === 'agent_supplied') {
    const proposalId = classification.proposal_id as string;
    const proposal = state.proposals.get(proposalId);
    if (proposal === undefined) {
      throw new RefusedError(
        `agent_supplied classification names proposal ${proposalId}, which is not committed — a ` +
          'semantic verdict claims to have been reviewed, and this claims it about nothing',
      );
    }
    // Checked for what it ASKED, not for `state === applied`: the applying
    // events fold after their mutations in the same batch.
    const op = (proposal.proposal as JsonObject).op as JsonObject;
    if (op.kind !== 'classify_conflict') {
      throw new RefusedError(
        `proposal ${proposalId} is a ${String(op.kind)} — a classification arrives through ` +
          'classify_conflict, which is the op the policy table maps to review',
      );
    }
    // `ProposalOp` is `{ kind, payload }` — the fields are one level down, and
    // reading them off `op` would make every check below compare against
    // `undefined` and refuse a verdict that is perfectly good.
    const asked = (op.payload ?? {}) as JsonObject;
    if (
      asked.model_id !== classification.model_id ||
      asked.prompt_version !== classification.prompt_version
    ) {
      throw new RefusedError(
        `proposal ${proposalId} was made by ${String(asked.model_id)}/` +
          `${String(asked.prompt_version)}, and this event credits ` +
          `${String(classification.model_id)}/${String(classification.prompt_version)} — an ` +
          'agent_supplied verdict IS its attribution',
      );
    }
    if (asked.comparison_id !== comparisonId) {
      throw new RefusedError(
        `proposal ${proposalId} classifies comparison ${String(asked.comparison_id)}, and this ` +
          `event reports it against ${comparisonId}`,
      );
    }
    if (asked.outcome !== body.outcome) {
      throw new RefusedError(
        `proposal ${proposalId} asked for ${String(asked.outcome)}, and this event records ` +
          `${String(body.outcome)} — the review answered a different question`,
      );
    }
  }
  for (const id of body.evidence_event_ids as string[]) {
    if (!state.observations.has(id)) {
      throw new RefusedError(
        `evidence_event_ids names ${id}, which is no Observation — a classification's evidence ` +
          'is what somebody OBSERVED, never another verdict',
      );
    }
  }

  state.conflictClassifications.set(comparisonId, {
    comparisonId,
    eventId: frame.event_id,
    outcome: body.outcome as string,
    classification,
    reasonCodes: body.reason_codes as string[],
    evidenceEventIds: body.evidence_event_ids as string[],
  });
  // The comparison advances once. Endpoint Beliefs and evidence Observations
  // are READ — an unresolved verdict advances the Beliefs through its
  // same-batch open, and a resolved one advances nothing.
  bumpVersion(state, 'comparison', comparisonId, frame.event_id);
}

/** The edge a classification opens, or null for the five that resolve. */
const EDGE_KIND_OF: { [outcome: string]: string } = {
  genuine_direct: 'genuine_direct',
  partial: 'partial',
  conditional: 'conditional',
};

function sameEndpoints(body: JsonObject, comparison: ComparisonRow): boolean {
  return (
    canonicalJson(body.left as Json) === canonicalJson(comparison.left as Json) &&
    canonicalJson(body.right as Json) === canonicalJson(comparison.right as Json)
  );
}

/**
 * `contradiction.opened` (M27.3) — the protected edge. Its classification is
 * normally a member of the SAME batch, folded one position earlier, so this
 * looks it up in state and does not refuse a staged reference.
 */
function applyContradictionOpened(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
): void {
  const edgeId = body.edge_id as string;
  const existingEdge = state.contradictionEdges.get(edgeId);
  if (existingEdge !== undefined) {
    throw new RefusedError(
      `edge ${edgeId} was already opened by event ${existingEdge.openedEventId} — exact replay ` +
        'is deduplicated at the door, so a second event reaching the reducer is a duplicate append',
    );
  }
  const comparisonId = body.comparison_id as string;
  const comparison = state.comparisons.get(comparisonId);
  if (comparison === undefined) {
    throw new RefusedError(`comparison ${comparisonId} was never detected or registered`);
  }
  if (!sameEndpoints(body, comparison)) {
    throw new RefusedError(
      `the edge's endpoints are not the tuple comparison ${comparisonId} was minted from`,
    );
  }
  const classification = state.conflictClassifications.get(comparisonId);
  if (classification === undefined) {
    throw new RefusedError(
      `comparison ${comparisonId} has no classification — an edge is what an UNRESOLVED verdict ` +
        'leaves behind, and there is no verdict here to leave one',
    );
  }
  if (classification.eventId !== body.classified_event_id) {
    throw new RefusedError(
      `classified_event_id ${String(body.classified_event_id)} is not the classification of ` +
        `comparison ${comparisonId} (that is event ${classification.eventId})`,
    );
  }
  const expected = EDGE_KIND_OF[classification.outcome];
  if (expected === undefined) {
    throw new RefusedError(
      `comparison ${comparisonId} classified ${classification.outcome}, which RESOLVED the pair ` +
        'apart — opening an edge over it is the crying-wolf failure this whole pipeline exists ' +
        'to prevent',
    );
  }
  if (expected !== body.kind) {
    throw new RefusedError(
      `comparison ${comparisonId} classified ${classification.outcome}, which opens a ` +
        `${expected} edge, and this opens a ${String(body.kind)} — the kind is in the edge id, ` +
        'so these are two different edges',
    );
  }

  const leftBeliefId = (comparison.left as JsonObject).belief_id as string;
  const rightBeliefId = (comparison.right as JsonObject).belief_id as string;
  state.contradictionEdges.set(edgeId, {
    edgeId,
    comparisonId,
    kind: body.kind as string,
    leftBeliefId,
    rightBeliefId,
    openedEventId: frame.event_id,
    classifiedEventId: body.classified_event_id as string,
    closed: null,
  });
  bumpVersion(state, 'comparison', comparisonId, frame.event_id);
  for (const beliefId of distinctEndpoints(leftBeliefId, rightBeliefId)) {
    bumpVersion(state, 'belief', beliefId, frame.event_id);
  }
}

/**
 * The endpoint Beliefs an open or close advances — "each DISTINCT endpoint
 * Belief once". One comparison can hold two assertions the SAME Belief
 * revision rests on, and double-bumping it would make every proposal against
 * that Belief fail its CAS for a reason nobody could reconstruct.
 */
function distinctEndpoints(left: string, right: string): string[] {
  return left === right ? [left] : [left, right];
}

/**
 * `contradiction.closed` (M27.3) — and there is no caller-authored path to it.
 *
 * The close travels in the same logical batch as the mutation that addressed
 * the edge, carrying that mutation's server-preallocated event id. Requiring
 * that id to be a member of THIS batch is the reducer half of "no standalone
 * close path exists".
 */
function applyContradictionClosed(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const edgeId = body.edge_id as string;
  const edge = state.contradictionEdges.get(edgeId);
  if (edge === undefined) {
    throw new RefusedError(`edge ${edgeId} was never opened — a close of nothing`);
  }
  if (edge.closed !== null) {
    throw new RefusedError(
      `edge ${edgeId} was already closed by event ${edge.closed.eventId} — a closed edge never ` +
        'reopens, and a second close would be a second answer to a question that has one',
    );
  }
  if (edge.comparisonId !== body.comparison_id) {
    throw new RefusedError(
      `edge ${edgeId} belongs to comparison ${edge.comparisonId}, and this close names ` +
        String(body.comparison_id),
    );
  }
  if (edge.leftBeliefId !== body.left_belief_id || edge.rightBeliefId !== body.right_belief_id) {
    throw new RefusedError(
      `the close's endpoint Beliefs are not edge ${edgeId}'s, side for side — the close copies ` +
        'the edge, it does not re-describe it',
    );
  }
  const addressedBy = body.addressed_by_event_id as string;
  if (addressedBy === frame.event_id) {
    throw new RefusedError(
      'addressed_by_event_id is this close’s own event — a close cannot be what addressed ' +
        'the contradiction',
    );
  }
  if (!staged.has(addressedBy)) {
    throw new RefusedError(
      `addressed_by_event_id ${addressedBy} is not a member of this batch — a close travels ` +
        'with the mutation that addressed the edge, and there is no standalone close path',
    );
  }
  for (const id of body.evidence_event_ids as string[]) {
    if (!state.observations.has(id)) {
      throw new RefusedError(
        `evidence_event_ids names ${id}, which is no Observation — silence and elapsed time ` +
          'cannot close an edge, and neither can a reference to nothing',
      );
    }
  }

  edge.closed = {
    eventId: frame.event_id,
    addressedByEventId: addressedBy,
    disposition: body.disposition as string,
    evidenceEventIds: body.evidence_event_ids as string[],
  };
  bumpVersion(state, 'comparison', edge.comparisonId, frame.event_id);
  for (const beliefId of distinctEndpoints(edge.leftBeliefId, edge.rightBeliefId)) {
    bumpVersion(state, 'belief', beliefId, frame.event_id);
  }
}

/**
 * `contradiction.backfill_completed` (M27.3) — the checkpoint activation is
 * gated on. Neither check is about ordering: `through_event_id` is an event
 * id and this reducer holds no id→position index. What it can prove is that
 * the same coverage is not claimed twice, and that a later checkpoint never
 * claims to have seen FEWER relations than an earlier one.
 */
function applyBackfillCompleted(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const through = body.through_event_id as string;
  if (staged.has(through)) {
    throw new RefusedError(
      `through_event_id ${through} is a member of this batch — a checkpoint claims coverage of ` +
        'what the store already holds, not of what it is still writing',
    );
  }
  const seen = body.source_relation_count as number;
  const previous = state.contradictionBackfill;
  if (previous !== null) {
    if (previous.throughEventId === through) {
      throw new RefusedError(
        `a checkpoint through ${through} is already recorded (event ${previous.eventId}) — the ` +
          'same coverage claimed twice',
      );
    }
    // A SHRINKING count is not a run that lost its place, and M27.5a removed
    // the refusal that said it was: the count is of relations still LIVE, and
    // withdrawing a `contradicts` is ordinary — the old rule wedged the
    // checkpoint permanently on the first withdrawal.
  }
  state.contradictionBackfill = {
    eventId: frame.event_id,
    throughEventId: through,
    sourceRelationCount: seen,
    resolvedCount: body.resolved_count as number,
    openedCount: body.opened_count as number,
    ruleVersion: body.rule_version as string,
  };
  // No registered-target effect: a marker is a fact about the backfill.
}

/** The three references one endpoint has to earn. */
function anchorConflictEndpoint(
  state: EpistemicState,
  staged: Set<string>,
  side: string,
  endpoint: JsonObject,
): void {
  const assertionId = endpoint.assertion_event_id as string;
  const beliefId = endpoint.belief_id as string;
  const revisionId = endpoint.belief_revision_event_id as string;
  for (const [name, id] of [
    ['assertion_event_id', assertionId],
    ['belief_revision_event_id', revisionId],
  ] as [string, string][]) {
    if (staged.has(id)) {
      throw new RefusedError(
        `${side}.${name} pins a STAGED event — a comparison is about what the store already ` +
          'holds, not about what this batch is still trying to write',
      );
    }
  }
  if (!state.observations.has(assertionId)) {
    throw new RefusedError(
      `${side}.assertion_event_id ${assertionId} names no committed observation`,
    );
  }
  const belief = state.beliefs.get(beliefId);
  if (belief === undefined) {
    throw new RefusedError(`${side}.belief_id ${beliefId} does not exist`);
  }
  if (belief.entityId !== endpoint.subject_id) {
    throw new RefusedError(
      `${side}.subject_id ${String(endpoint.subject_id)} is not the entity belief ${beliefId} ` +
        `is about (${belief.entityId})`,
    );
  }
  const indexed = state.beliefRevisionEvents.get(revisionId);
  if (indexed === undefined) {
    throw new RefusedError(
      `${side}.belief_revision_event_id ${revisionId} names no committed revision`,
    );
  }
  if (indexed[0] !== beliefId) {
    throw new RefusedError(
      `${side}.belief_revision_event_id belongs to belief ${indexed[0]}, not to ${beliefId}`,
    );
  }
  const revision = belief.revisions.find((r) => r.eventId === revisionId);
  if (revision === undefined) {
    throw new RefusedError(
      `${side}.belief_revision_event_id is indexed but absent from belief ${beliefId}`,
    );
  }
  // Any basis ROLE counts: a revision that recorded an assertion as `opposes`
  // weighed it too, and a pair where one side already logged the other as
  // counterevidence is the most worth classifying, not the least.
  const links = (revision.basis.links ?? []) as JsonObject[];
  const used = links.some((link) => link.observation_event_id === assertionId);
  if (!used) {
    throw new RefusedError(
      `${side} pins assertion ${assertionId} to a revision whose basis never named it — an ` +
        'endpoint is a claim that this Belief rested on this evidence, and a comparison built ' +
        'from one that did not is a disagreement between two things that never met',
    );
  }
}

// --- M25.4 coverage ---------------------------------------------------------

const COVERAGE_DIMENSION_ORDER = [
  'source_connected',
  'source_healthy',
  'scope_known',
  'scope_accessible',
  'retention_known',
  'index_current',
  'retrieval_attempted',
];

function applyCoverageFact(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const factId = body.fact_id as string;
  if (state.coverageFacts.has(factId)) {
    throw new RefusedError(
      `coverage fact ${factId} is already recorded — one fact per id, append once`,
    );
  }
  const sourceId = body.source_id as string;
  const source = state.sources.get(sourceId);
  if (source === undefined) {
    throw new RefusedError(
      `coverage fact names source ${sourceId} which has no committed registration`,
    );
  }
  if (source.registrationEventId !== body.source_registration_event_id) {
    throw new RefusedError(
      `coverage fact pins registration ${body.source_registration_event_id} and source ${sourceId} was registered by ${source.registrationEventId}`,
    );
  }
  const subject = body.subject as JsonObject;
  const entityId = subject.entity_id as string | null;
  if (entityId !== null && !state.entities.has(entityId)) {
    throw new RefusedError(
      `coverage fact names entity ${entityId}, which this store does not know`,
    );
  }
  state.coverageFacts.set(factId, {
    factId,
    sourceId,
    subjectId: entityId,
    predicateClass: subject.predicate_class as string | null,
    dimension: body.dimension as string,
    state: body.state as string,
    asOf: body.as_of as string,
  });
  createVersion(state, 'coverage_fact', factId, frame.event_id);
  bumpVersion(state, 'source', sourceId, frame.event_id);
}

function applyCoverageAssessed(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const assessmentId = body.assessment_id as string;
  if (state.coverageAssessments.has(assessmentId)) {
    throw new RefusedError(`assessment ${assessmentId} is already recorded — append once`);
  }
  const sourceId = body.source_id as string;
  if (!state.sources.has(sourceId)) {
    throw new RefusedError(
      `assessment names source ${sourceId} which has no committed registration`,
    );
  }
  const subject = body.subject as JsonObject;
  const entityId = subject.entity_id as string | null;
  const predicateClass = subject.predicate_class as string | null;
  if (entityId !== null && !state.entities.has(entityId)) {
    throw new RefusedError(`assessment names entity ${entityId}, which this store does not know`);
  }
  const dimensions = body.dimensions as JsonObject;
  for (const name of COVERAGE_DIMENSION_ORDER) {
    const d = dimensions[name] as JsonObject;
    for (const factId of d.basis_event_ids as string[]) {
      if (staged.has(factId)) {
        throw new RefusedError(
          `${name}: basis ${factId} is a member of this batch — a basis is committed history, not a promise made alongside the claim`,
        );
      }
      const fact = state.coverageFacts.get(factId);
      if (fact === undefined) {
        throw new RefusedError(`${name}: basis ${factId} is not a committed coverage fact`);
      }
      if (fact.dimension !== name) {
        throw new RefusedError(
          `${name}: basis ${factId} establishes ${fact.dimension}, not this dimension`,
        );
      }
      if (fact.state !== d.state) {
        throw new RefusedError(
          `${name}: basis ${factId} says ${fact.state}, and the assessment says ${d.state}`,
        );
      }
      if (fact.sourceId !== sourceId) {
        throw new RefusedError(`${name}: basis ${factId} is about a different source`);
      }
      if (fact.subjectId !== entityId || fact.predicateClass !== predicateClass) {
        throw new RefusedError(`${name}: basis ${factId} is about a different subject`);
      }
    }
    const basis = d.basis_event_ids as string[];
    if (basis.length > 0) {
      const newest = basis
        .map((id) => state.coverageFacts.get(id)?.asOf ?? '')
        .reduce((a, b) => (a > b ? a : b), '');
      if (d.as_of !== newest) {
        throw new RefusedError(
          `${name}: as_of is ${d.as_of} and its newest basis fact is ${newest}`,
        );
      }
    }
  }
  const supersedes = body.supersedes_assessment_id as string | null;
  if (supersedes !== null) {
    const prior = state.coverageAssessments.get(supersedes);
    if (prior === undefined) {
      throw new RefusedError(
        `assessment supersedes ${supersedes}, which is not a committed assessment`,
      );
    }
    if (prior.superseded) {
      throw new RefusedError(`assessment ${supersedes} is already superseded`);
    }
    if (
      prior.sourceId !== sourceId ||
      prior.subjectId !== entityId ||
      prior.predicateClass !== predicateClass
    ) {
      throw new RefusedError('an assessment supersedes one about the same source and subject');
    }
    prior.superseded = true;
    bumpVersion(state, 'coverage_assessment', supersedes, frame.event_id);
  }
  state.coverageAssessments.set(assessmentId, {
    assessmentId,
    sourceId,
    subjectId: entityId,
    predicateClass,
    dimensions,
    hasRetrievalReceipt: body.retrieval_receipt !== null,
    superseded: false,
  });
  createVersion(state, 'coverage_assessment', assessmentId, frame.event_id);
}

function applyCoverageGap(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const gapId = body.gap_id as string;
  if (state.coverageGaps.has(gapId)) {
    throw new RefusedError(
      `gap ${gapId} is already open — append once, so a retry cannot duplicate an episode`,
    );
  }
  const sourceId = body.source_id as string | null;
  if (sourceId !== null && !state.sources.has(sourceId)) {
    throw new RefusedError(`gap names source ${sourceId} which has no committed registration`);
  }
  const assessmentId = body.assessment_id as string | null;
  if (assessmentId !== null) {
    if (staged.has(assessmentId)) {
      throw new RefusedError('a gap cites a COMMITTED assessment, not one staged beside it');
    }
    const assessment = state.coverageAssessments.get(assessmentId);
    if (assessment === undefined) {
      throw new RefusedError(`gap cites assessment ${assessmentId}, which is not committed`);
    }
    if (assessment.superseded) {
      throw new RefusedError(`gap cites assessment ${assessmentId}, which a later one replaced`);
    }
    if (sourceId !== assessment.sourceId) {
      throw new RefusedError('a gap and the assessment it cites are about the same source');
    }
  }
  const cause = body.cause as JsonObject;
  state.coverageGaps.set(gapId, {
    gapId,
    cause: cause.kind as string,
    component: cause.component as string | null,
    sourceId,
    remaining: [...(body.affected_dimensions as string[])],
    closed: false,
  });
  createVersion(state, 'coverage_gap', gapId, frame.event_id);
}

function applyCoverageRestored(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  const gapId = body.gap_id as string;
  const gap = state.coverageGaps.get(gapId);
  if (gap === undefined) {
    throw new RefusedError(`restoration names gap ${gapId}, which was never opened`);
  }
  if (gap.closed) {
    throw new RefusedError(
      `gap ${gapId} is already closed — a closed episode cannot be closed twice`,
    );
  }
  const dimensions = body.restored_dimensions as string[];
  for (const dimension of dimensions) {
    if (!gap.remaining.includes(dimension)) {
      throw new RefusedError(
        `restoration names ${dimension}, which this gap does not still affect`,
      );
    }
  }
  const assessmentId = body.assessment_id as string | null;
  if (gap.cause === 'source') {
    if (assessmentId === null) {
      throw new RefusedError('a source gap is restored by a newer assessment, not by an assertion');
    }
    if (staged.has(assessmentId)) {
      throw new RefusedError('a restoration cites a COMMITTED assessment');
    }
    const assessment = state.coverageAssessments.get(assessmentId);
    if (assessment === undefined) {
      throw new RefusedError(
        `restoration cites assessment ${assessmentId}, which is not committed`,
      );
    }
    for (const dimension of dimensions) {
      const state_ = (assessment.dimensions[dimension] as JsonObject).state as string;
      if (state_ !== 'yes') {
        throw new RefusedError(
          `restoration claims ${dimension} recovered and the cited assessment says ${state_}`,
        );
      }
    }
  }
  gap.remaining = gap.remaining.filter((d) => !dimensions.includes(d));
  gap.closed = gap.remaining.length === 0;
  bumpVersion(state, 'coverage_gap', gapId, frame.event_id);
}

// --- M24 governed mutations -------------------------------------------------

/**
 * A Belief that can still be governed. Tombstoned is TERMINAL: nothing
 * mutates it afterwards, which is what "non-reversible" means here rather
 * than a convention the ops are trusted to observe.
 */
function liveBelief(state: EpistemicState, beliefId: string): BeliefState {
  const belief = state.beliefs.get(beliefId);
  if (!belief) throw new RefusedError('belief does not exist');
  if (belief.tombstonedBy !== null) {
    throw new RefusedError('belief is tombstoned — a tombstone is terminal');
  }
  return belief;
}

function applyQualification(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const belief = liveBelief(state, body.belief_id as string);
  // The event declares where it came FROM; if state disagrees, the proposal
  // was computed against a snapshot that has since moved.
  if (belief.qualification !== body.from) {
    throw new RefusedError('illegal_transition: qualification source does not match state');
  }
  belief.qualification = body.to as string;
  belief.qualificationHeadEvent = frame.event_id;
  belief.projectionHeadEvent = frame.event_id;
  bumpVersion(state, 'belief', belief.beliefId, frame.event_id);
}

function applyLifecycle(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const replacement = body.replacement_id as string | null;
  if (replacement !== null && !state.beliefs.has(replacement)) {
    throw new RefusedError('replacement belief does not exist');
  }
  const belief = liveBelief(state, body.belief_id as string);
  if (belief.lifecycle !== body.from) {
    throw new RefusedError('illegal_transition: lifecycle source does not match state');
  }
  belief.lifecycle = body.to as string;
  belief.lifecycleHeadEvent = frame.event_id;
  belief.projectionHeadEvent = frame.event_id;
  bumpVersion(state, 'belief', belief.beliefId, frame.event_id);
}

function applyTombstone(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const replacement = body.replacement_id as string | null;
  if (replacement !== null && !state.beliefs.has(replacement)) {
    throw new RefusedError('replacement belief does not exist');
  }
  const belief = liveBelief(state, body.belief_id as string);
  belief.tombstonedBy = frame.event_id;
  belief.projectionHeadEvent = frame.event_id;
  bumpVersion(state, 'belief', belief.beliefId, frame.event_id);
}

function applyContest(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
  staged: Set<string>,
): void {
  for (const ref of body.counterevidence_refs as string[]) {
    // Counterevidence must be COMMITTED: same-batch evidence would let one
    // batch both invent the objection and rest on it.
    if (staged.has(ref) || !state.observations.has(ref)) {
      throw new RefusedError('counterevidence is not a committed Observation');
    }
  }
  const belief = liveBelief(state, body.belief_id as string);
  if (body.action === 'open') {
    if (belief.openContestEvent !== null) {
      throw new RefusedError('belief already has an open contest');
    }
    belief.openContestEvent = frame.event_id;
  } else {
    // At most one contest is ever open, so "which one does this close?" has
    // exactly one answer and needs no second pointer.
    if (belief.openContestEvent === null) {
      throw new RefusedError('belief has no open contest to close');
    }
    if (body.addressed_by_event_id === belief.openContestEvent) {
      throw new RefusedError('a contest cannot be addressed by its own opening event');
    }
    belief.openContestEvent = null;
  }
  belief.contestHeadEvent = frame.event_id;
  belief.projectionHeadEvent = frame.event_id;
  bumpVersion(state, 'belief', belief.beliefId, frame.event_id);
}

function applyEntityMerge(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const plan = body.reassignment_plan as JsonObject;
  const survivor = plan.survivor_id as string;
  const mergedIds = plan.merged_ids as string[];
  if (!state.entities.has(survivor)) throw new RefusedError('survivor entity does not exist');
  for (const merged of mergedIds) {
    if (!state.entities.has(merged)) throw new RefusedError('merged entity does not exist');
  }
  // The plan must enumerate EXACTLY the beliefs that point at a merged
  // entity: an omission leaves a dangling identity, an extra reassigns
  // something the proposal never named, and the CAS target set is derived
  // from this list so both are silent otherwise.
  const expected = [...state.beliefs.values()]
    .filter((b) => mergedIds.includes(b.entityId))
    .map((b) => b.beliefId)
    .sort();
  const declared = plan.affected_belief_ids as string[];
  if (expected.join('|') !== declared.join('|')) {
    throw new RefusedError('reassignment plan does not match state');
  }
  const relationIds = plan.affected_relation_ids as string[];
  for (const relationId of relationIds) {
    if (!state.relations.has(relationId)) throw new RefusedError('relation does not exist');
  }
  const aliases = plan.live_aliases as JsonObject[];
  for (const alias of aliases) {
    const registered = state.aliasRegistry.get(alias.normalized_alias as string);
    if (!registered) throw new RefusedError('alias is not registered');
    if (registered.entityId !== alias.from_entity_id) {
      throw new RefusedError('alias is bound to a different entity');
    }
  }

  // One event, every reassignment.
  for (const alias of aliases) {
    const registered = state.aliasRegistry.get(alias.normalized_alias as string);
    if (registered) registered.entityId = survivor;
  }
  for (const beliefId of declared) {
    const belief = state.beliefs.get(beliefId);
    if (belief) {
      belief.entityId = survivor;
      belief.entityMergeEventIds.push(frame.event_id);
      belief.projectionHeadEvent = frame.event_id;
    }
    bumpVersion(state, 'belief', beliefId, frame.event_id);
  }
  for (const relationId of relationIds) {
    bumpVersion(state, 'relation', relationId, frame.event_id);
  }
  for (const merged of mergedIds) {
    state.entities.delete(merged);
    bumpVersion(state, 'entity', merged, frame.event_id);
  }
  bumpVersion(state, 'entity', survivor, frame.event_id);
}

// --- The proposal lifecycle -------------------------------------------------

const TERMINAL_PROPOSAL_STATES = ['rejected', 'applied', 'reverted'];

/**
 * Terminal means terminal. A second terminal event for one proposal is a
 * refusal, not a state change — otherwise an applied proposal could be
 * "rejected" afterwards and the durable record would contradict itself.
 */
function requireNonTerminal(state: EpistemicState, proposalId: string): ProposalRow {
  const row = state.proposals.get(proposalId);
  if (!row) throw new RefusedError('proposal was never submitted');
  if (TERMINAL_PROPOSAL_STATES.includes(row.state)) {
    throw new RefusedError('terminal states cannot be left');
  }
  return row;
}

function applyProposalSubmitted(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const proposal = body.proposal as JsonObject;
  const id = proposal.proposal_id as string;
  if (state.proposals.has(id)) throw new RefusedError('proposal is already submitted');
  state.proposals.set(id, {
    proposalId: id,
    proposal: proposal as Json,
    actor: ((body.actor as JsonObject).id as string) ?? '',
    state: 'submitted',
    commitSetId: null,
    queuedMembers: [],
    queuedRisk: null,
    queuedFor: [],
    decision: null,
    appliedEventId: null,
    revertPlan: null,
    submittedEventId: frame.event_id,
    submittedAt: frame.ingested_at,
  });
  createVersion(state, 'proposal', id, frame.event_id);
}

function applyProposalQueued(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const row = requireNonTerminal(state, body.proposal_id as string);
  for (const member of body.member_proposal_ids as string[]) {
    if (!state.proposals.has(member)) {
      throw new RefusedError('commit set member was never submitted');
    }
  }
  row.state = 'queued';
  row.commitSetId = body.commit_set_id as string;
  row.queuedMembers = [...(body.member_proposal_ids as string[])];
  row.queuedRisk = body.effective_risk as string;
  row.queuedFor = (body.queued_for as string[]) ?? [];
  bumpVersion(state, 'proposal', row.proposalId, frame.event_id);
}

function applyProposalDecision(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const row = state.proposals.get(body.proposal_id as string);
  if (!row) throw new RefusedError('proposal was never submitted');
  // A decision is only meaningful on something actually awaiting one.
  if (row.state !== 'queued') throw new RefusedError('proposal is not queued');
  if (row.decision !== null) throw new RefusedError('proposal already carries a decision');
  row.decision = [body.decision_id as string, body.decision as string];
  bumpVersion(state, 'proposal', row.proposalId, frame.event_id);
}

function applyProposalApplied(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const row = requireNonTerminal(state, body.proposal_id as string);
  const decisionId = body.decision_id as string | null;
  if (decisionId !== null) {
    if (row.decision === null || row.decision[0] !== decisionId) {
      throw new RefusedError('applied names a decision that is not its recorded one');
    }
    if (row.decision[1] === 'reject') {
      throw new RefusedError('a rejected proposal cannot cite that decision to apply');
    }
  }
  row.state = 'applied';
  row.appliedEventId = frame.event_id;
  row.revertPlan = (body.revert_plan ?? null) as Json | null;
  if (row.commitSetId === null) row.commitSetId = body.commit_set_id as string;
  bumpVersion(state, 'proposal', row.proposalId, frame.event_id);
}

function applyProposalRejected(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const row = requireNonTerminal(state, body.proposal_id as string);
  const peer = body.refused_by_proposal_id as string | null;
  if (peer !== null && !state.proposals.has(peer)) {
    throw new RefusedError('refused_by proposal was never submitted');
  }
  row.state = 'rejected';
  bumpVersion(state, 'proposal', row.proposalId, frame.event_id);
}

function applyProposalReverted(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const row = state.proposals.get(body.proposal_id as string);
  if (!row) throw new RefusedError('proposal was never submitted');
  // Only an APPLIED proposal can be reverted, and the reverting proposal
  // must itself exist — a reversion pointing at nothing is unauditable.
  if (row.state !== 'applied') throw new RefusedError('only an applied proposal can be reverted');
  if (!state.proposals.has(body.reverted_by_proposal_id as string)) {
    throw new RefusedError('reverting proposal was never submitted');
  }
  row.state = 'reverted';
  bumpVersion(state, 'proposal', row.proposalId, frame.event_id);
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
  if (proof.kind === 'human_confirmed') {
    // M27.2c. Checked for its APPROVAL, not for `state === 'applied'`:
    // mutation members fold BEFORE `proposal.applied` in the same batch, so
    // demanding the applied state would refuse the very batch that applies
    // it. The approval is what the proof claims — a human confirmed this pair
    // — and it is already committed by the time this folds.
    const proposalId = proof.proposal_id as string;
    const proposal = state.proposals.get(proposalId);
    if (proposal === undefined) {
      throw new RefusedError(
        `human_confirmed independence names proposal ${proposalId}, which is not committed`,
      );
    }
    if (proposal.decision === null) {
      throw new RefusedError(
        `human_confirmed independence names proposal ${proposalId}, which nobody has decided ` +
          '— silence is not confirmation',
      );
    }
    const [decisionEvent, decision] = proposal.decision;
    if (decision !== 'approve' || decisionEvent !== proof.decision_event_id) {
      throw new RefusedError(
        `human_confirmed independence pins decision ${String(proof.decision_event_id)}, and ` +
          `proposal ${proposalId} was decided ${decision} at ${decisionEvent} — a proof that a ` +
          'human confirmed this pair has to name the approval that did',
      );
    }
    if (proposal.queuedRisk === null) {
      throw new RefusedError(
        `proposal ${proposalId} was never put to a person — an auto-applied confirmation ` +
          'confirms nothing',
      );
    }
    proofKind = 'human_confirmed';
  } else if (proof.kind === 'distinct_firsthand_origin') {
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
  // The projection-path claim: the first `.md` subject alias names the
  // knowledge-relative file this Belief projects to. One Belief per path.
  const path = (subject.aliases as string[]).find((a) => a.endsWith('.md')) ?? null;
  if (path !== null) {
    if (state.projectionPaths.has(path)) {
      throw new RefusedError(`projection path ${path} is already claimed`);
    }
    state.projectionPaths.set(path, beliefId);
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
    attestationEvents: [],
    path,
    overrides: [],
    overrideHeadEvent: null,
    projectionHeadEvent: frame.event_id,
    // A created Belief is active and draft: promotion's only legal source
    // is `draft`, supersede's only legal source is `active`.
    qualification: 'draft',
    lifecycle: 'active',
    tombstonedBy: null,
    openContestEvent: null,
    qualificationHeadEvent: null,
    lifecycleHeadEvent: null,
    contestHeadEvent: null,
    entityMergeEventIds: [],
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
  // A revision never silently clears a human overlay: it stays active and
  // is marked stale against its base revision.
  for (const override of belief.overrides) override.stale = true;
  belief.projectionHeadEvent = frame.event_id;
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
  // Both transitions move the FROM Belief's projection identity.
  const fromBelief = state.beliefs.get(body.from as string);
  if (fromBelief) fromBelief.projectionHeadEvent = frame.event_id;
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
  belief.attestationEvents.push(frame.event_id);
  belief.projectionHeadEvent = frame.event_id;
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
  // A live subject alias is descriptor state for every Belief about the
  // Entity: their projection identity advances even byte-identically.
  for (const belief of state.beliefs.values()) {
    if (belief.entityId === entityId) belief.projectionHeadEvent = frame.event_id;
  }
  bumpVersion(state, 'entity', entityId, frame.event_id);
}

// --- the M23 projection overlay + reconciliation fold ----------------------

const pointerTokens = (path: string): string[] =>
  path
    .slice('/fields/'.length)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));

/** Apply one overlay op WITHOUT preconditions — an op a later revision made
 * inapplicable is skipped deterministically, never an error. */
function applyOverlayOp(carrier: { content: string; fields: JsonObject }, op: JsonObject): void {
  const path = op.field_path as string;
  const after = op.after as JsonObject;
  if (path === '/body') {
    if (after.type === 'string') carrier.content = after.value as string;
    return;
  }
  try {
    setTypedAt(carrier.fields, pointerTokens(path), after);
  } catch (error) {
    if (!(error instanceof RefusedError)) throw error;
  }
}

/** The review-metadata overlay (M23.4): a PREDATING attestation renders
 * its notice instead of silently rendering stale review state. A current
 * attestation leaves the stored fields untouched. */
function applyReviewOverlay(state: EpistemicState, belief: BeliefState, fields: JsonObject): void {
  if (belief.attested === null) return;
  const pinned = belief.attested[1];
  const current = belief.revisions[belief.revisions.length - 1];
  if (pinned === current.eventId) return;
  const pinnedRevision = state.beliefRevisionEvents.get(pinned)?.[1] ?? 0;
  fields.verified = `verified at r${pinnedRevision}; current is r${current.revision} — attestation predates revision`;
}

/** Canonical projection state with the review overlay and the active
 * editorial overlay applied. */
function overlaid(
  state: EpistemicState,
  belief: BeliefState,
): { content: string; fields: JsonObject } {
  const current = belief.revisions[belief.revisions.length - 1];
  const carrier = { content: current.content, fields: structuredClone(current.fields) };
  applyReviewOverlay(state, belief, carrier.fields);
  for (const override of belief.overrides) {
    for (const op of override.patch) applyOverlayOp(carrier, op);
  }
  return carrier;
}

function projected(state: EpistemicState, belief: BeliefState): string {
  const carrier = overlaid(state, belief);
  return project(carrier.content, carrier.fields as Json);
}

/** The canonical projection-state descriptor — field order IS the digest
 * input; must serialize byte-identically to Rust's serde output. */
function descriptor(state: EpistemicState, belief: BeliefState): JsonObject {
  const relationHeads: JsonObject[] = [];
  for (const [, relation] of sorted([...state.relations.entries()])) {
    if (relation.from === belief.beliefId) {
      relationHeads.push({ relation_id: relation.relationId, event_id: relation.lastEventId });
    }
  }
  const aliasEvents: string[] = [];
  for (const [, alias] of sorted([...state.aliasRegistry.entries()])) {
    if (alias.entityId === belief.entityId) aliasEvents.push(alias.eventId);
  }
  return {
    belief_revision_event: belief.revisions[belief.revisions.length - 1].eventId,
    review_event_ids: [...belief.attestationEvents],
    relation_transition_heads: relationHeads,
    alias_event_ids: aliasEvents,
    active_override_event_ids: belief.overrides.map((o) => o.eventId),
    override_head_event_id: belief.overrideHeadEvent,
    // Format 2 (M24.3): the governed-state heads. They join the descriptor
    // before any M24 mutation body can emit, so a projection's identity
    // always accounts for every transition that could change what it
    // renders — and the digest moves even when the bytes do not.
    qualification_head_event_id: belief.qualificationHeadEvent,
    lifecycle_head_event_id: belief.lifecycleHeadEvent,
    tombstone_event_id: belief.tombstonedBy,
    contest_head_event_id: belief.contestHeadEvent,
    entity_merge_event_ids: [...belief.entityMergeEventIds],
  };
}

function applyOverride(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const belief = state.beliefs.get(body.belief_id as string);
  if (!belief) throw new RefusedError('belief does not exist');
  if (belief.path === null) {
    throw new RefusedError('the Belief is not a projection — it claimed no path');
  }
  if (belief.path !== body.path) {
    throw new RefusedError('override path does not match the projection path');
  }
  const current = belief.revisions[belief.revisions.length - 1];
  if (
    body.base_belief_revision !== current.revision ||
    body.base_belief_revision_event !== current.eventId
  ) {
    throw new RefusedError('override base is not the current revision — wrong base');
  }
  if (body.base_generating_event !== belief.projectionHeadEvent) {
    throw new RefusedError('override base generating event is not the projection head');
  }
  if (sha256Hex(projected(state, belief)) !== body.before_projection_hash) {
    throw new RefusedError('before_projection_hash does not match the current projection');
  }

  const change = body.change as JsonObject;
  let next: OverrideState[];
  if (change.action === 'set') {
    const supersedes = change.supersedes_override_event_ids as string[];
    for (const id of supersedes) {
      if (!belief.overrides.some((o) => o.eventId === id)) {
        throw new RefusedError('supersedes names a non-active override');
      }
    }
    const carrier = overlaid(state, belief);
    for (const op of change.patch as JsonObject[]) {
      const path = op.field_path as string;
      const currentValue =
        path === '/body'
          ? typedString(carrier.content)
          : typedAt(carrier.fields, pointerTokens(path));
      if (canonicalJson(op.before as Json) !== canonicalJson(currentValue)) {
        throw new RefusedError('override before-value does not match the projected state');
      }
      if (path === '/body' && (op.after as JsonObject).type !== 'string') {
        throw new RefusedError('the body override must stay a string');
      }
    }
    next = belief.overrides.filter((o) => !supersedes.includes(o.eventId));
    next.push({
      eventId: frame.event_id,
      baseBeliefRevision: current.revision,
      patch: change.patch as JsonObject[],
      stale: false,
    });
  } else {
    const cleared = change.override_event_ids as string[];
    for (const id of cleared) {
      if (!belief.overrides.some((o) => o.eventId === id)) {
        throw new RefusedError('clear names a non-active override');
      }
    }
    next = belief.overrides.filter((o) => !cleared.includes(o.eventId));
  }

  // The after-hash proof against the WOULD-BE overlay before any mutation.
  const carrier = { content: current.content, fields: structuredClone(current.fields) };
  for (const override of next) {
    for (const op of override.patch) applyOverlayOp(carrier, op);
  }
  if (sha256Hex(project(carrier.content, carrier.fields as Json)) !== body.after_projection_hash) {
    throw new RefusedError('after_projection_hash does not reproduce from the declared change');
  }

  belief.overrides = next;
  belief.overrideHeadEvent = frame.event_id;
  belief.projectionHeadEvent = frame.event_id;
  bumpVersion(state, 'belief', belief.beliefId, frame.event_id);
}

function applyDivergence(state: EpistemicState, frame: VectorFrame, body: JsonObject): void {
  const key = body.detection_key as string;
  if (state.reconciliationDivergences.has(key)) {
    throw new RefusedError('detection key is already open');
  }
  state.reconciliationDivergences.set(key, frame.event_id);
}

function applyReconciliationResolved(
  state: EpistemicState,
  frame: VectorFrame,
  body: JsonObject,
): void {
  const divergenceEvent = body.divergence_event_id as string;
  let active = false;
  for (const event of state.reconciliationDivergences.values()) {
    if (event === divergenceEvent) active = true;
  }
  if (!active) throw new RefusedError('divergence is not active — wrong or stale resolution');
  const entries: Json[] = [];
  for (const path of body.affected_paths as string[]) {
    const beliefId = state.projectionPaths.get(path);
    if (beliefId === undefined) {
      throw new RefusedError('affected path is not a known projection');
    }
    const belief = state.beliefs.get(beliefId) as BeliefState;
    entries.push({ path, content_hash: sha256Hex(projected(state, belief)) });
  }
  if (sha256Hex(canonicalJson(entries)) !== body.resulting_projection_digest) {
    throw new RefusedError('resulting_projection_digest does not match the reducer projections');
  }
  state.reconciliationDivergences.clear();
  state.reconciliationLog.push({
    eventId: frame.event_id,
    divergenceEventId: divergenceEvent,
    action: body.action as string,
  });
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

/**
 * One comparison endpoint, summarized for the vectors: the kind, then the
 * four ids it pins. The FIRST id differs by kind on purpose — an asserted
 * endpoint pins the assertion its claim came from, a declared one pins the
 * relation event somebody wrote, and a declared endpoint has no assertion at
 * all.
 */
function endpointSummary(endpoint: JsonObject): JsonObject {
  if (endpoint.kind === 'asserted') {
    return {
      kind: 'asserted',
      assertion_event_id: endpoint.assertion_event_id,
      belief_id: endpoint.belief_id,
      belief_revision_event_id: endpoint.belief_revision_event_id,
      subject_id: endpoint.subject_id,
    };
  }
  return {
    kind: 'declared_relation',
    relation_event_id: endpoint.relation_event_id,
    belief_id: endpoint.belief_id,
    belief_revision_event_id: endpoint.belief_revision_event_id,
    subject_id: endpoint.subject_id,
  };
}

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
      projection: {
        path: b.path,
        generating_event: b.projectionHeadEvent,
        state_digest: sha256Hex(canonicalJson(descriptor(state, b) as Json)),
        content_hash: sha256Hex(projected(state, b)),
        review_event_ids: [...b.attestationEvents],
        active_overrides: b.overrides.map((o) => o.eventId),
        stale_overrides: b.overrides.filter((o) => o.stale).map((o) => o.eventId),
        override_head: b.overrideHeadEvent,
        // Format 2 (M24.3): the governed-state heads.
        qualification_head: b.qualificationHeadEvent,
        lifecycle_head: b.lifecycleHeadEvent,
        tombstone_event: b.tombstonedBy,
        contest_head: b.contestHeadEvent,
        entity_merge_events: [...b.entityMergeEventIds],
      },
      governance: {
        qualification: b.qualification,
        lifecycle: b.lifecycle,
        tombstoned: b.tombstonedBy !== null,
        open_contest: b.openContestEvent,
      },
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
    proposals: (() => {
      const out: JsonObject = {};
      for (const [, p] of sorted([...state.proposals.entries()])) {
        out[p.proposalId] = {
          state: p.state,
          commit_set_id: p.commitSetId,
          decision: p.decision === null ? null : ([p.decision[0], p.decision[1]] as Json[]),
          applied_event_id: p.appliedEventId,
          has_revert_plan: p.revertPlan !== null && p.revertPlan !== undefined,
        };
      }
      return out;
    })(),
    coverage_facts: (() => {
      const out: JsonObject = {};
      for (const [, f] of sorted([...state.coverageFacts.entries()])) {
        out[f.factId] = {
          source_id: f.sourceId,
          subject_id: f.subjectId,
          predicate_class: f.predicateClass,
          dimension: f.dimension,
          state: f.state,
          as_of: f.asOf,
        };
      }
      return out;
    })(),
    coverage_assessments: (() => {
      const out: JsonObject = {};
      for (const [, a] of sorted([...state.coverageAssessments.entries()])) {
        const dimensions: JsonObject = {};
        // Sorted by NAME, matching Rust's BTreeMap serialization — the
        // declaration order is the schema's, and the vector's is alphabetical.
        for (const name of [...COVERAGE_DIMENSION_ORDER].sort()) {
          dimensions[name] = a.dimensions[name];
        }
        out[a.assessmentId] = {
          source_id: a.sourceId,
          subject_id: a.subjectId,
          predicate_class: a.predicateClass,
          dimensions,
          has_retrieval_receipt: a.hasRetrievalReceipt,
          superseded: a.superseded,
        };
      }
      return out;
    })(),
    coverage_gaps: (() => {
      const out: JsonObject = {};
      for (const [, g] of sorted([...state.coverageGaps.entries()])) {
        out[g.gapId] = {
          cause: g.cause,
          component: g.component,
          source_id: g.sourceId,
          remaining: [...g.remaining].sort(),
          closed: g.closed,
        };
      }
      return out;
    })(),
    ingest_receipts: (() => {
      const out: JsonObject = {};
      for (const [, r] of sorted([...state.ingestReceipts.entries()])) {
        out[r.receiptId] = {
          item_id: r.itemId,
          source_id: r.sourceId,
          artifact_hash: r.artifactHash,
          normalizer_version: r.normalizerVersion,
          processing_epoch: r.processingEpoch,
          route: r.route,
          superseded: r.superseded,
          m26_batch_key: r.m26BatchKey,
        };
      }
      return out;
    })(),
    semantic_assessments: (() => {
      const out: JsonObject = {};
      for (const [, a] of sorted([...state.semanticAssessments.entries()])) {
        out[a.semanticAssessmentId] = {
          m26_batch_key: a.m26BatchKey,
          input_receipt_ids: a.inputReceiptIds,
          outcome: a.outcome,
          proposal_ids: a.proposalIds,
        };
      }
      return out;
    })(),
    comparisons: (() => {
      const out: JsonObject = {};
      for (const [, c] of sorted([...state.comparisons.entries()])) {
        out[c.comparisonId] = {
          registered_by: c.eventId,
          origin:
            c.origin.kind === 'detected'
              ? {
                  kind: 'detected',
                  detector_version: c.origin.detectorVersion,
                  reason_codes: c.origin.reasonCodes,
                }
              : {
                  kind: 'declared',
                  source_relation_event_id: c.origin.sourceRelationEventId,
                  rule_version: c.origin.ruleVersion,
                },
          left: endpointSummary(c.left),
          right: endpointSummary(c.right),
        };
      }
      return out;
    })(),
    classifications: (() => {
      const out: JsonObject = {};
      for (const [, c] of sorted([...state.conflictClassifications.entries()])) {
        const classification = c.classification;
        out[c.comparisonId] = {
          classified_by: c.eventId,
          outcome: c.outcome,
          classification:
            classification.kind === 'deterministic'
              ? { kind: 'deterministic', rule_version: classification.rule_version }
              : {
                  kind: 'agent_supplied',
                  proposal_id: classification.proposal_id,
                  model_id: classification.model_id,
                  prompt_version: classification.prompt_version,
                },
          reason_codes: c.reasonCodes,
          evidence_event_ids: c.evidenceEventIds,
        };
      }
      return out;
    })(),
    contradiction_edges: (() => {
      const out: JsonObject = {};
      for (const [, e] of sorted([...state.contradictionEdges.entries()])) {
        out[e.edgeId] = {
          comparison_id: e.comparisonId,
          kind: e.kind,
          left_belief_id: e.leftBeliefId,
          right_belief_id: e.rightBeliefId,
          opened_by: e.openedEventId,
          classified_event_id: e.classifiedEventId,
          closed:
            e.closed === null
              ? null
              : {
                  closed_by: e.closed.eventId,
                  addressed_by_event_id: e.closed.addressedByEventId,
                  disposition: e.closed.disposition,
                  evidence_event_ids: e.closed.evidenceEventIds,
                },
        };
      }
      return out;
    })(),
    contradiction_backfill:
      state.contradictionBackfill === null
        ? null
        : {
            event_id: state.contradictionBackfill.eventId,
            through_event_id: state.contradictionBackfill.throughEventId,
            source_relation_count: state.contradictionBackfill.sourceRelationCount,
            resolved_count: state.contradictionBackfill.resolvedCount,
            opened_count: state.contradictionBackfill.openedCount,
            rule_version: state.contradictionBackfill.ruleVersion,
          },
    freshness: (() => {
      const out: JsonObject = {};
      for (const [, f] of sorted([...state.freshness.entries()])) {
        const predicate = f.facet.predicate as JsonObject;
        out[f.facetId] = {
          belief_id: f.facet.belief_id,
          belief_revision_event_id: f.facet.belief_revision_event_id,
          predicate: predicate.kind === 'known' ? (predicate.value as string) : null,
          state_stage: f.facet.state_stage,
          state: f.state,
          effective_at: f.effectiveAt,
          rule_version: f.ruleVersion,
          transitioned_by: f.eventId,
        };
      }
      return out;
    })(),
    reconciliation: {
      open: state.reconciliationDivergences.size > 0,
      divergences: Object.fromEntries(
        sorted([...state.reconciliationDivergences.entries()]),
      ) as Json,
      resolutions: state.reconciliationLog.map(
        (r) => [r.eventId, r.divergenceEventId, r.action] as Json[],
      ),
    },
  };
}
