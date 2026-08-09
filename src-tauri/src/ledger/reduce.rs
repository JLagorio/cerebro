//! The reducer (M22.3): folds committed frames in `seq` order into
//! epistemic entity state.
//!
//! Rules that hold everywhere in this file:
//! - Plumbing bodies (no `schema` key) index as events and create NOTHING
//!   here. A body that CLAIMS schema membership and fails it produces a
//!   deterministic anomaly row — never a panic, never a silent skip.
//! - Atomicity is marker-based: batch members are buffered and applied only
//!   when a valid `batch.committed` marker names the exact contiguous
//!   ordered member set with a matching digest. Any invalid member refuses
//!   the ENTIRE batch with zero entity-state effect.
//! - Versions are reducer-owned: producers never stamp version claims; the
//!   closed event-to-version matrix in the design is implemented here and
//!   nowhere else.
//! - Independence is positive and produced; unknown is never materialized.

use std::collections::{BTreeMap, BTreeSet};

use super::frame::Frame;
use super::schema::{
    self, AssertionBasis, AuthorityProvenance, BeliefBasis, EventBody, IndependenceProof,
    ObservationKind, ObservationPayload, RelationAction, ResolutionChange, ResolverTier,
    SubjectRef, TypedValue,
};

#[derive(Debug, Clone, PartialEq)]
pub struct Anomaly {
    pub seq: u64,
    pub event_id: String,
    pub batch_id: Option<String>,
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceState {
    pub source_id: String,
    pub registration_event_id: String,
    pub registration: schema::SourceRegistration,
    /// Canonical body bytes, for the duplicate-re-registration check.
    pub canonical: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntityState {
    pub entity_id: String,
    pub registered_by_event_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AliasState {
    pub normalized: String,
    pub alias: String,
    pub entity_id: String,
    pub event_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ObservationState {
    pub event_id: String,
    pub seq: u64,
    pub kind: ObservationKind,
    pub source_id: String,
    pub source_registration_event_id: String,
    pub subject: SubjectRef,
    /// Current effective attachment (resolved subjects start attached).
    pub effective_entity: Option<String>,
    /// The attach/correct event currently in effect; None until attached.
    pub effective_resolution_event: Option<String>,
    pub authority: Option<AuthorityProvenance>,
    pub assertion_basis: Option<AssertionBasis>,
    pub actor: String,
    pub lineage_parents: Vec<(schema::LineageKind, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RevisionState {
    pub revision: u64,
    pub event_id: String,
    pub content: String,
    pub fields: serde_json::Value,
    pub basis: BeliefBasis,
}

/// One active editorial overlay (M23.1). Durable canonical projection
/// state, structurally excluded from evidence. A Belief revision does not
/// clear it — the overlay stays active and is marked STALE against its
/// base revision until superseded or cleared.
#[derive(Debug, Clone, PartialEq)]
pub struct OverrideState {
    pub event_id: String,
    pub base_belief_revision: u64,
    pub patch: Vec<schema::OverridePatchOp>,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BeliefState {
    pub belief_id: String,
    pub entity_id: String,
    pub created_event_id: String,
    pub revisions: Vec<RevisionState>,
    /// Verification pointer: (attesting event, attested revision event).
    pub attested: Option<(String, String)>,
    /// Every APPLIED attestation event, fold (= seq) order — the
    /// descriptor's review_event_ids.
    pub attestation_events: Vec<String>,
    /// The knowledge-relative projection path, when this Belief is a
    /// projection (its creation subject carried a `.md` alias).
    pub path: Option<String>,
    /// Active editorial overlays in application order.
    pub overrides: Vec<OverrideState>,
    /// The latest override set/supersede/clear event, clear included.
    pub override_head_event: Option<String>,
    /// The highest-seq projection-state transition event — the projection
    /// identity head. Advances on revision, attestation, relation
    /// transition, alias addition, and override set/clear, even when the
    /// projected bytes stay identical.
    pub projection_head_event: String,
    // --- M24 governed state ------------------------------------------------
    /// Draft until a promotion qualifies it.
    pub qualification: schema::Qualification,
    /// Active until superseded, archived, or deprecated.
    pub lifecycle: schema::Lifecycle,
    /// Set once, never cleared: tombstoning is terminal by construction, so
    /// there is no state a `lifecycle_changed` inverse could spell to
    /// escape it.
    pub tombstoned_by: Option<String>,
    /// The open contest event, when one is open.
    pub open_contest_event: Option<String>,
    /// The latest qualification / lifecycle / contest transition and every
    /// merge that touched this Belief — the format-2 projection descriptor
    /// components (M24.3).
    pub qualification_head_event: Option<String>,
    pub lifecycle_head_event: Option<String>,
    pub contest_head_event: Option<String>,
    pub entity_merge_event_ids: Vec<String>,
}

impl BeliefState {
    pub fn current(&self) -> &RevisionState {
        self.revisions
            .last()
            .expect("a belief always has revision 1")
    }
}

/// The review-metadata overlay (M23.4, D8): when the attestation PREDATES
/// the current revision, the projection SAYS so instead of silently
/// rendering stale review state or none at all. A current attestation
/// leaves the stored fields untouched — migrated verified stamps render
/// byte-identically, and a fresh verify writes its stamp through a normal
/// field revision before attesting.
fn apply_review_overlay(
    state: &EpistemicState,
    belief: &BeliefState,
    fields: &mut serde_json::Value,
) {
    let Some((_, pinned_event)) = &belief.attested else {
        return;
    };
    if pinned_event == &belief.current().event_id {
        return;
    }
    let pinned_revision = state
        .belief_revision_events
        .get(pinned_event)
        .map(|(_, revision)| *revision)
        .unwrap_or(0);
    let notice = format!(
        "verified at r{pinned_revision}; current is r{} — attestation predates revision",
        belief.current().revision
    );
    if let Some(map) = fields.as_object_mut() {
        map.insert("verified".to_string(), serde_json::Value::String(notice));
    }
}

/// Canonical projection state with the review overlay and the active
/// editorial overlay applied: current-revision content/fields, the
/// predating-attestation notice, then every active override's ops in
/// order. An op a later revision made inapplicable is skipped — the
/// overlay is presentation state, not a patch with preconditions.
pub fn overlaid(state: &EpistemicState, belief: &BeliefState) -> (String, serde_json::Value) {
    let current = belief.current();
    let mut content = current.content.clone();
    let mut fields = current.fields.clone();
    apply_review_overlay(state, belief, &mut fields);
    for override_state in &belief.overrides {
        for op in &override_state.patch {
            apply_overlay_op(&mut content, &mut fields, op);
        }
    }
    (content, fields)
}

/// The projected bytes of the overlaid state.
pub fn projected_bytes(state: &EpistemicState, belief: &BeliefState) -> String {
    let (content, fields) = overlaid(state, belief);
    super::project::project(&content, &fields)
}

/// The typed value at a `/fields/...` pointer over a fields object;
/// Missing when absent. (The `/body` pointer is the caller's branch —
/// content is not inside fields.)
pub fn typed_at_pointer(fields: &serde_json::Value, pointer: &str) -> TypedValue {
    let Some(rest) = pointer.strip_prefix("/fields/") else {
        return TypedValue::Missing;
    };
    let tokens: Vec<String> = rest
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    typed_at(fields, &tokens)
}

/// The canonical projection-state descriptor (M23): every event the
/// renderer's output — or its identity — depends on. Serialized field
/// order IS the canonical digest input.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProjectionStateDescriptor {
    pub belief_revision_event: String,
    pub review_event_ids: Vec<String>,
    pub relation_transition_heads: Vec<RelationHead>,
    pub alias_event_ids: Vec<String>,
    pub active_override_event_ids: Vec<String>,
    pub override_head_event_id: Option<String>,
    // --- Format 2 (M24.3) --------------------------------------------------
    // The governed-state heads. They join the descriptor BEFORE any M24
    // mutation body can emit, so a projection's identity always accounts
    // for every transition that could have changed what it renders — and
    // the digest advances even when the rendered bytes do not, which is
    // what keeps a stale editorial overlay from surviving a lifecycle
    // change it never saw.
    pub qualification_head_event_id: Option<String>,
    pub lifecycle_head_event_id: Option<String>,
    pub tombstone_event_id: Option<String>,
    pub contest_head_event_id: Option<String>,
    pub entity_merge_event_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RelationHead {
    pub relation_id: String,
    pub event_id: String,
}

impl ProjectionStateDescriptor {
    /// SHA-256 of the canonical JSON serialization.
    pub fn digest(&self) -> Result<String, String> {
        let canonical = serde_json::to_string(self).map_err(|e| e.to_string())?;
        Ok(crate::ledger::sha256_hex(canonical.as_bytes()))
    }
}

/// Build the descriptor for one Belief from reduced state alone.
pub fn descriptor(state: &EpistemicState, belief: &BeliefState) -> ProjectionStateDescriptor {
    // BTreeMap iteration: relations sorted by relation_id, aliases by
    // normalized alias — exactly the descriptor's required orders.
    let relation_transition_heads = state
        .relations
        .values()
        .filter(|r| r.from == belief.belief_id)
        .map(|r| RelationHead {
            relation_id: r.relation_id.clone(),
            event_id: r.last_event_id.clone(),
        })
        .collect();
    let alias_event_ids = state
        .alias_registry
        .values()
        .filter(|a| a.entity_id == belief.entity_id)
        .map(|a| a.event_id.clone())
        .collect();
    ProjectionStateDescriptor {
        belief_revision_event: belief.current().event_id.clone(),
        review_event_ids: belief.attestation_events.clone(),
        relation_transition_heads,
        alias_event_ids,
        active_override_event_ids: belief
            .overrides
            .iter()
            .map(|o| o.event_id.clone())
            .collect(),
        override_head_event_id: belief.override_head_event.clone(),
        qualification_head_event_id: belief.qualification_head_event.clone(),
        lifecycle_head_event_id: belief.lifecycle_head_event.clone(),
        tombstone_event_id: belief.tombstoned_by.clone(),
        contest_head_event_id: belief.contest_head_event.clone(),
        entity_merge_event_ids: belief.entity_merge_event_ids.clone(),
    }
}

/// The complete projector result (M23.1) — what the manifest and
/// reconciliation consume, never a file hash alone.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectionResult {
    pub bytes: String,
    pub content_hash: String,
    pub belief_id: String,
    pub projected_revision: u64,
    pub belief_revision_event: String,
    pub generating_event: String,
    pub projection_state_digest: String,
    pub descriptor: ProjectionStateDescriptor,
    pub active_override_event_ids: Vec<String>,
}

/// Project one Belief with its full identity tuple.
pub fn project_belief(state: &EpistemicState, belief_id: &str) -> Result<ProjectionResult, String> {
    let belief = state
        .beliefs
        .get(belief_id)
        .ok_or_else(|| format!("belief {belief_id} does not exist"))?;
    let bytes = projected_bytes(state, belief);
    let described = descriptor(state, belief);
    Ok(ProjectionResult {
        content_hash: crate::ledger::sha256_hex(bytes.as_bytes()),
        bytes,
        belief_id: belief.belief_id.clone(),
        projected_revision: belief.current().revision,
        belief_revision_event: belief.current().event_id.clone(),
        generating_event: belief.projection_head_event.clone(),
        projection_state_digest: described.digest()?,
        active_override_event_ids: belief
            .overrides
            .iter()
            .map(|o| o.event_id.clone())
            .collect(),
        descriptor: described,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct RelationState {
    pub relation_id: String,
    pub from: String,
    pub to: String,
    pub relation: schema::RelationKind,
    pub live: bool,
    /// The add event currently making this relation live (resolver proofs
    /// cite it); updated on re-add.
    pub last_add_event_id: String,
    pub last_event_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolutionRow {
    pub seq: u64,
    pub event_id: String,
    pub observation_event_id: String,
    pub action: String,
    pub from_entity_id: Option<String>,
    pub to_entity_id: String,
    pub resolver_tier: ResolverTier,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IndependenceRow {
    pub event_id: String,
    pub proof_kind: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BatchRow {
    pub batch_id: String,
    pub state: &'static str, // committed | refused | orphaned
    pub marker_seq: Option<u64>,
    pub member_count: u64,
    pub operation_key: Option<String>,
    pub members: Vec<(String, u64)>,
}

#[derive(Debug, Clone, PartialEq)]
struct MigrationEpoch {
    store_uuid: String,
    source_digest: String,
    planned_output_count: u64,
    completed: bool,
}

/// The durable lifecycle of one proposal, folded from `proposal.*` events.
///
/// This is REDUCER state, not runtime cache: a queued HIGH proposal
/// survives a restart, a deleted runtime DB, and a wiped app-data
/// directory, because the queue is derived from the vault's own ledger.
#[derive(Debug, Clone, PartialEq)]
pub struct ProposalRow {
    pub proposal_id: String,
    /// The submitted proposal, WHOLE. The review card, the pre-append
    /// revalidation, and the revert all read this record rather than a
    /// summary of it — which is also what makes run accumulation durable:
    /// a run's members are the submitted proposals carrying its `run_id`,
    /// so a restart mid-run loses nothing and applies nothing.
    pub proposal: Box<schema::ProposalV1>,
    /// WHO proposed it. The mutations an application performs are
    /// attributed to this actor, not to the policy layer that authorized
    /// them — "system:policy wrote your knowledge base" would erase the
    /// only authorship the ledger has.
    pub actor: String,
    pub state: schema::ProposalState,
    pub commit_set_id: Option<String>,
    /// The frozen ordered member list this set's id was derived from —
    /// the only durable copy, so a queued set is resolvable after a restart
    /// without guessing which permutation it was committed in.
    pub queued_members: Vec<String>,
    /// The effective risk the CARD SAID when a human was asked. If the world
    /// moves and the same proposal would now be more dangerous, the approval
    /// was given to a different question.
    pub queued_risk: Option<schema::Risk>,
    /// The human's answer, once there is one.
    pub decision: Option<(String, schema::Decision)>,
    pub applied_event_id: Option<String>,
    /// Present exactly when the applied op's policy rule said `one_click` —
    /// which is what the UI keys its Revert action off, never the op name.
    pub revert_plan: Option<schema::RevertPlan>,
    pub submitted_event_id: String,
}

/// One reconciliation resolution, kept as history after the mode closes.
#[derive(Debug, Clone, PartialEq)]
pub struct ReconciliationLogRow {
    pub event_id: String,
    pub divergence_event_id: String,
    pub action: schema::ReconciliationAction,
}

/// The whole reduced world. `Clone` is the batch staging mechanism: members
/// fold into a scratch clone that replaces the state only when every member
/// applies.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EpistemicState {
    pub sources: BTreeMap<String, SourceState>,
    pub source_keys: BTreeMap<String, String>,
    pub registrations_by_event: BTreeMap<String, String>,
    pub entities: BTreeMap<String, EntityState>,
    pub alias_registry: BTreeMap<String, AliasState>,
    pub alias_events: BTreeMap<String, (String, String)>,
    pub observations: BTreeMap<String, ObservationState>,
    /// Entity-registering events (belief.created / resolved-subject
    /// observations): event id → (entity, preserved source aliases).
    pub entity_registrations: BTreeMap<String, (String, Vec<String>)>,
    pub beliefs: BTreeMap<String, BeliefState>,
    pub belief_revision_events: BTreeMap<String, (String, u64)>,
    pub relations: BTreeMap<String, RelationState>,
    pub relation_add_events: BTreeMap<String, String>,
    /// The M24 proposal lifecycle — portable, not a runtime cache.
    pub proposals: BTreeMap<String, ProposalRow>,
    pub resolutions: Vec<ResolutionRow>,
    pub independence: BTreeMap<(String, String), IndependenceRow>,
    pub derived_belief_sources: Vec<(String, String)>,
    /// (class, id) → (version, last event id). The closed matrix.
    pub versions: BTreeMap<(String, String), (u64, String)>,
    pub batches: Vec<BatchRow>,
    pub anomalies: Vec<Anomaly>,
    migration: Option<MigrationEpoch>,
    /// knowledge-relative projection path → Belief id — one Belief per
    /// projection file, claimed at creation by its `.md` subject alias.
    pub projection_paths: BTreeMap<String, String>,
    /// Active divergences: detection_key → divergence event id. The mode is
    /// OPEN exactly while this is non-empty; a new detection key arriving
    /// under an open mode is absorbed, never a second mode entry.
    pub reconciliation_divergences: BTreeMap<String, String>,
    /// Every valid resolution, in fold order.
    pub reconciliation_log: Vec<ReconciliationLogRow>,
    /// Producer-side index (deliberately OUTSIDE the vector contract):
    /// extracted-assertion event → its extracted_text, for the M23.7
    /// out-of-band correction carve-out.
    pub extracted_texts: BTreeMap<String, String>,
}

impl EpistemicState {
    /// Is the divergence circuit breaker's named reconciliation mode open?
    pub fn reconciliation_open(&self) -> bool {
        !self.reconciliation_divergences.is_empty()
    }
}

impl EpistemicState {
    fn create_version(&mut self, class: &str, id: &str, event_id: &str) {
        self.versions.insert(
            (class.to_string(), id.to_string()),
            (1, event_id.to_string()),
        );
    }

    fn bump_version(&mut self, class: &str, id: &str, event_id: &str) {
        let entry = self
            .versions
            .entry((class.to_string(), id.to_string()))
            .or_insert((0, String::new()));
        entry.0 += 1;
        entry.1 = event_id.to_string();
    }

    pub fn version(&self, class: &str, id: &str) -> Option<u64> {
        self.versions
            .get(&(class.to_string(), id.to_string()))
            .map(|(v, _)| *v)
    }
}

/// Event ids staged by the current batch — the "committed only" checks
/// refuse these even though the scratch state already contains them.
type Staged = BTreeSet<String>;

/// Fold every frame into entity state. Never fails: refusals become
/// deterministic anomaly rows.
pub fn reduce(frames: &[Frame], store_id: &str) -> EpistemicState {
    let mut state = EpistemicState::default();
    let mut pending: BTreeMap<String, Vec<(Frame, EventBody)>> = BTreeMap::new();
    let mut committed_batches: BTreeSet<String> = BTreeSet::new();

    for frame in frames {
        let decoded = match schema::decode_body(&frame.kind, &frame.body) {
            Ok(Some(decoded)) => decoded,
            Ok(None) => continue, // plumbing: indexable, zero entity state
            Err(detail) => {
                state.anomalies.push(Anomaly {
                    seq: frame.seq,
                    event_id: frame.event_id.clone(),
                    batch_id: None,
                    code: "schema".to_string(),
                    detail,
                });
                continue;
            }
        };

        match (decoded.batch_id().map(str::to_string), &decoded) {
            (Some(batch_id), EventBody::BatchCommitted(marker)) => {
                let members = pending.remove(&batch_id).unwrap_or_default();
                commit_batch(
                    &mut state,
                    store_id,
                    frame,
                    &batch_id,
                    (**marker).clone(),
                    members,
                    &mut committed_batches,
                );
            }
            (Some(batch_id), _) => {
                pending
                    .entry(batch_id)
                    .or_default()
                    .push((frame.clone(), decoded));
            }
            (None, _) => {
                let staged = Staged::new();
                if let Err((code, detail)) =
                    apply(&mut state, store_id, frame, &decoded, &staged, &[])
                {
                    state.anomalies.push(Anomaly {
                        seq: frame.seq,
                        event_id: frame.event_id.clone(),
                        batch_id: None,
                        code,
                        detail,
                    });
                }
            }
        }
    }

    // Whatever is still buffered has no marker: orphaned, diagnosable,
    // zero entity-state effect.
    for (batch_id, members) in pending {
        let first = &members[0].0;
        state.anomalies.push(Anomaly {
            seq: first.seq,
            event_id: first.event_id.clone(),
            batch_id: Some(batch_id.clone()),
            code: "batch".to_string(),
            detail: format!(
                "batch {batch_id} has {} member(s) and no committed marker — orphaned",
                members.len()
            ),
        });
        state.batches.push(BatchRow {
            batch_id,
            state: "orphaned",
            marker_seq: None,
            member_count: members.len() as u64,
            operation_key: None,
            members: members
                .iter()
                .map(|(f, _)| (f.event_id.clone(), f.seq))
                .collect(),
        });
    }
    // Batch rows in deterministic order (fold order for committed/refused,
    // then the BTreeMap-ordered orphans appended above — already stable).
    state
}

/// Validate a marker against its buffered members and, if the batch is
/// valid as a UNIT, fold the members in order.
#[allow(clippy::too_many_arguments)]
fn commit_batch(
    state: &mut EpistemicState,
    store_id: &str,
    marker_frame: &Frame,
    batch_id: &str,
    marker: schema::BatchCommitted,
    members: Vec<(Frame, EventBody)>,
    committed_batches: &mut BTreeSet<String>,
) {
    let refuse = |state: &mut EpistemicState, detail: String| {
        state.anomalies.push(Anomaly {
            seq: marker_frame.seq,
            event_id: marker_frame.event_id.clone(),
            batch_id: Some(batch_id.to_string()),
            code: "batch".to_string(),
            detail,
        });
        state.batches.push(BatchRow {
            batch_id: batch_id.to_string(),
            state: "refused",
            marker_seq: Some(marker_frame.seq),
            member_count: members.len() as u64,
            operation_key: marker.idempotency_key.clone(),
            members: members
                .iter()
                .map(|(f, _)| (f.event_id.clone(), f.seq))
                .collect(),
        });
    };

    if committed_batches.contains(batch_id) {
        refuse(
            state,
            format!("batch {batch_id} already has a committed marker — duplicate marker"),
        );
        return;
    }
    if let Err(detail) = marker.validate() {
        refuse(state, format!("invalid marker: {detail}"));
        return;
    }
    let ids_match = members.len() == marker.member_event_ids.len()
        && members
            .iter()
            .zip(&marker.member_event_ids)
            .all(|((frame, _), id)| &frame.event_id == id);
    if !ids_match {
        refuse(
            state,
            format!(
                "marker names {} member(s); {} buffered in order — truncated, substituted, or \
                 wrong order",
                marker.member_event_ids.len(),
                members.len()
            ),
        );
        return;
    }
    let contiguous = members
        .windows(2)
        .all(|pair| pair[1].0.seq == pair[0].0.seq + 1)
        && members
            .last()
            .is_some_and(|(last, _)| last.seq + 1 == marker_frame.seq);
    if !contiguous {
        refuse(
            state,
            "batch members are not one contiguous run ending at the marker — interleaved".into(),
        );
        return;
    }
    let digest = super::members_digest(members.iter().map(|(frame, _)| frame)).unwrap_or_default();
    if digest != marker.members_digest {
        refuse(
            state,
            "members digest mismatch — substituted or torn member".into(),
        );
        return;
    }

    // Two-phase: fold members into a scratch clone; any refusal drops the
    // scratch and the whole batch has zero entity-state effect.
    let mut scratch = state.clone();
    let staged: Staged = members
        .iter()
        .map(|(frame, _)| frame.event_id.clone())
        .collect();
    for (ordinal, (frame, body)) in members.iter().enumerate() {
        if let Err((code, detail)) = apply(&mut scratch, store_id, frame, body, &staged, &members) {
            state.anomalies.push(Anomaly {
                seq: frame.seq,
                event_id: frame.event_id.clone(),
                batch_id: Some(batch_id.to_string()),
                code,
                detail: format!("batch member {ordinal}: {detail}"),
            });
            refuse(
                state,
                format!("member {ordinal} refused — whole batch has no effect"),
            );
            return;
        }
    }
    *state = scratch;
    committed_batches.insert(batch_id.to_string());
    state.batches.push(BatchRow {
        batch_id: batch_id.to_string(),
        state: "committed",
        marker_seq: Some(marker_frame.seq),
        member_count: members.len() as u64,
        operation_key: marker.idempotency_key.clone(),
        members: members
            .iter()
            .map(|(f, _)| (f.event_id.clone(), f.seq))
            .collect(),
    });
}

type Refusal = (String, String);

fn refused(detail: impl Into<String>) -> Refusal {
    ("refused".to_string(), detail.into())
}

/// Apply one schema-v1 event. Structural validation first, then the
/// state-dependent rules. Mutates `state` only on success when called for
/// an unbatched event; batch members mutate a scratch clone.
fn apply(
    state: &mut EpistemicState,
    store_id: &str,
    frame: &Frame,
    body: &EventBody,
    staged: &Staged,
    members: &[(Frame, EventBody)],
) -> Result<(), Refusal> {
    body.validate(store_id).map_err(refused)?;
    match body {
        EventBody::BatchCommitted(_) => Err(refused("a marker cannot be applied as a member")),
        EventBody::SourceRegistered(b) => apply_source(state, frame, b),
        EventBody::ObservationRecorded(b) => apply_observation(state, frame, b, staged, members),
        EventBody::SubjectResolved(b) => apply_resolution(state, frame, b, staged),
        EventBody::IndependenceRecorded(b) => apply_independence(state, frame, b),
        EventBody::BeliefCreated(b) => apply_belief_created(state, frame, b),
        EventBody::BeliefRevised(b) => apply_belief_revised(state, frame, b),
        EventBody::BeliefRelation(b) => apply_relation(state, frame, b),
        EventBody::BeliefAttested(b) => apply_attested(state, frame, b, staged),
        EventBody::EntityAliasAdded(b) => apply_alias(state, frame, b),
        EventBody::MigrationStarted(b) => apply_migration_started(state, b),
        EventBody::MigrationCompleted(b) => apply_migration_completed(state, b),
        EventBody::ProjectionOverridden(b) => apply_override(state, frame, b),
        EventBody::LedgerDivergence(b) => apply_divergence(state, frame, b),
        EventBody::ReconciliationResolved(b) => apply_reconciliation_resolved(state, frame, b),
        EventBody::BeliefQualificationChanged(b) => apply_qualification(state, frame, b),
        EventBody::BeliefLifecycleChanged(b) => apply_lifecycle(state, frame, b),
        EventBody::BeliefTombstoned(b) => apply_tombstone(state, frame, b),
        EventBody::BeliefContested(b) => apply_contest(state, frame, b, staged),
        EventBody::EntityMerged(b) => apply_entity_merge(state, frame, b),
        EventBody::ProposalSubmitted(b) => apply_proposal_submitted(state, frame, b),
        EventBody::ProposalQueued(b) => apply_proposal_queued(state, frame, b),
        EventBody::ProposalDecisionRecorded(b) => apply_proposal_decision(state, frame, b),
        EventBody::ProposalApplied(b) => apply_proposal_applied(state, frame, b),
        EventBody::ProposalRejected(b) => apply_proposal_rejected(state, frame, b),
        EventBody::ProposalReverted(b) => apply_proposal_reverted(state, frame, b),
    }
}

/// A Belief that can still be governed. Tombstoned is terminal: nothing
/// mutates it afterwards, which is what "non-reversible" means here rather
/// than a convention the ops are trusted to observe.
fn live_belief<'a>(
    state: &'a mut EpistemicState,
    belief_id: &str,
) -> Result<&'a mut BeliefState, Refusal> {
    let belief = state
        .beliefs
        .get_mut(belief_id)
        .ok_or_else(|| refused(format!("belief {belief_id} does not exist")))?;
    if belief.tombstoned_by.is_some() {
        return Err(refused(format!(
            "belief {belief_id} is tombstoned — a tombstone is terminal, not a state to move out of"
        )));
    }
    Ok(belief)
}

fn apply_qualification(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefQualificationChanged,
) -> Result<(), Refusal> {
    let belief = live_belief(state, &body.belief_id)?;
    // The event declares where it came FROM; if state disagrees, the
    // proposal was computed against a snapshot that has moved.
    if belief.qualification != body.from {
        return Err(refused(format!(
            "illegal_transition: belief {} is {:?}, not {:?}",
            body.belief_id, belief.qualification, body.from
        )));
    }
    belief.qualification = body.to;
    belief.qualification_head_event = Some(frame.event_id.clone());
    belief.projection_head_event = frame.event_id.clone();
    state.bump_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

fn apply_lifecycle(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefLifecycleChanged,
) -> Result<(), Refusal> {
    if let Some(replacement) = &body.replacement_id {
        if !state.beliefs.contains_key(replacement) {
            return Err(refused(format!(
                "replacement belief {replacement} does not exist"
            )));
        }
    }
    let belief = live_belief(state, &body.belief_id)?;
    if belief.lifecycle != body.from {
        return Err(refused(format!(
            "illegal_transition: belief {} is {:?}, not {:?}",
            body.belief_id, belief.lifecycle, body.from
        )));
    }
    belief.lifecycle = body.to;
    belief.lifecycle_head_event = Some(frame.event_id.clone());
    belief.projection_head_event = frame.event_id.clone();
    state.bump_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

fn apply_tombstone(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefTombstoned,
) -> Result<(), Refusal> {
    if let Some(replacement) = &body.replacement_id {
        if !state.beliefs.contains_key(replacement) {
            return Err(refused(format!(
                "replacement belief {replacement} does not exist"
            )));
        }
    }
    let belief = live_belief(state, &body.belief_id)?;
    belief.tombstoned_by = Some(frame.event_id.clone());
    belief.projection_head_event = frame.event_id.clone();
    state.bump_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

fn apply_contest(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefContested,
    staged: &Staged,
) -> Result<(), Refusal> {
    for reference in &body.counterevidence_refs {
        // Counterevidence must be COMMITTED: same-batch evidence would let
        // one batch both invent the objection and rest on it.
        if staged.contains(reference) || !state.observations.contains_key(reference) {
            return Err(refused(format!(
                "counterevidence {reference} is not a committed Observation"
            )));
        }
    }
    let belief = live_belief(state, &body.belief_id)?;
    match body.action {
        schema::ContestAction::Open => {
            if belief.open_contest_event.is_some() {
                return Err(refused(format!(
                    "belief {} already has an open contest — a second one would make \
                     'is this contested?' ambiguous",
                    body.belief_id
                )));
            }
            belief.open_contest_event = Some(frame.event_id.clone());
        }
        schema::ContestAction::Close => {
            // At most one contest is ever open, so "which one does this
            // close?" has exactly one answer and needs no second pointer.
            let Some(open) = belief.open_contest_event.clone() else {
                return Err(refused(format!(
                    "belief {} has no open contest to close",
                    body.belief_id
                )));
            };
            let addressed = body
                .addressed_by_event_id
                .as_ref()
                .expect("schema validation requires an addressing event on close");
            if addressed == &open {
                return Err(refused(
                    "a contest cannot be addressed by its own opening event".to_string(),
                ));
            }
            belief.open_contest_event = None;
        }
    }
    belief.contest_head_event = Some(frame.event_id.clone());
    belief.projection_head_event = frame.event_id.clone();
    state.bump_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

fn apply_entity_merge(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::EntityMerged,
) -> Result<(), Refusal> {
    let plan = &body.reassignment_plan;
    if !state.entities.contains_key(&plan.survivor_id) {
        return Err(refused(format!(
            "survivor entity {} does not exist",
            plan.survivor_id
        )));
    }
    for merged in &plan.merged_ids {
        if !state.entities.contains_key(merged) {
            return Err(refused(format!("merged entity {merged} does not exist")));
        }
    }
    // The plan must enumerate EXACTLY the beliefs and relations that point
    // at a merged entity. An omission would leave a dangling identity; an
    // extra would reassign something the proposal never named — and the CAS
    // target set is derived from this list, so both are silent otherwise.
    let mut expected_beliefs: Vec<String> = state
        .beliefs
        .values()
        .filter(|belief| plan.merged_ids.contains(&belief.entity_id))
        .map(|belief| belief.belief_id.clone())
        .collect();
    expected_beliefs.sort();
    if expected_beliefs != plan.affected_belief_ids {
        return Err(refused(format!(
            "reassignment plan lists {:?} beliefs, state has {:?}",
            plan.affected_belief_ids.len(),
            expected_beliefs.len()
        )));
    }
    for relation_id in &plan.affected_relation_ids {
        if !state.relations.contains_key(relation_id) {
            return Err(refused(format!("relation {relation_id} does not exist")));
        }
    }
    for alias in &plan.live_aliases {
        match state.alias_registry.get(&alias.normalized_alias) {
            Some(registered) if registered.entity_id == alias.from_entity_id => {}
            Some(registered) => {
                return Err(refused(format!(
                    "alias {:?} is bound to {}, not {}",
                    alias.normalized_alias, registered.entity_id, alias.from_entity_id
                )))
            }
            None => {
                return Err(refused(format!(
                    "alias {:?} is not registered",
                    alias.normalized_alias
                )))
            }
        }
    }

    // One event, every reassignment.
    for alias in &plan.live_aliases {
        if let Some(registered) = state.alias_registry.get_mut(&alias.normalized_alias) {
            registered.entity_id = plan.survivor_id.clone();
        }
    }
    for belief_id in &plan.affected_belief_ids {
        if let Some(belief) = state.beliefs.get_mut(belief_id) {
            belief.entity_id = plan.survivor_id.clone();
            belief.entity_merge_event_ids.push(frame.event_id.clone());
            belief.projection_head_event = frame.event_id.clone();
        }
        state.bump_version("belief", belief_id, &frame.event_id);
    }
    for relation_id in &plan.affected_relation_ids {
        state.bump_version("relation", relation_id, &frame.event_id);
    }
    for merged in &plan.merged_ids {
        state.entities.remove(merged);
        state.bump_version("entity", merged, &frame.event_id);
    }
    state.bump_version("entity", &plan.survivor_id, &frame.event_id);
    Ok(())
}

// --- The proposal lifecycle ----------------------------------------------

fn proposal_state(state: &EpistemicState, proposal_id: &str) -> Option<schema::ProposalState> {
    state.proposals.get(proposal_id).map(|row| row.state)
}

/// Terminal means terminal. A second terminal event for one proposal is a
/// refusal, not a state change — otherwise an applied proposal could be
/// "rejected" afterwards and the durable record would contradict itself.
fn require_non_terminal(state: &EpistemicState, proposal_id: &str) -> Result<(), Refusal> {
    match proposal_state(state, proposal_id) {
        None => Err(refused(format!(
            "proposal {proposal_id} was never submitted"
        ))),
        Some(current) if current.is_terminal() => Err(refused(format!(
            "proposal {proposal_id} is already {current:?} — terminal states cannot be left"
        ))),
        Some(_) => Ok(()),
    }
}

fn apply_proposal_submitted(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ProposalSubmitted,
) -> Result<(), Refusal> {
    let id = body.proposal.proposal_id.clone();
    if state.proposals.contains_key(&id) {
        return Err(refused(format!("proposal {id} is already submitted")));
    }
    state.proposals.insert(
        id.clone(),
        ProposalRow {
            proposal_id: id.clone(),
            proposal: body.proposal.clone(),
            actor: body.actor.id.clone(),
            state: schema::ProposalState::Submitted,
            commit_set_id: None,
            queued_members: Vec::new(),
            queued_risk: None,
            decision: None,
            applied_event_id: None,
            revert_plan: None,
            submitted_event_id: frame.event_id.clone(),
        },
    );
    state.create_version("proposal", &id, &frame.event_id);
    Ok(())
}

fn apply_proposal_queued(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ProposalQueued,
) -> Result<(), Refusal> {
    require_non_terminal(state, &body.proposal_id)?;
    for member in &body.member_proposal_ids {
        if !state.proposals.contains_key(member) {
            return Err(refused(format!(
                "commit set member {member} was never submitted"
            )));
        }
    }
    let row = state
        .proposals
        .get_mut(&body.proposal_id)
        .expect("require_non_terminal proved it exists");
    row.state = schema::ProposalState::Queued;
    row.commit_set_id = Some(body.commit_set_id.clone());
    row.queued_members = body.member_proposal_ids.clone();
    row.queued_risk = Some(body.effective_risk);
    state.bump_version("proposal", &body.proposal_id, &frame.event_id);
    Ok(())
}

fn apply_proposal_decision(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ProposalDecisionRecorded,
) -> Result<(), Refusal> {
    // A decision is only meaningful on something actually awaiting one.
    match proposal_state(state, &body.proposal_id) {
        Some(schema::ProposalState::Queued) => {}
        Some(other) => {
            return Err(refused(format!(
                "proposal {} is {other:?}, not queued — there is nothing to decide",
                body.proposal_id
            )))
        }
        None => {
            return Err(refused(format!(
                "proposal {} was never submitted",
                body.proposal_id
            )))
        }
    }
    let row = state
        .proposals
        .get_mut(&body.proposal_id)
        .expect("checked above");
    if row.decision.is_some() {
        return Err(refused(format!(
            "proposal {} already carries a decision",
            body.proposal_id
        )));
    }
    row.decision = Some((body.decision_id.clone(), body.decision));
    state.bump_version("proposal", &body.proposal_id, &frame.event_id);
    Ok(())
}

fn apply_proposal_applied(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ProposalApplied,
) -> Result<(), Refusal> {
    require_non_terminal(state, &body.proposal_id)?;
    if let Some(decision_id) = &body.decision_id {
        let row = state.proposals.get(&body.proposal_id).expect("checked");
        match &row.decision {
            Some((recorded, schema::Decision::Approve)) if recorded == decision_id => {}
            Some((_, schema::Decision::Reject)) => {
                return Err(refused(format!(
                    "proposal {} was rejected — an application cannot cite that decision",
                    body.proposal_id
                )))
            }
            _ => {
                return Err(refused(format!(
                    "proposal {} names decision {decision_id}, which is not its recorded approval",
                    body.proposal_id
                )))
            }
        }
    }
    let row = state
        .proposals
        .get_mut(&body.proposal_id)
        .expect("checked above");
    row.state = schema::ProposalState::Applied;
    row.applied_event_id = Some(frame.event_id.clone());
    row.revert_plan = body.revert_plan.clone();
    if row.commit_set_id.is_none() {
        row.commit_set_id = Some(body.commit_set_id.clone());
    }
    state.bump_version("proposal", &body.proposal_id, &frame.event_id);
    Ok(())
}

fn apply_proposal_rejected(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ProposalRejected,
) -> Result<(), Refusal> {
    require_non_terminal(state, &body.proposal_id)?;
    if let Some(peer) = &body.refused_by_proposal_id {
        if !state.proposals.contains_key(peer) {
            return Err(refused(format!(
                "refused_by proposal {peer} was never submitted"
            )));
        }
    }
    let row = state
        .proposals
        .get_mut(&body.proposal_id)
        .expect("checked above");
    row.state = schema::ProposalState::Rejected;
    state.bump_version("proposal", &body.proposal_id, &frame.event_id);
    Ok(())
}

fn apply_proposal_reverted(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ProposalReverted,
) -> Result<(), Refusal> {
    // Only an APPLIED proposal can be reverted, and the reverting proposal
    // must itself exist — a reversion pointing at nothing is unauditable.
    match proposal_state(state, &body.proposal_id) {
        Some(schema::ProposalState::Applied) => {}
        Some(other) => {
            return Err(refused(format!(
                "proposal {} is {other:?} — only an applied proposal can be reverted",
                body.proposal_id
            )))
        }
        None => {
            return Err(refused(format!(
                "proposal {} was never submitted",
                body.proposal_id
            )))
        }
    }
    if !state.proposals.contains_key(&body.reverted_by_proposal_id) {
        return Err(refused(format!(
            "reverting proposal {} was never submitted",
            body.reverted_by_proposal_id
        )));
    }
    let row = state
        .proposals
        .get_mut(&body.proposal_id)
        .expect("checked above");
    row.state = schema::ProposalState::Reverted;
    // History is never rewound: the original application event id stays.
    state.bump_version("proposal", &body.proposal_id, &frame.event_id);
    Ok(())
}

fn apply_source(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::SourceRegistered,
) -> Result<(), Refusal> {
    let canonical = serde_json::to_string(&frame.body).map_err(|e| refused(e.to_string()))?;
    if let Some(existing) = state.sources.get(&body.source_id) {
        return Err(refused(if existing.canonical == canonical {
            format!(
                "source {} is already registered — one registration per source",
                body.source_id
            )
        } else {
            format!(
                "source {} re-registered with different canonical bytes — refused",
                body.source_id
            )
        }));
    }
    let key = body.registration.source_key().to_string();
    if state.source_keys.contains_key(&key) {
        return Err(refused(format!(
            "source key {key:?} is already registered under another source id"
        )));
    }
    state.sources.insert(
        body.source_id.clone(),
        SourceState {
            source_id: body.source_id.clone(),
            registration_event_id: frame.event_id.clone(),
            registration: body.registration.clone(),
            canonical,
        },
    );
    state.source_keys.insert(key, body.source_id.clone());
    state
        .registrations_by_event
        .insert(frame.event_id.clone(), body.source_id.clone());
    state.create_version("source", &body.source_id, &frame.event_id);
    Ok(())
}

fn apply_observation(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ObservationRecorded,
    staged: &Staged,
    members: &[(Frame, EventBody)],
) -> Result<(), Refusal> {
    let payload = body.validate().map_err(refused)?;
    if let ObservationPayload::HumanAssertion(human) = &payload {
        verify_human_form_pairing(state, frame, human, members)?;
    }

    // The registration pin: an earlier committed (or earlier-staged)
    // registration event whose source id matches.
    let pinned_source = state
        .registrations_by_event
        .get(&body.source_registration_event_id)
        .ok_or_else(|| {
            refused(format!(
                "source_registration_event_id {} names no committed registration",
                body.source_registration_event_id
            ))
        })?;
    if pinned_source != &body.source_id {
        return Err(refused(format!(
            "registration event registers source {pinned_source}, not {}",
            body.source_id
        )));
    }
    let source = state
        .sources
        .get(&body.source_id)
        .expect("pinned source exists");

    // Authority is DERIVED from the registration and call path; the payload
    // must claim exactly the derivation — no upgrade, no downgrade.
    let (authority, assertion_basis) = if let Some(assertion) = payload.assertion() {
        let derived =
            schema::derive_authority(&source.registration, &body.actor.id, body.observation_kind);
        if assertion.authority_provenance != derived {
            return Err(refused(format!(
                "authority_provenance {:?} disagrees with the registration-derived {:?} — \
                 authority is provenance, not a caller-selected label",
                assertion.authority_provenance, derived
            )));
        }
        (Some(derived), Some(assertion.assertion_basis))
    } else {
        (None, None)
    };

    // Lineage: every parent an existing Observation (committed or earlier
    // staged), in strictly ascending seq order.
    let mut prev_seq: Option<u64> = None;
    for edge in &body.lineage {
        let parent = state
            .observations
            .get(&edge.parent_observation_event_id)
            .ok_or_else(|| {
                refused(format!(
                    "lineage parent {} is not an Observation (attestations and other events can \
                     never be evidence ancestry)",
                    edge.parent_observation_event_id
                ))
            })?;
        if prev_seq.is_some_and(|prev| parent.seq <= prev) {
            return Err(refused(
                "lineage edges must be in canonical ascending parent order".to_string(),
            ));
        }
        prev_seq = Some(parent.seq);
    }

    if let ObservationPayload::ExtractedAssertion(extracted) = &payload {
        state
            .extracted_texts
            .insert(frame.event_id.clone(), extracted.extracted_text.clone());
    }

    // Derived-content Belief inputs: earlier COMMITTED creation/revision
    // events, read-only.
    if let ObservationPayload::DerivedContent(derived) = &payload {
        for id in derived
            .source_belief_revision_event_ids
            .as_deref()
            .unwrap_or(&[])
        {
            if staged.contains(id) {
                return Err(refused(format!(
                    "belief-revision source {id} is staged in this batch — committed only"
                )));
            }
            if !state.belief_revision_events.contains_key(id) {
                return Err(refused(format!(
                    "belief-revision source {id} names no committed belief.created/belief.revised"
                )));
            }
            state
                .derived_belief_sources
                .push((frame.event_id.clone(), id.clone()));
        }
    }

    // A resolved subject may FIRST-REGISTER an unseen Entity; it never bumps
    // an existing one merely by reference.
    let effective_entity = match &body.subject {
        SubjectRef::Resolved { entity_id, aliases } => {
            if !state.entities.contains_key(entity_id) {
                state.entities.insert(
                    entity_id.clone(),
                    EntityState {
                        entity_id: entity_id.clone(),
                        registered_by_event_id: frame.event_id.clone(),
                    },
                );
                state.create_version("entity", entity_id, &frame.event_id);
            }
            state
                .entity_registrations
                .insert(frame.event_id.clone(), (entity_id.clone(), aliases.clone()));
            Some(entity_id.clone())
        }
        _ => None,
    };

    state.observations.insert(
        frame.event_id.clone(),
        ObservationState {
            event_id: frame.event_id.clone(),
            seq: frame.seq,
            kind: body.observation_kind,
            source_id: body.source_id.clone(),
            source_registration_event_id: body.source_registration_event_id.clone(),
            subject: body.subject.clone(),
            effective_entity,
            effective_resolution_event: None,
            authority,
            assertion_basis,
            actor: body.actor.id.clone(),
            lineage_parents: body
                .lineage
                .iter()
                .map(|e| (e.edge, e.parent_observation_event_id.clone()))
                .collect(),
        },
    );
    state.create_version("observation", &frame.event_id, &frame.event_id);
    state.bump_version("source", &body.source_id, &frame.event_id);
    Ok(())
}

/// Human EFFECT forms (field_change / relation_change / alias_add) pair
/// one-to-one with the exact event that realizes them, in the SAME logical
/// batch — a claimed effect without its event (or vice versa in spirit)
/// refuses the whole batch. `standalone` is root evidence and stays free,
/// but a same-batch basis use must agree with its intended Belief.
fn verify_human_form_pairing(
    state: &EpistemicState,
    frame: &Frame,
    human: &schema::HumanAssertionPayload,
    members: &[(Frame, EventBody)],
) -> Result<(), Refusal> {
    match &human.form {
        schema::HumanAssertionForm::FieldChange {
            target_belief_id,
            field_path,
            before,
            after,
            ..
        } => {
            let paired = members.iter().any(|(_, member)| match member {
                EventBody::BeliefRevised(revised) => {
                    revised.belief_id == *target_belief_id
                        && revised.patch.iter().any(|op| {
                            op.field_path == *field_path
                                && op.before == *before
                                && op.after == *after
                        })
                }
                _ => false,
            });
            if !paired {
                return Err(refused(
                    "field_change requires its exact paired belief.revised patch in the same                      logical batch",
                ));
            }
        }
        schema::HumanAssertionForm::RelationChange {
            relation_id,
            action,
            from,
            to,
            relation,
            ..
        } => {
            let paired = members.iter().any(|(_, member)| match member {
                EventBody::BeliefRelation(rel) => {
                    rel.relation_id == *relation_id
                        && rel.action == *action
                        && rel.from == *from
                        && rel.to == *to
                        && rel.relation == *relation
                }
                _ => false,
            });
            if !paired {
                return Err(refused(
                    "relation_change requires its exact paired belief.relation event in the same                      logical batch",
                ));
            }
        }
        schema::HumanAssertionForm::AliasAdd {
            target_belief_id,
            entity_id,
            alias,
            normalized_alias,
            ..
        } => {
            let belief = state
                .beliefs
                .get(target_belief_id)
                .ok_or_else(|| refused("alias_add target Belief does not exist"))?;
            if belief.entity_id != *entity_id {
                return Err(refused(
                    "alias_add entity must be the subject Entity of the target Belief",
                ));
            }
            let paired = members.iter().any(|(_, member)| match member {
                EventBody::EntityAliasAdded(added) => {
                    added.entity_id == *entity_id
                        && added.alias == *alias
                        && added.normalized_alias == *normalized_alias
                }
                _ => false,
            });
            if !paired {
                return Err(refused(
                    "alias_add requires its exact paired entity.alias_added event in the same                      logical batch",
                ));
            }
        }
        schema::HumanAssertionForm::Standalone {
            intended_belief_id, ..
        } => {
            if let Some(intended) = intended_belief_id {
                for (_, member) in members {
                    let (belief_id, basis) = match member {
                        EventBody::BeliefCreated(b) => (&b.belief_id, &b.basis),
                        EventBody::BeliefRevised(b) => (&b.belief_id, &b.basis),
                        _ => continue,
                    };
                    if let BeliefBasis::Linked { links } = basis {
                        if links
                            .iter()
                            .any(|l| l.observation_event_id == frame.event_id)
                            && belief_id != intended
                        {
                            return Err(refused(
                                "a same-batch basis use must name the standalone assertion's                                  intended Belief",
                            ));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn apply_resolution(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::SubjectResolved,
    staged: &Staged,
) -> Result<(), Refusal> {
    if staged.contains(&body.observation_event_id) {
        return Err(refused(
            "subject resolution targets a same-batch Observation — committed only".to_string(),
        ));
    }
    let observation = state
        .observations
        .get(&body.observation_event_id)
        .ok_or_else(|| refused("subject resolution targets no committed Observation"))?
        .clone();
    if !matches!(observation.subject, SubjectRef::Unresolved { .. }) {
        return Err(refused(
            "only an originally unresolved Observation can be attached — `none` and resolved \
             subjects are refused",
        ));
    }
    let raw_ref = match &observation.subject {
        SubjectRef::Unresolved { raw_ref, .. } => raw_ref.clone(),
        _ => unreachable!("checked above"),
    };

    let (to_entity, from_entity, tier, basis, action) = match &body.change {
        ResolutionChange::Attach {
            entity_id,
            resolver_tier,
            basis_event_ids,
        } => {
            if observation.effective_resolution_event.is_some() {
                return Err(refused(
                    "attach on an already attached Observation — correction is the explicit door",
                ));
            }
            (
                entity_id.clone(),
                None,
                *resolver_tier,
                basis_event_ids,
                "attach",
            )
        }
        ResolutionChange::Correct {
            prior_resolution_event_id,
            from_entity_id,
            to_entity_id,
            resolver_tier,
            basis_event_ids,
            ..
        } => {
            let current = observation
                .effective_resolution_event
                .as_deref()
                .ok_or_else(|| refused("correction before any attachment — nothing to correct"))?;
            if current != prior_resolution_event_id {
                return Err(refused(format!(
                    "correction pins prior resolution {prior_resolution_event_id}, but the \
                     current effective resolution is {current} — stale prior"
                )));
            }
            if observation.effective_entity.as_deref() != Some(from_entity_id.as_str()) {
                return Err(refused(
                    "correction from_entity does not match the current Entity",
                ));
            }
            (
                to_entity_id.clone(),
                Some(from_entity_id.clone()),
                *resolver_tier,
                basis_event_ids,
                "correct",
            )
        }
    };

    if !state.entities.contains_key(&to_entity) {
        return Err(refused(format!("target Entity {to_entity} does not exist")));
    }
    for id in basis {
        if staged.contains(id) {
            return Err(refused(
                "same-batch basis events are not permitted in resolution proofs",
            ));
        }
    }
    let correcting = action == "correct";
    verify_tier_proof(state, tier, basis, &raw_ref, &to_entity, correcting)?;

    let observation_entry = state
        .observations
        .get_mut(&body.observation_event_id)
        .expect("observation exists");
    observation_entry.effective_entity = Some(to_entity.clone());
    observation_entry.effective_resolution_event = Some(frame.event_id.clone());
    state.resolutions.push(ResolutionRow {
        seq: frame.seq,
        event_id: frame.event_id.clone(),
        observation_event_id: body.observation_event_id.clone(),
        action: action.to_string(),
        from_entity_id: from_entity,
        to_entity_id: to_entity,
        resolver_tier: tier,
    });
    state.bump_version("observation", &body.observation_event_id, &frame.event_id);
    Ok(())
}

/// The exact tier contract from the design. `correcting` switches exact_id
/// from the raw_ref self-proof to a one-event Entity-registration proof.
fn verify_tier_proof(
    state: &EpistemicState,
    tier: ResolverTier,
    basis: &[String],
    raw_ref: &str,
    target_entity: &str,
    correcting: bool,
) -> Result<(), Refusal> {
    match tier {
        ResolverTier::ExactId => {
            if correcting {
                let event = &basis[0]; // cardinality 1 is structural
                let (entity, _) = state.entity_registrations.get(event).ok_or_else(|| {
                    refused("exact_id correction basis is not an Entity-registering event")
                })?;
                if entity != target_entity {
                    return Err(refused(
                        "exact_id correction basis registers a different Entity",
                    ));
                }
            } else if raw_ref != target_entity {
                return Err(refused(
                    "exact_id attach requires raw_ref to equal the entity id exactly",
                ));
            }
        }
        ResolverTier::KnownAlias => {
            let event = &basis[0];
            let (entity, normalized) = state
                .alias_events
                .get(event)
                .ok_or_else(|| refused("known_alias basis is not an entity.alias_added event"))?;
            if normalized != &schema::normalize_alias_v1(raw_ref) {
                return Err(refused(
                    "known_alias basis does not match the normalized mention",
                ));
            }
            if entity != target_entity {
                return Err(refused("known_alias basis names a different Entity"));
            }
        }
        ResolverTier::ExplicitRelation => {
            let mut prev_to: Option<&str> = None;
            for event in basis {
                let relation_id = state.relation_add_events.get(event).ok_or_else(|| {
                    refused("explicit_relation basis is not a belief.relation add event")
                })?;
                let relation = state.relations.get(relation_id).expect("indexed relation");
                if !relation.live || &relation.last_add_event_id != event {
                    return Err(refused(
                        "explicit_relation basis relation is not currently live",
                    ));
                }
                if let Some(prev) = prev_to {
                    if relation.from != prev {
                        return Err(refused("explicit_relation path is not continuous"));
                    }
                }
                prev_to = Some(relation.to.as_str());
            }
            let terminal_belief = prev_to.expect("non-empty basis is structural");
            let belief = state
                .beliefs
                .get(terminal_belief)
                .ok_or_else(|| refused("explicit_relation path ends at no committed Belief"))?;
            if belief.entity_id != target_entity {
                return Err(refused(
                    "explicit_relation path does not end at the target Entity's Belief",
                ));
            }
        }
        ResolverTier::NormalizedMatch => {
            let event = &basis[0];
            let (entity, aliases) = state.entity_registrations.get(event).ok_or_else(|| {
                refused("normalized_match basis is not an Entity-registering event")
            })?;
            if entity != target_entity {
                return Err(refused(
                    "normalized_match basis registers a different Entity",
                ));
            }
            let mention = schema::normalize_alias_v1(raw_ref);
            if !aliases
                .iter()
                .any(|alias| schema::normalize_alias_v1(alias) == mention)
            {
                return Err(refused(
                    "no preserved source alias in the basis event normalizes to the mention",
                ));
            }
        }
    }
    Ok(())
}

fn apply_independence(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::IndependenceRecorded,
) -> Result<(), Refusal> {
    let left = state
        .observations
        .get(&body.left_observation_event_id)
        .ok_or_else(|| refused("left independence endpoint is not an Observation"))?
        .clone();
    let right = state
        .observations
        .get(&body.right_observation_event_id)
        .ok_or_else(|| refused("right independence endpoint is not an Observation"))?
        .clone();

    let (proof_left, proof_right) = body.proof.registration_refs();
    if proof_left != left.source_registration_event_id
        || proof_right != right.source_registration_event_id
    {
        return Err(refused(
            "proof registration refs do not match the endpoints' pinned registrations",
        ));
    }

    // Shared ancestry proves known_same_lineage and wins over any claim.
    let left_ancestors = ancestors(state, &left.event_id);
    let right_ancestors = ancestors(state, &right.event_id);
    if !left_ancestors.is_disjoint(&right_ancestors) {
        return Err(refused(
            "endpoints share lineage ancestry — known_same_lineage, never independent",
        ));
    }

    let pair = ordered_pair(&left.event_id, &right.event_id);
    if state.independence.contains_key(&pair) {
        return Err(refused("independence for this pair is already recorded"));
    }

    let proof_kind = match &body.proof {
        IndependenceProof::DistinctFirsthandOrigin { .. } => {
            for endpoint in [&left, &right] {
                if endpoint.authority != Some(AuthorityProvenance::TrustedHumanCapture) {
                    return Err(refused(
                        "distinct_firsthand_origin requires two trusted human captures",
                    ));
                }
                if endpoint.assertion_basis != Some(AssertionBasis::Firsthand) {
                    return Err(refused(
                        "distinct_firsthand_origin requires assertion_basis firsthand on both",
                    ));
                }
            }
            let left_actor = registered_actor(state, &left.source_id);
            let right_actor = registered_actor(state, &right.source_id);
            match (left_actor, right_actor) {
                (Some(a), Some(b)) if a != b => {}
                _ => {
                    return Err(refused(
                        "distinct_firsthand_origin requires two DIFFERENT registered actors",
                    ))
                }
            }
            "distinct_firsthand_origin"
        }
        IndependenceProof::IndependentSystemArtifact { .. } => {
            for endpoint in [&left, &right] {
                if endpoint.authority != Some(AuthorityProvenance::RegisteredDirectArtifact) {
                    return Err(refused(
                        "independent_system_artifact requires two registered direct artifacts",
                    ));
                }
            }
            let left_domain = registered_domain(state, &left.source_id);
            let right_domain = registered_domain(state, &right.source_id);
            match (left_domain, right_domain) {
                (Some(a), Some(b)) if a != b => {}
                _ => {
                    return Err(refused(
                        "independent_system_artifact requires two DIFFERENT non-null \
                         independence domains",
                    ))
                }
            }
            "independent_system_artifact"
        }
        IndependenceProof::HumanConfirmed { .. } => {
            return Err(refused(
                "human_confirmed independence is reserved until M24",
            ))
        }
    };

    state.independence.insert(
        pair,
        IndependenceRow {
            event_id: frame.event_id.clone(),
            proof_kind: proof_kind.to_string(),
        },
    );
    state.bump_version("observation", &left.event_id, &frame.event_id);
    state.bump_version("observation", &right.event_id, &frame.event_id);
    Ok(())
}

fn registered_actor<'a>(state: &'a EpistemicState, source_id: &str) -> Option<&'a str> {
    match &state.sources.get(source_id)?.registration {
        schema::SourceRegistration::HumanActor { actor_id, .. } => Some(actor_id),
        _ => None,
    }
}

fn registered_domain<'a>(state: &'a EpistemicState, source_id: &str) -> Option<&'a str> {
    state
        .sources
        .get(source_id)?
        .registration
        .independence_domain_id()
}

fn ordered_pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Transitive lineage closure INCLUDING the observation itself.
fn ancestors(state: &EpistemicState, event_id: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![event_id.to_string()];
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(observation) = state.observations.get(&id) {
            for (_, parent) in &observation.lineage_parents {
                stack.push(parent.clone());
            }
        }
    }
    seen
}

fn validate_basis_links(state: &EpistemicState, basis: &BeliefBasis) -> Result<(), Refusal> {
    if let BeliefBasis::Linked { links } = basis {
        for link in links {
            let observation = state
                .observations
                .get(&link.observation_event_id)
                .ok_or_else(|| {
                    refused(format!(
                    "basis link {} is not an Observation — attestations and overrides are never \
                     evidence",
                    link.observation_event_id
                ))
                })?;
            if matches!(
                link.role,
                schema::BasisRole::Supports | schema::BasisRole::Opposes
            ) && !observation.kind.is_assertion()
            {
                return Err(refused(
                    "supports/opposes may target only assertion Observations; context may target \
                     any",
                ));
            }
        }
    }
    Ok(())
}

fn apply_belief_created(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefCreated,
) -> Result<(), Refusal> {
    if state.beliefs.contains_key(&body.belief_id) {
        return Err(refused(format!("belief {} already exists", body.belief_id)));
    }
    validate_basis_links(state, &body.basis)?;
    let SubjectRef::Resolved { entity_id, aliases } = &body.subject else {
        return Err(refused("belief.created subject must be resolved"));
    };
    if !state.entities.contains_key(entity_id) {
        state.entities.insert(
            entity_id.clone(),
            EntityState {
                entity_id: entity_id.clone(),
                registered_by_event_id: frame.event_id.clone(),
            },
        );
        state.create_version("entity", entity_id, &frame.event_id);
    }
    // The projection-path claim: the first `.md` subject alias names the
    // knowledge-relative file this Belief projects to. One Belief per path.
    let path = aliases.iter().find(|a| a.ends_with(".md")).cloned();
    if let Some(path) = &path {
        if let Some(holder) = state.projection_paths.get(path) {
            return Err(refused(format!(
                "projection path {path:?} is already claimed by belief {holder}"
            )));
        }
        state
            .projection_paths
            .insert(path.clone(), body.belief_id.clone());
    }
    state
        .entity_registrations
        .insert(frame.event_id.clone(), (entity_id.clone(), aliases.clone()));
    state.beliefs.insert(
        body.belief_id.clone(),
        BeliefState {
            belief_id: body.belief_id.clone(),
            entity_id: entity_id.clone(),
            created_event_id: frame.event_id.clone(),
            revisions: vec![RevisionState {
                revision: 1,
                event_id: frame.event_id.clone(),
                content: body.content.clone(),
                fields: body.fields.clone(),
                basis: body.basis.clone(),
            }],
            attested: None,
            attestation_events: Vec::new(),
            path,
            overrides: Vec::new(),
            override_head_event: None,
            projection_head_event: frame.event_id.clone(),
            // A created Belief is active and draft. Both facts are load
            // bearing: promotion's only legal source is `draft`, and
            // supersede's only legal source is `active`.
            qualification: schema::Qualification::Draft,
            lifecycle: schema::Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: Vec::new(),
        },
    );
    state
        .belief_revision_events
        .insert(frame.event_id.clone(), (body.belief_id.clone(), 1));
    state.create_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

fn apply_belief_revised(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefRevised,
) -> Result<(), Refusal> {
    validate_basis_links(state, &body.basis)?;
    let belief = state
        .beliefs
        .get(&body.belief_id)
        .ok_or_else(|| refused(format!("belief {} does not exist", body.belief_id)))?;
    let prior = belief.current().clone();

    let mut content = prior.content.clone();
    let mut fields = prior.fields.clone();
    let mut content_changed = false;
    for op in &body.patch {
        let changed = apply_patch_op(&mut content, &mut fields, op)?;
        content_changed = content_changed || changed;
    }
    let basis_changed = serde_json::to_string(&body.basis).map_err(|e| refused(e.to_string()))?
        != serde_json::to_string(&prior.basis).map_err(|e| refused(e.to_string()))?;
    if !content_changed && !basis_changed {
        return Err(refused(
            "a revision that changes neither content nor canonical basis is a total no-op",
        ));
    }

    let revision = prior.revision + 1;
    let belief = state
        .beliefs
        .get_mut(&body.belief_id)
        .expect("checked above");
    belief.revisions.push(RevisionState {
        revision,
        event_id: frame.event_id.clone(),
        content,
        fields,
        basis: body.basis.clone(),
    });
    // A revision never silently clears a human overlay: it stays active and
    // is marked stale against its base revision (M26 maintenance's queue).
    for override_state in &mut belief.overrides {
        override_state.stale = true;
    }
    belief.projection_head_event = frame.event_id.clone();
    state
        .belief_revision_events
        .insert(frame.event_id.clone(), (body.belief_id.clone(), revision));
    state.bump_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

/// One patch op against canonical belief state. Returns whether it changed
/// anything. `before` must match prior state exactly — a stale patch is a
/// refusal, never a merge.
fn apply_patch_op(
    content: &mut String,
    fields: &mut serde_json::Value,
    op: &schema::PatchOp,
) -> Result<bool, Refusal> {
    if op.field_path == "/body" {
        let current = TypedValue::string(content);
        if op.before != current {
            return Err(refused("patch before-value does not match the prior body"));
        }
        let TypedValue::String { value } = &op.after else {
            return Err(refused(
                "the body is a string and cannot be removed or retyped",
            ));
        };
        let changed = value != content;
        *content = value.clone();
        return Ok(changed);
    }
    // /fields/... — navigate below the fields object.
    let tokens: Vec<String> = op
        .field_path
        .strip_prefix("/fields/")
        .expect("structural validation pinned the prefix")
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    let current = typed_at(fields, &tokens);
    if op.before != current {
        return Err(refused(format!(
            "patch before-value does not match prior state at {}",
            op.field_path
        )));
    }
    let changed = op.before != op.after;
    set_typed_at(fields, &tokens, &op.after)?;
    Ok(changed)
}

/// The typed view of the value at a pointer path; Missing when absent.
fn typed_at(fields: &serde_json::Value, tokens: &[String]) -> TypedValue {
    let mut cursor = fields;
    for token in tokens {
        match cursor {
            serde_json::Value::Object(map) => match map.get(token) {
                Some(next) => cursor = next,
                None => return TypedValue::Missing,
            },
            serde_json::Value::Array(items) => {
                match token.parse::<usize>().ok().and_then(|i| items.get(i)) {
                    Some(next) => cursor = next,
                    None => return TypedValue::Missing,
                }
            }
            _ => return TypedValue::Missing,
        }
    }
    typed_from_value(cursor)
}

pub(crate) fn typed_from_value(value: &serde_json::Value) -> TypedValue {
    match value {
        serde_json::Value::Null => TypedValue::Null { value: () },
        serde_json::Value::Bool(b) => TypedValue::Boolean { value: *b },
        serde_json::Value::Number(n) => TypedValue::Number { value: n.clone() },
        serde_json::Value::String(s) => TypedValue::String { value: s.clone() },
        serde_json::Value::Array(items) => TypedValue::Array {
            value: items.iter().map(typed_from_value).collect(),
        },
        serde_json::Value::Object(map) => TypedValue::Object {
            value: map
                .iter()
                .map(|(k, v)| (k.clone(), typed_from_value(v)))
                .collect(),
        },
    }
}

fn value_from_typed(value: &TypedValue) -> serde_json::Value {
    match value {
        TypedValue::Missing => serde_json::Value::Null, // callers handle Missing before this
        TypedValue::Null { .. } => serde_json::Value::Null,
        TypedValue::Boolean { value } => serde_json::Value::Bool(*value),
        TypedValue::Number { value } => serde_json::Value::Number(value.clone()),
        TypedValue::String { value } => serde_json::Value::String(value.clone()),
        TypedValue::Array { value } => {
            serde_json::Value::Array(value.iter().map(value_from_typed).collect())
        }
        TypedValue::Object { value } => serde_json::Value::Object(
            value
                .iter()
                .map(|(k, v)| (k.clone(), value_from_typed(v)))
                .collect(),
        ),
    }
}

/// Set (or remove, when `after` is Missing) the value at the path. Only the
/// LAST segment may be created; a missing parent is a refusal.
fn set_typed_at(
    fields: &mut serde_json::Value,
    tokens: &[String],
    after: &TypedValue,
) -> Result<(), Refusal> {
    let (last, parents) = tokens
        .split_last()
        .expect("field paths have at least one token");
    let mut cursor = fields;
    for token in parents {
        cursor = match cursor {
            serde_json::Value::Object(map) => map
                .get_mut(token)
                .ok_or_else(|| refused(format!("patch parent {token:?} does not exist")))?,
            serde_json::Value::Array(items) => token
                .parse::<usize>()
                .ok()
                .and_then(|i| items.get_mut(i))
                .ok_or_else(|| refused(format!("patch parent index {token:?} does not exist")))?,
            _ => {
                return Err(refused(format!(
                    "patch parent {token:?} is not a container"
                )))
            }
        };
    }
    match cursor {
        serde_json::Value::Object(map) => {
            if matches!(after, TypedValue::Missing) {
                map.shift_remove(last);
            } else {
                map.insert(last.clone(), value_from_typed(after));
            }
            Ok(())
        }
        serde_json::Value::Array(items) => {
            let index = last
                .parse::<usize>()
                .ok()
                .filter(|i| *i < items.len())
                .ok_or_else(|| refused(format!("patch index {last:?} is out of range")))?;
            if matches!(after, TypedValue::Missing) {
                items.remove(index);
            } else {
                items[index] = value_from_typed(after);
            }
            Ok(())
        }
        _ => Err(refused("patch target parent is not a container")),
    }
}

fn apply_relation(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefRelation,
) -> Result<(), Refusal> {
    for endpoint in [&body.from, &body.to] {
        if !state.beliefs.contains_key(endpoint) {
            return Err(refused(format!(
                "relation endpoint {endpoint} names no committed Belief — a relation can never \
                 precede its endpoints"
            )));
        }
    }
    match body.action {
        RelationAction::Add => {
            if let Some(existing) = state.relations.get_mut(&body.relation_id) {
                if existing.live {
                    return Err(refused("relation is already live — duplicate add"));
                }
                existing.live = true;
                existing.last_add_event_id = frame.event_id.clone();
                existing.last_event_id = frame.event_id.clone();
                state
                    .relation_add_events
                    .insert(frame.event_id.clone(), body.relation_id.clone());
                state.bump_version("relation", &body.relation_id, &frame.event_id);
            } else {
                state.relations.insert(
                    body.relation_id.clone(),
                    RelationState {
                        relation_id: body.relation_id.clone(),
                        from: body.from.clone(),
                        to: body.to.clone(),
                        relation: body.relation,
                        live: true,
                        last_add_event_id: frame.event_id.clone(),
                        last_event_id: frame.event_id.clone(),
                    },
                );
                state
                    .relation_add_events
                    .insert(frame.event_id.clone(), body.relation_id.clone());
                state.create_version("relation", &body.relation_id, &frame.event_id);
            }
        }
        RelationAction::Remove => {
            let existing = state
                .relations
                .get_mut(&body.relation_id)
                .filter(|r| r.live)
                .ok_or_else(|| refused("remove requires the matching LIVE relation"))?;
            existing.live = false;
            existing.last_event_id = frame.event_id.clone();
            state.bump_version("relation", &body.relation_id, &frame.event_id);
        }
    }
    // Both transitions move the FROM Belief's projection identity — a
    // remove changes what the renderer's relation state says even when the
    // resulting bytes match an older projection.
    if let Some(belief) = state.beliefs.get_mut(&body.from) {
        belief.projection_head_event = frame.event_id.clone();
    }
    Ok(())
}

fn apply_attested(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::BeliefAttested,
    staged: &Staged,
) -> Result<(), Refusal> {
    if staged.contains(&body.attested_belief_revision_event_id) {
        return Err(refused(
            "attestation must pin a COMMITTED revision, not a staged one",
        ));
    }
    let (belief_id, revision_no) = state
        .belief_revision_events
        .get(&body.attested_belief_revision_event_id)
        .ok_or_else(|| refused("attested_belief_revision_event_id names no committed revision"))?
        .clone();
    if belief_id != body.belief_id {
        return Err(refused("the pinned revision belongs to a different Belief"));
    }
    let belief = state
        .beliefs
        .get(&body.belief_id)
        .expect("revision index implies belief");
    let revision = belief
        .revisions
        .iter()
        .find(|r| r.revision == revision_no)
        .expect("revision index is consistent");
    let projected = super::project::project(&revision.content, &revision.fields);
    let expected = schema::belief::attested_content_hash(projected.as_bytes());
    if body.attested_content_hash != expected {
        return Err(refused(
            "attested_content_hash does not match the projection of the pinned revision — the \
             id/hash pair must name the same committed revision",
        ));
    }
    let belief = state
        .beliefs
        .get_mut(&body.belief_id)
        .expect("checked above");
    belief.attested = Some((
        frame.event_id.clone(),
        body.attested_belief_revision_event_id.clone(),
    ));
    belief.attestation_events.push(frame.event_id.clone());
    belief.projection_head_event = frame.event_id.clone();
    state.bump_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

fn apply_alias(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::EntityAliasAdded,
) -> Result<(), Refusal> {
    if !state.entities.contains_key(&body.entity_id) {
        return Err(refused(format!(
            "alias registration names unknown Entity {}",
            body.entity_id
        )));
    }
    if let Some(existing) = state.alias_registry.get(&body.normalized_alias) {
        return Err(refused(if existing.entity_id == body.entity_id {
            format!(
                "alias {:?} is already registered on this Entity",
                body.normalized_alias
            )
        } else {
            format!(
                "alias {:?} is already live on a different Entity — refused, never guessed",
                body.normalized_alias
            )
        }));
    }
    state.alias_registry.insert(
        body.normalized_alias.clone(),
        AliasState {
            normalized: body.normalized_alias.clone(),
            alias: body.alias.clone(),
            entity_id: body.entity_id.clone(),
            event_id: frame.event_id.clone(),
        },
    );
    state.alias_events.insert(
        frame.event_id.clone(),
        (body.entity_id.clone(), body.normalized_alias.clone()),
    );
    // A live subject alias is descriptor state for every Belief about the
    // Entity: their projection identity advances even byte-identically.
    for belief in state.beliefs.values_mut() {
        if belief.entity_id == body.entity_id {
            belief.projection_head_event = frame.event_id.clone();
        }
    }
    state.bump_version("entity", &body.entity_id, &frame.event_id);
    Ok(())
}

fn apply_migration_started(
    state: &mut EpistemicState,
    body: &schema::MigrationStarted,
) -> Result<(), Refusal> {
    if let Some(epoch) = &state.migration {
        if !epoch.completed && epoch.source_digest != body.source_digest {
            return Err(refused(
                "migration source digest changed mid-epoch — reconciliation, never a second epoch",
            ));
        }
        if epoch.source_digest == body.source_digest {
            return Err(refused("migration already started for this corpus"));
        }
    }
    state.migration = Some(MigrationEpoch {
        store_uuid: body.store_uuid.clone(),
        source_digest: body.source_digest.clone(),
        planned_output_count: body.planned_output_count,
        completed: false,
    });
    Ok(())
}

fn apply_migration_completed(
    state: &mut EpistemicState,
    body: &schema::MigrationCompleted,
) -> Result<(), Refusal> {
    let epoch = state
        .migration
        .as_mut()
        .ok_or_else(|| refused("migration.completed without migration.started"))?;
    if epoch.store_uuid != body.store_uuid || epoch.source_digest != body.source_digest {
        return Err(refused(
            "migration.completed does not agree with the started identity/digest",
        ));
    }
    if body.output_count != epoch.planned_output_count {
        return Err(refused(format!(
            "migration.completed output_count {} disagrees with the started plan {}",
            body.output_count, epoch.planned_output_count
        )));
    }
    epoch.completed = true;
    Ok(())
}

/// Apply one overlay op WITHOUT preconditions: overlays are presentation
/// state, so an op a later revision made inapplicable (missing parent,
/// retyped body) is skipped deterministically, never an error.
pub(crate) fn apply_overlay_op(
    content: &mut String,
    fields: &mut serde_json::Value,
    op: &schema::OverridePatchOp,
) {
    if op.field_path == "/body" {
        if let TypedValue::String { value } = &op.after {
            *content = value.clone();
        }
        return;
    }
    let tokens: Vec<String> = op
        .field_path
        .strip_prefix("/fields/")
        .expect("override pointers are /body or /fields/…")
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect();
    let _ = set_typed_at(fields, &tokens, &op.after);
}

fn apply_override(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ProjectionOverridden,
) -> Result<(), Refusal> {
    let belief = state
        .beliefs
        .get(&body.belief_id)
        .ok_or_else(|| refused(format!("belief {} does not exist", body.belief_id)))?;
    match &belief.path {
        Some(path) if path == &body.path => {}
        Some(path) => {
            return Err(refused(format!(
                "override path {:?} does not match the Belief's projection path {path:?}",
                body.path
            )))
        }
        None => {
            return Err(refused(
                "the Belief is not a projection — it claimed no projection path at creation",
            ))
        }
    }
    let current = belief.current();
    if body.base_belief_revision != current.revision
        || body.base_belief_revision_event != current.event_id
    {
        return Err(refused(format!(
            "override base r{} ({}) is not the current revision r{} ({}) — wrong base",
            body.base_belief_revision,
            body.base_belief_revision_event,
            current.revision,
            current.event_id
        )));
    }
    if body.base_generating_event != belief.projection_head_event {
        return Err(refused(format!(
            "override base generating event {} is not the projection head {} — the projection \
             state advanced (possibly byte-identically) since this edit was computed",
            body.base_generating_event, belief.projection_head_event
        )));
    }
    let before_bytes = projected_bytes(state, belief);
    if crate::ledger::sha256_hex(before_bytes.as_bytes()) != body.before_projection_hash {
        return Err(refused(
            "before_projection_hash does not match the current projection",
        ));
    }

    // Build the next overlay list on the side; nothing mutates until every
    // check (after-hash included) has passed.
    let mut next = belief.overrides.clone();
    match &body.change {
        schema::OverrideChange::Set {
            patch,
            supersedes_override_event_ids,
        } => {
            for id in supersedes_override_event_ids {
                if !next.iter().any(|o| &o.event_id == id) {
                    return Err(refused(format!(
                        "supersedes names {id}, which is not an active override"
                    )));
                }
            }
            // Every op's before must match the CURRENT overlaid projection
            // state — a stale edit is a refusal, never a merge.
            let (content, overlaid_fields) = overlaid(state, belief);
            for op in patch {
                let current_value = if op.field_path == "/body" {
                    TypedValue::string(&content)
                } else {
                    let tokens: Vec<String> = op
                        .field_path
                        .strip_prefix("/fields/")
                        .expect("validated pointer")
                        .split('/')
                        .map(|t| t.replace("~1", "/").replace("~0", "~"))
                        .collect();
                    typed_at(&overlaid_fields, &tokens)
                };
                if op.before != current_value {
                    return Err(refused(format!(
                        "override before-value does not match the projected state at {}",
                        op.field_path
                    )));
                }
                if op.field_path == "/body" && !matches!(op.after, TypedValue::String { .. }) {
                    return Err(refused("the body override must stay a string"));
                }
            }
            next.retain(|o| !supersedes_override_event_ids.contains(&o.event_id));
            next.push(OverrideState {
                event_id: frame.event_id.clone(),
                base_belief_revision: current.revision,
                patch: patch.clone(),
                stale: false,
            });
        }
        schema::OverrideChange::Clear {
            override_event_ids, ..
        } => {
            for id in override_event_ids {
                if !next.iter().any(|o| &o.event_id == id) {
                    return Err(refused(format!(
                        "clear names {id}, which is not an active override"
                    )));
                }
            }
            next.retain(|o| !override_event_ids.contains(&o.event_id));
        }
    }

    // The after-hash proof: the declared bytes must be exactly what the
    // new overlay projects (review overlay included).
    let mut content = current.content.clone();
    let mut fields = current.fields.clone();
    apply_review_overlay(state, belief, &mut fields);
    for override_state in &next {
        for op in &override_state.patch {
            apply_overlay_op(&mut content, &mut fields, op);
        }
    }
    let after_bytes = super::project::project(&content, &fields);
    if crate::ledger::sha256_hex(after_bytes.as_bytes()) != body.after_projection_hash {
        return Err(refused(
            "after_projection_hash does not reproduce from the declared overlay change",
        ));
    }

    let belief = state
        .beliefs
        .get_mut(&body.belief_id)
        .expect("checked above");
    belief.overrides = next;
    belief.override_head_event = Some(frame.event_id.clone());
    belief.projection_head_event = frame.event_id.clone();
    // Canonical projection state changed: the Belief version advances once,
    // whichever arm ran. Never an Observation, basis, lineage, support, or
    // independence effect — overrides are not evidence.
    state.bump_version("belief", &body.belief_id, &frame.event_id);
    Ok(())
}

fn apply_divergence(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::LedgerDivergence,
) -> Result<(), Refusal> {
    if state
        .reconciliation_divergences
        .contains_key(&body.detection_key)
    {
        return Err(refused(format!(
            "detection key {} is already open — one divergence event per unresolved condition",
            body.detection_key
        )));
    }
    // Open (or absorb into) the one reconciliation mode. No registered
    // target: divergence has no version effect.
    state
        .reconciliation_divergences
        .insert(body.detection_key.clone(), frame.event_id.clone());
    Ok(())
}

fn apply_reconciliation_resolved(
    state: &mut EpistemicState,
    frame: &Frame,
    body: &schema::ReconciliationResolved,
) -> Result<(), Refusal> {
    if !state
        .reconciliation_divergences
        .values()
        .any(|event| event == &body.divergence_event_id)
    {
        return Err(refused(format!(
            "divergence {} is not active — wrong or stale resolution",
            body.divergence_event_id
        )));
    }
    // The digest proof: every affected path must be a known projection, and
    // the staged/current reducer projections over those paths must equal the
    // declared resulting digest. A prose-only event cannot bless bytes that
    // were never translated into ledger state.
    let mut entries: Vec<serde_json::Value> = Vec::with_capacity(body.affected_paths.len());
    for path in &body.affected_paths {
        let belief_id = state.projection_paths.get(path).ok_or_else(|| {
            refused(format!(
                "affected path {path:?} is not a known projection — nothing proves its bytes"
            ))
        })?;
        let belief = state
            .beliefs
            .get(belief_id)
            .expect("path index is consistent");
        let projected = projected_bytes(state, belief);
        entries.push(serde_json::json!({
            "path": path,
            "content_hash": crate::ledger::sha256_hex(projected.as_bytes()),
        }));
    }
    let digest = crate::ledger::sha256_hex(
        serde_json::to_string(&entries)
            .map_err(|e| refused(e.to_string()))?
            .as_bytes(),
    );
    if digest != body.resulting_projection_digest {
        return Err(refused(
            "resulting_projection_digest does not match the reducer projections over the \
             affected paths",
        ));
    }
    // Close the mode: every unresolved condition is either explained by the
    // adoption batch this member rode in on or regenerated by restore.
    state.reconciliation_divergences.clear();
    state.reconciliation_log.push(ReconciliationLogRow {
        event_id: frame.event_id.clone(),
        divergence_event_id: body.divergence_event_id.clone(),
        action: body.action,
    });
    Ok(())
}

/// The canonical JSON view of reduced state for conformance vectors
/// (M22.4): every table the TS reducer must reproduce, keys sorted by the
/// BTreeMap iteration this state is built on. Refusal identity for parity
/// is `(seq, event_id, batch_id, code)` — detail strings are prose for
/// humans and are NOT part of the cross-implementation contract.
pub fn vector_state(state: &EpistemicState) -> serde_json::Value {
    let sources: serde_json::Map<String, serde_json::Value> = state
        .sources
        .values()
        .map(|s| {
            (
                s.source_id.clone(),
                serde_json::json!({
                    "source_key": s.registration.source_key(),
                    "kind": s.registration.kind_str(),
                    "capability": capability_name(s.registration.capability()),
                    "independence_domain_id": s.registration.independence_domain_id(),
                    "registration_event_id": s.registration_event_id,
                }),
            )
        })
        .collect();
    let entities: serde_json::Map<String, serde_json::Value> = state
        .entities
        .values()
        .map(|e| {
            (
                e.entity_id.clone(),
                serde_json::json!(e.registered_by_event_id),
            )
        })
        .collect();
    let aliases: serde_json::Map<String, serde_json::Value> = state
        .alias_registry
        .values()
        .map(|a| {
            (
                a.normalized.clone(),
                serde_json::json!({ "alias": a.alias, "entity_id": a.entity_id, "event_id": a.event_id }),
            )
        })
        .collect();
    let observations: serde_json::Map<String, serde_json::Value> = state
        .observations
        .values()
        .map(|o| {
            (
                o.event_id.clone(),
                serde_json::json!({
                    "seq": o.seq,
                    "kind": kind_name(o.kind),
                    "source_id": o.source_id,
                    "subject": subject_name(&o.subject),
                    "effective_entity": o.effective_entity,
                    "effective_resolution_event": o.effective_resolution_event,
                    "authority": o.authority.map(authority_name),
                    "lineage": o
                        .lineage_parents
                        .iter()
                        .map(|(edge, parent)| serde_json::json!([edge_name(*edge), parent]))
                        .collect::<Vec<_>>(),
                }),
            )
        })
        .collect();
    let beliefs: serde_json::Map<String, serde_json::Value> = state
        .beliefs
        .values()
        .map(|b| {
            let current = b.current();
            let described = descriptor(state, b);
            (
                b.belief_id.clone(),
                serde_json::json!({
                    "entity_id": b.entity_id,
                    "revision": current.revision,
                    "content": current.content,
                    "fields": current.fields,
                    "basis": current.basis,
                    "attested": b.attested.as_ref().map(|(e, r)| serde_json::json!([e, r])),
                    "revision_events": b
                        .revisions
                        .iter()
                        .map(|r| r.event_id.clone())
                        .collect::<Vec<_>>(),
                    // The full projection identity (M23.1): head, state
                    // digest, overlaid bytes hash, and overlay listing.
                    "projection": {
                        "path": b.path,
                        "generating_event": b.projection_head_event,
                        "state_digest": described.digest().unwrap_or_default(),
                        "content_hash": crate::ledger::sha256_hex(projected_bytes(state, b).as_bytes()),
                        "review_event_ids": b.attestation_events,
                        "active_overrides": b
                            .overrides
                            .iter()
                            .map(|o| o.event_id.clone())
                            .collect::<Vec<_>>(),
                        "stale_overrides": b
                            .overrides
                            .iter()
                            .filter(|o| o.stale)
                            .map(|o| o.event_id.clone())
                            .collect::<Vec<_>>(),
                        "override_head": b.override_head_event,
                        // Format 2 (M24.3): the governed-state heads.
                        "qualification_head": b.qualification_head_event,
                        "lifecycle_head": b.lifecycle_head_event,
                        "tombstone_event": b.tombstoned_by,
                        "contest_head": b.contest_head_event,
                        "entity_merge_events": b.entity_merge_event_ids,
                    },
                    "governance": {
                        "qualification": match b.qualification {
                            schema::Qualification::Draft => "draft",
                            schema::Qualification::Qualified => "qualified",
                        },
                        "lifecycle": match b.lifecycle {
                            schema::Lifecycle::Active => "active",
                            schema::Lifecycle::Superseded => "superseded",
                            schema::Lifecycle::Archived => "archived",
                        },
                        "tombstoned": b.tombstoned_by.is_some(),
                        "open_contest": b.open_contest_event,
                    },
                }),
            )
        })
        .collect();
    let relations: serde_json::Map<String, serde_json::Value> = state
        .relations
        .values()
        .map(|r| {
            (
                r.relation_id.clone(),
                serde_json::json!({
                    "from": r.from,
                    "to": r.to,
                    "relation": r.relation.as_str(),
                    "live": r.live,
                }),
            )
        })
        .collect();
    serde_json::json!({
        "sources": sources,
        "entities": entities,
        "aliases": aliases,
        "observations": observations,
        "beliefs": beliefs,
        "relations": relations,
        "resolutions": state
            .resolutions
            .iter()
            .map(|r| serde_json::json!([
                r.event_id,
                r.observation_event_id,
                r.action,
                r.from_entity_id,
                r.to_entity_id,
                tier_name(r.resolver_tier),
            ]))
            .collect::<Vec<_>>(),
        "independence": state
            .independence
            .iter()
            .map(|((l, r), row)| serde_json::json!([l, r, row.proof_kind]))
            .collect::<Vec<_>>(),
        "derived_belief_sources": state
            .derived_belief_sources
            .iter()
            .map(|(o, r)| serde_json::json!([o, r]))
            .collect::<Vec<_>>(),
        "versions": state
            .versions
            .iter()
            .map(|((class, id), (version, _))| (format!("{class}:{id}"), serde_json::json!(version)))
            .collect::<serde_json::Map<String, serde_json::Value>>(),
        "batches": state
            .batches
            .iter()
            .map(|b| serde_json::json!([b.batch_id, b.state, b.member_count]))
            .collect::<Vec<_>>(),
        "proposals": state
            .proposals
            .values()
            .map(|p| (
                p.proposal_id.clone(),
                serde_json::json!({
                    "state": match p.state {
                        schema::ProposalState::Submitted => "submitted",
                        schema::ProposalState::Queued => "queued",
                        schema::ProposalState::Rejected => "rejected",
                        schema::ProposalState::Applied => "applied",
                        schema::ProposalState::Reverted => "reverted",
                    },
                    "commit_set_id": p.commit_set_id,
                    "decision": p.decision.as_ref().map(|(id, decision)| serde_json::json!([
                        id,
                        match decision {
                            schema::Decision::Approve => "approve",
                            schema::Decision::Reject => "reject",
                        }
                    ])),
                    "applied_event_id": p.applied_event_id,
                    "has_revert_plan": p.revert_plan.is_some(),
                }),
            ))
            .collect::<serde_json::Map<String, serde_json::Value>>(),
        "reconciliation": {
            "open": state.reconciliation_open(),
            "divergences": state
                .reconciliation_divergences
                .iter()
                .map(|(key, event)| (key.clone(), serde_json::json!(event)))
                .collect::<serde_json::Map<String, serde_json::Value>>(),
            "resolutions": state
                .reconciliation_log
                .iter()
                .map(|r| serde_json::json!([
                    r.event_id,
                    r.divergence_event_id,
                    r.action.as_str(),
                ]))
                .collect::<Vec<_>>(),
        },
    })
}

fn capability_name(c: schema::AuthorityCapability) -> &'static str {
    match c {
        schema::AuthorityCapability::ContentOnly => "content_only",
        schema::AuthorityCapability::HumanAssertion => "human_assertion",
        schema::AuthorityCapability::DirectSystemArtifact => "direct_system_artifact",
    }
}

fn kind_name(k: ObservationKind) -> &'static str {
    match k {
        ObservationKind::SourceSnapshot => "source_snapshot",
        ObservationKind::SystemEvent => "system_event",
        ObservationKind::ExtractedAssertion => "extracted_assertion",
        ObservationKind::DerivedContent => "derived_content",
        ObservationKind::HumanAssertion => "human_assertion",
    }
}

fn subject_name(s: &SubjectRef) -> serde_json::Value {
    match s {
        SubjectRef::Resolved { entity_id, .. } => serde_json::json!(["resolved", entity_id]),
        SubjectRef::Unresolved { raw_ref, .. } => serde_json::json!(["unresolved", raw_ref]),
        SubjectRef::None => serde_json::json!(["none"]),
    }
}

fn authority_name(a: AuthorityProvenance) -> &'static str {
    match a {
        AuthorityProvenance::TrustedHumanCapture => "trusted_human_capture",
        AuthorityProvenance::RegisteredDirectArtifact => "registered_direct_artifact",
        AuthorityProvenance::AgentInferred => "agent_inferred",
    }
}

fn edge_name(e: schema::LineageKind) -> &'static str {
    match e {
        schema::LineageKind::ReportedBy => "reported_by",
        schema::LineageKind::DerivedFrom => "derived_from",
        schema::LineageKind::CopiedFrom => "copied_from",
        schema::LineageKind::SummarizedFrom => "summarized_from",
    }
}

fn tier_name(t: ResolverTier) -> &'static str {
    match t {
        ResolverTier::ExactId => "exact_id",
        ResolverTier::KnownAlias => "known_alias",
        ResolverTier::ExplicitRelation => "explicit_relation",
        ResolverTier::NormalizedMatch => "normalized_match",
    }
}

#[cfg(test)]
mod tests {
    use super::super::writer::{member_ref, LedgerWriter};
    use super::super::{ledger_dir, read_ledger, store};
    use super::*;
    use crate::ledger::schema::{
        derive_relation_id, derive_source_id, Actor, AssertionFields, AssertionKind, BasisLink,
        BasisRole, BeliefAttested, BeliefCreated, BeliefRelation, BeliefRevised, EntityAliasAdded,
        HumanAssertionForm, HumanAssertionPayload, IndependenceRecorded, LineageEdge, LineageKind,
        ObservationRecorded, PatchOp, Provenance, RelationKind, RelationshipToSubject, Scope,
        SourceRegistered, SourceRegistration, SourceSnapshotPayload, SubjectResolved, SubjectRole,
        BODY_SCHEMA,
    };
    use crate::vault::testutil;

    const WRITER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";

    struct Rig {
        vault: std::path::PathBuf,
        writer: LedgerWriter,
        store_id: String,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.vault);
        }
    }

    impl Rig {
        fn new(label: &str) -> Rig {
            let vault = testutil::temp_vault(label);
            let writer = LedgerWriter::open(&vault, WRITER).unwrap();
            let store_id = store::load(&ledger_dir(&vault)).unwrap().unwrap().store_id;
            Rig {
                vault,
                writer,
                store_id,
            }
        }

        fn append<T: serde::Serialize>(&mut self, kind: &str, body: &T) -> String {
            self.writer
                .append(kind, serde_json::to_value(body).unwrap())
                .unwrap()
                .event_id
        }

        fn state(&self) -> EpistemicState {
            let read = read_ledger(&ledger_dir(&self.vault)).unwrap();
            reduce(&read.frames, &self.store_id)
        }

        /// Register a human actor source; returns (source_id, reg event id).
        fn human_source(&mut self, actor_id: &str) -> (String, String) {
            let registration = SourceRegistration::HumanActor {
                source_key: String::new(),
                actor_id: actor_id.to_string(),
                authority_capability: schema::AuthorityCapability::HumanAssertion,
                independence_domain_id: None,
            };
            self.register(registration)
        }

        /// Register a direct-artifact connector; returns (source_id, reg id).
        fn direct_source(&mut self, instance: &str, domain: &str) -> (String, String) {
            let registration = SourceRegistration::Connector {
                source_key: String::new(),
                connector_instance_id: instance.to_string(),
                logical_scope_id: "scope".to_string(),
                authority_capability: schema::AuthorityCapability::DirectSystemArtifact,
                independence_domain_id: Some(domain.to_string()),
            };
            self.register(registration)
        }

        fn content_source(&mut self, service: &str) -> (String, String) {
            let registration = SourceRegistration::Builtin {
                source_key: String::new(),
                service_id: service.to_string(),
                authority_capability: schema::AuthorityCapability::ContentOnly,
                independence_domain_id: None,
            };
            self.register(registration)
        }

        fn register(&mut self, mut registration: SourceRegistration) -> (String, String) {
            let key = registration.derived_source_key().unwrap();
            match &mut registration {
                SourceRegistration::HumanActor { source_key, .. }
                | SourceRegistration::Connector { source_key, .. }
                | SourceRegistration::Builtin { source_key, .. }
                | SourceRegistration::CerebroRuntime { source_key, .. }
                | SourceRegistration::LegacyReference { source_key, .. } => {
                    *source_key = key.clone()
                }
            }
            let source_id = derive_source_id(&self.store_id, &key);
            let body = SourceRegistered {
                schema: BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: Actor {
                    id: schema::ACTOR_SOURCE_REGISTRY.to_string(),
                },
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                source_id: source_id.clone(),
                registration,
            };
            let event = self.append(schema::KIND_SOURCE_REGISTERED, &body);
            (source_id, event)
        }
    }

    fn assertion(authority: schema::AuthorityProvenance, basis: AssertionBasis) -> AssertionFields {
        AssertionFields {
            assertion_kind: AssertionKind::Presence,
            predicate: "status".into(),
            value: TypedValue::string("active"),
            scope: Scope::empty(),
            relationship_to_subject: RelationshipToSubject {
                role: SubjectRole::Unknown,
            },
            assertion_basis: basis,
            authority_provenance: authority,
            absence: None,
        }
    }

    fn observation(
        kind: ObservationKind,
        source: &(String, String),
        actor: &str,
        subject: SubjectRef,
        lineage: Vec<LineageEdge>,
        payload: serde_json::Value,
    ) -> ObservationRecorded {
        ObservationRecorded {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: actor.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            observation_kind: kind,
            source_id: source.0.clone(),
            source_registration_event_id: source.1.clone(),
            subject,
            lineage,
            provenance: Provenance::empty(),
            payload,
        }
    }

    fn snapshot_payload() -> serde_json::Value {
        serde_json::to_value(SourceSnapshotPayload {
            source_artifact_hash: None,
            raw_pointer: "docs/a.md".into(),
        })
        .unwrap()
    }

    fn human_payload(basis: AssertionBasis) -> serde_json::Value {
        serde_json::to_value(HumanAssertionPayload {
            assertion: assertion(schema::AuthorityProvenance::TrustedHumanCapture, basis),
            form: HumanAssertionForm::Standalone {
                intended_belief_id: None,
                corrects: None,
                reason: None,
            },
        })
        .unwrap()
    }

    fn extraction_payload(authority: schema::AuthorityProvenance) -> serde_json::Value {
        serde_json::to_value(schema::ExtractedAssertionPayload {
            assertion: assertion(authority, AssertionBasis::Reported),
            extracted_text: "status is active".into(),
            source_artifact_hash: "a".repeat(64),
            extractor_version: "x1".into(),
            raw_pointer: "mail/1".into(),
        })
        .unwrap()
    }

    const ENTITY: &str = "cccccccccccccccccccccccccccccccc";
    const ENTITY_B: &str = "dddddddddddddddddddddddddddddddd";
    const BELIEF: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const BELIEF_B: &str = "ffffffffffffffffffffffffffffffff";

    fn belief_created(belief_id: &str, entity_id: &str, basis: BeliefBasis) -> BeliefCreated {
        BeliefCreated {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "agent:run-1".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: belief_id.into(),
            subject: SubjectRef::Resolved {
                entity_id: entity_id.into(),
                aliases: vec!["Acme Corp".into()],
            },
            content: "# Acme\n\nActive vendor.\n".into(),
            fields: serde_json::json!({ "status": "active" }),
            basis,
        }
    }

    fn unsupported() -> BeliefBasis {
        BeliefBasis::Unsupported {
            reason: "migrated without observations".into(),
        }
    }

    #[test]
    fn sources_register_once_and_observations_pin_them() {
        let mut rig = Rig::new("reduce-sources");
        let human = rig.human_source("human:josef");
        // A snapshot from the registered source.
        let obs = observation(
            ObservationKind::SourceSnapshot,
            &human,
            "agent:run-1",
            SubjectRef::None,
            vec![],
            snapshot_payload(),
        );
        rig.append(schema::KIND_OBSERVATION_RECORDED, &obs);
        // A forged pin: registration event exists but registers another id.
        let other = rig.content_source("svc.other");
        let mut forged = observation(
            ObservationKind::SourceSnapshot,
            &human,
            "agent:run-1",
            SubjectRef::None,
            vec![],
            snapshot_payload(),
        );
        forged.source_registration_event_id = other.1.clone();
        rig.append(schema::KIND_OBSERVATION_RECORDED, &forged);
        // A duplicate registration of the same source: refused.
        let dup = SourceRegistration::HumanActor {
            source_key: String::new(),
            actor_id: "human:josef".into(),
            authority_capability: schema::AuthorityCapability::HumanAssertion,
            independence_domain_id: None,
        };
        rig.register(dup);

        let state = rig.state();
        assert_eq!(state.sources.len(), 2);
        assert_eq!(state.observations.len(), 1);
        assert_eq!(
            state.version("source", &human.0),
            Some(2),
            "register + one observation"
        );
        assert_eq!(
            state.anomalies.len(),
            2,
            "forged pin and duplicate registration: {:?}",
            state.anomalies
        );
        assert!(state.anomalies[0].detail.contains("registers source"));
        assert!(state.anomalies[1].detail.contains("already registered"));
    }

    #[test]
    fn authority_is_derived_from_registration_never_claimed() {
        let mut rig = Rig::new("reduce-authority");
        let human = rig.human_source("human:josef");
        let direct = rig.direct_source("conn-1", "domain-github");
        let content = rig.content_source("svc.mail");

        // Trusted human capture: right actor, right kind, right capability.
        let ok = observation(
            ObservationKind::HumanAssertion,
            &human,
            "human:josef",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            vec![],
            human_payload(AssertionBasis::Firsthand),
        );
        rig.append(schema::KIND_OBSERVATION_RECORDED, &ok);

        // The same claim from the WRONG actor is a forgery.
        let mut forged = ok.clone();
        forged.actor = Actor {
            id: "agent:sneaky".into(),
        };
        rig.append(schema::KIND_OBSERVATION_RECORDED, &forged);

        // Direct artifact: extraction from the direct-capability source.
        let mut extraction = observation(
            ObservationKind::ExtractedAssertion,
            &direct,
            "agent:run-1",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            vec![],
            extraction_payload(schema::AuthorityProvenance::RegisteredDirectArtifact),
        );
        // ...but it needs lineage; give it the trusted observation's parent.
        let state = rig.state();
        let parent = state
            .observations
            .keys()
            .next()
            .expect("one observation committed")
            .clone();
        extraction.lineage = vec![LineageEdge {
            edge: LineageKind::ReportedBy,
            parent_observation_event_id: parent.clone(),
        }];
        rig.append(schema::KIND_OBSERVATION_RECORDED, &extraction);

        // A content-only source cannot be upgraded to direct authority.
        let mut upgraded = extraction.clone();
        upgraded.source_id = content.0.clone();
        upgraded.source_registration_event_id = content.1.clone();
        rig.append(schema::KIND_OBSERVATION_RECORDED, &upgraded);

        // Nor may direct-artifact content downgrade itself.
        let mut downgraded = extraction.clone();
        downgraded.payload = extraction_payload(schema::AuthorityProvenance::AgentInferred);
        rig.append(schema::KIND_OBSERVATION_RECORDED, &downgraded);

        let state = rig.state();
        assert_eq!(state.observations.len(), 2, "trusted + direct committed");
        let refusals: Vec<&str> = state.anomalies.iter().map(|a| a.detail.as_str()).collect();
        assert_eq!(refusals.len(), 3, "{refusals:?}");
        assert!(
            refusals.iter().all(|d| d.contains("authority")),
            "{refusals:?}"
        );
    }

    #[test]
    fn beliefs_create_revise_and_refuse_stale_or_noop_patches() {
        let mut rig = Rig::new("reduce-beliefs");
        let created = rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF, ENTITY, unsupported()),
        );
        // A valid revision whose before matches.
        let revise = BeliefRevised {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "agent:run-1".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            patch: vec![PatchOp {
                field_path: "/fields/status".into(),
                before: TypedValue::string("active"),
                after: TypedValue::string("paused"),
            }],
            basis: unsupported(),
        };
        rig.append(schema::KIND_BELIEF_REVISED, &revise);
        // A stale patch: before no longer matches.
        rig.append(schema::KIND_BELIEF_REVISED, &revise);
        // A total no-op: empty patch, unchanged basis.
        let noop = BeliefRevised {
            patch: vec![],
            ..revise.clone()
        };
        rig.append(schema::KIND_BELIEF_REVISED, &noop);
        // A support-only revision: empty patch, DIFFERENT basis.
        let support_only = BeliefRevised {
            patch: vec![],
            basis: BeliefBasis::Unsupported {
                reason: "still unsupported, different reason".into(),
            },
            ..revise.clone()
        };
        rig.append(schema::KIND_BELIEF_REVISED, &support_only);
        // Removing a field via Missing.
        let remove = BeliefRevised {
            patch: vec![PatchOp {
                field_path: "/fields/status".into(),
                before: TypedValue::string("paused"),
                after: TypedValue::Missing,
            }],
            basis: unsupported(),
            ..revise.clone()
        };
        rig.append(schema::KIND_BELIEF_REVISED, &remove);

        let state = rig.state();
        let belief = state.beliefs.get(BELIEF).unwrap();
        assert_eq!(belief.revisions.len(), 4, "create + 3 valid revisions");
        assert_eq!(belief.current().fields, serde_json::json!({}));
        assert_eq!(state.version("belief", BELIEF), Some(4));
        assert_eq!(
            state.version("entity", ENTITY),
            Some(1),
            "first-registered once"
        );
        assert_eq!(state.anomalies.len(), 2, "{:?}", state.anomalies);
        assert!(state.anomalies[0].detail.contains("before-value"));
        assert!(state.anomalies[1].detail.contains("no-op"));
        assert_eq!(
            state.belief_revision_events.get(&created),
            Some(&(BELIEF.to_string(), 1))
        );
    }

    #[test]
    fn basis_links_point_at_assertions_or_context_only() {
        let mut rig = Rig::new("reduce-basis");
        let human = rig.human_source("human:josef");
        let snapshot = observation(
            ObservationKind::SourceSnapshot,
            &human,
            "agent:run-1",
            SubjectRef::None,
            vec![],
            snapshot_payload(),
        );
        let snapshot_id = rig.append(schema::KIND_OBSERVATION_RECORDED, &snapshot);

        // supports → snapshot: refused (not an assertion).
        let bad = belief_created(
            BELIEF,
            ENTITY,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: snapshot_id.clone(),
                    role: BasisRole::Supports,
                }],
            },
        );
        rig.append(schema::KIND_BELIEF_CREATED, &bad);
        // context → snapshot: fine.
        let good = belief_created(
            BELIEF,
            ENTITY,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: snapshot_id.clone(),
                    role: BasisRole::Context,
                }],
            },
        );
        rig.append(schema::KIND_BELIEF_CREATED, &good);
        // basis → an event that is no Observation at all (the belief event).
        let state = rig.state();
        let belief_event = state.beliefs.get(BELIEF).unwrap().created_event_id.clone();
        let evidence_from_belief = belief_created(
            BELIEF_B,
            ENTITY_B,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: belief_event,
                    role: BasisRole::Context,
                }],
            },
        );
        rig.append(schema::KIND_BELIEF_CREATED, &evidence_from_belief);

        let state = rig.state();
        assert_eq!(state.beliefs.len(), 1);
        assert_eq!(state.anomalies.len(), 2);
        assert!(state.anomalies[0].detail.contains("supports/opposes"));
        assert!(state.anomalies[1].detail.contains("not an Observation"));
    }

    #[test]
    fn relations_add_remove_readd_with_versions_and_endpoint_checks() {
        let mut rig = Rig::new("reduce-relations");
        rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF, ENTITY, unsupported()),
        );
        rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF_B, ENTITY_B, unsupported()),
        );
        let relation_id = derive_relation_id(BELIEF, BELIEF_B, RelationKind::Refines);
        let relation = |action| BeliefRelation {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "agent:run-1".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            relation_id: relation_id.clone(),
            action,
            from: BELIEF.into(),
            to: BELIEF_B.into(),
            relation: RelationKind::Refines,
        };
        rig.append(schema::KIND_BELIEF_RELATION, &relation(RelationAction::Add));
        rig.append(schema::KIND_BELIEF_RELATION, &relation(RelationAction::Add)); // dup
        rig.append(
            schema::KIND_BELIEF_RELATION,
            &relation(RelationAction::Remove),
        );
        rig.append(
            schema::KIND_BELIEF_RELATION,
            &relation(RelationAction::Remove),
        ); // dead
        rig.append(schema::KIND_BELIEF_RELATION, &relation(RelationAction::Add)); // re-add
                                                                                  // An endpoint that is no committed Belief.
        let ghost = BeliefRelation {
            relation_id: derive_relation_id(
                BELIEF,
                "9999999999999999999999999999999a",
                RelationKind::Refines,
            ),
            to: "9999999999999999999999999999999a".into(),
            ..relation(RelationAction::Add)
        };
        rig.append(schema::KIND_BELIEF_RELATION, &ghost);

        let state = rig.state();
        let rel = state.relations.get(&relation_id).unwrap();
        assert!(rel.live);
        assert_eq!(
            state.version("relation", &relation_id),
            Some(3),
            "add, remove, re-add"
        );
        assert_eq!(state.anomalies.len(), 3);
        assert!(state.anomalies[2].detail.contains("no committed Belief"));
    }

    #[test]
    fn attestation_pins_the_exact_revision_and_its_projection_hash() {
        let mut rig = Rig::new("reduce-attest");
        let created = rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF, ENTITY, unsupported()),
        );
        let projected = super::super::project::project(
            "# Acme\n\nActive vendor.\n",
            &serde_json::json!({ "status": "active" }),
        );
        let good_hash = schema::belief::attested_content_hash(projected.as_bytes());
        let attest = |hash: String| BeliefAttested {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "human:josef".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: BELIEF.into(),
            attested_belief_revision_event_id: created.clone(),
            attested_content_hash: hash,
        };
        // A wrong hash: the id/hash pair must name the same revision.
        rig.append(schema::KIND_BELIEF_ATTESTED, &attest("0".repeat(64)));
        // The right hash.
        rig.append(schema::KIND_BELIEF_ATTESTED, &attest(good_hash));

        let state = rig.state();
        let belief = state.beliefs.get(BELIEF).unwrap();
        assert!(belief.attested.is_some());
        assert_eq!(state.version("belief", BELIEF), Some(2));
        assert_eq!(state.anomalies.len(), 1);
        assert!(state.anomalies[0].detail.contains("projection"));
    }

    #[test]
    fn aliases_register_once_per_key_and_never_move_entities() {
        let mut rig = Rig::new("reduce-alias");
        rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF, ENTITY, unsupported()),
        );
        rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF_B, ENTITY_B, unsupported()),
        );
        let alias = |entity: &str, alias: &str| EntityAliasAdded {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "human:josef".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            entity_id: entity.into(),
            alias: alias.into(),
            normalized_alias: schema::normalize_alias_v1(alias),
        };
        rig.append(
            schema::KIND_ENTITY_ALIAS_ADDED,
            &alias(ENTITY, "Acme  Corp"),
        );
        // The same key on a DIFFERENT entity: refused, never guessed.
        rig.append(
            schema::KIND_ENTITY_ALIAS_ADDED,
            &alias(ENTITY_B, "ACME CORP"),
        );
        // An unknown entity: refused.
        rig.append(
            schema::KIND_ENTITY_ALIAS_ADDED,
            &alias("1111111111111111111111111111111a", "Other"),
        );

        let state = rig.state();
        assert_eq!(state.alias_registry.len(), 1);
        let stored = state.alias_registry.get("acme corp").unwrap();
        assert_eq!(stored.alias, "Acme  Corp", "display bytes preserved");
        assert_eq!(stored.entity_id, ENTITY);
        assert_eq!(state.version("entity", ENTITY), Some(2));
        assert_eq!(state.anomalies.len(), 2);
    }

    #[test]
    fn subject_resolution_attaches_by_exact_tier_proofs_and_corrects_once() {
        let mut rig = Rig::new("reduce-resolve");
        let human = rig.human_source("human:josef");
        // Two entities via beliefs; an alias on the first.
        rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF, ENTITY, unsupported()),
        );
        rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF_B, ENTITY_B, unsupported()),
        );
        let alias_event = rig.append(
            schema::KIND_ENTITY_ALIAS_ADDED,
            &EntityAliasAdded {
                schema: BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: Actor {
                    id: "human:josef".into(),
                },
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                entity_id: ENTITY.into(),
                alias: "Acme Corp".into(),
                normalized_alias: "acme corp".into(),
            },
        );
        // An unresolved mention of "ACME corp".
        let mut unresolved = observation(
            ObservationKind::HumanAssertion,
            &human,
            "human:josef",
            SubjectRef::Unresolved {
                raw_ref: "ACME corp".into(),
                aliases: vec![],
            },
            vec![],
            human_payload(AssertionBasis::Reported),
        );
        let obs_id = rig.append(schema::KIND_OBSERVATION_RECORDED, &unresolved);

        let resolve =
            |observation_event_id: &str, change: schema::ResolutionChange| SubjectResolved {
                schema: BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: Actor {
                    id: "agent:resolver".into(),
                },
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                observation_event_id: observation_event_id.into(),
                change,
            };

        // known_alias attach with the wrong entity first: refused.
        rig.append(
            schema::KIND_SUBJECT_RESOLVED,
            &resolve(
                &obs_id,
                ResolutionChange::Attach {
                    entity_id: ENTITY_B.into(),
                    resolver_tier: ResolverTier::KnownAlias,
                    basis_event_ids: vec![alias_event.clone()],
                },
            ),
        );
        // The right attach.
        let attach = resolve(
            &obs_id,
            ResolutionChange::Attach {
                entity_id: ENTITY.into(),
                resolver_tier: ResolverTier::KnownAlias,
                basis_event_ids: vec![alias_event.clone()],
            },
        );
        let attach_event = rig.append(schema::KIND_SUBJECT_RESOLVED, &attach);
        // A second attach: refused — correction is the explicit door.
        rig.append(schema::KIND_SUBJECT_RESOLVED, &attach);

        // Correction to ENTITY_B, exact_id tier: basis is B's registering
        // event (its belief.created).
        let state = rig.state();
        let register_b = state
            .entities
            .get(ENTITY_B)
            .unwrap()
            .registered_by_event_id
            .clone();
        let correct = resolve(
            &obs_id,
            ResolutionChange::Correct {
                prior_resolution_event_id: attach_event.clone(),
                from_entity_id: ENTITY.into(),
                to_entity_id: ENTITY_B.into(),
                resolver_tier: ResolverTier::ExactId,
                basis_event_ids: vec![register_b],
                reason: "the mention names the vendor's subsidiary".into(),
            },
        );
        let correct_event = rig.append(schema::KIND_SUBJECT_RESOLVED, &correct);
        // A stale correction pinning the superseded attach: refused.
        rig.append(schema::KIND_SUBJECT_RESOLVED, &correct);

        // A resolved-subject observation can never be attached.
        unresolved.subject = SubjectRef::Resolved {
            entity_id: ENTITY.into(),
            aliases: vec![],
        };
        let resolved_obs = rig.append(schema::KIND_OBSERVATION_RECORDED, &unresolved);
        rig.append(
            schema::KIND_SUBJECT_RESOLVED,
            &resolve(
                &resolved_obs,
                ResolutionChange::Attach {
                    entity_id: ENTITY.into(),
                    resolver_tier: ResolverTier::ExactId,
                    basis_event_ids: vec![],
                },
            ),
        );

        let state = rig.state();
        let observation_state = state.observations.get(&obs_id).unwrap();
        assert_eq!(
            observation_state.effective_entity.as_deref(),
            Some(ENTITY_B)
        );
        assert_eq!(
            observation_state.effective_resolution_event.as_deref(),
            Some(correct_event.as_str())
        );
        assert_eq!(
            state.version("observation", &obs_id),
            Some(3),
            "record, attach, correct"
        );
        assert_eq!(
            state.resolutions.len(),
            2,
            "history retained: attach + correct"
        );
        assert_eq!(state.anomalies.len(), 4, "{:?}", state.anomalies);
    }

    #[test]
    fn independence_is_positive_produced_and_lineage_beats_claims() {
        let mut rig = Rig::new("reduce-independence");
        let josef = rig.human_source("human:josef");
        let maya = rig.human_source("human:maya");
        let subject = SubjectRef::Resolved {
            entity_id: ENTITY.into(),
            aliases: vec![],
        };
        let left = rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::HumanAssertion,
                &josef,
                "human:josef",
                subject.clone(),
                vec![],
                human_payload(AssertionBasis::Firsthand),
            ),
        );
        let right = rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::HumanAssertion,
                &maya,
                "human:maya",
                subject.clone(),
                vec![],
                human_payload(AssertionBasis::Firsthand),
            ),
        );
        let independence =
            |left: &str, right: &str, left_reg: &str, right_reg: &str| IndependenceRecorded {
                schema: BODY_SCHEMA,
                batch_id: None,
                idempotency_key: None,
                actor: Actor {
                    id: "system:prefilter".into(),
                },
                occurred_at: None,
                valid_from: None,
                valid_to: None,
                left_observation_event_id: left.into(),
                right_observation_event_id: right.into(),
                proof: schema::IndependenceProof::DistinctFirsthandOrigin {
                    left_source_registration_event_id: left_reg.into(),
                    right_source_registration_event_id: right_reg.into(),
                    rule_version: "prefilter-v1".into(),
                },
                reason: "distinct registered reporters".into(),
            };
        rig.append(
            schema::KIND_INDEPENDENCE_RECORDED,
            &independence(&left, &right, &josef.1, &maya.1),
        );
        // Duplicate pair: refused.
        rig.append(
            schema::KIND_INDEPENDENCE_RECORDED,
            &independence(&left, &right, &josef.1, &maya.1),
        );
        // Same actor on both ends: never independent.
        let left2 = rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::HumanAssertion,
                &josef,
                "human:josef",
                subject.clone(),
                vec![],
                human_payload(AssertionBasis::Firsthand),
            ),
        );
        let right2 = rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::HumanAssertion,
                &josef,
                "human:josef",
                subject.clone(),
                vec![],
                human_payload(AssertionBasis::Firsthand),
            ),
        );
        rig.append(
            schema::KIND_INDEPENDENCE_RECORDED,
            &independence(&left2, &right2, &josef.1, &josef.1),
        );
        // Shared ancestry: two extractions of one parent snapshot.
        let direct = rig.direct_source("conn-1", "domain-a");
        let direct2 = rig.direct_source("conn-2", "domain-b");
        let parent = rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::SourceSnapshot,
                &direct,
                "agent:run-1",
                SubjectRef::None,
                vec![],
                snapshot_payload(),
            ),
        );
        let lineage = vec![LineageEdge {
            edge: LineageKind::DerivedFrom,
            parent_observation_event_id: parent.clone(),
        }];
        let sib_left = rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::ExtractedAssertion,
                &direct,
                "agent:run-1",
                subject.clone(),
                lineage.clone(),
                extraction_payload(schema::AuthorityProvenance::RegisteredDirectArtifact),
            ),
        );
        let sib_right = rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::ExtractedAssertion,
                &direct2,
                "agent:run-1",
                subject.clone(),
                lineage,
                extraction_payload(schema::AuthorityProvenance::RegisteredDirectArtifact),
            ),
        );
        let mut shared = independence(&sib_left, &sib_right, &direct.1, &direct2.1);
        shared.proof = schema::IndependenceProof::IndependentSystemArtifact {
            left_source_registration_event_id: direct.1.clone(),
            right_source_registration_event_id: direct2.1.clone(),
            rule_version: "prefilter-v1".into(),
        };
        rig.append(schema::KIND_INDEPENDENCE_RECORDED, &shared);

        let state = rig.state();
        assert_eq!(state.independence.len(), 1, "one positive fact");
        assert_eq!(state.version("observation", &left), Some(2));
        assert_eq!(state.version("observation", &right), Some(2));
        let details: Vec<&str> = state.anomalies.iter().map(|a| a.detail.as_str()).collect();
        assert_eq!(details.len(), 3, "{details:?}");
        assert!(details[0].contains("already recorded"));
        assert!(details[1].contains("DIFFERENT registered actors"));
        assert!(details[2].contains("share lineage"));
    }

    #[test]
    fn a_batch_applies_atomically_or_not_at_all() {
        let mut rig = Rig::new("reduce-batch");
        let human = rig.human_source("human:josef");
        // A valid batch: observation + belief basing on it symbolically.
        let obs_body = observation(
            ObservationKind::HumanAssertion,
            &human,
            "human:josef",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            vec![],
            human_payload(AssertionBasis::Firsthand),
        );
        let belief_body = belief_created(
            BELIEF,
            ENTITY,
            BeliefBasis::Linked {
                links: vec![BasisLink {
                    observation_event_id: member_ref(0),
                    role: BasisRole::Supports,
                }],
            },
        );
        rig.writer
            .append_batch(
                vec![
                    (
                        schema::KIND_OBSERVATION_RECORDED.to_string(),
                        serde_json::to_value(&obs_body).unwrap(),
                    ),
                    (
                        schema::KIND_BELIEF_CREATED.to_string(),
                        serde_json::to_value(&belief_body).unwrap(),
                    ),
                ],
                Some("op:capture"),
            )
            .unwrap();
        // Mixed in: plumbing (creates nothing) and a reduce-invalid batch —
        // a revision of a belief that does not exist is structurally fine
        // and reduce-refused, so the WHOLE second batch must vanish.
        rig.writer
            .append("vault.write", serde_json::json!({ "path": "a.md" }))
            .unwrap();
        let ghost_revision = BeliefRevised {
            schema: BODY_SCHEMA,
            batch_id: None,
            idempotency_key: None,
            actor: Actor {
                id: "agent:run-1".into(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            belief_id: "9999999999999999999999999999999a".into(),
            patch: vec![],
            basis: unsupported(),
        };
        let second_obs = observation(
            ObservationKind::HumanAssertion,
            &human,
            "human:josef",
            SubjectRef::Resolved {
                entity_id: ENTITY_B.into(),
                aliases: vec![],
            },
            vec![],
            human_payload(AssertionBasis::Firsthand),
        );
        rig.writer
            .append_batch(
                vec![
                    (
                        schema::KIND_OBSERVATION_RECORDED.to_string(),
                        serde_json::to_value(&second_obs).unwrap(),
                    ),
                    (
                        schema::KIND_BELIEF_REVISED.to_string(),
                        serde_json::to_value(&ghost_revision).unwrap(),
                    ),
                ],
                Some("op:bad"),
            )
            .unwrap();

        let state = rig.state();
        assert_eq!(state.beliefs.len(), 1, "only the valid batch's belief");
        assert_eq!(
            state.observations.len(),
            1,
            "the refused batch's observation has zero effect"
        );
        assert!(!state.entities.contains_key(ENTITY_B));
        let committed: Vec<_> = state
            .batches
            .iter()
            .filter(|b| b.state == "committed")
            .collect();
        let refused: Vec<_> = state
            .batches
            .iter()
            .filter(|b| b.state == "refused")
            .collect();
        assert_eq!((committed.len(), refused.len()), (1, 1));
        // The belief's basis link names the observation's REAL event id.
        let belief = state.beliefs.get(BELIEF).unwrap();
        let BeliefBasis::Linked { links } = &belief.current().basis else {
            panic!("linked basis");
        };
        assert!(state
            .observations
            .contains_key(&links[0].observation_event_id));
    }

    #[test]
    fn members_without_a_marker_are_orphans_with_zero_effect() {
        let mut rig = Rig::new("reduce-orphan");
        let human = rig.human_source("human:josef");
        let obs_body = observation(
            ObservationKind::HumanAssertion,
            &human,
            "human:josef",
            SubjectRef::Resolved {
                entity_id: ENTITY.into(),
                aliases: vec![],
            },
            vec![],
            human_payload(AssertionBasis::Firsthand),
        );
        rig.writer
            .append_batch(
                vec![(
                    schema::KIND_OBSERVATION_RECORDED.to_string(),
                    serde_json::to_value(&obs_body).unwrap(),
                )],
                Some("op:torn"),
            )
            .unwrap();
        // Tear the marker off, as a crash between member and marker would.
        drop(std::mem::replace(
            &mut rig.writer,
            LedgerWriter::open(&testutil::temp_vault("reduce-orphan-tmp"), WRITER).unwrap(),
        ));
        let dir = ledger_dir(&rig.vault);
        let read = read_ledger(&dir).unwrap();
        let open_path = dir.join(read.segments.last().unwrap().file_name());
        let bytes = std::fs::read(&open_path).unwrap();
        let marker_start = bytes[..bytes.len() - 1]
            .iter()
            .rposition(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap();
        std::fs::write(&open_path, &bytes[..marker_start]).unwrap();

        let read = read_ledger(&dir).unwrap();
        let state = reduce(&read.frames, &rig.store_id);
        assert!(state.observations.is_empty(), "orphans create nothing");
        assert_eq!(state.batches.len(), 1);
        assert_eq!(state.batches[0].state, "orphaned");
        assert!(state.anomalies[0].detail.contains("orphaned"));
    }

    #[test]
    fn a_malformed_schema_body_is_an_anomaly_never_a_panic() {
        let mut rig = Rig::new("reduce-malformed");
        // Plain append lets a schema-CLAIMING garbage body through (it has
        // no idempotency key), which is exactly the reducer's problem.
        rig.writer
            .append(
                schema::KIND_BELIEF_CREATED,
                serde_json::json!({ "schema": 1, "garbage": true }),
            )
            .unwrap();
        // M22 reserved `belief.tombstoned` with no body; M24.3 defined it.
        // A body that claims schema membership and then omits the common
        // fields is still an anomaly — the point of the test is that a
        // malformed body is a deterministic refusal and never a panic,
        // whichever side of the reservation it is on.
        rig.writer
            .append("belief.tombstoned", serde_json::json!({ "schema": 1 }))
            .unwrap();
        // A kind no build knows is still refused by name.
        rig.writer
            .append("belief.teleported", serde_json::json!({ "schema": 1 }))
            .unwrap();
        let state = rig.state();
        assert!(state.beliefs.is_empty());
        assert_eq!(state.anomalies.len(), 3);
        assert!(state.anomalies.iter().all(|a| a.code == "schema"));
        assert!(state.anomalies[1].detail.contains("missing field"));
        assert!(state.anomalies[2]
            .detail
            .contains("not in this build's vocabulary"));
    }

    #[test]
    fn reducing_twice_from_zero_is_identical() {
        let mut rig = Rig::new("reduce-deterministic");
        let human = rig.human_source("human:josef");
        rig.append(
            schema::KIND_BELIEF_CREATED,
            &belief_created(BELIEF, ENTITY, unsupported()),
        );
        rig.append(
            schema::KIND_OBSERVATION_RECORDED,
            &observation(
                ObservationKind::SourceSnapshot,
                &human,
                "agent:run-1",
                SubjectRef::None,
                vec![],
                snapshot_payload(),
            ),
        );
        let read = read_ledger(&ledger_dir(&rig.vault)).unwrap();
        let first = reduce(&read.frames, &rig.store_id);
        let second = reduce(&read.frames, &rig.store_id);
        assert_eq!(first, second);
    }
}
