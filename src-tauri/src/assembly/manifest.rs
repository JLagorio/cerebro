//! The working-memory manifest (M26.5a) — what one question was actually
//! shown, as data.
//!
//! **Serde, never a prompt appendix.** A manifest that lived only inside the
//! text handed to a model could not be checked, could not be persisted, and
//! could not be pointed at afterwards by an adequacy basis ref. Every rule
//! below is a rule somebody would otherwise have to trust a prompt to have
//! followed.
//!
//! **Five intents, all mandatory for a belief-affecting question**: positive,
//! contradiction, historical, authority, scope-neighbour. Each one carries a
//! terminal record, and there are only three terminal states — `satisfied`,
//! `exhausted`, `blocked`. `attempted` is deliberately NOT one of them: it is
//! the word a caller reaches for to claim credit for a search that did not
//! finish, so the vocabulary does not contain it.
//!
//! **Counterevidence is included, exhausted, or blocked — never quietly
//! trimmed.** If including an accessible contradiction would breach a cap,
//! the assembler returns `blocked(cap_conflict)` and does not synthesize. The
//! alternative — dropping the contradiction to fit — is the one failure this
//! whole structure exists to make impossible, because it is invisible in the
//! output and indistinguishable from there being none.
//!
//! **A source is never fabricated.** An assertion item pins its ONE M22
//! source. A belief revision may rest on many, through its basis, and may
//! rest on none — but only when it says `unsupported` and names no basis
//! Observation. `actual.source_count` is the distinct union across items and
//! attempts, so the count cannot be inflated by an item that invented one.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ledger::schema::{
    is_id128, is_sha256, IntendedUse, IntendedUseKind, Risk, Scope, Stage,
};

/// What the answer is FOR.
///
/// M24's closed kind/stakes/predicate-class contract plus the description a
/// question needs. `intended_use()` hands back the M24 value itself rather
/// than a copy built field by field, so the stopping-rule lookup and this
/// manifest cannot be reading two different things.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryIntendedUse {
    pub kind: IntendedUseKind,
    pub stakes: Risk,
    pub predicate_class: Option<String>,
    pub description: String,
}

impl QueryIntendedUse {
    /// The M24 value, byte-for-byte the one the policy layer reads.
    pub fn intended_use(&self) -> IntendedUse {
        IntendedUse {
            kind: self.kind,
            stakes: self.stakes,
            predicate_class: self.predicate_class.clone(),
        }
    }

    /// Does the high-stakes stopping rule bind to this question?
    pub fn is_high_stakes(&self) -> bool {
        matches!(self.stakes, Risk::High | Risk::Critical)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.description.trim().is_empty() {
            return Err("intended_use.description must be non-empty".into());
        }
        if self.predicate_class.as_deref().is_some_and(str::is_empty) {
            return Err("intended_use.predicate_class is null or a value, never empty".into());
        }
        Ok(())
    }
}

/// The five retrieval intents. Closed, and every one is required.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Positive,
    Contradiction,
    Historical,
    Authority,
    ScopeNeighbor,
}

impl Intent {
    pub const ALL: [Intent; 5] = [
        Intent::Positive,
        Intent::Contradiction,
        Intent::Historical,
        Intent::Authority,
        Intent::ScopeNeighbor,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Intent::Positive => "positive",
            Intent::Contradiction => "contradiction",
            Intent::Historical => "historical",
            Intent::Authority => "authority",
            Intent::ScopeNeighbor => "scope_neighbor",
        }
    }
}

/// How one retrieval attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptOutcome {
    CandidatesFound,
    NoCandidates,
    SourceInaccessible,
    RuntimeUnavailable,
}

/// One search, recorded whether or not it found anything.
///
/// The record is what makes `exhausted` an honest word: a search that found
/// nothing is only exhausted once anyone can see what was searched and where.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub attempt_id: String,
    pub query_hash: String,
    pub expanded_aliases: Vec<String>,
    pub source_ids: Vec<String>,
    pub candidate_item_ids: Vec<String>,
    pub outcome: AttemptOutcome,
}

impl Attempt {
    fn validate(&self) -> Result<(), String> {
        if self.attempt_id.trim().is_empty() {
            return Err("attempt_id must be non-empty".into());
        }
        if !is_sha256(&self.query_hash) {
            return Err(format!(
                "attempt {} query_hash must be a lowercase SHA-256",
                self.attempt_id
            ));
        }
        for id in &self.source_ids {
            if !is_id128(id) {
                return Err(format!("attempt {} names a bad source id", self.attempt_id));
            }
        }
        // An attempt that found candidates has to name them, and one that
        // found none must not: "no_candidates" beside a candidate list is a
        // record that disagrees with itself.
        match self.outcome {
            AttemptOutcome::CandidatesFound if self.candidate_item_ids.is_empty() => Err(format!(
                "attempt {} says candidates_found and names none",
                self.attempt_id
            )),
            AttemptOutcome::CandidatesFound => Ok(()),
            _ if !self.candidate_item_ids.is_empty() => Err(format!(
                "attempt {} did not find candidates and names some",
                self.attempt_id
            )),
            _ => Ok(()),
        }
    }
}

/// Why an intent could not be satisfied. `cap_conflict` is the assembler's
/// own refusal — see the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    SourceInaccessible,
    RuntimeUnavailable,
    CapConflict,
}

/// The three terminal states. There is no `attempted` — see the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentStatus {
    Satisfied,
    Exhausted,
    Blocked,
}

/// One intent's whole story.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntentRecord {
    pub status: IntentStatus,
    pub attempts: Vec<Attempt>,
    pub selected_item_ids: Vec<String>,
    pub blocked_reason: Option<BlockedReason>,
}

impl IntentRecord {
    fn validate(&self, intent: Intent) -> Result<(), String> {
        let name = intent.as_str();
        for attempt in &self.attempts {
            attempt.validate()?;
        }
        match self.status {
            IntentStatus::Satisfied => {
                if self.selected_item_ids.is_empty() {
                    return Err(format!(
                        "intent {name} is satisfied and selected nothing — satisfied by what?"
                    ));
                }
                if self.blocked_reason.is_some() {
                    return Err(format!("intent {name} is satisfied and names a block"));
                }
            }
            IntentStatus::Exhausted => {
                // The whole weight of the word. A search nobody can see is
                // not an exhausted one.
                if self.attempts.is_empty() {
                    return Err(format!(
                        "intent {name} is exhausted with no recorded attempt — exhausted means \
                         looked and found nothing, and a look nobody can see is not a look"
                    ));
                }
                if !self.selected_item_ids.is_empty() {
                    return Err(format!("intent {name} is exhausted and selected items"));
                }
                if self.blocked_reason.is_some() {
                    return Err(format!("intent {name} is exhausted and names a block"));
                }
            }
            IntentStatus::Blocked => {
                if self.blocked_reason.is_none() {
                    return Err(format!("intent {name} is blocked and does not say why"));
                }
            }
        }
        Ok(())
    }
}

/// What the base holds about an assertion item's belief, if anything.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BeliefContext {
    None,
    SupportedAt {
        belief_id: String,
        belief_revision_event_id: String,
    },
}

/// Whether a belief revision rests on anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupportState {
    Linked,
    Unsupported,
}

/// One thing the question was shown. The two tags are exclusive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ManifestItem {
    Assertion {
        item_id: String,
        assertion_event_id: String,
        belief_context: BeliefContext,
        /// SINGULAR. An assertion came from exactly one M22 source.
        source_id: String,
        content_hash: String,
        selected_by_intents: Vec<Intent>,
        lineage_event_ids: Vec<String>,
        scope: Scope,
        state_stage: Option<Stage>,
        valid_time: ValidTime,
        byte_count: u64,
    },
    BeliefRevision {
        item_id: String,
        belief_id: String,
        belief_revision_event_id: String,
        basis_observation_event_ids: Vec<String>,
        /// PLURAL, and possibly empty — but only for an unsupported belief.
        source_ids: Vec<String>,
        content_hash: String,
        selected_by_intents: Vec<Intent>,
        lineage_event_ids: Vec<String>,
        scope: Scope,
        state_stage: Option<Stage>,
        valid_time: ValidTime,
        byte_count: u64,
        support_state: SupportState,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValidTime {
    pub from: Option<String>,
    pub to: Option<String>,
}

impl ValidTime {
    pub fn unbounded() -> ValidTime {
        ValidTime {
            from: None,
            to: None,
        }
    }

    fn validate(&self) -> Result<(), String> {
        for stamp in [&self.from, &self.to].into_iter().flatten() {
            if chrono::DateTime::parse_from_rfc3339(stamp).is_err() {
                return Err(format!("valid_time {stamp:?} is not RFC3339"));
            }
        }
        Ok(())
    }
}

impl ManifestItem {
    pub fn item_id(&self) -> &str {
        match self {
            ManifestItem::Assertion { item_id, .. }
            | ManifestItem::BeliefRevision { item_id, .. } => item_id,
        }
    }

    pub fn byte_count(&self) -> u64 {
        match self {
            ManifestItem::Assertion { byte_count, .. }
            | ManifestItem::BeliefRevision { byte_count, .. } => *byte_count,
        }
    }

    pub fn selected_by_intents(&self) -> &[Intent] {
        match self {
            ManifestItem::Assertion {
                selected_by_intents,
                ..
            }
            | ManifestItem::BeliefRevision {
                selected_by_intents,
                ..
            } => selected_by_intents,
        }
    }

    /// Every source this item genuinely rests on. Never a fabricated one.
    pub fn source_ids(&self) -> Vec<&str> {
        match self {
            ManifestItem::Assertion { source_id, .. } => vec![source_id.as_str()],
            ManifestItem::BeliefRevision { source_ids, .. } => {
                source_ids.iter().map(String::as_str).collect()
            }
        }
    }

    fn validate(&self) -> Result<(), String> {
        let id = self.item_id();
        if id.trim().is_empty() {
            return Err("a manifest item has no item_id".into());
        }
        if self.selected_by_intents().is_empty() {
            return Err(format!(
                "item {id} was selected by no intent — an item nothing asked for is an item \
                 nobody can account for"
            ));
        }
        match self {
            ManifestItem::Assertion {
                assertion_event_id,
                belief_context,
                source_id,
                content_hash,
                lineage_event_ids,
                valid_time,
                ..
            } => {
                if !is_id128(assertion_event_id) {
                    return Err(format!("item {id} has a bad assertion_event_id"));
                }
                if !is_id128(source_id) {
                    return Err(format!("item {id} has a bad source_id"));
                }
                if !is_sha256(content_hash) {
                    return Err(format!(
                        "item {id} content_hash must be a lowercase SHA-256"
                    ));
                }
                if let BeliefContext::SupportedAt {
                    belief_id,
                    belief_revision_event_id,
                } = belief_context
                {
                    if !is_id128(belief_id) || !is_id128(belief_revision_event_id) {
                        return Err(format!("item {id} has a bad belief context ref"));
                    }
                }
                validate_ids(id, "lineage_event_ids", lineage_event_ids)?;
                valid_time.validate()
            }
            ManifestItem::BeliefRevision {
                belief_id,
                belief_revision_event_id,
                basis_observation_event_ids,
                source_ids,
                content_hash,
                lineage_event_ids,
                valid_time,
                support_state,
                ..
            } => {
                if !is_id128(belief_id) || !is_id128(belief_revision_event_id) {
                    return Err(format!("item {id} has a bad belief ref"));
                }
                if !is_sha256(content_hash) {
                    return Err(format!(
                        "item {id} content_hash must be a lowercase SHA-256"
                    ));
                }
                validate_ids(
                    id,
                    "basis_observation_event_ids",
                    basis_observation_event_ids,
                )?;
                validate_ids(id, "source_ids", source_ids)?;
                validate_ids(id, "lineage_event_ids", lineage_event_ids)?;
                // The rule that stops a source being invented for a belief
                // that has none, and stops one being omitted for a belief
                // that does.
                match support_state {
                    SupportState::Linked
                        if basis_observation_event_ids.is_empty() || source_ids.is_empty() =>
                    {
                        Err(format!(
                            "item {id} is a linked belief revision and names no basis or no \
                             source — linked means it rests on something"
                        ))
                    }
                    SupportState::Unsupported
                        if !basis_observation_event_ids.is_empty() || !source_ids.is_empty() =>
                    {
                        Err(format!(
                            "item {id} is an unsupported belief revision and names a basis or a \
                             source — a source for an unsupported belief is a fabricated one"
                        ))
                    }
                    _ => valid_time.validate(),
                }
            }
        }
    }
}

fn validate_ids(item: &str, name: &str, ids: &[String]) -> Result<(), String> {
    if ids.iter().any(|id| !is_id128(id)) {
        return Err(format!("item {item} has a bad id in {name}"));
    }
    let unique: BTreeSet<&String> = ids.iter().collect();
    if unique.len() != ids.len() {
        return Err(format!("item {item} repeats an id in {name}"));
    }
    Ok(())
}

/// What happened to the counterevidence. Three answers, and "nothing to
/// report" is not one of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Counterevidence {
    Included {
        item_ids: Vec<String>,
    },
    Exhausted {
        attempt_refs: Vec<String>,
        source_ids: Vec<String>,
        /// The only reason exhaustion can have: it looked and found none.
        reason: ExhaustedReason,
    },
    Blocked {
        attempt_refs: Vec<String>,
        source_ids: Vec<String>,
        reason: BlockedCounterevidence,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExhaustedReason {
    NoCandidates,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedCounterevidence {
    SourceInaccessible,
    RuntimeUnavailable,
}

/// The caps an attended assembly is bounded by.
///
/// **Not a budget.** These bound one request so it cannot run away; M25's
/// daily run and token ceilings govern AMBIENT work and never refuse an
/// attended question. There is deliberately no `max_daily_runs` here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_sources_per_run: u64,
    pub max_context_bytes: u64,
    pub max_evidence_items: u64,
}

/// What the assembly actually used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Actual {
    pub source_count: u64,
    pub context_bytes: u64,
    pub evidence_item_count: u64,
}

/// All five intents, by name. A map would let one go missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intents {
    pub positive: IntentRecord,
    pub contradiction: IntentRecord,
    pub historical: IntentRecord,
    pub authority: IntentRecord,
    pub scope_neighbor: IntentRecord,
}

impl Intents {
    pub fn get(&self, intent: Intent) -> &IntentRecord {
        match intent {
            Intent::Positive => &self.positive,
            Intent::Contradiction => &self.contradiction,
            Intent::Historical => &self.historical,
            Intent::Authority => &self.authority,
            Intent::ScopeNeighbor => &self.scope_neighbor,
        }
    }

    fn validate(&self) -> Result<(), String> {
        for intent in Intent::ALL {
            self.get(intent).validate(intent)?;
        }
        Ok(())
    }
}

/// What one question was shown, and what it could not be.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkingMemoryManifest {
    pub assembly_id: String,
    pub question_hash: String,
    pub intended_use: QueryIntendedUse,
    pub limits: Limits,
    pub actual: Actual,
    pub intents: Intents,
    pub items: Vec<ManifestItem>,
    pub counterevidence: Counterevidence,
}

impl WorkingMemoryManifest {
    /// Every rule the spec states, checked here rather than trusted.
    pub fn validate(&self) -> Result<(), String> {
        if self.assembly_id.trim().is_empty() {
            return Err("assembly_id must be non-empty".into());
        }
        if !is_sha256(&self.question_hash) {
            return Err("question_hash must be a lowercase SHA-256".into());
        }
        self.intended_use.validate()?;
        self.intents.validate()?;

        let mut ids: BTreeSet<&str> = BTreeSet::new();
        for item in &self.items {
            item.validate()?;
            if !ids.insert(item.item_id()) {
                return Err(format!("item {} appears twice", item.item_id()));
            }
        }

        // Every id anyone points at must be an item that is actually here.
        for intent in Intent::ALL {
            for id in &self.intents.get(intent).selected_item_ids {
                if !ids.contains(id.as_str()) {
                    return Err(format!(
                        "intent {} selected item {id}, which is not in the manifest",
                        intent.as_str()
                    ));
                }
            }
        }
        self.validate_counterevidence(&ids)?;
        self.validate_actuals()?;
        self.validate_caps()
    }

    fn validate_counterevidence(&self, ids: &BTreeSet<&str>) -> Result<(), String> {
        match &self.counterevidence {
            Counterevidence::Included { item_ids } => {
                if item_ids.is_empty() {
                    return Err(
                        "counterevidence is included and names nothing — an empty inclusion is \
                         an omission with a friendlier word on it"
                            .into(),
                    );
                }
                for id in item_ids {
                    if !ids.contains(id.as_str()) {
                        return Err(format!(
                            "counterevidence names item {id}, which is not in the manifest"
                        ));
                    }
                }
                Ok(())
            }
            Counterevidence::Exhausted {
                attempt_refs,
                source_ids,
                ..
            } => {
                if attempt_refs.is_empty() {
                    return Err(
                        "counterevidence is exhausted with no attempt — see IntentRecord: a look \
                         nobody can see is not a look"
                            .into(),
                    );
                }
                self.validate_attempt_refs(attempt_refs)?;
                validate_ids("counterevidence", "source_ids", source_ids)
            }
            Counterevidence::Blocked {
                attempt_refs,
                source_ids,
                ..
            } => {
                if attempt_refs.is_empty() || source_ids.is_empty() {
                    return Err(
                        "counterevidence is blocked and must name both the attempts and the \
                         sources it could not reach"
                            .into(),
                    );
                }
                self.validate_attempt_refs(attempt_refs)?;
                validate_ids("counterevidence", "source_ids", source_ids)
            }
        }
    }

    /// A counterevidence attempt ref names an attempt this manifest RECORDED.
    /// Otherwise "we tried" is a claim with nothing behind it.
    fn validate_attempt_refs(&self, refs: &[String]) -> Result<(), String> {
        let known: BTreeSet<&str> = Intent::ALL
            .iter()
            .flat_map(|intent| &self.intents.get(*intent).attempts)
            .map(|attempt| attempt.attempt_id.as_str())
            .collect();
        for id in refs {
            if !known.contains(id.as_str()) {
                return Err(format!(
                    "counterevidence names attempt {id}, which no intent recorded"
                ));
            }
        }
        Ok(())
    }

    /// The counted union across items AND attempts — so a manifest cannot
    /// inflate its source count with a source no item rests on, nor hide one
    /// an attempt reached.
    pub fn distinct_sources(&self) -> BTreeSet<&str> {
        let mut sources: BTreeSet<&str> = BTreeSet::new();
        for item in &self.items {
            sources.extend(item.source_ids());
        }
        for intent in Intent::ALL {
            for attempt in &self.intents.get(intent).attempts {
                sources.extend(attempt.source_ids.iter().map(String::as_str));
            }
        }
        sources
    }

    fn validate_actuals(&self) -> Result<(), String> {
        let sources = self.distinct_sources().len() as u64;
        if self.actual.source_count != sources {
            return Err(format!(
                "actual.source_count is {} and the distinct union of item and attempt sources is \
                 {sources}",
                self.actual.source_count
            ));
        }
        let items = self.items.len() as u64;
        if self.actual.evidence_item_count != items {
            return Err(format!(
                "actual.evidence_item_count is {} and there are {items} items",
                self.actual.evidence_item_count
            ));
        }
        let bytes: u64 = self.items.iter().map(ManifestItem::byte_count).sum();
        if self.actual.context_bytes != bytes {
            return Err(format!(
                "actual.context_bytes is {} and the items sum to {bytes}",
                self.actual.context_bytes
            ));
        }
        Ok(())
    }

    /// A manifest that exceeded its own caps is not a manifest, it is a
    /// receipt for a cap that did nothing.
    fn validate_caps(&self) -> Result<(), String> {
        for (name, actual, limit) in [
            (
                "source_count",
                self.actual.source_count,
                self.limits.max_sources_per_run,
            ),
            (
                "context_bytes",
                self.actual.context_bytes,
                self.limits.max_context_bytes,
            ),
            (
                "evidence_item_count",
                self.actual.evidence_item_count,
                self.limits.max_evidence_items,
            ),
        ] {
            if actual > limit {
                return Err(format!(
                    "{name} is {actual} and the cap was {limit} — a manifest over its cap means \
                     the cap did not run"
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const ID_A: &str = "aa11bb22cc33dd44ee55ff6600778899";
    pub(crate) const ID_B: &str = "bb11bb22cc33dd44ee55ff6600778899";
    pub(crate) const ID_C: &str = "cc11bb22cc33dd44ee55ff6600778899";
    pub(crate) const SHA: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";

    pub(crate) fn use_for(stakes: Risk) -> QueryIntendedUse {
        QueryIntendedUse {
            kind: IntendedUseKind::OperationalDecision,
            stakes,
            predicate_class: Some("delivery_date".into()),
            description: "when does the warehouse cutover land".into(),
        }
    }

    pub(crate) fn assertion(item: &str, intents: &[Intent]) -> ManifestItem {
        ManifestItem::Assertion {
            item_id: item.to_string(),
            assertion_event_id: ID_A.into(),
            belief_context: BeliefContext::None,
            source_id: ID_B.into(),
            content_hash: SHA.into(),
            selected_by_intents: intents.to_vec(),
            lineage_event_ids: vec![],
            scope: Scope::empty(),
            state_stage: None,
            valid_time: ValidTime::unbounded(),
            byte_count: 100,
        }
    }

    fn attempt(id: &str, outcome: AttemptOutcome, candidates: &[&str]) -> Attempt {
        Attempt {
            attempt_id: id.to_string(),
            query_hash: SHA.into(),
            expanded_aliases: vec!["Falcon".into()],
            source_ids: vec![ID_B.into()],
            candidate_item_ids: candidates.iter().map(|c| (*c).to_string()).collect(),
            outcome,
        }
    }

    fn satisfied(attempt_id: &str, item: &str) -> IntentRecord {
        IntentRecord {
            status: IntentStatus::Satisfied,
            attempts: vec![attempt(
                attempt_id,
                AttemptOutcome::CandidatesFound,
                &[item],
            )],
            selected_item_ids: vec![item.to_string()],
            blocked_reason: None,
        }
    }

    /// A manifest that satisfies every intent from one item — the smallest
    /// thing that validates, which every test below perturbs.
    pub(crate) fn manifest() -> WorkingMemoryManifest {
        let item = assertion("i-1", &Intent::ALL);
        WorkingMemoryManifest {
            assembly_id: "asm-1".into(),
            question_hash: SHA.into(),
            intended_use: use_for(Risk::Medium),
            limits: Limits {
                max_sources_per_run: 10,
                max_context_bytes: 10_000,
                max_evidence_items: 50,
            },
            actual: Actual {
                source_count: 1,
                context_bytes: 100,
                evidence_item_count: 1,
            },
            intents: Intents {
                positive: satisfied("at-1", "i-1"),
                contradiction: satisfied("at-2", "i-1"),
                historical: satisfied("at-3", "i-1"),
                authority: satisfied("at-4", "i-1"),
                scope_neighbor: satisfied("at-5", "i-1"),
            },
            items: vec![item],
            counterevidence: Counterevidence::Included {
                item_ids: vec!["i-1".into()],
            },
        }
    }

    #[test]
    fn the_smallest_complete_manifest_validates() {
        manifest().validate().unwrap();
    }

    #[test]
    fn attempted_is_not_a_status_anyone_can_spell() {
        // The word a caller reaches for to claim credit for a search that did
        // not finish. It is not in the vocabulary, so it cannot be said.
        let err = serde_json::from_str::<IntentStatus>("\"attempted\"").unwrap_err();
        assert!(err.to_string().contains("unknown variant"), "{err}");
    }

    #[test]
    fn an_exhausted_intent_must_show_the_search_it_ran() {
        // "We looked and found nothing" is only true if anyone can see the
        // looking.
        let mut m = manifest();
        m.intents.historical = IntentRecord {
            status: IntentStatus::Exhausted,
            attempts: vec![],
            selected_item_ids: vec![],
            blocked_reason: None,
        };
        let err = m.validate().unwrap_err();
        assert!(err.contains("a look nobody can see is not a look"), "{err}");

        m.intents.historical.attempts = vec![attempt("at-9", AttemptOutcome::NoCandidates, &[])];
        m.validate().unwrap();
    }

    #[test]
    fn a_blocked_intent_says_why() {
        let mut m = manifest();
        m.intents.authority = IntentRecord {
            status: IntentStatus::Blocked,
            attempts: vec![attempt("at-9", AttemptOutcome::SourceInaccessible, &[])],
            selected_item_ids: vec![],
            blocked_reason: None,
        };
        assert!(m.validate().unwrap_err().contains("does not say why"));
        m.intents.authority.blocked_reason = Some(BlockedReason::SourceInaccessible);
        m.validate().unwrap();
    }

    #[test]
    fn a_satisfied_intent_that_selected_nothing_is_refused() {
        let mut m = manifest();
        m.intents.positive.selected_item_ids = vec![];
        assert!(m.validate().unwrap_err().contains("satisfied by what?"));
    }

    #[test]
    fn an_empty_inclusion_is_an_omission_with_a_friendlier_word_on_it() {
        let mut m = manifest();
        m.counterevidence = Counterevidence::Included { item_ids: vec![] };
        let err = m.validate().unwrap_err();
        assert!(err.contains("friendlier word"), "{err}");
    }

    #[test]
    fn counterevidence_can_only_name_attempts_this_manifest_recorded() {
        // Otherwise "we tried" is a claim with nothing behind it.
        let mut m = manifest();
        m.counterevidence = Counterevidence::Exhausted {
            attempt_refs: vec!["at-never".into()],
            source_ids: vec![ID_B.into()],
            reason: ExhaustedReason::NoCandidates,
        };
        let err = m.validate().unwrap_err();
        assert!(err.contains("which no intent recorded"), "{err}");

        m.counterevidence = Counterevidence::Exhausted {
            attempt_refs: vec!["at-2".into()],
            source_ids: vec![ID_B.into()],
            reason: ExhaustedReason::NoCandidates,
        };
        m.validate().unwrap();
    }

    #[test]
    fn blocked_counterevidence_names_the_sources_it_could_not_reach() {
        let mut m = manifest();
        m.counterevidence = Counterevidence::Blocked {
            attempt_refs: vec!["at-2".into()],
            source_ids: vec![],
            reason: BlockedCounterevidence::SourceInaccessible,
        };
        assert!(m.validate().unwrap_err().contains("could not reach"));
    }

    #[test]
    fn an_unsupported_belief_never_gets_a_source_invented_for_it() {
        // The rule the spec spends a paragraph on: a singular source
        // fabricated for a belief that rests on nothing.
        let mut m = manifest();
        let bad = ManifestItem::BeliefRevision {
            item_id: "i-2".into(),
            belief_id: ID_A.into(),
            belief_revision_event_id: ID_B.into(),
            basis_observation_event_ids: vec![],
            source_ids: vec![ID_C.into()],
            content_hash: SHA.into(),
            selected_by_intents: vec![Intent::Positive],
            lineage_event_ids: vec![],
            scope: Scope::empty(),
            state_stage: None,
            valid_time: ValidTime::unbounded(),
            byte_count: 10,
            support_state: SupportState::Unsupported,
        };
        m.items.push(bad);
        let err = m.validate().unwrap_err();
        assert!(err.contains("fabricated one"), "{err}");
    }

    #[test]
    fn a_linked_belief_revision_must_rest_on_something() {
        let mut m = manifest();
        m.items.push(ManifestItem::BeliefRevision {
            item_id: "i-2".into(),
            belief_id: ID_A.into(),
            belief_revision_event_id: ID_B.into(),
            basis_observation_event_ids: vec![],
            source_ids: vec![],
            content_hash: SHA.into(),
            selected_by_intents: vec![Intent::Positive],
            lineage_event_ids: vec![],
            scope: Scope::empty(),
            state_stage: None,
            valid_time: ValidTime::unbounded(),
            byte_count: 10,
            support_state: SupportState::Linked,
        });
        let err = m.validate().unwrap_err();
        assert!(err.contains("linked means it rests on something"), "{err}");
    }

    #[test]
    fn the_source_count_is_the_union_across_items_and_attempts() {
        // Not the item count, and not the attempt count: a manifest that
        // counted only one would either inflate or hide.
        let mut m = manifest();
        m.items.push(ManifestItem::BeliefRevision {
            item_id: "i-2".into(),
            belief_id: ID_A.into(),
            belief_revision_event_id: ID_B.into(),
            basis_observation_event_ids: vec![ID_C.into()],
            source_ids: vec![ID_C.into()],
            content_hash: SHA.into(),
            selected_by_intents: vec![Intent::Positive],
            lineage_event_ids: vec![],
            scope: Scope::empty(),
            state_stage: None,
            valid_time: ValidTime::unbounded(),
            byte_count: 10,
            support_state: SupportState::Linked,
        });
        m.actual.evidence_item_count = 2;
        m.actual.context_bytes = 110;
        // Still 1 — the new item's source is a second one.
        assert!(m.validate().unwrap_err().contains("distinct union"));
        m.actual.source_count = 2;
        m.validate().unwrap();
        assert_eq!(m.distinct_sources().len(), 2);
    }

    #[test]
    fn a_manifest_over_its_own_cap_means_the_cap_did_not_run() {
        for mutate in [
            (|m: &mut WorkingMemoryManifest| m.limits.max_evidence_items = 0) as fn(&mut _),
            |m: &mut WorkingMemoryManifest| m.limits.max_context_bytes = 1,
            |m: &mut WorkingMemoryManifest| m.limits.max_sources_per_run = 0,
        ] {
            let mut m = manifest();
            mutate(&mut m);
            assert!(m.validate().unwrap_err().contains("the cap did not run"));
        }
    }

    #[test]
    fn an_item_no_intent_asked_for_cannot_be_accounted_for() {
        let mut m = manifest();
        m.items.push(assertion("i-2", &[]));
        m.actual.evidence_item_count = 2;
        m.actual.context_bytes = 200;
        let err = m.validate().unwrap_err();
        assert!(err.contains("selected by no intent"), "{err}");
    }

    #[test]
    fn an_intent_cannot_select_an_item_that_is_not_here() {
        let mut m = manifest();
        m.intents.positive.selected_item_ids = vec!["i-ghost".into()];
        let err = m.validate().unwrap_err();
        assert!(err.contains("not in the manifest"), "{err}");
    }

    #[test]
    fn an_attempt_that_found_nothing_cannot_name_candidates() {
        let mut m = manifest();
        m.intents.positive.attempts = vec![attempt("at-1", AttemptOutcome::NoCandidates, &["i-1"])];
        assert!(m.validate().unwrap_err().contains("names some"));
    }

    #[test]
    fn the_intended_use_is_the_one_the_policy_layer_reads() {
        // Not a copy assembled field by field — the M24 value itself, so the
        // stopping-rule lookup and this manifest cannot disagree.
        let question = use_for(Risk::Critical);
        let m24 = question.intended_use();
        assert_eq!(m24.kind, question.kind);
        assert_eq!(m24.stakes, question.stakes);
        assert_eq!(m24.predicate_class, question.predicate_class);
        assert!(question.is_high_stakes());
        assert!(!use_for(Risk::Low).is_high_stakes());
    }

    #[test]
    fn a_question_with_no_description_is_refused() {
        let mut m = manifest();
        m.intended_use.description = "   ".into();
        assert!(m.validate().unwrap_err().contains("non-empty"));
    }

    #[test]
    fn every_intent_is_a_named_field_so_one_cannot_go_missing() {
        // A map would let a manifest ship four intents and look complete.
        let json = serde_json::to_value(manifest()).unwrap();
        let intents = json["intents"].as_object().unwrap();
        assert_eq!(intents.len(), 5);
        for intent in Intent::ALL {
            assert!(intents.contains_key(intent.as_str()), "{}", intent.as_str());
        }
        let short = serde_json::json!({ "positive": intents["positive"] });
        assert!(serde_json::from_value::<Intents>(short).is_err());
    }

    #[test]
    fn a_manifest_round_trips_through_its_own_bytes() {
        let m = manifest();
        let bytes = serde_json::to_string(&m).unwrap();
        let back: WorkingMemoryManifest = serde_json::from_str(&bytes).unwrap();
        assert_eq!(back, m);
        back.validate().unwrap();
    }
}
