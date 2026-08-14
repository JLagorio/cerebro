//! IPC-boundary human capture (M23.5): the valve's machinery.
//!
//! A structured in-app edit is ASSERTION PLUS EFFECT, committed as one M22
//! logical batch before the request acknowledges:
//!
//! - the actor-bound `human_actor` source registration is resolved, or
//!   staged as the FIRST member under its own `source-register-v1:` key
//!   (idempotent whether it arrives standalone or batched);
//! - one `human_assertion` Observation per epistemic effect — field_change,
//!   relation_change, alias_add — each pinning that registration and
//!   receiving CORE-derived `authority_provenance: trusted_human_capture`
//!   (neither the request nor projection bytes can author or upgrade it);
//! - one `belief.revised` whose patches match exactly the field assertions,
//!   whose basis is a COMPLETE replacement preserving every still-admissible
//!   prior link and adding all new Observations as `supports`;
//! - one exact `belief.relation` / `entity.alias_added` per paired
//!   assertion. When there are no field changes, the changed basis makes
//!   the empty-patch revision valid.
//!
//! The batch is keyed by the UI request id, so a lost acknowledgement
//! replays instead of duplicating. Any stale before-value, mismatched
//! pairing, invalid target, or alias removal refuses the WHOLE batch —
//! zero entity-state effect. Editorial (body/presentation-only) changes
//! commit `projection.overridden` instead and never enter evidence.
//!
//! Both authority fields are UI-selected and default to `unknown`; nothing
//! here infers `project_owner` or `firsthand` from the actor's identity.
//!
//! The valve itself opens at M23.7 — until then `guard_human_write` still
//! refuses the in-app paths, and this module is the machinery behind the
//! new capture boundary plus the reconciliation adoption path.

use std::collections::BTreeSet;
use std::path::Path;

use super::manifest;
use super::reduce::{project_belief, reduce, typed_at_pointer, EpistemicState};
use super::schema::{
    self, Actor, AssertionBasis, AssertionFields, AssertionKind, AuthorityProvenance, BasisLink,
    BasisRole, BeliefBasis, HumanAssertionForm, HumanAssertionPayload, ObservationKind, PatchOp,
    Provenance, RelationAction, RelationKind, Scope, SourceRegistration, SubjectRef, SubjectRole,
    TypedValue,
};
use super::writer::{member_ref, LedgerWriter};
use super::{ledger_dir, read_ledger, shadow};

/// One ordinary field change: pointer plus typed before/after, with an
/// optional correction trail (the extracted-claim-text carve-out).
/// `deny_unknown_fields` everywhere on the wire types: a request smuggling
/// `authority_provenance` (or anything else) is refused at the door.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldEdit {
    pub field_path: String,
    pub before: TypedValue,
    pub after: TypedValue,
    #[serde(default)]
    pub corrects: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// One relation transition, endpoints resolved by the boundary.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelationEdit {
    pub action: RelationAction,
    pub to_belief_id: String,
    #[serde(rename = "relation")]
    pub kind: RelationKind,
}

/// The UI-selected authority answers. BOTH default to `unknown` — never
/// inferred from who the actor is.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityAnswers {
    #[serde(default = "unknown_role")]
    pub role: SubjectRole,
    #[serde(default = "unknown_basis")]
    pub assertion_basis: AssertionBasis,
}

fn unknown_role() -> SubjectRole {
    SubjectRole::Unknown
}

fn unknown_basis() -> AssertionBasis {
    AssertionBasis::Unknown
}

impl Default for AuthorityAnswers {
    fn default() -> AuthorityAnswers {
        AuthorityAnswers {
            role: SubjectRole::Unknown,
            assertion_basis: AssertionBasis::Unknown,
        }
    }
}

/// A structured capture request at the IPC boundary.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureRequest {
    /// Vault-relative projection path (`knowledge/…`).
    pub path: String,
    /// The human actor id (e.g. `human:owner`).
    pub actor_id: String,
    #[serde(default)]
    pub fields: Vec<FieldEdit>,
    #[serde(default)]
    pub relations: Vec<RelationEdit>,
    #[serde(default)]
    pub alias_adds: Vec<String>,
    #[serde(default)]
    pub authority: AuthorityAnswers,
    /// The UI request id — the batch operation key.
    pub request_id: String,
}

/// An editorial request: body/presentation-only override ops.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorialRequest {
    pub path: String,
    pub actor_id: String,
    pub ops: Vec<schema::OverridePatchOp>,
    pub origin: schema::OverrideOrigin,
    pub request_id: String,
}

/// The IPC wire shape: one command, two capture channels.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WireRequest {
    Structured(CaptureRequest),
    Editorial(EditorialRequest),
}

/// Parse and dispatch one IPC capture request. `None` when no ledger
/// writer is active for the vault.
pub fn capture_from_json(vault: &Path, request: &serde_json::Value) -> Option<Result<(), String>> {
    let parsed: WireRequest = match serde_json::from_value(request.clone()) {
        Ok(parsed) => parsed,
        Err(e) => return Some(Err(format!("malformed capture request: {e}"))),
    };
    match parsed {
        WireRequest::Structured(request) => capture_structured(vault, &request),
        WireRequest::Editorial(request) => capture_editorial(vault, &request),
    }
}

/// The suspension refusal while the divergence circuit breaker is open.
pub const RECONCILIATION_SUSPENDED: &str =
    "reconciliation is open for this vault — resolve the divergence before capturing edits";

/// The typed alias-removal refusal, shared with the concepts adapter.
pub use super::concepts::UNSUPPORTED_ALIAS_REMOVAL;

/// Capture a structured edit through the vault's active writer. `None`
/// without one (the caller surfaces the ledger status instead).
pub fn capture_structured(vault: &Path, request: &CaptureRequest) -> Option<Result<(), String>> {
    shadow::with_writer(vault, |writer| {
        capture_structured_with(writer, vault, request)
    })
}

/// Capture one out-of-band knowledge change through the vault's active
/// writer — the live watcher's half of M23.7. Hash-based (never mtime):
/// a file that already equals its projection is a silent no-op.
pub fn capture_out_of_band(vault: &Path, rel: &str) -> Option<Result<(), String>> {
    shadow::with_writer(vault, |writer| capture_out_of_band_with(writer, vault, rel))
}

/// Capture an editorial override through the vault's active writer.
pub fn capture_editorial(vault: &Path, request: &EditorialRequest) -> Option<Result<(), String>> {
    shadow::with_writer(vault, |writer| {
        capture_editorial_with(writer, vault, request)
    })
}

fn current_state(writer: &LedgerWriter, vault: &Path) -> Result<EpistemicState, String> {
    let read = read_ledger(&ledger_dir(vault)).map_err(|e| e.to_string())?;
    Ok(reduce(&read.frames, writer.store_id()))
}

fn common(actor: &str) -> (u64, Option<String>, Option<String>, Actor) {
    (
        schema::BODY_SCHEMA,
        None,
        None,
        Actor {
            id: actor.to_string(),
        },
    )
}

/// The actor-bound human registration and, when absent, the staged member
/// carrying its own `source-register-v1:` idempotency key.
///
/// `ordinal` is where the caller will place that member. It was a constant
/// `0` while capture was the only caller and always staged first; M26.4i's
/// ingest pass can stage two registrations in one batch, so the position is
/// the caller's to state.
pub(crate) fn resolve_registration(
    state: &EpistemicState,
    store: &str,
    actor_id: &str,
    ordinal: usize,
) -> (String, String, Option<(String, serde_json::Value)>) {
    let mut registration = SourceRegistration::HumanActor {
        source_key: String::new(),
        actor_id: actor_id.to_string(),
        authority_capability: schema::AuthorityCapability::HumanAssertion,
        independence_domain_id: None,
    };
    let key = registration
        .derived_source_key()
        .expect("strings serialize");
    if let SourceRegistration::HumanActor { source_key, .. } = &mut registration {
        *source_key = key.clone();
    }
    let source_id = schema::derive_source_id(store, &key);
    if let Some(existing) = state.sources.get(&source_id) {
        return (source_id, existing.registration_event_id.clone(), None);
    }
    let (schema_v, batch_id, _, actor) = common(schema::ACTOR_SOURCE_REGISTRY);
    let body = schema::SourceRegistered {
        schema: schema_v,
        batch_id,
        idempotency_key: Some(format!("source-register-v1:{store}:{source_id}")),
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        source_id: source_id.clone(),
        registration,
    };
    (
        source_id,
        member_ref(ordinal),
        Some((
            schema::KIND_SOURCE_REGISTERED.to_string(),
            serde_json::to_value(&body).expect("registrations serialize"),
        )),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn human_assertion(
    actor_id: &str,
    source_id: &str,
    registration_event: &str,
    entity_id: &str,
    authority: &AuthorityAnswers,
    predicate: &str,
    value: TypedValue,
    form: HumanAssertionForm,
) -> (String, serde_json::Value) {
    let (schema_v, batch_id, idempotency_key, actor) = common(actor_id);
    let body = schema::ObservationRecorded {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        observation_kind: ObservationKind::HumanAssertion,
        source_id: source_id.to_string(),
        source_registration_event_id: registration_event.to_string(),
        subject: SubjectRef::Resolved {
            entity_id: entity_id.to_string(),
            aliases: vec![],
        },
        lineage: vec![],
        provenance: Provenance::empty(),
        payload: serde_json::to_value(HumanAssertionPayload {
            assertion: AssertionFields {
                assertion_kind: AssertionKind::Presence,
                predicate: predicate.to_string(),
                value,
                scope: Scope::empty(),
                relationship_to_subject: schema::RelationshipToSubject {
                    role: authority.role,
                },
                assertion_basis: authority.assertion_basis,
                // CORE-derived — the reducer re-derives and refuses any
                // disagreement; the request never supplies this.
                authority_provenance: AuthorityProvenance::TrustedHumanCapture,
                absence: None,
            },
            form,
        })
        .expect("assertion payloads serialize"),
    };
    (
        schema::KIND_OBSERVATION_RECORDED.to_string(),
        serde_json::to_value(&body).expect("observations serialize"),
    )
}

pub(crate) fn capture_structured_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    request: &CaptureRequest,
) -> Result<(), String> {
    let krel = request
        .path
        .strip_prefix("knowledge/")
        .ok_or("capture applies only to knowledge/ projections")?;
    if request.fields.is_empty() && request.relations.is_empty() && request.alias_adds.is_empty() {
        return Err("an empty capture request captures nothing".to_string());
    }
    if request.request_id.is_empty() {
        return Err("capture requires the UI request id".to_string());
    }
    let store = writer.store_id().to_string();
    let state = current_state(writer, vault)?;
    // The circuit breaker: while reconciliation is open, automatic capture
    // is suspended — resolve the divergence first (agent writes continue).
    if state.reconciliation_open() {
        return Err(RECONCILIATION_SUSPENDED.to_string());
    }
    let belief_id = state
        .projection_paths
        .get(krel)
        .ok_or_else(|| format!("{} is not a committed projection", request.path))?
        .clone();

    // The lost-acknowledgement retry: the request id already committed —
    // regenerate the projection and acknowledge, appending nothing.
    if state
        .batches
        .iter()
        .any(|b| b.state == "committed" && b.operation_key.as_deref() == Some(&request.request_id))
    {
        let projection = project_belief(&state, &belief_id)?;
        manifest::write_projection(vault, &request.path, &projection)?;
        crate::vault::watcher::note_own_write(&vault.join(&request.path));
        return Ok(());
    }
    let belief = state.beliefs.get(&belief_id).expect("path index");
    let current = belief.current();

    // Pre-flight the stale checks for clean errors; the reducer remains the
    // authority (a raced batch still refuses wholesale).
    let (overlaid_content, overlaid_fields) = super::reduce::overlaid(&state, belief);
    for edit in &request.fields {
        schema::validate_field_path(&edit.field_path)?;
        let current_value = if edit.field_path == "/body" {
            TypedValue::string(&overlaid_content)
        } else {
            typed_at_pointer(&overlaid_fields, &edit.field_path)
        };
        if edit.before != current_value {
            return Err(format!(
                "stale edit: {} no longer holds the value this change was based on",
                edit.field_path
            ));
        }
    }
    for relation in &request.relations {
        let live = state.relations.values().any(|r| {
            r.live
                && r.from == belief_id
                && r.to == relation.to_belief_id
                && r.relation == relation.kind
        });
        match relation.action {
            RelationAction::Add if live => {
                return Err("the relation is already live — nothing to add".to_string())
            }
            RelationAction::Remove if !live => {
                return Err("the relation is not live — nothing to remove".to_string())
            }
            _ => {}
        }
    }
    for alias in &request.alias_adds {
        let normalized = schema::normalize_alias_v1(alias);
        if normalized.is_empty() {
            return Err(format!("alias {alias:?} normalizes to empty"));
        }
        if state.alias_registry.contains_key(&normalized) {
            return Err(format!("alias {alias:?} is already registered"));
        }
    }

    // Assemble the one logical batch.
    let mut events: Vec<(String, serde_json::Value)> = Vec::new();
    let (source_id, registration_event, staged_registration) =
        resolve_registration(&state, &store, &request.actor_id, events.len());
    if let Some(member) = staged_registration {
        events.push(member);
    }

    // Observations: F, then R, then A — their ordinals feed the basis refs.
    let mut observation_refs: Vec<String> = Vec::new();
    for edit in &request.fields {
        let ordinal = events.len();
        events.push(human_assertion(
            &request.actor_id,
            &source_id,
            &registration_event,
            &belief.entity_id,
            &request.authority,
            &edit.field_path,
            edit.after.clone(),
            HumanAssertionForm::FieldChange {
                target_belief_id: belief_id.clone(),
                field_path: edit.field_path.clone(),
                before: edit.before.clone(),
                after: edit.after.clone(),
                corrects: edit.corrects.clone(),
                reason: edit.reason.clone(),
            },
        ));
        observation_refs.push(member_ref(ordinal));
    }
    for relation in &request.relations {
        let relation_id =
            schema::derive_relation_id(&belief_id, &relation.to_belief_id, relation.kind);
        let value = TypedValue::Object {
            value: [
                ("relation_id".to_string(), TypedValue::string(&relation_id)),
                (
                    "action".to_string(),
                    TypedValue::string(match relation.action {
                        RelationAction::Add => "add",
                        RelationAction::Remove => "remove",
                    }),
                ),
                ("from".to_string(), TypedValue::string(&belief_id)),
                ("to".to_string(), TypedValue::string(&relation.to_belief_id)),
                (
                    "relation".to_string(),
                    TypedValue::string(relation.kind.as_str()),
                ),
            ]
            .into_iter()
            .collect(),
        };
        let ordinal = events.len();
        events.push(human_assertion(
            &request.actor_id,
            &source_id,
            &registration_event,
            &belief.entity_id,
            &request.authority,
            "belief_relation",
            value,
            HumanAssertionForm::RelationChange {
                target_belief_id: belief_id.clone(),
                relation_id,
                action: relation.action,
                from: belief_id.clone(),
                to: relation.to_belief_id.clone(),
                relation: relation.kind,
                corrects: None,
                reason: None,
            },
        ));
        observation_refs.push(member_ref(ordinal));
    }
    for alias in &request.alias_adds {
        let normalized = schema::normalize_alias_v1(alias);
        let value = TypedValue::Object {
            value: [
                (
                    "entity_id".to_string(),
                    TypedValue::string(&belief.entity_id),
                ),
                ("alias".to_string(), TypedValue::string(alias)),
                (
                    "normalized_alias".to_string(),
                    TypedValue::string(&normalized),
                ),
            ]
            .into_iter()
            .collect(),
        };
        let ordinal = events.len();
        events.push(human_assertion(
            &request.actor_id,
            &source_id,
            &registration_event,
            &belief.entity_id,
            &request.authority,
            "entity_alias",
            value,
            HumanAssertionForm::AliasAdd {
                target_belief_id: belief_id.clone(),
                entity_id: belief.entity_id.clone(),
                alias: alias.clone(),
                normalized_alias: normalized,
                corrects: None,
                reason: None,
            },
        ));
        observation_refs.push(member_ref(ordinal));
    }

    // The one revision: patches are EXACTLY the field assertions; the basis
    // is a complete replacement — every still-admissible prior link plus
    // all new Observations as supports.
    let mut links: Vec<BasisLink> = match &current.basis {
        BeliefBasis::Linked { links } => links.clone(),
        BeliefBasis::Unsupported { .. } => Vec::new(),
    };
    for observation in &observation_refs {
        links.push(BasisLink {
            observation_event_id: observation.clone(),
            role: BasisRole::Supports,
        });
    }
    let (schema_v, batch_id, idempotency_key, actor) = common(&request.actor_id);
    let revised = schema::BeliefRevised {
        schema: schema_v,
        batch_id,
        idempotency_key,
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.clone(),
        patch: request
            .fields
            .iter()
            .map(|edit| PatchOp {
                field_path: edit.field_path.clone(),
                before: edit.before.clone(),
                after: edit.after.clone(),
            })
            .collect(),
        basis: BeliefBasis::Linked { links },
    };
    events.push((
        schema::KIND_BELIEF_REVISED.to_string(),
        serde_json::to_value(&revised).map_err(|e| e.to_string())?,
    ));

    // The exact paired effects.
    for relation in &request.relations {
        let (schema_v, batch_id, idempotency_key, actor) = common(&request.actor_id);
        let body = schema::BeliefRelation {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            relation_id: schema::derive_relation_id(
                &belief_id,
                &relation.to_belief_id,
                relation.kind,
            ),
            action: relation.action,
            from: belief_id.clone(),
            to: relation.to_belief_id.clone(),
            relation: relation.kind,
        };
        events.push((
            schema::KIND_BELIEF_RELATION.to_string(),
            serde_json::to_value(&body).map_err(|e| e.to_string())?,
        ));
    }
    for alias in &request.alias_adds {
        let (schema_v, batch_id, idempotency_key, actor) = common(&request.actor_id);
        let body = schema::EntityAliasAdded {
            schema: schema_v,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            entity_id: belief.entity_id.clone(),
            alias: alias.clone(),
            normalized_alias: schema::normalize_alias_v1(alias),
        };
        events.push((
            schema::KIND_ENTITY_ALIAS_ADDED.to_string(),
            serde_json::to_value(&body).map_err(|e| e.to_string())?,
        ));
    }

    // One atomic commit, keyed by the UI request id, fsynced through the
    // marker before any acknowledgement.
    let receipt = writer.append_batch(events, Some(&request.request_id))?;
    crate::crash::crash_point("capture-committed");

    // The reducer is the authority: a refused batch has zero state effect
    // and the request errors instead of acknowledging.
    let state = current_state(writer, vault)?;
    let committed = state
        .batches
        .iter()
        .any(|b| b.batch_id == receipt.batch_id && b.state == "committed");
    if !committed && !receipt.replayed {
        let detail = state
            .anomalies
            .iter()
            .rev()
            .find(|a| a.batch_id.as_deref() == Some(receipt.batch_id.as_str()))
            .map(|a| a.detail.clone())
            .unwrap_or_else(|| "the capture batch did not apply".to_string());
        return Err(format!("capture refused: {detail}"));
    }

    // Reduce, project, manifest-first write, THEN acknowledge.
    let projection = project_belief(&state, &belief_id)?;
    manifest::write_projection(vault, &request.path, &projection)?;
    crate::vault::watcher::note_own_write(&vault.join(&request.path));
    Ok(())
}

fn capture_editorial_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    request: &EditorialRequest,
) -> Result<(), String> {
    let krel = request
        .path
        .strip_prefix("knowledge/")
        .ok_or("capture applies only to knowledge/ projections")?;
    if request.ops.is_empty() {
        return Err("an editorial capture with no ops changes nothing".to_string());
    }
    if request.request_id.is_empty() {
        return Err("capture requires the UI request id".to_string());
    }
    for op in &request.ops {
        // The pointer allowlist IS the refusal: generated/verified
        // provenance, epistemic frontmatter, and relation fields stay
        // hard-refused.
        schema::validate_override_pointer(&op.field_path)?;
    }
    let read = read_ledger(&ledger_dir(vault)).map_err(|e| e.to_string())?;
    let state = reduce(&read.frames, writer.store_id());
    if state.reconciliation_open() {
        return Err(RECONCILIATION_SUSPENDED.to_string());
    }
    let belief_id = state
        .projection_paths
        .get(krel)
        .ok_or_else(|| format!("{} is not a committed projection", request.path))?
        .clone();

    // The lost-acknowledgement retry: the keyed override already
    // committed — regenerate and acknowledge.
    if read.frames.iter().any(|f| {
        f.kind == schema::KIND_PROJECTION_OVERRIDDEN
            && f.body.get("idempotency_key").and_then(|v| v.as_str())
                == Some(request.request_id.as_str())
    }) {
        let projection = project_belief(&state, &belief_id)?;
        manifest::write_projection(vault, &request.path, &projection)?;
        crate::vault::watcher::note_own_write(&vault.join(&request.path));
        return Ok(());
    }
    let belief = state.beliefs.get(&belief_id).expect("path index");
    let current = belief.current();

    let before_bytes = super::reduce::projected_bytes(&state, belief);
    // Simulate the new overlay for the after-hash the reducer must prove.
    let (mut content, mut fields) = super::reduce::overlaid(&state, belief);
    for op in &request.ops {
        let current_value = if op.field_path == "/body" {
            TypedValue::string(&content)
        } else {
            typed_at_pointer(&fields, &op.field_path)
        };
        if op.before != current_value {
            return Err(format!(
                "stale edit: {} no longer holds the value this change was based on",
                op.field_path
            ));
        }
        super::reduce::apply_overlay_op(&mut content, &mut fields, op);
    }
    let after_bytes = super::project::project(&content, &fields);

    let (schema_v, batch_id, _, actor) = common(&request.actor_id);
    let body = schema::ProjectionOverridden {
        schema: schema_v,
        batch_id,
        idempotency_key: None, // append_once stamps the request id
        actor,
        occurred_at: None,
        valid_from: None,
        valid_to: None,
        belief_id: belief_id.clone(),
        path: krel.to_string(),
        base_belief_revision: current.revision,
        base_belief_revision_event: current.event_id.clone(),
        base_generating_event: belief.projection_head_event.clone(),
        before_projection_hash: crate::ledger::sha256_hex(before_bytes.as_bytes()),
        after_projection_hash: crate::ledger::sha256_hex(after_bytes.as_bytes()),
        origin: request.origin,
        change: schema::OverrideChange::Set {
            patch: request.ops.clone(),
            supersedes_override_event_ids: vec![],
        },
    };
    let result = writer.append_once(
        &request.request_id,
        schema::KIND_PROJECTION_OVERRIDDEN,
        serde_json::to_value(&body).map_err(|e| e.to_string())?,
    )?;
    crate::crash::crash_point("capture-committed");

    let state = current_state(writer, vault)?;
    let applied = state
        .beliefs
        .get(&belief_id)
        .is_some_and(|b| b.override_head_event.as_deref() == Some(&result.committed().event_id));
    if !applied && !result.was_existing() {
        let detail = state
            .anomalies
            .iter()
            .rev()
            .find(|a| a.event_id == result.committed().event_id)
            .map(|a| a.detail.clone())
            .unwrap_or_else(|| "the override did not apply".to_string());
        return Err(format!("editorial capture refused: {detail}"));
    }
    let projection = project_belief(&state, &belief_id)?;
    manifest::write_projection(vault, &request.path, &projection)?;
    crate::vault::watcher::note_own_write(&vault.join(&request.path));
    Ok(())
}

// --- Out-of-band capture (M23.7) -------------------------------------------

/// The presentation-only frontmatter keys — everything else in a diff is
/// epistemic (mirrors `schema::projection::PRESENTATION_ONLY_FIELDS`).
fn is_presentation_key(key: &str) -> bool {
    schema::projection::PRESENTATION_ONLY_FIELDS.contains(&key)
}

/// String items of an `aliases:` field value.
fn alias_items(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Capture one out-of-band knowledge edit from the file's parsed state,
/// exactly as the launch scan or the live watcher found it. Field-level
/// diffs run the SAME assertion+revision batch builder as IPC capture,
/// with actor `human:owner`, both authority fields `unknown`, and a
/// deterministic request key from path/base revision/old hash/new hash.
/// Prose defaults to editorial override, with the one carve-out: a body
/// change that uniquely maps onto a current-basis Observation's
/// `extracted_text` becomes a `field_change` correction. Ambiguity,
/// provenance forgery, and alias removal refuse with typed errors — the
/// caller escalates those into reconciliation, never guesses.
pub(crate) fn capture_out_of_band_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    path: &str,
) -> Result<(), String> {
    let krel = path
        .strip_prefix("knowledge/")
        .ok_or("capture applies only to knowledge/ projections")?;
    let raw = std::fs::read_to_string(vault.join(path)).map_err(|e| format!("{path}: {e}"))?;
    super::project::parse_okf(&raw)?; // unparsable bytes refuse early

    let state = current_state(writer, vault)?;
    if state.reconciliation_open() {
        return Err(RECONCILIATION_SUSPENDED.to_string());
    }
    let diff = diff_projection_file(&state, krel, &raw)?;
    capture_diff_with(writer, vault, path, diff, schema::OverrideOrigin::OutOfBand)
}

/// Commit one mechanical diff: structured first (the revision moves the
/// head), then ONE editorial override carrying every presentation op plus
/// the body rewrite — each under its deterministic request key.
fn capture_diff_with(
    writer: &mut LedgerWriter,
    vault: &Path,
    path: &str,
    diff: FileDiff,
    origin: schema::OverrideOrigin,
) -> Result<(), String> {
    let request_id = crate::ledger::sha256_hex(
        serde_json::to_string(&serde_json::json!({
            "capture": "out-of-band-v1",
            "path": path,
            "base": diff.base_generating_event,
            "old": diff.old_hash,
            "new": diff.new_hash,
        }))
        .map_err(|e| e.to_string())?
        .as_bytes(),
    );
    if !diff.fields.is_empty() || !diff.relations.is_empty() || !diff.alias_adds.is_empty() {
        let request = CaptureRequest {
            path: path.to_string(),
            actor_id: "human:owner".to_string(),
            fields: diff.fields,
            relations: diff.relations,
            alias_adds: diff.alias_adds,
            authority: AuthorityAnswers::default(),
            request_id: request_id.clone(),
        };
        capture_structured_with(writer, vault, &request)?;
    }
    if !diff.editorial_ops.is_empty() {
        let request = EditorialRequest {
            path: path.to_string(),
            actor_id: "human:owner".to_string(),
            ops: diff.editorial_ops,
            origin,
            request_id: format!("{request_id}-editorial"),
        };
        capture_editorial_with(writer, vault, &request)?;
    }
    Ok(())
}

/// The M23.7 valve, body half: an in-app body edit to a projection is a
/// captured change, not a refused write. `None` without an active writer.
pub fn capture_body_edit(vault: &Path, path: &str, body: &str) -> Option<Result<(), String>> {
    shadow::with_writer(vault, |writer| {
        let krel = path
            .strip_prefix("knowledge/")
            .ok_or("capture applies only to knowledge/ projections")?;
        let state = current_state(writer, vault)?;
        if state.reconciliation_open() {
            return Err(RECONCILIATION_SUSPENDED.to_string());
        }
        let belief_id = state
            .projection_paths
            .get(krel)
            .ok_or_else(|| format!("{path} is not a committed projection"))?
            .clone();
        let belief = state.beliefs.get(&belief_id).expect("path index");
        let (_, fields) = super::reduce::overlaid(&state, belief);
        let empty = fields.as_object().is_none_or(|m| m.is_empty());
        let trimmed = body.trim_end();
        let content = if empty {
            format!(
                "{trimmed}
"
            )
        } else {
            format!(
                "
{trimmed}
"
            )
        };
        let raw = super::project::project(&content, &fields);
        let diff = diff_projection_file(&state, krel, &raw)?;
        capture_diff_with(writer, vault, path, diff, schema::OverrideOrigin::InApp)
    })
}

/// The M23.7 valve, frontmatter half: an in-app patch to a projection's
/// frontmatter partitions exactly like every other capture — presentation
/// keys become editorial ops, epistemic keys become assertions plus their
/// revision, relation/alias keys their paired events; provenance stamps and
/// alias removal stay refused. `None` without an active writer.
pub fn capture_frontmatter_patch(
    vault: &Path,
    path: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Option<Result<(), String>> {
    shadow::with_writer(vault, |writer| {
        let krel = path
            .strip_prefix("knowledge/")
            .ok_or("capture applies only to knowledge/ projections")?;
        let state = current_state(writer, vault)?;
        if state.reconciliation_open() {
            return Err(RECONCILIATION_SUSPENDED.to_string());
        }
        let belief_id = state
            .projection_paths
            .get(krel)
            .ok_or_else(|| format!("{path} is not a committed projection"))?
            .clone();
        let belief = state.beliefs.get(&belief_id).expect("path index");
        let (content, fields) = super::reduce::overlaid(&state, belief);
        let mut intended = fields.as_object().cloned().unwrap_or_default();
        for (key, value) in patch {
            if value.is_null() {
                intended.shift_remove(key);
            } else {
                intended.insert(key.clone(), value.clone());
            }
        }
        let raw = super::project::project(&content, &serde_json::Value::Object(intended));
        let diff = diff_projection_file(&state, krel, &raw)?;
        capture_diff_with(writer, vault, path, diff, schema::OverrideOrigin::InApp)
    })
}

/// The mechanical, deterministic diff of one on-disk projection file
/// against the current reducer state — the shared core of out-of-band
/// capture and reconciliation adoption. Refusals are typed: provenance
/// forgery, alias removal, and ambiguous extracted-text overlap all refuse
/// rather than guess.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FileDiff {
    pub belief_id: String,
    pub fields: Vec<FieldEdit>,
    pub relations: Vec<RelationEdit>,
    pub alias_adds: Vec<String>,
    /// Presentation-field ops plus the default body override, in op order.
    pub editorial_ops: Vec<schema::OverridePatchOp>,
    pub old_hash: String,
    pub new_hash: String,
    pub base_generating_event: String,
}

pub(crate) fn diff_projection_file(
    state: &EpistemicState,
    krel: &str,
    raw: &str,
) -> Result<FileDiff, String> {
    let (new_content, new_fields) = super::project::parse_okf(raw)?;
    let new_fields = new_fields.as_object().cloned().unwrap_or_default();
    let belief_id = state
        .projection_paths
        .get(krel)
        .ok_or_else(|| format!("knowledge/{krel} is not a committed projection"))?
        .clone();
    let belief = state.beliefs.get(&belief_id).expect("path index");
    let (old_content, old_fields_value) = super::reduce::overlaid(state, belief);
    let old_fields = old_fields_value.as_object().cloned().unwrap_or_default();
    let old_hash =
        crate::ledger::sha256_hex(super::reduce::projected_bytes(state, belief).as_bytes());
    let new_hash = crate::ledger::sha256_hex(raw.as_bytes());

    // Partition the frontmatter diff.
    let mut fields: Vec<FieldEdit> = Vec::new();
    let mut editorial_ops: Vec<schema::OverridePatchOp> = Vec::new();
    let mut alias_adds: Vec<String> = Vec::new();
    let keys: Vec<String> = old_fields
        .keys()
        .chain(new_fields.keys().filter(|k| !old_fields.contains_key(*k)))
        .cloned()
        .collect();
    for key in keys {
        let before = old_fields.get(&key);
        let after = new_fields.get(&key);
        if before == after {
            continue;
        }
        // Provenance is never a human diff: a changed generated/verified
        // stamp is forgery, hard-refused into reconciliation.
        if key == "generated" || key == "verified" {
            return Err(format!(
                "provenance forgery: the {key} stamp changed out of band — refused"
            ));
        }
        if key == "aliases" {
            let norms = |value: Option<&serde_json::Value>| -> BTreeSet<String> {
                alias_items(value)
                    .iter()
                    .map(|a| schema::normalize_alias_v1(a))
                    .filter(|n| !n.is_empty())
                    .collect()
            };
            if norms(before).difference(&norms(after)).next().is_some() {
                return Err(UNSUPPORTED_ALIAS_REMOVAL.to_string());
            }
            for alias in alias_items(after) {
                let normalized = schema::normalize_alias_v1(&alias);
                if !normalized.is_empty() && !state.alias_registry.contains_key(&normalized) {
                    alias_adds.push(alias);
                }
            }
        }
        let edit = FieldEdit {
            field_path: format!("/fields/{}", key.replace('~', "~0").replace('/', "~1")),
            before: before
                .map(super::reduce::typed_from_value)
                .unwrap_or(TypedValue::Missing),
            after: after
                .map(super::reduce::typed_from_value)
                .unwrap_or(TypedValue::Missing),
            corrects: None,
            reason: None,
        };
        if is_presentation_key(&key) {
            editorial_ops.push(schema::OverridePatchOp {
                field_path: edit.field_path.clone(),
                before: edit.before,
                after: edit.after,
            });
        } else {
            fields.push(edit);
        }
    }

    // Relation diffs pair with their exact events (field patches above keep
    // the projection matching the file bytes).
    let relations = relation_diff(state, &belief_id, &old_fields, &new_fields);

    // The body: editorial by default; the extracted-claim-text carve-out
    // when the mapping is UNIQUE; ambiguity refuses, never guesses.
    if new_content != old_content {
        let candidates = extracted_text_candidates(state, belief, &old_content, &new_content);
        match candidates.len() {
            0 => editorial_ops.push(schema::OverridePatchOp {
                field_path: "/body".to_string(),
                before: TypedValue::string(&old_content),
                after: TypedValue::string(&new_content),
            }),
            1 => fields.push(FieldEdit {
                field_path: "/body".to_string(),
                before: TypedValue::string(&old_content),
                after: TypedValue::string(&new_content),
                corrects: Some(candidates[0].clone()),
                reason: Some("out-of-band correction of extracted claim text".to_string()),
            }),
            _ => {
                return Err(
                    "ambiguous extracted-text overlap — reconciliation, never a guess".to_string(),
                )
            }
        }
    }

    Ok(FileDiff {
        belief_id,
        fields,
        relations,
        alias_adds,
        editorial_ops,
        old_hash,
        new_hash,
        base_generating_event: belief.projection_head_event.clone(),
    })
}

/// The intended-vs-live relation diff for a parsed fields object.
fn relation_diff(
    state: &EpistemicState,
    belief_id: &str,
    old_fields: &serde_json::Map<String, serde_json::Value>,
    new_fields: &serde_json::Map<String, serde_json::Value>,
) -> Vec<RelationEdit> {
    use super::migrate::{stem_of, wikilinks};
    let stems: std::collections::BTreeMap<String, String> = state
        .projection_paths
        .iter()
        .map(|(path, belief)| (stem_of(path).to_string(), belief.clone()))
        .collect();
    let resolve = |fields: &serde_json::Map<String, serde_json::Value>| {
        let mut set: BTreeSet<(String, RelationKind)> = BTreeSet::new();
        for (field, kind) in [
            ("supersedes", RelationKind::Supersedes),
            ("refines", RelationKind::Refines),
            ("contradicts", RelationKind::Contradicts),
        ] {
            for link in wikilinks(fields.get(field)) {
                if let Some(target) = stems.get(&link) {
                    if target != belief_id {
                        set.insert((target.clone(), kind));
                    }
                }
            }
        }
        set
    };
    let old = resolve(old_fields);
    let new = resolve(new_fields);
    let mut edits: Vec<RelationEdit> = Vec::new();
    for (to, kind) in new.difference(&old) {
        edits.push(RelationEdit {
            action: RelationAction::Add,
            to_belief_id: to.clone(),
            kind: *kind,
        });
    }
    for (to, kind) in old.difference(&new) {
        edits.push(RelationEdit {
            action: RelationAction::Remove,
            to_belief_id: to.clone(),
            kind: *kind,
        });
    }
    edits
}

/// Current-basis Observations whose `extracted_text` occurs EXACTLY once in
/// the old body and was changed by the edit — the correction candidates.
fn extracted_text_candidates(
    state: &EpistemicState,
    belief: &super::reduce::BeliefState,
    old_content: &str,
    new_content: &str,
) -> Vec<String> {
    let BeliefBasis::Linked { links } = &belief.current().basis else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for link in links {
        let Some(text) = state.extracted_texts.get(&link.observation_event_id) else {
            continue;
        };
        if old_content.matches(text.as_str()).count() == 1 && !new_content.contains(text.as_str()) {
            candidates.push(link.observation_event_id.clone());
        }
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::super::migrate::tests::{corpus_copy, WRITER};
    use super::super::reduce::{projected_bytes, typed_from_value};
    use super::*;

    const PATH: &str = "knowledge/systems/status-model.md";
    const KREL: &str = "systems/status-model.md";

    fn migrated(label: &str) -> (std::path::PathBuf, LedgerWriter, String) {
        let vault = corpus_copy(label);
        let mut writer = LedgerWriter::open(&vault, WRITER).unwrap();
        let store = writer.store_id().to_string();
        super::super::migrate::migrate_vault(&mut writer, &vault.join("knowledge")).unwrap();
        (vault, writer, store)
    }

    fn field_edit(path: &str, before: TypedValue, after: TypedValue) -> FieldEdit {
        FieldEdit {
            field_path: path.into(),
            before,
            after,
            corrects: None,
            reason: None,
        }
    }

    #[test]
    fn a_field_edit_commits_assertion_plus_revision_atomically() {
        let (vault, mut writer, store) = migrated("capture-field");
        let state = current_state(&writer, &vault).unwrap();
        let belief_id = schema::migrate_id(&store, "belief", KREL);
        let belief = state.beliefs.get(&belief_id).unwrap();
        let before = belief
            .current()
            .fields
            .get("title")
            .cloned()
            .map(|v| typed_from_value(&v))
            .unwrap_or(TypedValue::Missing);

        let request = CaptureRequest {
            path: PATH.into(),
            actor_id: "human:owner".into(),
            fields: vec![field_edit(
                "/fields/title",
                before,
                TypedValue::string("Status model (authoritative)"),
            )],
            relations: vec![],
            alias_adds: vec![],
            authority: AuthorityAnswers::default(),
            request_id: "req-capture-1".into(),
        };
        capture_structured_with(&mut writer, &vault, &request).unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief = state.beliefs.get(&belief_id).unwrap();
        assert_eq!(belief.current().revision, 2);
        // The basis became linked: the human assertion supports it.
        let BeliefBasis::Linked { links } = &belief.current().basis else {
            panic!("the replacement basis links the assertion");
        };
        assert_eq!(links.len(), 1);
        let observation = state
            .observations
            .get(&links[0].observation_event_id)
            .unwrap();
        assert_eq!(observation.kind, ObservationKind::HumanAssertion);
        assert_eq!(
            observation.authority,
            Some(AuthorityProvenance::TrustedHumanCapture)
        );
        assert_eq!(observation.assertion_basis, Some(AssertionBasis::Unknown));
        // The first capture registered the human source IN the same batch.
        assert!(state
            .sources
            .values()
            .any(|s| s.registration.kind_str() == "human_actor"));
        // The projection landed, title updated.
        let disk = std::fs::read_to_string(vault.join(PATH)).unwrap();
        assert_eq!(disk, projected_bytes(&state, belief));
        assert!(disk.contains("Status model (authoritative)"));
        // A retry with the same request id replays, appending nothing.
        let head = writer.head();
        capture_structured_with(&mut writer, &vault, &request).unwrap();
        assert_eq!(writer.head(), head);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_stale_before_value_refuses_the_whole_capture() {
        let (vault, mut writer, _) = migrated("capture-stale");
        let request = CaptureRequest {
            path: PATH.into(),
            actor_id: "human:owner".into(),
            fields: vec![field_edit(
                "/fields/title",
                TypedValue::string("never the current title"),
                TypedValue::string("X"),
            )],
            relations: vec![],
            alias_adds: vec![],
            authority: AuthorityAnswers::default(),
            request_id: "req-capture-stale".into(),
        };
        let head = writer.head();
        let err = capture_structured_with(&mut writer, &vault, &request).unwrap_err();
        assert!(err.contains("stale"), "{err}");
        assert_eq!(writer.head(), head, "zero events for a refused capture");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn relation_and_alias_edits_pair_with_their_exact_events() {
        let (vault, mut writer, store) = migrated("capture-relation");
        let belief_id = schema::migrate_id(&store, "belief", KREL);
        let pilot = schema::migrate_id(&store, "belief", "systems/offline-window-pilot.md");
        let request = CaptureRequest {
            path: PATH.into(),
            actor_id: "human:owner".into(),
            fields: vec![],
            relations: vec![RelationEdit {
                action: RelationAction::Add,
                to_belief_id: pilot.clone(),
                kind: RelationKind::Refines,
            }],
            alias_adds: vec!["The Status Model".into()],
            authority: AuthorityAnswers {
                role: SubjectRole::ProjectOwner,
                assertion_basis: AssertionBasis::Firsthand,
            },
            request_id: "req-capture-rel".into(),
        };
        capture_structured_with(&mut writer, &vault, &request).unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief = state.beliefs.get(&belief_id).unwrap();
        // F = 0: the changed basis makes the empty-patch revision valid.
        assert_eq!(belief.current().revision, 2);
        let BeliefBasis::Linked { links } = &belief.current().basis else {
            panic!("basis linked");
        };
        assert_eq!(links.len(), 2, "relation + alias assertions support it");
        assert!(state
            .relations
            .values()
            .any(|r| r.live && r.from == belief_id && r.to == pilot));
        assert!(state.alias_registry.contains_key("the status model"));
        // The UI-selected authority rode the assertions; provenance is the
        // core's derivation either way.
        let observation = state
            .observations
            .get(&links[0].observation_event_id)
            .unwrap();
        assert_eq!(observation.assertion_basis, Some(AssertionBasis::Firsthand));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn editorial_capture_changes_projection_without_evidence() {
        let (vault, mut writer, store) = migrated("capture-editorial");
        let belief_id = schema::migrate_id(&store, "belief", KREL);
        let state = current_state(&writer, &vault).unwrap();
        let belief = state.beliefs.get(&belief_id).unwrap();
        let (content, _) = super::super::reduce::overlaid(&state, belief);

        let request = EditorialRequest {
            path: PATH.into(),
            actor_id: "human:owner".into(),
            ops: vec![schema::OverridePatchOp {
                field_path: "/body".into(),
                before: TypedValue::string(&content),
                after: TypedValue::string(&format!(
                    "{}\nEditorial touch-up.\n",
                    content.trim_end()
                )),
            }],
            origin: schema::OverrideOrigin::InApp,
            request_id: "req-editorial-1".into(),
        };
        let observations_before = current_state(&writer, &vault).unwrap().observations.len();
        capture_editorial_with(&mut writer, &vault, &request).unwrap();

        let state = current_state(&writer, &vault).unwrap();
        let belief = state.beliefs.get(&belief_id).unwrap();
        assert_eq!(belief.overrides.len(), 1, "one active overlay");
        assert_eq!(belief.current().revision, 1, "no revision — not evidence");
        assert_eq!(
            state.observations.len(),
            observations_before,
            "no Observation, basis, lineage, or support from an override"
        );
        let disk = std::fs::read_to_string(vault.join(PATH)).unwrap();
        assert!(disk.contains("Editorial touch-up."));
        assert_eq!(disk, projected_bytes(&state, belief));

        // Provenance and epistemic fields stay hard-refused.
        let refused = EditorialRequest {
            path: PATH.into(),
            actor_id: "human:owner".into(),
            ops: vec![schema::OverridePatchOp {
                field_path: "/fields/verified".into(),
                before: TypedValue::Missing,
                after: TypedValue::string("forged"),
            }],
            origin: schema::OverrideOrigin::InApp,
            request_id: "req-editorial-2".into(),
        };
        let err = capture_editorial_with(&mut writer, &vault, &refused).unwrap_err();
        assert!(err.contains("presentation-only"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn the_capture_batch_without_its_marker_has_no_effect() {
        // The reducer-level guarantee is already pinned by the batches
        // vectors; here the CAPTURE path proves the writer door: kill after
        // the commit means the retry replays, and a torn marker means the
        // orphaned members never touch state (writer::tests cover the tear;
        // this asserts the capture request id is the operation key).
        let (vault, mut writer, _) = migrated("capture-orphan");
        let request = CaptureRequest {
            path: PATH.into(),
            actor_id: "human:owner".into(),
            fields: vec![field_edit(
                "/fields/status",
                TypedValue::Missing,
                TypedValue::string("authoritative"),
            )],
            relations: vec![],
            alias_adds: vec![],
            authority: AuthorityAnswers::default(),
            request_id: "req-capture-key".into(),
        };
        capture_structured_with(&mut writer, &vault, &request).unwrap();
        drop(writer);
        let read = super::super::read_ledger(&ledger_dir(&vault)).unwrap();
        let marker = read
            .frames
            .iter()
            .find(|f| f.kind == schema::KIND_BATCH_COMMITTED)
            .unwrap();
        assert_eq!(
            marker.body["idempotency_key"],
            serde_json::json!("req-capture-key")
        );
        let _ = std::fs::remove_dir_all(&vault);
    }
}
