//! The coverage vocabulary (M25.4): what the base can honestly claim to have
//! looked at.
//!
//! **Seven dimensions, never collapsed (§46).** Connection, source health,
//! known scope, accessible scope, known retention, index currency, and
//! attempted retrieval are seven separate facts about seven different
//! questions. Connected does not imply healthy; healthy does not imply the
//! scope is known; indexing does not imply anybody ran a query. A UI may
//! summarize all of that as "partial"; the record never does.
//!
//! **No assessment can bootstrap itself.** A `yes` or `no` dimension cites a
//! non-empty list of committed `coverage.fact_recorded` ids — server-stamped
//! records of an operation that actually ran. `unknown` and `not_applicable`
//! cite nothing and must carry a limitation saying why. Without that split,
//! "we assessed our coverage as complete" would be a claim a caller could
//! simply assert, which is exactly the shape of the problem coverage exists
//! to solve.
//!
//! **Facts are server-only and telemetry-free.** Connection, health, scope,
//! access, and retention facts may be stamped only by the adapter bound to
//! the pinned registration; index facts only by `system:vault-indexer`;
//! retrieval facts only by `system:retrieval-engine`. No proposal, agent
//! Observation DTO, connector response body, or prior assessment authors one.
//!
//! **Runtime blindness is not source blindness (§86).** A gap caused by the
//! reasoning runtime names a component and carries no source; it may affect
//! processing, index currency, or retrieval, and it NEVER rewrites
//! `source_connected` or `source_healthy`. Evidence that exists and cannot be
//! processed is a different sentence from reality changing unobserved.

use serde::{Deserialize, Serialize};

use super::{is_id128, is_sha256, schema_body, Scope};

/// Fixed system actors for the two producers that are not adapters.
pub const ACTOR_VAULT_INDEXER: &str = "system:vault-indexer";
pub const ACTOR_RETRIEVAL_ENGINE: &str = "system:retrieval-engine";

/// The seven dimensions. Declaration order is canonical order everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Dimension {
    SourceConnected,
    SourceHealthy,
    ScopeKnown,
    ScopeAccessible,
    RetentionKnown,
    IndexCurrent,
    RetrievalAttempted,
}

impl Dimension {
    pub fn as_str(self) -> &'static str {
        match self {
            Dimension::SourceConnected => "source_connected",
            Dimension::SourceHealthy => "source_healthy",
            Dimension::ScopeKnown => "scope_known",
            Dimension::ScopeAccessible => "scope_accessible",
            Dimension::RetentionKnown => "retention_known",
            Dimension::IndexCurrent => "index_current",
            Dimension::RetrievalAttempted => "retrieval_attempted",
        }
    }

    pub fn parse(raw: &str) -> Option<Dimension> {
        Dimension::ALL.into_iter().find(|d| d.as_str() == raw)
    }

    pub const ALL: [Dimension; 7] = [
        Dimension::SourceConnected,
        Dimension::SourceHealthy,
        Dimension::ScopeKnown,
        Dimension::ScopeAccessible,
        Dimension::RetentionKnown,
        Dimension::IndexCurrent,
        Dimension::RetrievalAttempted,
    ];
}

/// What a dimension says. `unknown` and `not_applicable` are DIFFERENT
/// answers: one is "we do not know", the other is "the question does not
/// apply to this source", and collapsing them would let a source that cannot
/// have retention look identical to one whose retention nobody checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DimensionState {
    Yes,
    No,
    Unknown,
    NotApplicable,
}

impl DimensionState {
    pub fn as_str(self) -> &'static str {
        match self {
            DimensionState::Yes => "yes",
            DimensionState::No => "no",
            DimensionState::Unknown => "unknown",
            DimensionState::NotApplicable => "not_applicable",
        }
    }

    /// Is this a state a committed fact has to carry?
    fn needs_basis(self) -> bool {
        matches!(self, DimensionState::Yes | DimensionState::No)
    }
}

/// Who stamped a fact. Pinned so a later reader can tell an adapter probe
/// from an index checkpoint without re-deriving it from the actor string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProducerKind {
    ConnectorAdapter,
    BuiltinAdapter,
    VaultIndexer,
    RetrievalEngine,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Producer {
    pub kind: ProducerKind,
    pub producer_version: String,
}

/// The scoped thing an assessment or fact is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageSubject {
    pub entity_id: Option<String>,
    pub predicate_class: Option<String>,
    pub scope: Scope,
}

/// The canonical record of one retrieval that actually ran.
///
/// The four canonical strings are shared byte-for-byte with M22's absence
/// block; M24's formal-absence rule compares them exactly, which is why they
/// are stored rather than re-derived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetrievalReceipt {
    pub strategy_version: String,
    pub query_strategy: String,
    pub query_fingerprint: String,
    pub attempted_at: String,
    pub searched_domain: String,
    pub search_scope: String,
    pub observation_window: String,
    pub searched_aliases: Vec<String>,
    pub searched_scopes: Vec<Scope>,
}

impl RetrievalReceipt {
    fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("strategy_version", &self.strategy_version),
            ("query_strategy", &self.query_strategy),
            ("attempted_at", &self.attempted_at),
            ("searched_domain", &self.searched_domain),
            ("search_scope", &self.search_scope),
            ("observation_window", &self.observation_window),
        ] {
            if value.is_empty() {
                return Err(format!("retrieval receipt {name} must be non-empty"));
            }
        }
        if !is_sha256(&self.query_fingerprint) {
            return Err("query_fingerprint must be a lowercase SHA-256".into());
        }
        if chrono::DateTime::parse_from_rfc3339(&self.attempted_at).is_err() {
            return Err("retrieval receipt attempted_at must be RFC3339".into());
        }
        if self.searched_aliases.iter().any(String::is_empty) {
            return Err("a searched alias cannot be empty".into());
        }
        Ok(())
    }
}

/// The eight fact variants, one per dimension in declaration order — except
/// `retrieval_attempted`, which has two: one for a retrieval that ran, one
/// for a window that closed without anybody looking. The second is the honest
/// record of NOT looking, and it is what stops "no attempt" from silently
/// reading as "attempted and found nothing".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fact {
    ConnectionProbe {
        result: ConnectionResult,
    },
    HealthProbe {
        result: HealthResult,
    },
    ScopeDiscovery {
        scope_digest: String,
        result: KnownResult,
    },
    AccessProbe {
        scope_digest: String,
        result: AccessResult,
    },
    RetentionDiscovery {
        result: KnownResult,
        retention_seconds: Option<u64>,
    },
    IndexCheckpoint {
        index_head: String,
        source_revision: String,
        result: CurrentResult,
    },
    RetrievalExecution {
        retrieval_receipt: RetrievalReceipt,
    },
    RetrievalWindowClosedWithoutAttempt {
        window_start: String,
        window_end: String,
    },
}

macro_rules! binary_result {
    ($name:ident, $yes:ident => $yes_str:literal, $no:ident => $no_str:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $yes,
            $no,
        }
        impl $name {
            fn is_yes(self) -> bool {
                matches!(self, $name::$yes)
            }
            #[allow(dead_code)]
            pub fn as_str(self) -> &'static str {
                match self {
                    $name::$yes => $yes_str,
                    $name::$no => $no_str,
                }
            }
        }
    };
}

binary_result!(ConnectionResult, Connected => "connected", Disconnected => "disconnected");
binary_result!(HealthResult, Healthy => "healthy", Unhealthy => "unhealthy");
binary_result!(KnownResult, Known => "known", Unknown => "unknown");
binary_result!(AccessResult, Accessible => "accessible", Denied => "denied");
binary_result!(CurrentResult, Current => "current", Stale => "stale");

impl Fact {
    /// The one dimension this variant establishes. One-to-one, in the order
    /// the dimensions are declared.
    pub fn dimension(&self) -> Dimension {
        match self {
            Fact::ConnectionProbe { .. } => Dimension::SourceConnected,
            Fact::HealthProbe { .. } => Dimension::SourceHealthy,
            Fact::ScopeDiscovery { .. } => Dimension::ScopeKnown,
            Fact::AccessProbe { .. } => Dimension::ScopeAccessible,
            Fact::RetentionDiscovery { .. } => Dimension::RetentionKnown,
            Fact::IndexCheckpoint { .. } => Dimension::IndexCurrent,
            Fact::RetrievalExecution { .. } | Fact::RetrievalWindowClosedWithoutAttempt { .. } => {
                Dimension::RetrievalAttempted
            }
        }
    }

    /// The state this variant's result maps to. Exact, never interpreted.
    pub fn state(&self) -> DimensionState {
        let yes = match self {
            Fact::ConnectionProbe { result } => result.is_yes(),
            Fact::HealthProbe { result } => result.is_yes(),
            Fact::ScopeDiscovery { result, .. } => result.is_yes(),
            Fact::AccessProbe { result, .. } => result.is_yes(),
            Fact::RetentionDiscovery { result, .. } => result.is_yes(),
            Fact::IndexCheckpoint { result, .. } => result.is_yes(),
            Fact::RetrievalExecution { .. } => true,
            Fact::RetrievalWindowClosedWithoutAttempt { .. } => false,
        };
        if yes {
            DimensionState::Yes
        } else {
            DimensionState::No
        }
    }

    /// Which producer is allowed to stamp this variant.
    fn allowed_producer(&self) -> &'static [ProducerKind] {
        match self {
            Fact::IndexCheckpoint { .. } => &[ProducerKind::VaultIndexer],
            Fact::RetrievalExecution { .. } | Fact::RetrievalWindowClosedWithoutAttempt { .. } => {
                &[ProducerKind::RetrievalEngine]
            }
            _ => &[ProducerKind::ConnectorAdapter, ProducerKind::BuiltinAdapter],
        }
    }

    fn validate(&self) -> Result<(), String> {
        match self {
            Fact::ScopeDiscovery { scope_digest, .. } | Fact::AccessProbe { scope_digest, .. }
                if !is_sha256(scope_digest) =>
            {
                return Err("scope_digest must be a lowercase SHA-256".into())
            }
            Fact::RetentionDiscovery {
                result,
                retention_seconds,
            } => {
                // A retention we claim to KNOW has a number; one we do not
                // has none. Either half alone is a record that says two
                // things at once.
                match (result.is_yes(), retention_seconds) {
                    (true, None) => return Err("a known retention fact carries its value".into()),
                    (false, Some(_)) => {
                        return Err("an unknown retention fact carries no value".into())
                    }
                    _ => {}
                }
            }
            Fact::IndexCheckpoint {
                index_head,
                source_revision,
                ..
            } if index_head.is_empty() || source_revision.is_empty() => {
                return Err("an index checkpoint names its head and the source revision".into())
            }
            Fact::RetrievalExecution { retrieval_receipt } => retrieval_receipt.validate()?,
            Fact::RetrievalWindowClosedWithoutAttempt {
                window_start,
                window_end,
            } => {
                for (name, value) in [("window_start", window_start), ("window_end", window_end)] {
                    if chrono::DateTime::parse_from_rfc3339(value).is_err() {
                        return Err(format!("{name} must be RFC3339"));
                    }
                }
                if window_end <= window_start {
                    return Err("a closed window ends after it starts".into());
                }
            }
            _ => {}
        }
        Ok(())
    }
}

schema_body! {
    /// One trusted, telemetry-free fact about one dimension.
    pub struct CoverageFactRecorded {
        pub fact_id: String,
        pub source_id: String,
        pub source_registration_event_id: String,
        pub subject: CoverageSubject,
        pub dimension: Dimension,
        pub state: DimensionState,
        pub as_of: String,
        pub producer: Producer,
        pub fact: Fact,
    }
}

impl CoverageFactRecorded {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.fact_id) {
            return Err("fact_id must be a 128-bit hex id".into());
        }
        if !is_id128(&self.source_id) || !is_id128(&self.source_registration_event_id) {
            return Err("a fact pins its source and its registration by id".into());
        }
        if chrono::DateTime::parse_from_rfc3339(&self.as_of).is_err() {
            return Err("as_of must be RFC3339".into());
        }
        if self.producer.producer_version.is_empty() {
            return Err("producer_version must be non-empty".into());
        }
        // The variant IS the dimension and the result IS the state; a body
        // that says otherwise is a body two readers would disagree about.
        if self.fact.dimension() != self.dimension {
            return Err(format!(
                "a {} fact establishes {}, not {}",
                variant_name(&self.fact),
                self.fact.dimension().as_str(),
                self.dimension.as_str()
            ));
        }
        if self.fact.state() != self.state {
            return Err(format!(
                "this fact's result is {}, and the body says {}",
                self.fact.state().as_str(),
                self.state.as_str()
            ));
        }
        if !self.state.needs_basis() {
            return Err("a recorded fact is yes or no — unknown is the absence of one".into());
        }
        if !self.fact.allowed_producer().contains(&self.producer.kind) {
            return Err(format!(
                "a {} fact is stamped only by {:?}, not by {:?}",
                variant_name(&self.fact),
                self.fact.allowed_producer(),
                self.producer.kind
            ));
        }
        match self.producer.kind {
            ProducerKind::VaultIndexer if self.actor.id != ACTOR_VAULT_INDEXER => {
                return Err(format!(
                    "an index fact is appended only by {ACTOR_VAULT_INDEXER}"
                ))
            }
            ProducerKind::RetrievalEngine if self.actor.id != ACTOR_RETRIEVAL_ENGINE => {
                return Err(format!(
                    "a retrieval fact is appended only by {ACTOR_RETRIEVAL_ENGINE}"
                ))
            }
            _ => {}
        }
        self.fact.validate()
    }
}

fn variant_name(fact: &Fact) -> &'static str {
    match fact {
        Fact::ConnectionProbe { .. } => "connection_probe",
        Fact::HealthProbe { .. } => "health_probe",
        Fact::ScopeDiscovery { .. } => "scope_discovery",
        Fact::AccessProbe { .. } => "access_probe",
        Fact::RetentionDiscovery { .. } => "retention_discovery",
        Fact::IndexCheckpoint { .. } => "index_checkpoint",
        Fact::RetrievalExecution { .. } => "retrieval_execution",
        Fact::RetrievalWindowClosedWithoutAttempt { .. } => {
            "retrieval_window_closed_without_attempt"
        }
    }
}

/// One dimension's answer, with what carries it and when it was true.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DimensionAssessment {
    pub state: DimensionState,
    /// Sorted, duplicate-free, and only committed `coverage.fact_recorded`
    /// ids. An assessment id is never a basis id — that is the rule that
    /// stops an assessment bootstrapping itself.
    pub basis_event_ids: Vec<String>,
    pub as_of: String,
}

/// All seven, in declaration order. A struct rather than a map so a missing
/// dimension is a parse error rather than a silent default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dimensions {
    pub source_connected: DimensionAssessment,
    pub source_healthy: DimensionAssessment,
    pub scope_known: DimensionAssessment,
    pub scope_accessible: DimensionAssessment,
    pub retention_known: DimensionAssessment,
    pub index_current: DimensionAssessment,
    pub retrieval_attempted: DimensionAssessment,
}

impl Dimensions {
    pub fn get(&self, dimension: Dimension) -> &DimensionAssessment {
        match dimension {
            Dimension::SourceConnected => &self.source_connected,
            Dimension::SourceHealthy => &self.source_healthy,
            Dimension::ScopeKnown => &self.scope_known,
            Dimension::ScopeAccessible => &self.scope_accessible,
            Dimension::RetentionKnown => &self.retention_known,
            Dimension::IndexCurrent => &self.index_current,
            Dimension::RetrievalAttempted => &self.retrieval_attempted,
        }
    }

    pub fn each(&self) -> [(Dimension, &DimensionAssessment); 7] {
        [
            (Dimension::SourceConnected, &self.source_connected),
            (Dimension::SourceHealthy, &self.source_healthy),
            (Dimension::ScopeKnown, &self.scope_known),
            (Dimension::ScopeAccessible, &self.scope_accessible),
            (Dimension::RetentionKnown, &self.retention_known),
            (Dimension::IndexCurrent, &self.index_current),
            (Dimension::RetrievalAttempted, &self.retrieval_attempted),
        ]
    }
}

/// Why a dimension could not be established.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limitation {
    pub dimension: Dimension,
    pub reason: String,
}

schema_body! {
    /// One assessment of one source's coverage of one scoped subject.
    pub struct CoverageAssessed {
        pub assessment_id: String,
        pub subject: CoverageSubject,
        pub source_id: String,
        pub dimensions: Dimensions,
        pub retrieval_receipt: Option<RetrievalReceipt>,
        pub limitations: Vec<Limitation>,
        pub supersedes_assessment_id: Option<String>,
    }
}

impl CoverageAssessed {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.assessment_id) || !is_id128(&self.source_id) {
            return Err("an assessment pins its id and its source by id".into());
        }
        if let Some(prior) = &self.supersedes_assessment_id {
            if !is_id128(prior) {
                return Err("supersedes_assessment_id must be a 128-bit hex id".into());
            }
            if prior == &self.assessment_id {
                return Err("an assessment cannot supersede itself".into());
            }
        }
        let limited: std::collections::BTreeSet<Dimension> =
            self.limitations.iter().map(|l| l.dimension).collect();
        if limited.len() != self.limitations.len() {
            return Err("one limitation per dimension, at most".into());
        }
        for limitation in &self.limitations {
            if limitation.reason.is_empty() {
                return Err("a limitation without a reason explains nothing".into());
            }
        }

        for (dimension, assessment) in self.dimensions.each() {
            if chrono::DateTime::parse_from_rfc3339(&assessment.as_of).is_err() {
                return Err(format!("{}: as_of must be RFC3339", dimension.as_str()));
            }
            let sorted = assessment
                .basis_event_ids
                .windows(2)
                .all(|pair| pair[0] < pair[1]);
            if !sorted {
                return Err(format!(
                    "{}: basis_event_ids must be sorted and duplicate-free",
                    dimension.as_str()
                ));
            }
            if assessment.basis_event_ids.iter().any(|id| !is_id128(id)) {
                return Err(format!(
                    "{}: basis ids must be event ids",
                    dimension.as_str()
                ));
            }
            if assessment.basis_event_ids.contains(&self.assessment_id) {
                return Err(format!(
                    "{}: an assessment id is never a basis id — no assessment bootstraps itself",
                    dimension.as_str()
                ));
            }
            if assessment.state.needs_basis() {
                if assessment.basis_event_ids.is_empty() {
                    return Err(format!(
                        "{}: a {} needs at least one committed fact behind it",
                        dimension.as_str(),
                        assessment.state.as_str()
                    ));
                }
                if limited.contains(&dimension) {
                    return Err(format!(
                        "{}: a dimension carried by facts does not also carry a limitation",
                        dimension.as_str()
                    ));
                }
            } else {
                if !assessment.basis_event_ids.is_empty() {
                    return Err(format!(
                        "{}: {} cites nothing — a basis would contradict it",
                        dimension.as_str(),
                        assessment.state.as_str()
                    ));
                }
                if !limited.contains(&dimension) {
                    return Err(format!(
                        "{}: {} requires a limitation saying why",
                        dimension.as_str(),
                        assessment.state.as_str()
                    ));
                }
            }
        }

        // The receipt exists exactly when a retrieval is claimed to have run.
        // It records that retrieval OCCURRED, never that it was adequate.
        match (
            self.dimensions.retrieval_attempted.state,
            &self.retrieval_receipt,
        ) {
            (DimensionState::Yes, None) => {
                Err("a claimed retrieval attempt carries its receipt".into())
            }
            (DimensionState::Yes, Some(receipt)) => receipt.validate(),
            (_, Some(_)) => {
                Err("only a retrieval that happened carries a retrieval receipt".into())
            }
            (_, None) => Ok(()),
        }
    }
}

/// What made the base blind. The two causes are different sentences and
/// different tables; collapsing them is a review-blocking defect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapCauseKind {
    Source,
    ReasoningRuntime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GapCause {
    pub kind: GapCauseKind,
    /// The runtime component that failed. Present exactly for a runtime
    /// cause: a source outage is named by its source, not by a component.
    pub component: Option<String>,
}

/// Dimensions a RUNTIME cause may affect.
///
/// A dead CLI quota means evidence exists and cannot currently be processed.
/// It cannot make a connector disconnected, and it cannot make a source
/// unhealthy — those are claims about the world, and the runtime has no
/// standing to make them.
const RUNTIME_AFFECTABLE: [Dimension; 3] = [
    Dimension::ScopeAccessible,
    Dimension::IndexCurrent,
    Dimension::RetrievalAttempted,
];

fn sorted_unique_dimensions(dimensions: &[Dimension], what: &str) -> Result<(), String> {
    if dimensions.is_empty() {
        return Err(format!("{what} must name at least one dimension"));
    }
    if !dimensions.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(format!("{what} must be sorted and duplicate-free"));
    }
    Ok(())
}

schema_body! {
    /// A period of blindness, opened.
    pub struct CoverageGap {
        pub gap_id: String,
        pub subject: CoverageSubject,
        pub source_id: Option<String>,
        pub responsibility_id: Option<String>,
        pub contract_version: Option<u64>,
        pub contract_digest: Option<String>,
        pub cause: GapCause,
        pub opened_at: String,
        pub assessment_id: Option<String>,
        pub affected_dimensions: Vec<Dimension>,
        pub pending_count_at_open: u64,
        pub reason: String,
    }
}

impl CoverageGap {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.gap_id) {
            return Err("gap_id must be a 128-bit hex id".into());
        }
        if chrono::DateTime::parse_from_rfc3339(&self.opened_at).is_err() {
            return Err("opened_at must be RFC3339".into());
        }
        if self.reason.is_empty() {
            return Err("a gap without a reason explains nothing".into());
        }
        sorted_unique_dimensions(&self.affected_dimensions, "affected_dimensions")?;
        match self.cause.kind {
            GapCauseKind::Source => {
                let Some(source_id) = &self.source_id else {
                    return Err("a source-caused gap names its source".into());
                };
                if !is_id128(source_id) {
                    return Err("source_id must be a 128-bit hex id".into());
                }
                if self.cause.component.is_some() {
                    return Err("a source-caused gap names a source, not a component".into());
                }
                let Some(assessment_id) = &self.assessment_id else {
                    return Err(
                        "a source-caused gap cites the assessment that established it".into(),
                    );
                };
                if !is_id128(assessment_id) {
                    return Err("assessment_id must be a 128-bit hex id".into());
                }
            }
            GapCauseKind::ReasoningRuntime => {
                if self.source_id.is_some() {
                    return Err(
                        "a runtime-caused gap carries no source — the source is fine, we are not"
                            .into(),
                    );
                }
                match &self.cause.component {
                    Some(component) if !component.is_empty() => {}
                    _ => return Err("a runtime-caused gap names the component that failed".into()),
                }
                for dimension in &self.affected_dimensions {
                    if !RUNTIME_AFFECTABLE.contains(dimension) {
                        return Err(format!(
                            "the reasoning runtime cannot affect {} — that is a claim about the \
                             source, and a runtime failure has no standing to make it",
                            dimension.as_str()
                        ));
                    }
                }
            }
        }
        // A responsibility ref is all-or-nothing: an M28 R10-eligible miss
        // pins the version and digest it was decided under, and a partial
        // pin would be a citation nobody can reproduce.
        let pinned = [
            self.responsibility_id.is_some(),
            self.contract_version.is_some(),
            self.contract_digest.is_some(),
        ];
        if pinned.iter().any(|p| *p) && !pinned.iter().all(|p| *p) {
            return Err(
                "a declared responsibility is pinned by id, version, AND digest, or not at all"
                    .into(),
            );
        }
        if let Some(digest) = &self.contract_digest {
            if !is_sha256(digest) {
                return Err("contract_digest must be a lowercase SHA-256".into());
            }
        }
        Ok(())
    }
}

schema_body! {
    /// Demonstrated recovery, in whole or in part.
    pub struct CoverageRestored {
        pub gap_id: String,
        pub restored_at: String,
        pub assessment_id: Option<String>,
        pub restored_dimensions: Vec<Dimension>,
        pub reason: String,
    }
}

impl CoverageRestored {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        if !is_id128(&self.gap_id) {
            return Err("gap_id must be a 128-bit hex id".into());
        }
        if chrono::DateTime::parse_from_rfc3339(&self.restored_at).is_err() {
            return Err("restored_at must be RFC3339".into());
        }
        if self.reason.is_empty() {
            return Err("a restoration without a reason demonstrates nothing".into());
        }
        if let Some(assessment_id) = &self.assessment_id {
            if !is_id128(assessment_id) {
                return Err("assessment_id must be a 128-bit hex id".into());
            }
        }
        sorted_unique_dimensions(&self.restored_dimensions, "restored_dimensions")
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{common, ID_A, ID_B, ID_C, SHA_A};
    use super::*;

    fn subject() -> CoverageSubject {
        CoverageSubject {
            entity_id: Some(ID_C.into()),
            predicate_class: Some("status".into()),
            scope: Scope::empty(),
        }
    }

    fn receipt() -> RetrievalReceipt {
        RetrievalReceipt {
            strategy_version: "retrieval-v1".into(),
            query_strategy: "alias-expansion".into(),
            query_fingerprint: SHA_A.into(),
            attempted_at: "2026-08-09T10:00:00Z".into(),
            searched_domain: "vault".into(),
            search_scope: "records/".into(),
            observation_window: "2026-08-01/2026-08-09".into(),
            searched_aliases: vec!["Ada".into()],
            searched_scopes: vec![Scope::empty()],
        }
    }

    pub(crate) fn fact(variant: Fact, producer: ProducerKind, actor: &str) -> CoverageFactRecorded {
        let (schema, batch_id, idempotency_key, actor) = common_of(actor);
        CoverageFactRecorded {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            fact_id: ID_A.into(),
            source_id: ID_B.into(),
            source_registration_event_id: ID_C.into(),
            subject: subject(),
            dimension: variant.dimension(),
            state: variant.state(),
            as_of: "2026-08-09T10:00:00Z".into(),
            producer: Producer {
                kind: producer,
                producer_version: "1".into(),
            },
            fact: variant,
        }
    }

    fn common_of(actor: &str) -> (u64, Option<String>, Option<String>, super::super::Actor) {
        let (schema, a) = common(actor);
        (schema, None, None, a)
    }

    fn known(basis: &str) -> DimensionAssessment {
        DimensionAssessment {
            state: DimensionState::Yes,
            basis_event_ids: vec![basis.to_string()],
            as_of: "2026-08-09T10:00:00Z".into(),
        }
    }

    fn unknown() -> DimensionAssessment {
        DimensionAssessment {
            state: DimensionState::Unknown,
            basis_event_ids: vec![],
            as_of: "2026-08-09T10:00:00Z".into(),
        }
    }

    pub(crate) fn assessed() -> CoverageAssessed {
        let (schema, batch_id, idempotency_key, actor) = common_of("system:coverage");
        CoverageAssessed {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            assessment_id: ID_A.into(),
            subject: subject(),
            source_id: ID_B.into(),
            dimensions: Dimensions {
                source_connected: known(ID_C),
                source_healthy: known(ID_C),
                scope_known: known(ID_C),
                scope_accessible: known(ID_C),
                retention_known: known(ID_C),
                index_current: known(ID_C),
                retrieval_attempted: known(ID_C),
            },
            retrieval_receipt: Some(receipt()),
            limitations: vec![],
            supersedes_assessment_id: None,
        }
    }

    #[test]
    fn every_fact_variant_establishes_exactly_one_dimension() {
        let seen: std::collections::BTreeSet<Dimension> = [
            Fact::ConnectionProbe {
                result: ConnectionResult::Connected,
            },
            Fact::HealthProbe {
                result: HealthResult::Healthy,
            },
            Fact::ScopeDiscovery {
                scope_digest: SHA_A.into(),
                result: KnownResult::Known,
            },
            Fact::AccessProbe {
                scope_digest: SHA_A.into(),
                result: AccessResult::Accessible,
            },
            Fact::RetentionDiscovery {
                result: KnownResult::Known,
                retention_seconds: Some(3600),
            },
            Fact::IndexCheckpoint {
                index_head: "h".into(),
                source_revision: "r".into(),
                result: CurrentResult::Current,
            },
            Fact::RetrievalExecution {
                retrieval_receipt: receipt(),
            },
        ]
        .iter()
        .map(Fact::dimension)
        .collect();
        assert_eq!(seen.len(), 7, "one variant per dimension, all seven");
    }

    #[test]
    fn a_closed_window_without_an_attempt_is_a_no_not_a_silence() {
        // The honest record of NOT looking. Without it, "nobody ran a query"
        // and "a query found nothing" would be the same absence.
        let variant = Fact::RetrievalWindowClosedWithoutAttempt {
            window_start: "2026-08-01T00:00:00Z".into(),
            window_end: "2026-08-09T00:00:00Z".into(),
        };
        assert_eq!(variant.dimension(), Dimension::RetrievalAttempted);
        assert_eq!(variant.state(), DimensionState::No);
        fact(
            variant,
            ProducerKind::RetrievalEngine,
            ACTOR_RETRIEVAL_ENGINE,
        )
        .validate()
        .unwrap();
    }

    #[test]
    fn a_body_that_disagrees_with_its_own_variant_is_refused() {
        let mut body = fact(
            Fact::ConnectionProbe {
                result: ConnectionResult::Connected,
            },
            ProducerKind::ConnectorAdapter,
            "connector:github",
        );
        body.dimension = Dimension::SourceHealthy;
        assert!(body.validate().unwrap_err().contains("establishes"));

        let mut body = fact(
            Fact::ConnectionProbe {
                result: ConnectionResult::Disconnected,
            },
            ProducerKind::ConnectorAdapter,
            "connector:github",
        );
        body.state = DimensionState::Yes;
        assert!(body.validate().unwrap_err().contains("result is no"));
    }

    #[test]
    fn only_the_named_producer_may_stamp_each_fact() {
        // A connector that could stamp an index checkpoint could declare its
        // own index current, which is the whole point of separating them.
        let indexed = Fact::IndexCheckpoint {
            index_head: "h".into(),
            source_revision: "r".into(),
            result: CurrentResult::Current,
        };
        assert!(fact(
            indexed.clone(),
            ProducerKind::ConnectorAdapter,
            ACTOR_VAULT_INDEXER
        )
        .validate()
        .is_err());
        assert!(
            fact(indexed.clone(), ProducerKind::VaultIndexer, "agent:sneaky")
                .validate()
                .unwrap_err()
                .contains(ACTOR_VAULT_INDEXER)
        );
        fact(indexed, ProducerKind::VaultIndexer, ACTOR_VAULT_INDEXER)
            .validate()
            .unwrap();
    }

    #[test]
    fn a_retention_fact_says_the_number_or_says_it_does_not_know() {
        assert!(fact(
            Fact::RetentionDiscovery {
                result: KnownResult::Known,
                retention_seconds: None,
            },
            ProducerKind::BuiltinAdapter,
            "builtin:vault",
        )
        .validate()
        .is_err());
        assert!(fact(
            Fact::RetentionDiscovery {
                result: KnownResult::Unknown,
                retention_seconds: Some(1),
            },
            ProducerKind::BuiltinAdapter,
            "builtin:vault",
        )
        .validate()
        .is_err());
    }

    #[test]
    fn a_full_assessment_validates_and_names_all_seven() {
        let body = assessed();
        body.validate().unwrap();
        assert_eq!(body.dimensions.each().len(), 7);
        for (dimension, _) in body.dimensions.each() {
            assert_eq!(body.dimensions.get(dimension).state, DimensionState::Yes);
        }
    }

    #[test]
    fn a_yes_with_no_basis_is_refused_and_an_unknown_with_a_basis_is_too() {
        let mut body = assessed();
        body.dimensions.source_healthy.basis_event_ids.clear();
        assert!(body
            .validate()
            .unwrap_err()
            .contains("needs at least one committed fact"));

        let mut body = assessed();
        body.dimensions.source_healthy = DimensionAssessment {
            state: DimensionState::Unknown,
            basis_event_ids: vec![ID_C.into()],
            as_of: "2026-08-09T10:00:00Z".into(),
        };
        assert!(body.validate().unwrap_err().contains("cites nothing"));
    }

    #[test]
    fn an_unknown_dimension_must_say_why() {
        let mut body = assessed();
        body.dimensions.retention_known = unknown();
        assert!(body
            .validate()
            .unwrap_err()
            .contains("requires a limitation"));
        body.limitations = vec![Limitation {
            dimension: Dimension::RetentionKnown,
            reason: "this source declares no retention policy".into(),
        }];
        body.validate().unwrap();
    }

    #[test]
    fn an_assessment_can_never_be_its_own_basis() {
        // The bootstrap rule, in one line: coverage that cites itself is a
        // claim wearing the shape of evidence.
        let mut body = assessed();
        body.dimensions.scope_known.basis_event_ids = vec![body.assessment_id.clone()];
        assert!(body
            .validate()
            .unwrap_err()
            .contains("no assessment bootstraps itself"));
    }

    #[test]
    fn the_retrieval_receipt_exists_exactly_when_retrieval_did() {
        let mut body = assessed();
        body.retrieval_receipt = None;
        assert!(body.validate().unwrap_err().contains("carries its receipt"));

        let mut body = assessed();
        body.dimensions.retrieval_attempted = unknown();
        body.limitations = vec![Limitation {
            dimension: Dimension::RetrievalAttempted,
            reason: "no query has run in this window".into(),
        }];
        assert!(body
            .validate()
            .unwrap_err()
            .contains("only a retrieval that happened"));
        body.retrieval_receipt = None;
        body.validate().unwrap();
    }

    fn gap(kind: GapCauseKind) -> CoverageGap {
        let (schema, batch_id, idempotency_key, actor) = common_of("system:coverage");
        CoverageGap {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            gap_id: ID_A.into(),
            subject: subject(),
            source_id: match kind {
                GapCauseKind::Source => Some(ID_B.into()),
                GapCauseKind::ReasoningRuntime => None,
            },
            responsibility_id: None,
            contract_version: None,
            contract_digest: None,
            cause: GapCause {
                kind,
                component: match kind {
                    GapCauseKind::Source => None,
                    GapCauseKind::ReasoningRuntime => Some("claude-cli".into()),
                },
            },
            opened_at: "2026-08-09T10:00:00Z".into(),
            assessment_id: match kind {
                GapCauseKind::Source => Some(ID_C.into()),
                GapCauseKind::ReasoningRuntime => None,
            },
            affected_dimensions: match kind {
                GapCauseKind::Source => vec![Dimension::SourceHealthy],
                GapCauseKind::ReasoningRuntime => vec![Dimension::IndexCurrent],
            },
            pending_count_at_open: 12,
            reason: "unreachable for three days".into(),
        }
    }

    #[test]
    fn a_runtime_gap_can_never_say_the_source_is_unhealthy() {
        // §86 in one assertion. A dead CLI quota means evidence exists and
        // cannot be processed; it is not a claim about the world.
        let mut body = gap(GapCauseKind::ReasoningRuntime);
        body.validate().unwrap();
        body.affected_dimensions = vec![Dimension::SourceHealthy];
        let err = body.validate().unwrap_err();
        assert!(err.contains("has no standing"), "{err}");

        body.affected_dimensions = vec![Dimension::SourceConnected];
        assert!(body.validate().is_err());
    }

    #[test]
    fn a_source_gap_names_a_source_and_a_runtime_gap_names_a_component() {
        gap(GapCauseKind::Source).validate().unwrap();
        let mut body = gap(GapCauseKind::Source);
        body.source_id = None;
        assert!(body.validate().unwrap_err().contains("names its source"));

        let mut body = gap(GapCauseKind::ReasoningRuntime);
        body.source_id = Some(ID_B.into());
        assert!(body.validate().unwrap_err().contains("carries no source"));

        let mut body = gap(GapCauseKind::ReasoningRuntime);
        body.cause.component = None;
        assert!(body.validate().unwrap_err().contains("names the component"));
    }

    #[test]
    fn a_source_gap_cites_the_assessment_that_established_it() {
        let mut body = gap(GapCauseKind::Source);
        body.assessment_id = None;
        assert!(body
            .validate()
            .unwrap_err()
            .contains("cites the assessment"));
    }

    #[test]
    fn a_responsibility_is_pinned_completely_or_not_at_all() {
        let mut body = gap(GapCauseKind::Source);
        body.responsibility_id = Some("watch-inbox".into());
        let err = body.validate().unwrap_err();
        assert!(err.contains("id, version, AND digest"), "{err}");
        body.contract_version = Some(0);
        body.contract_digest = Some(SHA_A.into());
        body.validate().unwrap();
    }

    #[test]
    fn a_restoration_names_what_it_restored() {
        let (schema, batch_id, idempotency_key, actor) = common_of("system:coverage");
        let mut body = CoverageRestored {
            schema,
            batch_id,
            idempotency_key,
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            gap_id: ID_A.into(),
            restored_at: "2026-08-09T12:00:00Z".into(),
            assessment_id: Some(ID_B.into()),
            restored_dimensions: vec![Dimension::SourceHealthy],
            reason: "the connector answered".into(),
        };
        body.validate().unwrap();
        body.restored_dimensions.clear();
        assert!(body
            .validate()
            .unwrap_err()
            .contains("at least one dimension"));
        body.restored_dimensions = vec![Dimension::SourceHealthy, Dimension::SourceConnected];
        assert!(body.validate().unwrap_err().contains("sorted"));
    }
}
