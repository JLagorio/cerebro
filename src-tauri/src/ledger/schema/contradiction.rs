//! The resolution pipeline's vocabulary (M27.3a) — five bodies, one matrix.
//!
//! **Scope resolution BEFORE contradiction** (D12/amendment 8). M26's
//! `conflict.candidate_detected` says a pair is worth classifying. Everything
//! here is the classification, and the whole point of it is that most
//! candidates are NOT contradictions: "Rev A uses NVIDIA" against "Rev C uses
//! AMD" is temporal succession, and intended-vs-shipping is stage lag. Without
//! this step the preservation gate screams at normal evolution, the owner
//! learns to ignore it, and the entire surface dies.
//!
//! **Every classification records epistemic history, including the ones that
//! resolve.** "We almost called this a contradiction, and here is why we did
//! not" is a fact about the base worth keeping — it is what stops the same
//! pair being re-litigated on every pass, and it is Skeptic food later.
//!
//! **Two endpoint kinds, and the second exists because nothing may fabricate
//! an assertion.** An ordinary comparison wraps M26's exact
//! [`ConflictCandidateEndpointV1`]. A declared `contradicts` relation — a
//! migrated one, or one a person authored — has no assertion behind it at
//! all, and inventing one to fit the ordinary shape would put a claim in the
//! ledger that nobody made. It gets a tagged `declared_relation` endpoint
//! whose scope, stage, and valid time are explicitly `known`-or-`unknown`
//! rather than defaulted, and its own comparison-id formula so the two kinds
//! can never collide.
//!
//! **The outcome/provenance/reason matrix is closed and checked here.** Typed
//! subject, scope, time, and stage comparisons are deterministic and may never
//! be agent-supplied; `same_meaning` and `conditional` are semantic judgements
//! and may never be deterministic. Mixing a semantic reason into a structural
//! result, or a relation reason into a non-relation one, refuses. That is what
//! stops a model smuggling "these mean the same thing" in as a reducer fact.

use serde::{Deserialize, Serialize};

use super::{
    canonical_json, is_id128, is_sha256, schema_body, sha256_first128, ConflictCandidateEndpointV1,
    ConflictOutcome, Scope, Stage, ValidInterval,
};

/// Where a declared `contradicts` relation came from. Closed, and the three
/// are genuinely different: a migration inherited it, a person wrote it before
/// the pipeline existed, or a person wrote it after — and only the last had a
/// classification available at the moment it was authored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationOrigin {
    LegacyMigration,
    PreActivationDeclared,
    PostActivationDeclared,
}

impl RelationOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            RelationOrigin::LegacyMigration => "legacy_migration",
            RelationOrigin::PreActivationDeclared => "pre_activation_declared",
            RelationOrigin::PostActivationDeclared => "post_activation_declared",
        }
    }

    pub const ALL: [RelationOrigin; 3] = [
        RelationOrigin::LegacyMigration,
        RelationOrigin::PreActivationDeclared,
        RelationOrigin::PostActivationDeclared,
    ];
}

/// A qualifier a declared relation may or may not have. Tagged rather than
/// nullable for the reason [`super::StateStage::Unknown`] exists: "the relation did
/// not say" and "the relation said `planned`" are different inputs to the
/// gauntlet, and a null makes every reader decide which one it meant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KnownScope {
    Known { value: Scope },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KnownStage {
    Known { value: Stage },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KnownValidTime {
    Known { value: ValidInterval },
    Unknown,
}

/// One end of a declared-relation comparison. No assertion, because there is
/// none: the relation IS the claim, and the content hash is over the belief
/// revision's own projected bytes rather than over a value nobody asserted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeclaredRelationEndpoint {
    pub relation_event_id: String,
    pub belief_id: String,
    /// The revision current AT the relation event. Pinned, so a comparison
    /// stays about what was believed then.
    pub belief_revision_event_id: String,
    pub relation_origin: RelationOrigin,
    pub subject_id: String,
    pub content_hash: String,
    pub scope: KnownScope,
    pub state_stage: KnownStage,
    pub valid_time: KnownValidTime,
}

impl DeclaredRelationEndpoint {
    pub fn validate(&self, side: &str) -> Result<(), String> {
        for (name, id) in [
            ("relation_event_id", &self.relation_event_id),
            ("belief_id", &self.belief_id),
            ("belief_revision_event_id", &self.belief_revision_event_id),
            ("subject_id", &self.subject_id),
        ] {
            if !is_id128(id) {
                return Err(format!("{side}.{name} is not a 128-bit hex id"));
            }
        }
        if !is_sha256(&self.content_hash) {
            return Err(format!("{side}.content_hash is not a sha256 digest"));
        }
        if let KnownValidTime::Known { value } = &self.valid_time {
            for (name, stamp) in [("from", &value.from), ("to", &value.to)] {
                if let Some(stamp) = stamp {
                    if chrono::DateTime::parse_from_rfc3339(stamp).is_err() {
                        return Err(format!("{side}.valid_time.{name} {stamp:?} is not RFC3339"));
                    }
                }
            }
            if let (Some(from), Some(to)) = (&value.from, &value.to) {
                if from > to {
                    return Err(format!("{side}.valid_time ends before it starts"));
                }
            }
        }
        Ok(())
    }
}

/// One end of a comparison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConflictEndpoint {
    /// M26's endpoint, byte for byte. `flatten` rather than a nested object
    /// because the design says "wraps M26's exact candidate endpoint" — a
    /// nesting level would make the two shapes different bytes for the same
    /// facts, and the reducer compares them against the committed candidate.
    Asserted {
        #[serde(flatten)]
        endpoint: ConflictCandidateEndpointV1,
    },
    DeclaredRelation {
        #[serde(flatten)]
        endpoint: DeclaredRelationEndpoint,
    },
}

impl ConflictEndpoint {
    pub fn belief_id(&self) -> &str {
        match self {
            ConflictEndpoint::Asserted { endpoint } => &endpoint.belief_id,
            ConflictEndpoint::DeclaredRelation { endpoint } => &endpoint.belief_id,
        }
    }

    pub fn belief_revision_event_id(&self) -> &str {
        match self {
            ConflictEndpoint::Asserted { endpoint } => &endpoint.belief_revision_event_id,
            ConflictEndpoint::DeclaredRelation { endpoint } => &endpoint.belief_revision_event_id,
        }
    }

    pub fn subject_id(&self) -> &str {
        match self {
            ConflictEndpoint::Asserted { endpoint } => &endpoint.subject_id,
            ConflictEndpoint::DeclaredRelation { endpoint } => &endpoint.subject_id,
        }
    }

    pub fn asserted(&self) -> Option<&ConflictCandidateEndpointV1> {
        match self {
            ConflictEndpoint::Asserted { endpoint } => Some(endpoint),
            ConflictEndpoint::DeclaredRelation { .. } => None,
        }
    }

    pub fn declared(&self) -> Option<&DeclaredRelationEndpoint> {
        match self {
            ConflictEndpoint::DeclaredRelation { endpoint } => Some(endpoint),
            ConflictEndpoint::Asserted { .. } => None,
        }
    }

    pub fn validate(&self, side: &str) -> Result<(), String> {
        match self {
            ConflictEndpoint::Asserted { endpoint } => endpoint.validate(side),
            ConflictEndpoint::DeclaredRelation { endpoint } => endpoint.validate(side),
        }
    }
}

/// Why a classification concluded what it did. Closed.
///
/// Declared in string-sorted order, so `Ord` and the wire spelling agree and
/// "sorted" means one thing in both implementations — the same discipline
/// [`super::ConflictCandidateReason`] carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictReasonCode {
    ConditionalContext,
    DeclaredContradictsRelation,
    GranularityMismatch,
    IncompatibleValues,
    RelationMissingAssertion,
    RelationMissingScope,
    RelationMissingStage,
    RelationMissingValidTime,
    ScopeDisjoint,
    SemanticSameMeaning,
    StageDisjoint,
    TemporalDisjoint,
}

impl ConflictReasonCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ConflictReasonCode::ConditionalContext => "conditional_context",
            ConflictReasonCode::DeclaredContradictsRelation => "declared_contradicts_relation",
            ConflictReasonCode::GranularityMismatch => "granularity_mismatch",
            ConflictReasonCode::IncompatibleValues => "incompatible_values",
            ConflictReasonCode::RelationMissingAssertion => "relation_missing_assertion",
            ConflictReasonCode::RelationMissingScope => "relation_missing_scope",
            ConflictReasonCode::RelationMissingStage => "relation_missing_stage",
            ConflictReasonCode::RelationMissingValidTime => "relation_missing_valid_time",
            ConflictReasonCode::ScopeDisjoint => "scope_disjoint",
            ConflictReasonCode::SemanticSameMeaning => "semantic_same_meaning",
            ConflictReasonCode::StageDisjoint => "stage_disjoint",
            ConflictReasonCode::TemporalDisjoint => "temporal_disjoint",
        }
    }

    pub fn is_relation_missing(self) -> bool {
        matches!(
            self,
            ConflictReasonCode::RelationMissingAssertion
                | ConflictReasonCode::RelationMissingScope
                | ConflictReasonCode::RelationMissingStage
                | ConflictReasonCode::RelationMissingValidTime
        )
    }

    pub const ALL: [ConflictReasonCode; 12] = [
        ConflictReasonCode::ConditionalContext,
        ConflictReasonCode::DeclaredContradictsRelation,
        ConflictReasonCode::GranularityMismatch,
        ConflictReasonCode::IncompatibleValues,
        ConflictReasonCode::RelationMissingAssertion,
        ConflictReasonCode::RelationMissingScope,
        ConflictReasonCode::RelationMissingStage,
        ConflictReasonCode::RelationMissingValidTime,
        ConflictReasonCode::ScopeDisjoint,
        ConflictReasonCode::SemanticSameMeaning,
        ConflictReasonCode::StageDisjoint,
        ConflictReasonCode::TemporalDisjoint,
    ];
}

/// What kind of contradiction an open edge records. Exactly the three
/// unresolved outcomes — an edge is never `resolved_by_stage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    GenuineDirect,
    Partial,
    Conditional,
}

impl EdgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeKind::GenuineDirect => "genuine_direct",
            EdgeKind::Partial => "partial",
            EdgeKind::Conditional => "conditional",
        }
    }

    /// The edge an outcome opens, or `None` for the five that resolve the
    /// pair apart. The one place the "only unresolved classes open an edge"
    /// rule is spelled — [`ConflictOutcome::is_unresolved`] answers the same
    /// question, and this returns the kind that answer implies.
    pub fn of(outcome: ConflictOutcome) -> Option<EdgeKind> {
        match outcome {
            ConflictOutcome::GenuineDirect => Some(EdgeKind::GenuineDirect),
            ConflictOutcome::Partial => Some(EdgeKind::Partial),
            ConflictOutcome::Conditional => Some(EdgeKind::Conditional),
            _ => None,
        }
    }

    pub const ALL: [EdgeKind; 3] = [
        EdgeKind::GenuineDirect,
        EdgeKind::Partial,
        EdgeKind::Conditional,
    ];
}

/// Who decided, and under what.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Classification {
    Deterministic {
        rule_version: String,
    },
    /// The M24-mapped MEDIUM `classify_conflict` proposal. A semantic result
    /// cannot be smuggled in as a reducer fact, and this is the shape that
    /// makes the difference visible to a reader.
    AgentSupplied {
        proposal_id: String,
        model_id: String,
        prompt_version: String,
    },
}

impl Classification {
    pub fn is_deterministic(&self) -> bool {
        matches!(self, Classification::Deterministic { .. })
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Classification::Deterministic { .. } => "deterministic",
            Classification::AgentSupplied { .. } => "agent_supplied",
        }
    }
}

/// How a closed edge was addressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseDisposition {
    ResolvedWithEvidence,
    SupersededWithAddressing,
}

impl CloseDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseDisposition::ResolvedWithEvidence => "resolved_with_evidence",
            CloseDisposition::SupersededWithAddressing => "superseded_with_addressing",
        }
    }
}

/// `sha256("cerebro-relation-conflict-v1\0" + relation_event_id + "\0" +
/// first + "\0" + second)`, first 128 bits — where first/second are the
/// canonically sorted declared endpoints.
///
/// A separate domain from M26's asserted formula, so a declared comparison and
/// an asserted one about the same two beliefs can never collide: they are
/// different claims about different evidence and must be classifiable
/// separately.
pub fn derive_declared_comparison_id(
    relation_event_id: &str,
    left: &DeclaredRelationEndpoint,
    right: &DeclaredRelationEndpoint,
) -> Result<String, String> {
    let (first, second) = ordered_declared_endpoints(left, right)?;
    Ok(sha256_first128(
        format!("cerebro-relation-conflict-v1\0{relation_event_id}\0{first}\0{second}").as_bytes(),
    ))
}

/// The two declared endpoints as canonical JSON, lexicographically sorted.
pub fn ordered_declared_endpoints(
    a: &DeclaredRelationEndpoint,
    b: &DeclaredRelationEndpoint,
) -> Result<(String, String), String> {
    let (a, b) = (canonical_json(a)?, canonical_json(b)?);
    if a <= b {
        Ok((a, b))
    } else {
        Ok((b, a))
    }
}

/// `sha256("cerebro-contradiction-edge-v1\0" + comparison_id + "\0" + kind)`,
/// first 128 bits.
///
/// The KIND is in the id, so an edge that would be `partial` and one that
/// would be `genuine_direct` over the same comparison are different edges —
/// which they are: a reclassification is a different claim, not an amendment.
pub fn derive_edge_id(comparison_id: &str, kind: EdgeKind) -> String {
    sha256_first128(
        format!(
            "cerebro-contradiction-edge-v1\0{comparison_id}\0{}",
            kind.as_str()
        )
        .as_bytes(),
    )
}

pub fn derive_declared_comparison_key(store_uuid: &str, comparison_id: &str) -> String {
    format!("declared-comparison:{store_uuid}:{comparison_id}")
}

pub fn derive_contradiction_open_key(store_uuid: &str, edge_id: &str) -> String {
    format!("contradiction-open:{store_uuid}:{edge_id}")
}

schema_body! {
    /// The ONLY declared-endpoint creation event. Creates its comparison at
    /// v1; a duplicate append, a wrong formula, a mismatched relation event,
    /// or a reused id over different endpoint bytes all refuse.
    pub struct ConflictComparisonRegistered {
        pub comparison_id: String,
        pub left: DeclaredRelationEndpoint,
        pub right: DeclaredRelationEndpoint,
        /// Must equal BOTH endpoints' relation event. A registration that
        /// spanned two relations would be a comparison nobody declared.
        pub source_relation_event_id: String,
        pub reason: ConflictReasonCode,
        pub rule_version: String,
    }
}

impl ConflictComparisonRegistered {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.comparison_id) {
            return Err("comparison_id must be a 128-bit hex id".into());
        }
        if !is_id128(&self.source_relation_event_id) {
            return Err("source_relation_event_id must be a 128-bit hex id".into());
        }
        if self.rule_version.is_empty() {
            return Err("rule_version must be non-empty".into());
        }
        if self.reason != ConflictReasonCode::DeclaredContradictsRelation {
            return Err(format!(
                "a declared-relation registration is raised for {}, and this says {} — the \
                 registration records that somebody DECLARED a conflict, which is the only \
                 reason it exists",
                ConflictReasonCode::DeclaredContradictsRelation.as_str(),
                self.reason.as_str()
            ));
        }
        self.left.validate("left")?;
        self.right.validate("right")?;
        for (side, endpoint) in [("left", &self.left), ("right", &self.right)] {
            if endpoint.relation_event_id != self.source_relation_event_id {
                return Err(format!(
                    "{side}.relation_event_id is {}, and source_relation_event_id is {} — both \
                     endpoints come from the ONE relation this registration is about",
                    endpoint.relation_event_id, self.source_relation_event_id
                ));
            }
        }
        let (first, second) = ordered_declared_endpoints(&self.left, &self.right)?;
        if first == second {
            return Err(
                "left and right are the same endpoint — a belief does not contradict itself \
                 through a relation to itself"
                    .into(),
            );
        }
        if canonical_json(&self.left)? != first {
            return Err(
                "left must be the lexicographically-first endpoint — the body is a function of \
                 the pair, so an exact retry is exactly a retry"
                    .into(),
            );
        }
        let derived =
            derive_declared_comparison_id(&self.source_relation_event_id, &self.left, &self.right)?;
        if derived != self.comparison_id {
            return Err(format!(
                "comparison_id {} does not follow from this relation and these endpoints \
                 (expected {derived})",
                self.comparison_id
            ));
        }
        Ok(())
    }
}

schema_body! {
    /// What the gauntlet concluded about one comparison.
    pub struct ConflictClassified {
        pub comparison_id: String,
        pub left: ConflictEndpoint,
        pub right: ConflictEndpoint,
        pub outcome: ConflictOutcome,
        pub classification: Classification,
        /// Non-empty for an agent-supplied classification: a semantic
        /// judgement with no evidence is an opinion.
        pub evidence_event_ids: Vec<String>,
        /// Non-empty, sorted, duplicate-free. A classification that cannot
        /// say why is not one.
        pub reason_codes: Vec<ConflictReasonCode>,
        /// Supplied content for display. NEVER ordering — the ledger's own
        /// system position orders events (D3).
        pub classified_at: String,
    }
}

impl ConflictClassified {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.comparison_id) {
            return Err("comparison_id must be a 128-bit hex id".into());
        }
        self.left.validate("left")?;
        self.right.validate("right")?;
        if chrono::DateTime::parse_from_rfc3339(&self.classified_at).is_err() {
            return Err(format!(
                "classified_at {:?} is not RFC3339",
                self.classified_at
            ));
        }
        if self.reason_codes.is_empty() {
            return Err(
                "reason_codes must name at least one reason — a classification that cannot say \
                 why is not one"
                    .into(),
            );
        }
        if !self.reason_codes.windows(2).all(|pair| pair[0] < pair[1]) {
            return Err("reason_codes must be sorted and duplicate-free".into());
        }
        for id in &self.evidence_event_ids {
            if !is_id128(id) {
                return Err(format!(
                    "evidence_event_ids names {id:?}, which is not an id"
                ));
            }
        }
        if !self
            .evidence_event_ids
            .windows(2)
            .all(|pair| pair[0] < pair[1])
        {
            return Err("evidence_event_ids must be sorted and duplicate-free".into());
        }
        match &self.classification {
            Classification::Deterministic { rule_version } => {
                if rule_version.is_empty() {
                    return Err("a deterministic classification carries its rule version".into());
                }
            }
            Classification::AgentSupplied {
                proposal_id,
                model_id,
                prompt_version,
            } => {
                if !is_id128(proposal_id) {
                    return Err("agent_supplied.proposal_id must be a 128-bit hex id".into());
                }
                if model_id.is_empty() || prompt_version.is_empty() {
                    return Err(
                        "an agent-supplied classification names the model and the prompt version \
                         it came from"
                            .into(),
                    );
                }
                if self.evidence_event_ids.is_empty() {
                    return Err(
                        "an agent-supplied classification requires evidence — a semantic \
                         judgement with nothing behind it is an opinion"
                            .into(),
                    );
                }
            }
        }
        check_matrix(self.outcome, &self.classification, &self.reason_codes)
    }
}

/// The closed outcome/provenance/reason matrix.
///
/// Every rule here exists to stop one specific lie:
///
/// - **temporal / scope / stage are deterministic-ONLY**, because they are
///   typed comparisons over recorded qualifiers. A model that could "decide"
///   two valid-time intervals were disjoint could resolve a real conflict
///   away by being confident about arithmetic.
/// - **`same_meaning` and `conditional` are agent-ONLY**, because they are
///   semantic judgements. Letting a deterministic rule claim either would put
///   a model's job in the reducer with none of the review that goes with it.
/// - **`partial` splits by provenance**: an agent may reach it on
///   incompatible values, and the deterministic path may reach it ONLY as the
///   declared-relation expansion. A declared relation with missing
///   qualifiers cannot be resolved apart and must not be silently dropped, so
///   it opens a `partial` edge naming exactly what was missing.
/// - **Mixed reason sets refuse**: semantic with structural, relation with
///   non-relation. A classification is one claim about one pair.
pub fn check_matrix(
    outcome: ConflictOutcome,
    classification: &Classification,
    reasons: &[ConflictReasonCode],
) -> Result<(), String> {
    use ConflictOutcome as O;
    use ConflictReasonCode as R;

    let deterministic = classification.is_deterministic();
    let exactly = |code: R| -> Result<(), String> {
        if reasons == [code] {
            Ok(())
        } else {
            Err(format!(
                "outcome {} carries exactly [{}], and this carries [{}]",
                outcome.as_str(),
                code.as_str(),
                reasons
                    .iter()
                    .map(|r| r.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
    };
    let deterministic_only = |allowed: bool| -> Result<(), String> {
        if allowed {
            Ok(())
        } else {
            Err(format!(
                "outcome {} is a typed comparison over recorded qualifiers and is deterministic \
                 only — a model that could decide it could resolve a real conflict away by being \
                 confident about arithmetic",
                outcome.as_str()
            ))
        }
    };
    let agent_only = |allowed: bool| -> Result<(), String> {
        if allowed {
            Ok(())
        } else {
            Err(format!(
                "outcome {} is a semantic judgement and arrives only through an applied \
                 classify_conflict proposal — a deterministic rule claiming it would put a \
                 model's job in the reducer with none of the review",
                outcome.as_str()
            ))
        }
    };

    match outcome {
        O::ResolvedTemporally => {
            deterministic_only(deterministic)?;
            exactly(R::TemporalDisjoint)
        }
        O::ResolvedByScope => {
            deterministic_only(deterministic)?;
            exactly(R::ScopeDisjoint)
        }
        O::ResolvedByStage => {
            deterministic_only(deterministic)?;
            exactly(R::StageDisjoint)
        }
        O::ResolvedByGranularity => exactly(R::GranularityMismatch),
        O::SameMeaning => {
            agent_only(!deterministic)?;
            exactly(R::SemanticSameMeaning)
        }
        O::GenuineDirect => exactly(R::IncompatibleValues),
        O::Conditional => {
            agent_only(!deterministic)?;
            exactly(R::ConditionalContext)
        }
        O::Partial if deterministic => {
            // The declared-relation expansion, and nothing else. Either the
            // relation could not be resolved apart for named reasons, or it
            // is the bare declaration.
            if reasons == [R::DeclaredContradictsRelation] {
                return Ok(());
            }
            if !reasons.is_empty() && reasons.iter().all(|r| r.is_relation_missing()) {
                return Ok(());
            }
            Err(format!(
                "a deterministic `partial` is the declared-relation expansion only: either \
                 exactly [declared_contradicts_relation] or one or more relation_missing_* \
                 codes, and this carries [{}]",
                reasons
                    .iter()
                    .map(|r| r.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        }
        O::Partial => exactly(R::IncompatibleValues),
    }
}

schema_body! {
    /// A contradiction edge, opened. Only the three unresolved classes.
    pub struct ContradictionOpened {
        pub edge_id: String,
        pub comparison_id: String,
        pub left: ConflictEndpoint,
        pub right: ConflictEndpoint,
        pub kind: EdgeKind,
        pub classified_event_id: String,
    }
}

impl ContradictionOpened {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        for (name, id) in [
            ("edge_id", &self.edge_id),
            ("comparison_id", &self.comparison_id),
            ("classified_event_id", &self.classified_event_id),
        ] {
            if !is_id128(id) {
                return Err(format!("{name} must be a 128-bit hex id"));
            }
        }
        self.left.validate("left")?;
        self.right.validate("right")?;
        let derived = derive_edge_id(&self.comparison_id, self.kind);
        if derived != self.edge_id {
            return Err(format!(
                "edge_id {} does not follow from comparison {} and kind {} (expected {derived})",
                self.edge_id,
                self.comparison_id,
                self.kind.as_str()
            ));
        }
        Ok(())
    }
}

schema_body! {
    /// A contradiction edge, closed. There is no caller-authored close path:
    /// the interpreter emits this beside the addressing mutation whose event
    /// id it names.
    pub struct ContradictionClosed {
        pub edge_id: String,
        pub comparison_id: String,
        pub left_belief_id: String,
        pub right_belief_id: String,
        /// The mutation that addressed it — a preallocated event id, never a
        /// proposal lifecycle event and never a caller value.
        pub addressed_by_event_id: String,
        pub evidence_event_ids: Vec<String>,
        pub disposition: CloseDisposition,
    }
}

impl ContradictionClosed {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        for (name, id) in [
            ("edge_id", &self.edge_id),
            ("comparison_id", &self.comparison_id),
            ("left_belief_id", &self.left_belief_id),
            ("right_belief_id", &self.right_belief_id),
            ("addressed_by_event_id", &self.addressed_by_event_id),
        ] {
            if !is_id128(id) {
                return Err(format!("{name} must be a 128-bit hex id"));
            }
        }
        // NO distinctness check, deliberately, and M27.3a was wrong to have
        // one. A comparison may hold two assertions that one Belief revision
        // rests on at once — "Rev C is AMD" and "Rev C is NVIDIA", both
        // supporting the same revision — and that is not a degenerate case but
        // the most serious one: the base disagreeing with ITSELF, where a
        // merge cannot even be the fix. Refusing the close of such an edge
        // would have made it unclosable, which is a trap with a two-milestone
        // fuse. The version matrix says "each DISTINCT endpoint Belief once"
        // for exactly this reason.
        if self.evidence_event_ids.is_empty() {
            return Err(
                "a close carries the evidence that addressed it — silence and elapsed time \
                 cannot close an edge"
                    .into(),
            );
        }
        for id in &self.evidence_event_ids {
            if !is_id128(id) {
                return Err(format!(
                    "evidence_event_ids names {id:?}, which is not an id"
                ));
            }
        }
        if !self
            .evidence_event_ids
            .windows(2)
            .all(|pair| pair[0] < pair[1])
        {
            return Err("evidence_event_ids must be sorted and duplicate-free".into());
        }
        Ok(())
    }
}

schema_body! {
    /// The backfill checkpoint. Gate and lane activation require one covering
    /// the pre-activation ledger head.
    pub struct ContradictionBackfillCompleted {
        pub through_event_id: String,
        pub source_relation_count: u64,
        pub resolved_count: u64,
        pub opened_count: u64,
        pub rule_version: String,
    }
}

impl ContradictionBackfillCompleted {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.through_event_id) {
            return Err("through_event_id must be a 128-bit hex id".into());
        }
        if self.rule_version.is_empty() {
            return Err("rule_version must be non-empty".into());
        }
        if self.resolved_count + self.opened_count != self.source_relation_count {
            return Err(format!(
                "the backfill saw {} relations and accounts for {} — every relation it read is \
                 either resolved apart or has an open edge, and a marker that does not add up is \
                 a marker that stopped early",
                self.source_relation_count,
                self.resolved_count + self.opened_count
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::schema::{derive_value_hash, Actor, StateStage, TypedValue, BODY_SCHEMA};

    const A: &str = "11111111111111111111111111111111";
    const B: &str = "22222222222222222222222222222222";
    const C: &str = "33333333333333333333333333333333";
    const D: &str = "44444444444444444444444444444444";
    const RELATION: &str = "55555555555555555555555555555555";
    const SUBJECT: &str = "cccccccccccccccccccccccccccccccc";

    fn declared(belief: &str, revision: &str) -> DeclaredRelationEndpoint {
        DeclaredRelationEndpoint {
            relation_event_id: RELATION.into(),
            belief_id: belief.into(),
            belief_revision_event_id: revision.into(),
            relation_origin: RelationOrigin::LegacyMigration,
            subject_id: SUBJECT.into(),
            content_hash: "a".repeat(64),
            scope: KnownScope::Unknown,
            state_stage: KnownStage::Unknown,
            valid_time: KnownValidTime::Unknown,
        }
    }

    fn asserted(assertion: &str, belief: &str) -> ConflictCandidateEndpointV1 {
        ConflictCandidateEndpointV1 {
            assertion_event_id: assertion.into(),
            belief_id: belief.into(),
            belief_revision_event_id: belief.into(),
            subject_id: SUBJECT.into(),
            predicate: "ships_with".into(),
            value_hash: derive_value_hash(&TypedValue::string(assertion)).unwrap(),
            scope: Scope::empty(),
            state_stage: StateStage::Unknown,
            valid_time: ValidInterval {
                from: None,
                to: None,
            },
        }
    }

    fn common(actor: &str) -> (u64, Option<String>, Option<String>, Actor) {
        (
            BODY_SCHEMA,
            None,
            None,
            Actor {
                id: actor.to_string(),
            },
        )
    }

    fn registration() -> ConflictComparisonRegistered {
        let (left, right) = (declared(A, C), declared(B, D));
        let (first, _) = ordered_declared_endpoints(&left, &right).unwrap();
        let (left, right) = if canonical_json(&left).unwrap() == first {
            (left, right)
        } else {
            (right, left)
        };
        let (schema, batch_id, idempotency_key, actor) = common("system:conflict-backfill");
        ConflictComparisonRegistered {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            comparison_id: derive_declared_comparison_id(RELATION, &left, &right).unwrap(),
            left,
            right,
            source_relation_event_id: RELATION.into(),
            reason: ConflictReasonCode::DeclaredContradictsRelation,
            rule_version: "declared_contradicts_relation".into(),
        }
    }

    fn classified(
        outcome: ConflictOutcome,
        classification: Classification,
        reasons: Vec<ConflictReasonCode>,
    ) -> ConflictClassified {
        let (schema, batch_id, idempotency_key, actor) = common("system:conflict-classifier");
        let evidence = if classification.is_deterministic() {
            vec![]
        } else {
            vec![A.to_string()]
        };
        ConflictClassified {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            comparison_id: C.into(),
            left: ConflictEndpoint::Asserted {
                endpoint: asserted(A, C),
            },
            right: ConflictEndpoint::Asserted {
                endpoint: asserted(B, D),
            },
            outcome,
            classification,
            evidence_event_ids: evidence,
            reason_codes: reasons,
            classified_at: "2026-08-12T12:00:00.000Z".into(),
        }
    }

    fn deterministic() -> Classification {
        Classification::Deterministic {
            rule_version: "conflict-gauntlet-v1".into(),
        }
    }

    fn agent() -> Classification {
        Classification::AgentSupplied {
            proposal_id: A.into(),
            model_id: "claude-haiku-4-5-20251001".into(),
            prompt_version: "classify-conflict-v1".into(),
        }
    }

    #[test]
    fn the_reason_spelling_and_the_sort_order_are_the_same_order() {
        // `reason_codes` sorts by the enum's ordinal and the wire carries
        // strings; a TS reducer sorting the strings has to agree.
        let mut spellings: Vec<&str> = ConflictReasonCode::ALL.iter().map(|r| r.as_str()).collect();
        let declared = spellings.clone();
        spellings.sort_unstable();
        assert_eq!(spellings, declared);
    }

    #[test]
    fn only_the_three_unresolved_outcomes_open_an_edge() {
        let opens: Vec<&str> = ConflictOutcome::ALL
            .iter()
            .filter(|outcome| EdgeKind::of(**outcome).is_some())
            .map(|outcome| outcome.as_str())
            .collect();
        assert_eq!(opens, ["genuine_direct", "partial", "conditional"]);
        // The two spellings of the same rule must agree — `is_unresolved` is
        // M24's, `EdgeKind::of` is M27's, and a disagreement would mean a
        // proposal and its event class different things unresolved.
        for outcome in ConflictOutcome::ALL {
            assert_eq!(
                outcome.is_unresolved(),
                EdgeKind::of(outcome).is_some(),
                "{} disagrees with itself",
                outcome.as_str()
            );
        }
    }

    #[test]
    fn the_matrix_is_exhaustive_over_outcome_and_provenance() {
        // Every cell, both ways round. The rows that must refuse are the
        // whole reason the matrix is checked in the body rather than trusted
        // to the producer.
        use ConflictOutcome as O;
        use ConflictReasonCode as R;
        for (outcome, reason, deterministic_ok, agent_ok) in [
            (O::ResolvedTemporally, R::TemporalDisjoint, true, false),
            (O::ResolvedByScope, R::ScopeDisjoint, true, false),
            (O::ResolvedByStage, R::StageDisjoint, true, false),
            (O::ResolvedByGranularity, R::GranularityMismatch, true, true),
            (O::SameMeaning, R::SemanticSameMeaning, false, true),
            (O::GenuineDirect, R::IncompatibleValues, true, true),
            (O::Conditional, R::ConditionalContext, false, true),
        ] {
            assert_eq!(
                check_matrix(outcome, &deterministic(), &[reason]).is_ok(),
                deterministic_ok,
                "{} deterministic",
                outcome.as_str()
            );
            assert_eq!(
                check_matrix(outcome, &agent(), &[reason]).is_ok(),
                agent_ok,
                "{} agent-supplied",
                outcome.as_str()
            );
        }
    }

    #[test]
    fn a_semantic_result_cannot_be_smuggled_in_as_a_reducer_fact() {
        let detail = classified(
            ConflictOutcome::SameMeaning,
            deterministic(),
            vec![ConflictReasonCode::SemanticSameMeaning],
        )
        .validate()
        .unwrap_err();
        assert!(detail.contains("semantic judgement"), "{detail}");
    }

    #[test]
    fn a_structural_result_cannot_be_asserted_by_a_model() {
        let detail = classified(
            ConflictOutcome::ResolvedByStage,
            agent(),
            vec![ConflictReasonCode::StageDisjoint],
        )
        .validate()
        .unwrap_err();
        assert!(detail.contains("deterministic only"), "{detail}");
    }

    #[test]
    fn a_mixed_reason_set_refuses() {
        for reasons in [
            vec![
                ConflictReasonCode::IncompatibleValues,
                ConflictReasonCode::SemanticSameMeaning,
            ],
            vec![
                ConflictReasonCode::DeclaredContradictsRelation,
                ConflictReasonCode::IncompatibleValues,
            ],
        ] {
            assert!(classified(ConflictOutcome::GenuineDirect, agent(), reasons)
                .validate()
                .is_err());
        }
    }

    #[test]
    fn a_deterministic_partial_is_the_declared_relation_expansion_only() {
        // The bare declaration.
        classified(
            ConflictOutcome::Partial,
            deterministic(),
            vec![ConflictReasonCode::DeclaredContradictsRelation],
        )
        .validate()
        .unwrap();
        // Or named missing qualifiers, one or more.
        classified(
            ConflictOutcome::Partial,
            deterministic(),
            vec![
                ConflictReasonCode::RelationMissingScope,
                ConflictReasonCode::RelationMissingStage,
            ],
        )
        .validate()
        .unwrap();
        // Never incompatible values, which is the agent's route to partial.
        assert!(classified(
            ConflictOutcome::Partial,
            deterministic(),
            vec![ConflictReasonCode::IncompatibleValues],
        )
        .validate()
        .is_err());
        // And the agent may not reach it through relation codes.
        assert!(classified(
            ConflictOutcome::Partial,
            agent(),
            vec![ConflictReasonCode::RelationMissingScope],
        )
        .validate()
        .is_err());
    }

    #[test]
    fn an_agent_supplied_classification_without_evidence_is_an_opinion() {
        let mut body = classified(
            ConflictOutcome::SameMeaning,
            agent(),
            vec![ConflictReasonCode::SemanticSameMeaning],
        );
        body.evidence_event_ids.clear();
        assert!(body.validate().unwrap_err().contains("is an opinion"));
    }

    #[test]
    fn a_classification_has_to_say_why() {
        let mut body = classified(
            ConflictOutcome::GenuineDirect,
            deterministic(),
            vec![ConflictReasonCode::IncompatibleValues],
        );
        body.reason_codes.clear();
        assert!(body.validate().unwrap_err().contains("at least one reason"));
        body.reason_codes = vec![
            ConflictReasonCode::IncompatibleValues,
            ConflictReasonCode::ConditionalContext,
        ];
        assert!(body.validate().unwrap_err().contains("sorted"));
    }

    #[test]
    fn a_declared_registration_is_a_function_of_its_pair() {
        let body = registration();
        body.validate().unwrap();
        let mut swapped = body.clone();
        std::mem::swap(&mut swapped.left, &mut swapped.right);
        assert!(swapped
            .validate()
            .unwrap_err()
            .contains("lexicographically-first"));
    }

    #[test]
    fn a_registration_spanning_two_relations_refuses() {
        let mut body = registration();
        body.right.relation_event_id = "9".repeat(32);
        let detail = body.validate().unwrap_err();
        assert!(detail.contains("the ONE relation"), "{detail}");
    }

    #[test]
    fn the_declared_formula_is_a_different_domain_from_the_asserted_one() {
        // Two comparisons about the same two beliefs — one from evidence, one
        // from a declaration — are different claims and must be classifiable
        // separately.
        let body = registration();
        let asserted_id =
            crate::ledger::schema::derive_comparison_id(&asserted(A, C), &asserted(B, D)).unwrap();
        assert_ne!(body.comparison_id, asserted_id);
    }

    #[test]
    fn an_edge_id_follows_from_its_comparison_and_kind() {
        let genuine = derive_edge_id(C, EdgeKind::GenuineDirect);
        let partial = derive_edge_id(C, EdgeKind::Partial);
        assert_ne!(
            genuine, partial,
            "a reclassification is a different claim, not an amendment"
        );
        assert_eq!(genuine.len(), 32);
    }

    #[test]
    fn an_opened_edge_must_carry_the_id_its_own_fields_derive() {
        let (schema, batch_id, idempotency_key, actor) = common("system:conflict-classifier");
        let mut body = ContradictionOpened {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            edge_id: derive_edge_id(C, EdgeKind::GenuineDirect),
            comparison_id: C.into(),
            left: ConflictEndpoint::Asserted {
                endpoint: asserted(A, C),
            },
            right: ConflictEndpoint::Asserted {
                endpoint: asserted(B, D),
            },
            kind: EdgeKind::GenuineDirect,
            classified_event_id: A.into(),
        };
        body.validate().unwrap();
        body.kind = EdgeKind::Partial;
        assert!(body.validate().unwrap_err().contains("does not follow"));
    }

    #[test]
    fn silence_cannot_close_an_edge() {
        let (schema, batch_id, idempotency_key, actor) = common("system:policy");
        let mut body = ContradictionClosed {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            edge_id: derive_edge_id(C, EdgeKind::GenuineDirect),
            comparison_id: C.into(),
            left_belief_id: A.into(),
            right_belief_id: B.into(),
            addressed_by_event_id: D.into(),
            evidence_event_ids: vec![A.into()],
            disposition: CloseDisposition::ResolvedWithEvidence,
        };
        body.validate().unwrap();
        body.evidence_event_ids.clear();
        let detail = body.validate().unwrap_err();
        assert!(detail.contains("silence and elapsed time"), "{detail}");
    }

    #[test]
    fn a_backfill_marker_that_does_not_add_up_stopped_early() {
        let (schema, batch_id, idempotency_key, actor) = common("system:conflict-backfill");
        let mut body = ContradictionBackfillCompleted {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            through_event_id: A.into(),
            source_relation_count: 5,
            resolved_count: 3,
            opened_count: 2,
            rule_version: "conflict-backfill-v1".into(),
        };
        body.validate().unwrap();
        body.opened_count = 1;
        let detail = body.validate().unwrap_err();
        assert!(detail.contains("stopped early"), "{detail}");
    }

    #[test]
    fn an_asserted_endpoint_is_m26s_bytes_with_a_tag() {
        // The design says "wraps M26's exact candidate endpoint". A nesting
        // level would make the two shapes different bytes for the same facts.
        let endpoint = asserted(A, C);
        let wrapped = ConflictEndpoint::Asserted {
            endpoint: endpoint.clone(),
        };
        let inner = canonical_json(&endpoint).unwrap();
        let outer = canonical_json(&wrapped).unwrap();
        assert!(outer.starts_with("{\"kind\":\"asserted\","));
        assert!(outer.ends_with(&inner[1..]));
    }
}
