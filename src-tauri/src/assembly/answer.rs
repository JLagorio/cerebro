//! The nine-part answer (M26.5b) — one closed struct, not roughly nine prose
//! sections.
//!
//! **Retrieval adequacy and evidence sufficiency stay separate, always.**
//! They answer different questions — "did we look properly" and "is what we
//! found enough" — and they diverge in both directions: excellent retrieval
//! over thin evidence, and a single decisive document nobody searched hard
//! for. A model that could collapse them into one word would lose exactly the
//! distinction a person needs to decide whether to go looking.
//!
//! **Ten adequacy dimensions, named, never a score and never a generic map.**
//! A number cannot be argued with and a map can silently omit. Each dimension
//! carries its own state, its own basis refs, its own gaps, and its own
//! `as_of` — because "the source list was current an hour ago" and "the scope
//! was last confirmed in March" are different facts and averaging them
//! destroys both.
//!
//! **`as_of` is the MINIMUM of what it rests on, never the synthesis clock.**
//! A dimension resting on a coverage assessment from March is as of March. A
//! newer timestamp would be the answer claiming freshness it inherited from
//! nothing.
//!
//! **Every citation resolves.** `citation_refs` must equal the canonical
//! deduplicated set of the statement's own `basis_refs` — a citation list that
//! disagreed with the statement it cites is a footnote pointing somewhere the
//! text does not — and every ref must resolve to the CURRENT manifest, so an
//! answer cannot cite an item this assembly never held.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ledger::schema::{is_id128, is_sha256, Risk, Scope, Stage, SubjectRef};

use super::manifest::{QueryIntendedUse, ValidTime, WorkingMemoryManifest};

/// What kind of thing a statement is. Closed, because "shared root cause" is
/// a `hypothesis` unless it is directly supported (§76), and a vocabulary
/// that let a model call it a `conclusion` would make that rule unenforceable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementLabel {
    Observation,
    Conclusion,
    Uncertainty,
    Counterevidence,
    Alternative,
    Hypothesis,
    MissingExpectedEvidence,
    InvalidationCondition,
    Limitation,
    ProvisionalReason,
}

/// Something a statement rests on.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvidenceRef {
    ManifestItem {
        item_id: String,
    },
    Assertion {
        assertion_event_id: String,
    },
    BeliefRevision {
        belief_id: String,
        belief_revision_event_id: String,
    },
}

impl EvidenceRef {
    fn validate(&self) -> Result<(), String> {
        match self {
            EvidenceRef::ManifestItem { item_id } if item_id.trim().is_empty() => {
                Err("an evidence ref names an empty item_id".into())
            }
            EvidenceRef::ManifestItem { .. } => Ok(()),
            EvidenceRef::Assertion { assertion_event_id } if !is_id128(assertion_event_id) => {
                Err("an evidence ref has a bad assertion_event_id".into())
            }
            EvidenceRef::Assertion { .. } => Ok(()),
            EvidenceRef::BeliefRevision {
                belief_id,
                belief_revision_event_id,
            } if !is_id128(belief_id) || !is_id128(belief_revision_event_id) => {
                Err("an evidence ref has a bad belief revision ref".into())
            }
            EvidenceRef::BeliefRevision { .. } => Ok(()),
        }
    }
}

/// A sentence with a type and its basis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LabeledStatement {
    pub text: String,
    pub label: StatementLabel,
    pub basis_refs: Vec<EvidenceRef>,
}

impl LabeledStatement {
    fn validate(&self) -> Result<(), String> {
        if self.text.trim().is_empty() {
            return Err("a statement has no text".into());
        }
        for reference in &self.basis_refs {
            reference.validate()?;
        }
        Ok(())
    }
}

/// A statement that must cite something.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CitedStatement {
    pub statement: LabeledStatement,
    pub citation_refs: Vec<EvidenceRef>,
}

impl CitedStatement {
    fn validate(&self) -> Result<(), String> {
        self.statement.validate()?;
        if self.citation_refs.is_empty() {
            return Err(format!(
                "a cited statement cites nothing: {:?}",
                truncate(&self.statement.text)
            ));
        }
        // The citation list IS the statement's basis, canonicalized. A
        // footnote that points somewhere the text does not is worse than no
        // footnote, because it reads as corroboration.
        let cited = canonical(&self.citation_refs);
        let basis = canonical(&self.statement.basis_refs);
        if cited != basis {
            return Err(format!(
                "citation_refs and basis_refs disagree for {:?} — a citation that points \
                 somewhere the statement does not reads as corroboration and is not",
                truncate(&self.statement.text)
            ));
        }
        Ok(())
    }
}

fn canonical(refs: &[EvidenceRef]) -> BTreeSet<&EvidenceRef> {
    refs.iter().collect()
}

fn truncate(text: &str) -> String {
    text.chars().take(60).collect()
}

/// M25's seven coverage keys. Named so a basis ref cannot stand a generic
/// assessment id in for one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageDimensionKey {
    SourceConnected,
    SourceHealthy,
    ScopeKnown,
    ScopeAccessible,
    RetentionKnown,
    IndexCurrent,
    RetrievalAttempted,
}

/// What one adequacy dimension rests on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DimensionBasisRef {
    ManifestItem {
        item_id: String,
    },
    RuntimeHealth {
        component: String,
    },
    CoverageDimension {
        assessment_id: String,
        dimension: CoverageDimensionKey,
    },
}

impl DimensionBasisRef {
    fn validate(&self) -> Result<(), String> {
        match self {
            DimensionBasisRef::ManifestItem { item_id } if item_id.trim().is_empty() => {
                Err("a dimension basis ref names an empty item_id".into())
            }
            DimensionBasisRef::RuntimeHealth { component } if component.trim().is_empty() => {
                Err("a runtime_health basis ref names no component".into())
            }
            DimensionBasisRef::CoverageDimension { assessment_id, .. }
                if !is_id128(assessment_id) =>
            {
                Err("a coverage_dimension basis ref has a bad assessment_id".into())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DimensionState {
    Sufficient,
    Partial,
    Insufficient,
    Unknown,
    NotApplicable,
}

/// One of the ten. State, basis, gaps, and its OWN `as_of`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DimensionAssessment {
    pub state: DimensionState,
    pub basis_refs: Vec<DimensionBasisRef>,
    pub gaps: Vec<LabeledStatement>,
    pub as_of: String,
}

impl DimensionAssessment {
    fn validate(&self, name: &str) -> Result<(), String> {
        if chrono::DateTime::parse_from_rfc3339(&self.as_of).is_err() {
            return Err(format!("{name}.as_of {:?} is not RFC3339", self.as_of));
        }
        for reference in &self.basis_refs {
            reference.validate().map_err(|e| format!("{name}: {e}"))?;
        }
        for gap in &self.gaps {
            gap.validate().map_err(|e| format!("{name}: {e}"))?;
        }
        // A dimension that says it fell short and names no gap has told
        // nobody what to go and do about it.
        if matches!(
            self.state,
            DimensionState::Partial | DimensionState::Insufficient
        ) && self.gaps.is_empty()
        {
            return Err(format!(
                "{name} is {:?} and names no gap — a shortfall nobody can act on",
                self.state
            ));
        }
        Ok(())
    }

    /// Every coverage assessment this dimension rests on, with the exact
    /// dimension it read.
    pub fn coverage_refs(&self) -> Vec<(&str, CoverageDimensionKey)> {
        self.basis_refs
            .iter()
            .filter_map(|r| match r {
                DimensionBasisRef::CoverageDimension {
                    assessment_id,
                    dimension,
                } => Some((assessment_id.as_str(), *dimension)),
                _ => None,
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdequacyState {
    Sufficient,
    Partial,
    Insufficient,
    Unknown,
}

/// Did we look properly? Ten named dimensions — see the module note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dimensions {
    pub source_availability: DimensionAssessment,
    pub source_health: DimensionAssessment,
    pub scope_coverage: DimensionAssessment,
    pub temporal_suitability: DimensionAssessment,
    pub authority_coverage: DimensionAssessment,
    pub firsthandness: DimensionAssessment,
    pub retrieval_breadth: DimensionAssessment,
    pub contradiction_search: DimensionAssessment,
    pub lineage_independence: DimensionAssessment,
    pub stakes: DimensionAssessment,
}

impl Dimensions {
    /// All ten, by name. The array is what makes "ten" checkable.
    pub fn all(&self) -> [(&'static str, &DimensionAssessment); 10] {
        [
            ("source_availability", &self.source_availability),
            ("source_health", &self.source_health),
            ("scope_coverage", &self.scope_coverage),
            ("temporal_suitability", &self.temporal_suitability),
            ("authority_coverage", &self.authority_coverage),
            ("firsthandness", &self.firsthandness),
            ("retrieval_breadth", &self.retrieval_breadth),
            ("contradiction_search", &self.contradiction_search),
            ("lineage_independence", &self.lineage_independence),
            ("stakes", &self.stakes),
        ]
    }

    fn validate(&self) -> Result<(), String> {
        for (name, dimension) in self.all() {
            dimension.validate(name)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetrievalAdequacy {
    pub overall: AdequacyState,
    pub statement: LabeledStatement,
    pub dimensions: Dimensions,
}

impl RetrievalAdequacy {
    fn validate(&self) -> Result<(), String> {
        self.statement.validate()?;
        self.dimensions.validate()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SufficiencyLevel {
    Insufficient,
    Partial,
    Adequate,
    Strong,
}

/// Is what we found enough? Separate from adequacy, always — see the module
/// note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSufficiency {
    pub intended_use: QueryIntendedUse,
    pub level: SufficiencyLevel,
    pub basis_refs: Vec<EvidenceRef>,
    pub limitations: Vec<LabeledStatement>,
    pub requires_human_verification: bool,
}

impl EvidenceSufficiency {
    fn validate(&self) -> Result<(), String> {
        self.intended_use.validate()?;
        for reference in &self.basis_refs {
            reference.validate()?;
        }
        for limitation in &self.limitations {
            limitation.validate()?;
        }
        Ok(())
    }
}

/// Where to look next.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NextSource {
    pub source_id: Option<String>,
    pub source_class: String,
    pub authority_route_id: Option<String>,
    pub reason: LabeledStatement,
}

impl NextSource {
    fn validate(&self) -> Result<(), String> {
        if self.source_class.trim().is_empty() {
            return Err("a next source names no source_class".into());
        }
        if self.source_id.as_deref().is_some_and(|id| !is_id128(id)) {
            return Err("a next source has a bad source_id".into());
        }
        if self
            .authority_route_id
            .as_deref()
            .is_some_and(str::is_empty)
        {
            return Err("authority_route_id is null or a value, never empty".into());
        }
        self.reason.validate()
    }
}

/// A step before the server has numbered it. What `plan_id` hashes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryStepDraft {
    pub action: String,
    pub source: Option<NextSource>,
}

/// A step after the server has numbered it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryStep {
    pub step_id: String,
    pub ordinal: u64,
    pub action: String,
    pub source: Option<NextSource>,
}

/// What to go and find out. **Not a Discovery object** — it is a plan, and
/// the distinction is why the ids are content-derived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryPlan {
    pub plan_id: String,
    pub goal: String,
    pub steps: Vec<DiscoveryStep>,
    pub stop_when: Vec<LabeledStatement>,
    pub stakes: Risk,
}

/// `sha256("cerebro-discovery-plan-v1\0" + store + "\0" + canonical json)`.
///
/// Over the goal, the step DRAFTS, the stopping conditions and the stakes —
/// and deliberately not over any caller-authored step id. A render-only
/// change cannot mint a second plan, which is what makes the runtime
/// lifecycle table dedupe rather than accumulate.
pub fn derive_plan_id(
    store_uuid: &str,
    goal: &str,
    drafts: &[DiscoveryStepDraft],
    stop_when: &[LabeledStatement],
    stakes: Risk,
) -> Result<String, String> {
    let body = serde_json::json!({
        "goal": goal,
        "step_drafts": drafts,
        "stop_when": stop_when,
        "stakes": stakes,
    });
    let canonical = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"cerebro-discovery-plan-v1\0");
    bytes.extend_from_slice(store_uuid.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(canonical.as_bytes());
    Ok(crate::ledger::sha256_hex(&bytes))
}

impl DiscoveryPlan {
    /// Mint a plan: derive the id from the drafts, THEN number the steps.
    ///
    /// The order is the point. `step_id` is `plan_id:ordinal`, so the ids are
    /// a function of the plan rather than of whoever wrote it down — a caller
    /// cannot hand in step ids and get a different plan for the same work.
    pub fn mint(
        store_uuid: &str,
        goal: &str,
        drafts: Vec<DiscoveryStepDraft>,
        stop_when: Vec<LabeledStatement>,
        stakes: Risk,
    ) -> Result<DiscoveryPlan, String> {
        if drafts.is_empty() {
            return Err("a discovery plan with no steps is not a plan".into());
        }
        let plan_id = derive_plan_id(store_uuid, goal, &drafts, &stop_when, stakes)?;
        let steps = drafts
            .into_iter()
            .enumerate()
            .map(|(index, draft)| DiscoveryStep {
                step_id: format!("{plan_id}:{}", index + 1),
                ordinal: index as u64 + 1,
                action: draft.action,
                source: draft.source,
            })
            .collect();
        let plan = DiscoveryPlan {
            plan_id,
            goal: goal.to_string(),
            steps,
            stop_when,
            stakes,
        };
        plan.validate()?;
        Ok(plan)
    }

    fn validate(&self) -> Result<(), String> {
        if !is_sha256(&self.plan_id) {
            return Err("plan_id must be a lowercase SHA-256".into());
        }
        if self.goal.trim().is_empty() {
            return Err("a discovery plan has no goal".into());
        }
        if self.steps.is_empty() {
            return Err("a discovery plan with no steps is not a plan".into());
        }
        if self.stop_when.is_empty() {
            return Err(
                "a discovery plan must say when to STOP — a plan that cannot end is a standing \
                 instruction to keep spending"
                    .into(),
            );
        }
        for (index, step) in self.steps.iter().enumerate() {
            let expected = index as u64 + 1;
            if step.ordinal != expected {
                return Err(format!(
                    "step {} is at ordinal {expected} and says {}",
                    step.step_id, step.ordinal
                ));
            }
            if step.step_id != format!("{}:{expected}", self.plan_id) {
                return Err(format!(
                    "step id {:?} is not this plan's — step ids are derived, never authored",
                    step.step_id
                ));
            }
            if step.action.trim().is_empty() {
                return Err(format!("step {} has no action", step.step_id));
            }
            if let Some(source) = &step.source {
                source.validate()?;
            }
        }
        for stop in &self.stop_when {
            stop.validate()?;
        }
        Ok(())
    }
}

/// Where the answer applies, and when it was true.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeAndTime {
    pub subjects: Vec<SubjectRef>,
    pub scope: Scope,
    pub state_stage: Option<Stage>,
    pub valid_time: ValidTime,
    pub as_of: String,
}

impl ScopeAndTime {
    fn validate(&self) -> Result<(), String> {
        if self.subjects.is_empty() {
            return Err("an answer about nothing is not an answer — name a subject".into());
        }
        for subject in &self.subjects {
            subject.validate()?;
            // `SubjectRef::None` is a real M22 value — a snapshot may say it
            // is about nothing. An ANSWER may not: "this is about nothing"
            // beside a conclusion is a conclusion with no subject, which is
            // the same hole `subjects: []` would leave.
            if matches!(subject, SubjectRef::None) {
                return Err(
                    "an answer names a subject of `none` — a conclusion about nothing is not an \
                     answer, whichever way the hole is spelled"
                        .into(),
                );
            }
        }
        if chrono::DateTime::parse_from_rfc3339(&self.as_of).is_err() {
            return Err(format!(
                "scope_and_time.as_of {:?} is not RFC3339",
                self.as_of
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UncertaintiesAndCounterevidence {
    pub uncertainties: Vec<LabeledStatement>,
    pub counterevidence: Vec<CitedStatement>,
    pub alternatives: Vec<LabeledStatement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NextEvidence {
    pub missing_expected_evidence: Vec<LabeledStatement>,
    pub authoritative_next_sources: Vec<NextSource>,
    pub discovery_plan: Option<DiscoveryPlan>,
}

/// Why an answer is provisional. Closed: "we are not sure" is not a reason,
/// it is a restatement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisionalReasonCode {
    CoverageGap,
    AuthorityGap,
    CounterevidenceBlocked,
    EvidenceInsufficient,
    RuntimeFailure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provisional {
    pub value: bool,
    pub reason_codes: Vec<ProvisionalReasonCode>,
    pub reasons: Vec<LabeledStatement>,
}

/// Everything a model may say about a belief-affecting question, and nothing
/// it may say without.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SynthesisAnswer {
    pub observations: Vec<CitedStatement>,
    pub current_answer: LabeledStatement,
    pub basis: Vec<CitedStatement>,
    pub scope_and_time: ScopeAndTime,
    pub uncertainties_and_counterevidence: UncertaintiesAndCounterevidence,
    pub retrieval_adequacy: RetrievalAdequacy,
    pub evidence_sufficiency: EvidenceSufficiency,
    pub next_evidence: NextEvidence,
    pub invalidation_conditions: Vec<LabeledStatement>,
    pub provisional: Provisional,
    pub working_memory_manifest_id: String,
    pub content_label: ContentLabel,
}

/// One value. Everything a model writes is agent-supplied, and saying so is
/// not decoration — it is the field a reader checks before believing a
/// sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentLabel {
    AgentSupplied,
}

impl SynthesisAnswer {
    /// Everything checkable from the answer alone.
    pub fn validate(&self) -> Result<(), String> {
        for cited in self
            .observations
            .iter()
            .chain(&self.basis)
            .chain(&self.uncertainties_and_counterevidence.counterevidence)
        {
            cited.validate()?;
        }
        self.current_answer.validate()?;
        for statement in self
            .uncertainties_and_counterevidence
            .uncertainties
            .iter()
            .chain(&self.uncertainties_and_counterevidence.alternatives)
            .chain(&self.next_evidence.missing_expected_evidence)
            .chain(&self.invalidation_conditions)
            .chain(&self.provisional.reasons)
        {
            statement.validate()?;
        }
        for source in &self.next_evidence.authoritative_next_sources {
            source.validate()?;
        }
        if let Some(plan) = &self.next_evidence.discovery_plan {
            plan.validate()?;
        }
        self.scope_and_time.validate()?;
        self.retrieval_adequacy.validate()?;
        self.evidence_sufficiency.validate()?;
        self.validate_provisional()?;
        self.validate_basis_union()
    }

    fn validate_provisional(&self) -> Result<(), String> {
        let has = !self.provisional.reason_codes.is_empty() || !self.provisional.reasons.is_empty();
        match (self.provisional.value, has) {
            (true, false) => Err(
                "an answer is provisional and does not say why — 'we are not sure' is a \
                 restatement, not a reason"
                    .into(),
            ),
            (true, true) if self.provisional.reason_codes.is_empty() => {
                Err("a provisional answer needs a reason CODE, not only prose".into())
            }
            (true, true) if self.provisional.reasons.is_empty() => {
                Err("a provisional answer needs a reason a person can read".into())
            }
            (false, true) => {
                Err("an answer that is not provisional carries provisional reasons".into())
            }
            _ => Ok(()),
        }
    }

    /// `current_answer.basis_refs` is the union of what the basis cites.
    ///
    /// Not a superset and not a subset. A conclusion resting on something no
    /// basis statement cites is resting on something invisible; a basis
    /// statement the conclusion does not rest on is a citation for a claim
    /// nobody made.
    fn validate_basis_union(&self) -> Result<(), String> {
        let union: BTreeSet<&EvidenceRef> = self
            .basis
            .iter()
            .flat_map(|cited| &cited.citation_refs)
            .collect();
        let claimed: BTreeSet<&EvidenceRef> = self.current_answer.basis_refs.iter().collect();
        if union != claimed {
            return Err(
                "current_answer.basis_refs is not the union of what basis cites — a conclusion \
                 resting on something no basis names is resting on something invisible"
                    .into(),
            );
        }
        Ok(())
    }

    /// The rules that need the assembly this answer came from.
    ///
    /// Split from [`Self::validate`] because they are a DIFFERENT claim: the
    /// shape is checkable anywhere, and "does this resolve" is only checkable
    /// beside the manifest it claims to resolve against.
    pub fn validate_against(&self, manifest: &WorkingMemoryManifest) -> Result<(), String> {
        self.validate()?;
        if self.working_memory_manifest_id != manifest.assembly_id {
            return Err(format!(
                "answer names manifest {:?} and was checked against {:?}",
                self.working_memory_manifest_id, manifest.assembly_id
            ));
        }
        // One byte-equal intended use across retrieval and synthesis: a model
        // cannot decide the question was lower-stakes than the one that was
        // assembled for.
        if self.evidence_sufficiency.intended_use != manifest.intended_use {
            return Err(
                "the answer's intended use is not the manifest's — a model cannot weaken the \
                 kind, the stakes, or the predicate class between retrieval and synthesis"
                    .into(),
            );
        }
        self.validate_refs_resolve(manifest)?;
        self.validate_high_stakes()
    }

    fn validate_refs_resolve(&self, manifest: &WorkingMemoryManifest) -> Result<(), String> {
        let items: BTreeSet<&str> = manifest.items.iter().map(|i| i.item_id()).collect();
        let pinned = manifest.pinned_refs();
        for reference in self.evidence_refs() {
            let ok = match reference {
                EvidenceRef::ManifestItem { item_id } => items.contains(item_id.as_str()),
                other => pinned.contains(other),
            };
            if !ok {
                return Err(format!(
                    "the answer cites {reference:?}, which this assembly never held"
                ));
            }
        }
        for (_, dimension) in self.retrieval_adequacy.dimensions.all() {
            for basis in &dimension.basis_refs {
                if let DimensionBasisRef::ManifestItem { item_id } = basis {
                    if !items.contains(item_id.as_str()) {
                        return Err(format!(
                            "an adequacy dimension cites item {item_id}, which is not in the \
                             manifest"
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Every `EvidenceRef` anywhere in the answer.
    fn evidence_refs(&self) -> impl Iterator<Item = &EvidenceRef> {
        let cited = self
            .observations
            .iter()
            .chain(&self.basis)
            .chain(&self.uncertainties_and_counterevidence.counterevidence)
            .flat_map(|c| c.citation_refs.iter().chain(&c.statement.basis_refs));
        let plain = self
            .uncertainties_and_counterevidence
            .uncertainties
            .iter()
            .chain(&self.uncertainties_and_counterevidence.alternatives)
            .chain(&self.next_evidence.missing_expected_evidence)
            .chain(&self.invalidation_conditions)
            .chain(&self.provisional.reasons)
            .flat_map(|s| s.basis_refs.iter());
        cited
            .chain(plain)
            .chain(self.current_answer.basis_refs.iter())
            .chain(self.evidence_sufficiency.basis_refs.iter())
    }

    /// What a HIGH or CRITICAL answer owes.
    ///
    /// The M24 stopping rule in the answer's own shape: at these stakes an
    /// answer must say what it rests on, what it is missing, where to look,
    /// and what would change its mind. A routine answer may leave all four
    /// empty and the UI does not render them.
    fn validate_high_stakes(&self) -> Result<(), String> {
        if !self.evidence_sufficiency.intended_use.is_high_stakes() {
            return Ok(());
        }
        for (name, empty) in [
            (
                "current_answer.basis_refs",
                self.current_answer.basis_refs.is_empty(),
            ),
            ("basis", self.basis.is_empty()),
            (
                "next_evidence.missing_expected_evidence",
                self.next_evidence.missing_expected_evidence.is_empty(),
            ),
            (
                "next_evidence.authoritative_next_sources",
                self.next_evidence.authoritative_next_sources.is_empty(),
            ),
            (
                "invalidation_conditions",
                self.invalidation_conditions.is_empty(),
            ),
        ] {
            if empty {
                return Err(format!(
                    "a {} answer must fill {name} — at these stakes an answer owes what it rests \
                     on, what is missing, where to look, and what would change its mind",
                    self.evidence_sufficiency.intended_use.stakes.as_str()
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::manifest::tests as fixture;
    use crate::ledger::schema::IntendedUseKind;

    const AS_OF: &str = "2026-08-11T09:00:00Z";

    fn item_ref(id: &str) -> EvidenceRef {
        EvidenceRef::ManifestItem {
            item_id: id.to_string(),
        }
    }

    fn statement(text: &str, label: StatementLabel, refs: Vec<EvidenceRef>) -> LabeledStatement {
        LabeledStatement {
            text: text.to_string(),
            label,
            basis_refs: refs,
        }
    }

    fn cited(text: &str, label: StatementLabel, refs: Vec<EvidenceRef>) -> CitedStatement {
        CitedStatement {
            statement: statement(text, label, refs.clone()),
            citation_refs: refs,
        }
    }

    fn dimension() -> DimensionAssessment {
        DimensionAssessment {
            state: DimensionState::Sufficient,
            basis_refs: vec![DimensionBasisRef::ManifestItem {
                item_id: "i-1".into(),
            }],
            gaps: vec![],
            as_of: AS_OF.into(),
        }
    }

    fn dimensions() -> Dimensions {
        Dimensions {
            source_availability: dimension(),
            source_health: dimension(),
            scope_coverage: dimension(),
            temporal_suitability: dimension(),
            authority_coverage: dimension(),
            firsthandness: dimension(),
            retrieval_breadth: dimension(),
            contradiction_search: dimension(),
            lineage_independence: dimension(),
            stakes: dimension(),
        }
    }

    fn answer(stakes: Risk) -> SynthesisAnswer {
        let basis_ref = item_ref("i-1");
        SynthesisAnswer {
            observations: vec![cited(
                "the cutover date moved",
                StatementLabel::Observation,
                vec![basis_ref.clone()],
            )],
            current_answer: statement(
                "the cutover lands in October",
                StatementLabel::Conclusion,
                vec![basis_ref.clone()],
            ),
            basis: vec![cited(
                "the standup note says October",
                StatementLabel::Observation,
                vec![basis_ref.clone()],
            )],
            scope_and_time: ScopeAndTime {
                subjects: vec![SubjectRef::Resolved {
                    entity_id: fixture::ID_A.into(),
                    aliases: vec!["Warehouse cutover".into()],
                }],
                scope: Scope::empty(),
                state_stage: None,
                valid_time: ValidTime::unbounded(),
                as_of: AS_OF.into(),
            },
            uncertainties_and_counterevidence: UncertaintiesAndCounterevidence {
                uncertainties: vec![],
                counterevidence: vec![],
                alternatives: vec![],
            },
            retrieval_adequacy: RetrievalAdequacy {
                overall: AdequacyState::Sufficient,
                statement: statement(
                    "we looked in five ways",
                    StatementLabel::Observation,
                    vec![],
                ),
                dimensions: dimensions(),
            },
            evidence_sufficiency: EvidenceSufficiency {
                intended_use: fixture::use_for(stakes),
                level: SufficiencyLevel::Adequate,
                basis_refs: vec![basis_ref],
                limitations: vec![],
                requires_human_verification: false,
            },
            next_evidence: NextEvidence {
                missing_expected_evidence: vec![],
                authoritative_next_sources: vec![],
                discovery_plan: None,
            },
            invalidation_conditions: vec![],
            provisional: Provisional {
                value: false,
                reason_codes: vec![],
                reasons: vec![],
            },
            working_memory_manifest_id: "asm-1".into(),
            content_label: ContentLabel::AgentSupplied,
        }
    }

    fn next_source() -> NextSource {
        NextSource {
            source_id: None,
            source_class: "the warehouse team's own schedule".into(),
            authority_route_id: None,
            reason: statement(
                "they own the date",
                StatementLabel::MissingExpectedEvidence,
                vec![],
            ),
        }
    }

    /// A HIGH-stakes answer with everything the stopping rule demands.
    fn high_stakes() -> SynthesisAnswer {
        let mut a = answer(Risk::High);
        a.next_evidence.missing_expected_evidence = vec![statement(
            "nobody has confirmed with the warehouse team",
            StatementLabel::MissingExpectedEvidence,
            vec![],
        )];
        a.next_evidence.authoritative_next_sources = vec![next_source()];
        a.invalidation_conditions = vec![statement(
            "a dated note from the warehouse team",
            StatementLabel::InvalidationCondition,
            vec![],
        )];
        a
    }

    #[test]
    fn a_routine_answer_validates_and_may_leave_the_optional_parts_empty() {
        answer(Risk::Low).validate().unwrap();
    }

    #[test]
    fn a_high_stakes_answer_owes_four_things_a_routine_one_does_not() {
        // The M24 stopping rule in the answer's own shape.
        high_stakes().validate().unwrap();
        for strip in [
            // Clearing the basis clears what the conclusion rests on too —
            // that is what an answer with no basis actually looks like, and
            // keeping the refs would trip the union rule first.
            (|a: &mut SynthesisAnswer| {
                a.basis.clear();
                a.current_answer.basis_refs.clear();
            }) as fn(&mut _),
            |a: &mut SynthesisAnswer| a.next_evidence.missing_expected_evidence.clear(),
            |a: &mut SynthesisAnswer| a.next_evidence.authoritative_next_sources.clear(),
            |a: &mut SynthesisAnswer| a.invalidation_conditions.clear(),
        ] {
            let mut a = high_stakes();
            strip(&mut a);
            let err = a
                .validate_against(&fixture::manifest_for(Risk::High))
                .unwrap_err();
            assert!(err.contains("at these stakes"), "{err}");
        }
    }

    #[test]
    fn a_citation_that_points_somewhere_the_statement_does_not_is_refused() {
        // Worse than no footnote: it reads as corroboration.
        let mut a = answer(Risk::Low);
        a.basis[0].citation_refs = vec![item_ref("i-other")];
        let err = a.validate().unwrap_err();
        assert!(err.contains("reads as corroboration"), "{err}");
    }

    #[test]
    fn the_conclusion_rests_on_exactly_what_the_basis_cites() {
        // Not a superset: a conclusion resting on something no basis names is
        // resting on something invisible.
        let mut a = answer(Risk::Low);
        a.current_answer.basis_refs.push(item_ref("i-2"));
        assert!(a.validate().unwrap_err().contains("something invisible"));

        // Not a subset either.
        let mut a = answer(Risk::Low);
        a.current_answer.basis_refs.clear();
        assert!(a.validate().unwrap_err().contains("something invisible"));
    }

    #[test]
    fn an_answer_cannot_cite_an_item_this_assembly_never_held() {
        let mut a = answer(Risk::Medium);
        a.observations[0] = cited(
            "somewhere else entirely",
            StatementLabel::Observation,
            vec![item_ref("i-ghost")],
        );
        let err = a
            .validate_against(&fixture::manifest_for(Risk::Medium))
            .unwrap_err();
        assert!(err.contains("never held"), "{err}");
    }

    #[test]
    fn a_model_cannot_weaken_the_stakes_between_retrieval_and_synthesis() {
        // The manifest was assembled for a CRITICAL question; the answer
        // claims it was a draft note.
        let manifest = fixture::manifest_for(Risk::Critical);
        let mut a = high_stakes();
        a.evidence_sufficiency.intended_use = QueryIntendedUse {
            kind: IntendedUseKind::DraftNote,
            stakes: Risk::Low,
            predicate_class: None,
            description: "just a note".into(),
        };
        let err = a.validate_against(&manifest).unwrap_err();
        assert!(err.contains("cannot weaken"), "{err}");
    }

    #[test]
    fn provisional_needs_a_code_and_a_sentence_and_not_being_provisional_needs_neither() {
        let mut a = answer(Risk::Low);
        a.provisional.value = true;
        assert!(a
            .validate()
            .unwrap_err()
            .contains("restatement, not a reason"));

        a.provisional.reason_codes = vec![ProvisionalReasonCode::CoverageGap];
        assert!(a.validate().unwrap_err().contains("a person can read"));

        a.provisional.reasons = vec![statement(
            "the warehouse source has not been reachable since Tuesday",
            StatementLabel::ProvisionalReason,
            vec![],
        )];
        a.validate().unwrap();

        a.provisional.value = false;
        assert!(a
            .validate()
            .unwrap_err()
            .contains("carries provisional reasons"));
    }

    #[test]
    fn a_dimension_that_fell_short_names_a_gap() {
        let mut a = answer(Risk::Low);
        a.retrieval_adequacy.dimensions.source_health.state = DimensionState::Partial;
        let err = a.validate().unwrap_err();
        assert!(err.contains("a shortfall nobody can act on"), "{err}");
    }

    #[test]
    fn there_are_exactly_ten_dimensions_and_each_carries_its_own_as_of() {
        // A map could omit one; a single as_of would let March inherit
        // today's freshness.
        let a = answer(Risk::Low);
        assert_eq!(a.retrieval_adequacy.dimensions.all().len(), 10);
        let json = serde_json::to_value(&a).unwrap();
        let dims = json["retrieval_adequacy"]["dimensions"]
            .as_object()
            .unwrap();
        assert_eq!(dims.len(), 10);
        for (name, _) in a.retrieval_adequacy.dimensions.all() {
            assert!(dims[name]["as_of"].is_string(), "{name}");
        }
        let short = serde_json::json!({ "source_health": dims["source_health"] });
        assert!(serde_json::from_value::<Dimensions>(short).is_err());
    }

    #[test]
    fn adequacy_and_sufficiency_stay_separate_even_when_they_agree() {
        // Excellent retrieval over thin evidence, and the reverse. Collapsing
        // them loses the distinction a person needs to decide whether to go
        // looking.
        let mut a = answer(Risk::Low);
        a.retrieval_adequacy.overall = AdequacyState::Sufficient;
        a.evidence_sufficiency.level = SufficiencyLevel::Insufficient;
        a.validate().unwrap();

        a.retrieval_adequacy.overall = AdequacyState::Insufficient;
        for (_, dimension) in a.retrieval_adequacy.dimensions.all() {
            assert_eq!(dimension.state, DimensionState::Sufficient);
        }
        a.evidence_sufficiency.level = SufficiencyLevel::Strong;
        a.validate().unwrap();
    }

    #[test]
    fn a_discovery_plan_id_is_its_content_and_the_step_ids_are_derived_from_it() {
        let drafts = vec![
            DiscoveryStepDraft {
                action: "ask the warehouse team for the current date".into(),
                source: Some(next_source()),
            },
            DiscoveryStepDraft {
                action: "read the cutover runbook".into(),
                source: None,
            },
        ];
        let stop = vec![statement(
            "a dated confirmation from the team that owns it",
            StatementLabel::InvalidationCondition,
            vec![],
        )];
        let plan = DiscoveryPlan::mint(
            "store",
            "confirm the cutover date",
            drafts.clone(),
            stop.clone(),
            Risk::High,
        )
        .unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[0].ordinal, 1);
        assert_eq!(plan.steps[0].step_id, format!("{}:1", plan.plan_id));
        assert_eq!(plan.steps[1].step_id, format!("{}:2", plan.plan_id));

        // The same work minted twice is the SAME plan — which is what lets
        // the lifecycle table dedupe rather than accumulate.
        let again = DiscoveryPlan::mint(
            "store",
            "confirm the cutover date",
            drafts.clone(),
            stop.clone(),
            Risk::High,
        )
        .unwrap();
        assert_eq!(again, plan);
        // A different store is a different plan.
        let elsewhere = DiscoveryPlan::mint(
            "other",
            "confirm the cutover date",
            drafts,
            stop,
            Risk::High,
        )
        .unwrap();
        assert_ne!(elsewhere.plan_id, plan.plan_id);
    }

    #[test]
    fn an_authored_step_id_cannot_survive() {
        let mut plan = DiscoveryPlan::mint(
            "store",
            "goal",
            vec![DiscoveryStepDraft {
                action: "look".into(),
                source: None,
            }],
            vec![statement("stop", StatementLabel::Limitation, vec![])],
            Risk::Low,
        )
        .unwrap();
        plan.steps[0].step_id = "mine:1".into();
        let err = plan.validate().unwrap_err();
        assert!(err.contains("derived, never authored"), "{err}");
    }

    #[test]
    fn a_plan_that_cannot_end_is_refused() {
        let err = DiscoveryPlan::mint(
            "store",
            "goal",
            vec![DiscoveryStepDraft {
                action: "look".into(),
                source: None,
            }],
            vec![],
            Risk::Low,
        )
        .unwrap_err();
        assert!(
            err.contains("a standing instruction to keep spending"),
            "{err}"
        );
    }

    #[test]
    fn an_answer_about_nothing_is_not_an_answer() {
        let mut a = answer(Risk::Low);
        a.scope_and_time.subjects = vec![];
        assert!(a.validate().unwrap_err().contains("name a subject"));
    }

    #[test]
    fn the_answer_round_trips_through_its_own_bytes() {
        let a = high_stakes();
        let bytes = serde_json::to_string(&a).unwrap();
        let back: SynthesisAnswer = serde_json::from_str(&bytes).unwrap();
        assert_eq!(back, a);
        back.validate_against(&fixture::manifest_for(Risk::High))
            .unwrap();
    }

    #[test]
    fn every_nine_part_is_a_required_key() {
        // "Roughly nine sections" is what this type exists to stop.
        let json = serde_json::to_value(answer(Risk::Low)).unwrap();
        for part in [
            "observations",
            "current_answer",
            "basis",
            "scope_and_time",
            "uncertainties_and_counterevidence",
            "retrieval_adequacy",
            "evidence_sufficiency",
            "next_evidence",
            "invalidation_conditions",
        ] {
            assert!(json.get(part).is_some(), "{part}");
            let mut short = json.clone();
            short.as_object_mut().unwrap().remove(part);
            assert!(
                serde_json::from_value::<SynthesisAnswer>(short).is_err(),
                "{part} is optional and must not be"
            );
        }
    }
}
