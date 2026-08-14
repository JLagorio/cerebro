//! The Coverage axis: seven dimensions folded, nothing deleted (M27.2a).
//!
//! **The fold is data** — `shared/policy/coverage-fold.v1.json`, digest-pinned
//! and compiled in. The order in which `no` beats `unknown` beats `yes`, which
//! five dimensions make a summary `blind`, and what a `not_applicable` means
//! are the kind of rules that would otherwise be written twice and drift on
//! the third edit. Every derived Coverage records the `fold_rule_version` it
//! was folded under, so a stored answer can be read against the table that
//! produced it.
//!
//! **A summary is a projection, never a replacement.** M25.4's whole point was
//! that a "partial" scalar erases which source could not be reached (§46), so
//! every folded dimension here keeps its contributing rows — assessment id,
//! source, state, basis refs, and each input's OWN `as_of`. There is
//! deliberately no global timestamp: two sources assessed a week apart do not
//! share a moment, and inventing one would make the newer answer vouch for the
//! older.
//!
//! **`no_assessments` is `blind`, and that is the honest reading.** Nobody
//! having looked is not the same as nothing being there (§90), and the two
//! must not render alike — which is exactly why the tagged union has a
//! separate `no_assessments` variant instead of an `assessed` one with an
//! empty map. A reader that only checked `summary` still gets `blind`; one
//! that wants to say "nobody has assessed this" can.
//!
//! **`not_applicable` is ignored unless it is all there is.** A source with no
//! retention policy genuinely has no `retention_known` answer, and letting one
//! N/A drag a dimension to `unknown` would make every such source look
//! half-observed forever. When EVERY input is N/A the dimension is N/A, which
//! the summary then treats as satisfied — because it is.
//!
//! **There is no shared golden file for this table, and the reason is the same
//! one M26.7f gave for the projection vectors.** `shared/policy/goldens/` has
//! one loader with one schema; a differently-shaped file there breaks it. More
//! to the point, parity is a property of TWO implementations, and there is
//! only one: TypeScript never folds Coverage — the chips it renders arrive
//! derived, over IPC. A golden for a single implementation is a unit test in a
//! JSON costume. The exhaustive boundary table lives below as a test, and the
//! shared vectors land the day TS grows a reader.

use std::collections::BTreeMap;

use crate::ledger::reduce::{CoverageAssessment, EpistemicState};
use crate::ledger::schema::{Dimension, DimensionState};
use crate::ledger::sha256_hex;

use super::facet::Facet;

const FOLD_JSON: &str = include_str!("../../../shared/policy/coverage-fold.v1.json");
const FOLD_DIGEST: &str = include_str!("../../../shared/policy/coverage-fold.v1.sha256");

/// What a folded Coverage says at a glance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Summary {
    Observed,
    Partial,
    Blind,
}

impl Summary {
    pub fn as_str(self) -> &'static str {
        match self {
            Summary::Observed => "observed",
            Summary::Partial => "partial",
            Summary::Blind => "blind",
        }
    }

    pub const ALL: [Summary; 3] = [Summary::Observed, Summary::Partial, Summary::Blind];
}

/// One assessment's contribution to one dimension. Kept whole.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DimensionInput {
    pub assessment_id: String,
    pub source_id: String,
    pub state: String,
    pub basis_event_ids: Vec<String>,
    pub as_of: String,
}

/// One folded dimension, plus every row that made it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FoldedDimension {
    pub state: String,
    /// At least one, always: a dimension with no inputs is not a dimension
    /// with an unknown state, it is a dimension that is not there — which is
    /// what the `no_assessments` variant says.
    pub inputs: Vec<DimensionInput>,
}

/// The axis.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Coverage {
    NoAssessments {
        summary: Summary,
        assessment_ids: Vec<String>,
        fold_rule_version: String,
    },
    Assessed {
        summary: Summary,
        dimensions: BTreeMap<String, FoldedDimension>,
        assessment_ids: Vec<String>,
        fold_rule_version: String,
    },
}

impl Coverage {
    pub fn summary(&self) -> Summary {
        match self {
            Coverage::NoAssessments { summary, .. } | Coverage::Assessed { summary, .. } => {
                *summary
            }
        }
    }

    pub fn assessment_ids(&self) -> &[String] {
        match self {
            Coverage::NoAssessments { assessment_ids, .. }
            | Coverage::Assessed { assessment_ids, .. } => assessment_ids,
        }
    }

    /// The human-readable half of the composed chip line.
    pub fn describe(&self) -> &'static str {
        match self.summary() {
            Summary::Observed => "observed coverage",
            Summary::Partial => "partial coverage",
            Summary::Blind => match self {
                Coverage::NoAssessments { .. } => "coverage unassessed",
                Coverage::Assessed { .. } => "blind coverage",
            },
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u64,
    artifact_version: u64,
    fold_rule_version: String,
    dimensions: Vec<String>,
    state_precedence: Vec<String>,
    not_applicable: String,
    blind_when_no: Vec<String>,
    summary_precedence: Vec<String>,
}

/// The loaded fold table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fold {
    pub artifact_version: u64,
    pub fold_rule_version: String,
    /// Highest precedence first: the winner of a fold.
    precedence: Vec<DimensionState>,
    blind_when_no: Vec<Dimension>,
}

impl Fold {
    /// Does a `no` on this dimension make the whole summary blind?
    pub fn is_hard(&self, dimension: Dimension) -> bool {
        self.blind_when_no.contains(&dimension)
    }

    fn rank(&self, state: DimensionState) -> usize {
        self.precedence
            .iter()
            .position(|candidate| *candidate == state)
            // Not in the precedence list means `not_applicable`, which the
            // artifact handles separately and which must never win a fold.
            .unwrap_or(usize::MAX)
    }
}

fn parse_dimension(name: &str) -> Option<Dimension> {
    [
        Dimension::SourceConnected,
        Dimension::SourceHealthy,
        Dimension::ScopeKnown,
        Dimension::ScopeAccessible,
        Dimension::RetentionKnown,
        Dimension::IndexCurrent,
        Dimension::RetrievalAttempted,
    ]
    .into_iter()
    .find(|dimension| dimension.as_str() == name)
}

fn parse_state(name: &str) -> Option<DimensionState> {
    match name {
        "yes" => Some(DimensionState::Yes),
        "no" => Some(DimensionState::No),
        "unknown" => Some(DimensionState::Unknown),
        "not_applicable" => Some(DimensionState::NotApplicable),
        _ => None,
    }
}

fn state_str(state: DimensionState) -> &'static str {
    match state {
        DimensionState::Yes => "yes",
        DimensionState::No => "no",
        DimensionState::Unknown => "unknown",
        DimensionState::NotApplicable => "not_applicable",
    }
}

/// Load the shipped fold table, digest-checked.
pub fn load() -> Result<Fold, String> {
    let expected = FOLD_DIGEST.trim();
    let actual = sha256_hex(FOLD_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/policy/coverage-fold.v1.json hashes to {actual}, and the committed digest \
             says {expected} — regenerate the digest deliberately, or find out who changed when \
             this app calls a subject blind"
        ));
    }
    let artifact: Artifact =
        serde_json::from_str(FOLD_JSON).map_err(|e| format!("coverage-fold.v1.json: {e}"))?;
    if artifact.format != 1 {
        return Err(format!(
            "coverage-fold format {} is not one this build speaks",
            artifact.format
        ));
    }
    if artifact.fold_rule_version.is_empty() {
        return Err(
            "fold_rule_version must be non-empty — every derived Coverage records it".into(),
        );
    }
    // The dimension list is the closed seven, in the schema's own order. An
    // artifact that could drop one would silently stop folding it, and a
    // summary that never looked at `scope_accessible` reads exactly like one
    // where access was fine.
    let declared: Vec<Dimension> = artifact
        .dimensions
        .iter()
        .map(|name| {
            parse_dimension(name).ok_or_else(|| format!("{name:?} is not a coverage dimension"))
        })
        .collect::<Result<_, _>>()?;
    let all: Vec<Dimension> = Dimension::ALL.to_vec();
    if declared != all {
        return Err(format!(
            "coverage-fold declares {:?}, and the seven dimensions are {:?} in that order — a \
             fold that skipped one would summarize as though it had been checked",
            artifact.dimensions,
            all.iter().map(|d| d.as_str()).collect::<Vec<_>>()
        ));
    }
    let precedence: Vec<DimensionState> = artifact
        .state_precedence
        .iter()
        .map(|name| parse_state(name).ok_or_else(|| format!("{name:?} is not a dimension state")))
        .collect::<Result<_, _>>()?;
    if precedence
        != vec![
            DimensionState::No,
            DimensionState::Unknown,
            DimensionState::Yes,
        ]
    {
        return Err(
            "state_precedence must be no > unknown > yes — any other order lets a `yes` from one \
             source hide a `no` from another, which is the collapse §46 forbids"
                .into(),
        );
    }
    if artifact.not_applicable != "ignored_unless_every_input_is_not_applicable" {
        return Err(format!(
            "not_applicable rule {:?} is not one this build implements",
            artifact.not_applicable
        ));
    }
    let blind_when_no: Vec<Dimension> = artifact
        .blind_when_no
        .iter()
        .map(|name| {
            parse_dimension(name).ok_or_else(|| format!("{name:?} is not a coverage dimension"))
        })
        .collect::<Result<_, _>>()?;
    if blind_when_no.is_empty() {
        return Err(
            "blind_when_no is empty — no dimension could then make a subject blind, and the \
             summary would answer `partial` to a source nobody can reach"
                .into(),
        );
    }
    if artifact.summary_precedence != ["blind", "observed", "partial"] {
        return Err(format!(
            "summary_precedence {:?} is not the design's blind → observed → partial",
            artifact.summary_precedence
        ));
    }

    Ok(Fold {
        artifact_version: artifact.artifact_version,
        fold_rule_version: artifact.fold_rule_version,
        precedence,
        blind_when_no,
    })
}

/// Fold one dimension's inputs into a state.
///
/// `not_applicable` is skipped unless every input is N/A, in which case the
/// dimension is N/A. An empty input list is `unknown` — but no caller can
/// produce one, because a dimension with no inputs means no assessments at
/// all, which is the other variant.
pub fn fold_states(fold: &Fold, states: &[DimensionState]) -> DimensionState {
    let considered: Vec<DimensionState> = states
        .iter()
        .copied()
        .filter(|state| *state != DimensionState::NotApplicable)
        .collect();
    if considered.is_empty() {
        return if states.is_empty() {
            DimensionState::Unknown
        } else {
            DimensionState::NotApplicable
        };
    }
    considered
        .into_iter()
        .min_by_key(|state| fold.rank(*state))
        .expect("non-empty")
}

/// Every assessment that speaks about this facet, newest per source.
///
/// Compatible means: it names this facet's subject (a subject-less assessment
/// covers a source in general, and §90's whole point is that general coverage
/// is not coverage OF this subject), it is not superseded, and its source is
/// one the facet's own supporting assertions came from.
/// Does this assessment speak about the facet's predicate class?
///
/// `None` on the assessment means source-wide: everything that source says
/// about this subject. `Some(c)` means it speaks only for class `c`, and a
/// facet in another class must not read it (M27.10).
///
/// A facet whose class cannot be resolved — no freshness rule names its
/// predicate — is only covered by source-wide assessments. That direction is
/// deliberate: counting a class-scoped assessment for an unknown class would
/// let one source's answer about something else read as "we looked".
fn speaks_for(assessment: &CoverageAssessment, class: Option<&str>) -> bool {
    match assessment.predicate_class.as_deref() {
        None => true,
        Some(scoped) => Some(scoped) == class,
    }
}

fn assessments_for<'a>(
    state: &'a EpistemicState,
    facet: &Facet,
    class: Option<&str>,
) -> Vec<&'a CoverageAssessment> {
    let mut subject: Option<&str> = None;
    let mut sources: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for event_id in &facet.supports {
        if let Some(observation) = state.observations.get(event_id) {
            sources.insert(observation.source_id.as_str());
        }
    }
    if let Some(belief) = state.beliefs.get(&facet.key.belief_id) {
        subject = Some(belief.entity_id.as_str());
    }
    let Some(subject) = subject else {
        return Vec::new();
    };

    // One per (source, class): `coverage_current` is the reducer's own
    // selection by fold sequence, and re-deriving "latest" here from an
    // agent-supplied `as_of` would let a source with a fast clock speak last.
    //
    // KEYED BY CLASS TOO, and it has to be (M27.10). The reducer keys
    // `coverage_current` by `(source, subject, predicate_class)`; this keyed
    // `best` by source alone, so one source's assessments about two classes
    // overwrote each other and whichever class sorted last decided the
    // facet's Coverage. An assessment about a different predicate class could
    // therefore report a facet `observed` — the base saying it had looked
    // when it had looked at something else.
    let mut best: BTreeMap<(&str, Option<&str>), &CoverageAssessment> = BTreeMap::new();
    let key = |assessment: &'a CoverageAssessment| {
        (
            assessment.source_id.as_str(),
            assessment.predicate_class.as_deref(),
        )
    };
    for assessment in state.coverage_assessments.values() {
        if assessment.superseded
            || assessment.subject_id.as_deref() != Some(subject)
            || !sources.contains(assessment.source_id.as_str())
            || !speaks_for(assessment, class)
        {
            continue;
        }
        best.insert(key(assessment), assessment);
    }
    // The reducer's current pointer wins where it has one.
    for ((source_id, subject_key, _), assessment_id) in &state.coverage_current {
        if subject_key != subject || !sources.contains(source_id.as_str()) {
            continue;
        }
        if let Some(current) = state.coverage_assessments.get(assessment_id) {
            if !current.superseded && speaks_for(current, class) {
                best.insert(key(current), current);
            }
        }
    }
    best.into_values().collect()
}

/// Derive one facet's Coverage.
/// `class` is the facet's predicate class, resolved by the CALLER from the
/// freshness artifact it already loaded. Passed in rather than looked up here
/// so this module never learns about freshness rules: it needs the name of
/// the class, not the clock attached to it.
pub fn coverage_of(
    state: &EpistemicState,
    fold: &Fold,
    facet: &Facet,
    class: Option<&str>,
) -> Coverage {
    let assessments = assessments_for(state, facet, class);
    let mut assessment_ids: Vec<String> = assessments
        .iter()
        .map(|a| a.assessment_id.clone())
        .collect();
    assessment_ids.sort();
    assessment_ids.dedup();

    if assessments.is_empty() {
        return Coverage::NoAssessments {
            // Nobody has looked. §90: that is not the same as nothing being
            // there, and it is certainly not `partial`.
            summary: Summary::Blind,
            assessment_ids,
            fold_rule_version: fold.fold_rule_version.clone(),
        };
    }

    let mut dimensions: BTreeMap<String, FoldedDimension> = BTreeMap::new();
    let mut folded_states: Vec<(Dimension, DimensionState)> = Vec::new();
    for dimension in Dimension::ALL {
        let mut inputs: Vec<DimensionInput> = Vec::new();
        let mut states: Vec<DimensionState> = Vec::new();
        for assessment in &assessments {
            let value = assessment.dimensions.get(dimension);
            states.push(value.state);
            inputs.push(DimensionInput {
                assessment_id: assessment.assessment_id.clone(),
                source_id: assessment.source_id.clone(),
                state: state_str(value.state).to_string(),
                basis_event_ids: value.basis_event_ids.clone(),
                // Each input's OWN as_of. Two sources assessed a week apart
                // do not share a moment.
                as_of: value.as_of.clone(),
            });
        }
        inputs.sort_by(|a, b| {
            (&a.source_id, &a.assessment_id).cmp(&(&b.source_id, &b.assessment_id))
        });
        let state = fold_states(fold, &states);
        folded_states.push((dimension, state));
        dimensions.insert(
            dimension.as_str().to_string(),
            FoldedDimension {
                state: state_str(state).to_string(),
                inputs,
            },
        );
    }

    let summary = summarize(fold, &folded_states);
    Coverage::Assessed {
        summary,
        dimensions,
        assessment_ids,
        fold_rule_version: fold.fold_rule_version.clone(),
    }
}

/// The artifact's summary precedence, read in its declared order: blind
/// first, then observed, then partial as the remainder.
pub fn summarize(fold: &Fold, folded: &[(Dimension, DimensionState)]) -> Summary {
    if folded
        .iter()
        .any(|(dimension, state)| *state == DimensionState::No && fold.is_hard(*dimension))
    {
        return Summary::Blind;
    }
    if folded
        .iter()
        .all(|(_, state)| matches!(state, DimensionState::Yes | DimensionState::NotApplicable))
    {
        return Summary::Observed;
    }
    Summary::Partial
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{B_ONE, OBS_AUTHORITY, OBS_INFERRED, SOURCE_A, SOURCE_B};
    use crate::dynamics::facet::{facets_of, tests::assertion_facet, tests::base};
    use crate::ledger::schema::{DimensionAssessment, Dimensions};

    fn dimension(state: DimensionState, as_of: &str) -> DimensionAssessment {
        DimensionAssessment {
            state,
            basis_event_ids: vec![],
            as_of: as_of.into(),
        }
    }

    fn all(state: DimensionState) -> Dimensions {
        Dimensions {
            source_connected: dimension(state, "2026-08-01T00:00:00Z"),
            source_healthy: dimension(state, "2026-08-01T00:00:00Z"),
            scope_known: dimension(state, "2026-08-01T00:00:00Z"),
            scope_accessible: dimension(state, "2026-08-01T00:00:00Z"),
            retention_known: dimension(state, "2026-08-01T00:00:00Z"),
            index_current: dimension(state, "2026-08-01T00:00:00Z"),
            retrieval_attempted: dimension(state, "2026-08-01T00:00:00Z"),
        }
    }

    fn assessed(state: &mut EpistemicState, id: &str, source: &str, dimensions: Dimensions) {
        state.coverage_assessments.insert(
            id.into(),
            CoverageAssessment {
                assessment_id: id.into(),
                subject_id: Some(crate::assembly::fixture::FALCON.into()),
                predicate_class: None,
                scope: crate::ledger::schema::Scope::empty(),
                source_id: source.into(),
                dimensions,
                retrieval_receipt: None,
                superseded: false,
            },
        );
    }

    /// The fixture's one belief, its one facet, both supports indexed.
    fn facet_base() -> EpistemicState {
        let mut state = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state.assertion_facets.insert(
                event.into(),
                assertion_facet("ci_status", None, "2026-08-01T00:00:00Z"),
            );
        }
        // The two supports come from two different sources.
        state.observations.get_mut(OBS_INFERRED).unwrap().source_id = SOURCE_B.into();
        state
    }

    fn only_facet(state: &EpistemicState) -> Facet {
        facets_of(state, state.beliefs.get(B_ONE).unwrap()).remove(0)
    }

    #[test]
    fn the_shipped_artifact_loads_and_its_digest_is_over_the_bytes_that_ship() {
        let fold = load().expect("the shipped fold");
        assert_eq!(fold.fold_rule_version, "coverage-fold-v1");
        assert_eq!(
            sha256_hex(FOLD_JSON.as_bytes()),
            FOLD_DIGEST.trim(),
            "regenerate shared/policy/coverage-fold.v1.sha256"
        );
    }

    #[test]
    fn nobody_having_looked_is_blind_and_says_so_in_its_own_variant() {
        // §90: "nobody assessed this" and "we looked and saw nothing" must
        // not render alike, which is why this is a separate variant rather
        // than an `assessed` one with an empty map.
        let state = facet_base();
        let coverage = coverage_of(&state, &load().unwrap(), &only_facet(&state), None);
        assert_eq!(coverage.summary(), Summary::Blind);
        assert!(matches!(coverage, Coverage::NoAssessments { .. }));
        assert_eq!(coverage.describe(), "coverage unassessed");
    }

    #[test]
    fn every_dimension_yes_is_observed() {
        let mut state = facet_base();
        assessed(&mut state, "a1", SOURCE_A, all(DimensionState::Yes));
        assessed(&mut state, "a2", SOURCE_B, all(DimensionState::Yes));
        let coverage = coverage_of(&state, &load().unwrap(), &only_facet(&state), None);
        assert_eq!(coverage.summary(), Summary::Observed);
        assert_eq!(coverage.assessment_ids(), ["a1", "a2"]);
    }

    #[test]
    fn one_hard_no_from_one_source_makes_the_whole_thing_blind() {
        // The collapse §46 forbids, as an assertion: a `yes` from the source
        // that worked must not hide the `no` from the one that did not.
        let mut state = facet_base();
        assessed(&mut state, "a1", SOURCE_A, all(DimensionState::Yes));
        let mut broken = all(DimensionState::Yes);
        broken.scope_accessible = dimension(DimensionState::No, "2026-08-02T00:00:00Z");
        assessed(&mut state, "a2", SOURCE_B, broken);
        let coverage = coverage_of(&state, &load().unwrap(), &only_facet(&state), None);
        assert_eq!(coverage.summary(), Summary::Blind);
        assert_eq!(coverage.describe(), "blind coverage");
    }

    #[test]
    fn a_soft_no_is_partial_rather_than_blind() {
        // `scope_known` and `retention_known` are completeness questions, not
        // reachability ones. Not knowing the retention policy of a source you
        // can read is a gap, not a blindness.
        let fold = load().unwrap();
        for dimension in [Dimension::ScopeKnown, Dimension::RetentionKnown] {
            assert!(!fold.is_hard(dimension), "{dimension:?} is not hard");
        }
        let mut state = facet_base();
        let mut soft = all(DimensionState::Yes);
        soft.retention_known = dimension(DimensionState::No, "2026-08-02T00:00:00Z");
        assessed(&mut state, "a1", SOURCE_A, soft);
        assessed(&mut state, "a2", SOURCE_B, all(DimensionState::Yes));
        assert_eq!(
            coverage_of(&state, &fold, &only_facet(&state), None).summary(),
            Summary::Partial
        );
    }

    #[test]
    fn an_unknown_anywhere_is_partial() {
        let mut state = facet_base();
        let mut vague = all(DimensionState::Yes);
        vague.index_current = dimension(DimensionState::Unknown, "2026-08-02T00:00:00Z");
        assessed(&mut state, "a1", SOURCE_A, vague);
        assessed(&mut state, "a2", SOURCE_B, all(DimensionState::Yes));
        assert_eq!(
            coverage_of(&state, &load().unwrap(), &only_facet(&state), None).summary(),
            Summary::Partial
        );
    }

    #[test]
    fn one_not_applicable_is_ignored_and_all_of_them_are_not() {
        let fold = load().unwrap();
        assert_eq!(
            fold_states(&fold, &[DimensionState::NotApplicable, DimensionState::Yes]),
            DimensionState::Yes,
            "a source with no retention policy must not drag the dimension to unknown"
        );
        assert_eq!(
            fold_states(
                &fold,
                &[DimensionState::NotApplicable, DimensionState::NotApplicable]
            ),
            DimensionState::NotApplicable
        );
        assert_eq!(
            fold_states(&fold, &[DimensionState::NotApplicable, DimensionState::No]),
            DimensionState::No
        );
    }

    #[test]
    fn all_not_applicable_still_summarizes_observed() {
        let mut state = facet_base();
        assessed(
            &mut state,
            "a1",
            SOURCE_A,
            all(DimensionState::NotApplicable),
        );
        assessed(
            &mut state,
            "a2",
            SOURCE_B,
            all(DimensionState::NotApplicable),
        );
        assert_eq!(
            coverage_of(&state, &load().unwrap(), &only_facet(&state), None).summary(),
            Summary::Observed
        );
    }

    #[test]
    fn the_precedence_is_exhaustive_over_every_pair() {
        // The boundary table the acceptance matrix asks for, as arithmetic.
        let fold = load().unwrap();
        use DimensionState::*;
        for (a, b, expected) in [
            (No, Yes, No),
            (Yes, No, No),
            (No, Unknown, No),
            (Unknown, Yes, Unknown),
            (Yes, Yes, Yes),
            (Unknown, Unknown, Unknown),
            (No, No, No),
            (NotApplicable, Unknown, Unknown),
        ] {
            assert_eq!(fold_states(&fold, &[a, b]), expected, "{a:?} + {b:?}");
        }
    }

    #[test]
    fn the_boundary_table_is_exhaustive_over_dimension_and_state() {
        // The acceptance matrix's "Coverage boundary table" row, as all 28
        // cases rather than a sample: every dimension, every state, with the
        // other six affirmative. A hard `no` is blind; a soft `no` and every
        // `unknown` are partial; `yes` and N/A are observed.
        let fold = load().unwrap();
        for dimension in Dimension::ALL {
            for state in [
                DimensionState::Yes,
                DimensionState::No,
                DimensionState::Unknown,
                DimensionState::NotApplicable,
            ] {
                let mut folded: Vec<(Dimension, DimensionState)> = Dimension::ALL
                    .iter()
                    .map(|d| (*d, DimensionState::Yes))
                    .collect();
                for entry in folded.iter_mut() {
                    if entry.0 == dimension {
                        entry.1 = state;
                    }
                }
                let expected = match state {
                    DimensionState::Yes | DimensionState::NotApplicable => Summary::Observed,
                    DimensionState::Unknown => Summary::Partial,
                    DimensionState::No if fold.is_hard(dimension) => Summary::Blind,
                    DimensionState::No => Summary::Partial,
                };
                assert_eq!(
                    summarize(&fold, &folded),
                    expected,
                    "{} = {state:?}",
                    dimension.as_str()
                );
            }
        }
    }

    #[test]
    fn the_five_hard_dimensions_are_the_designs_five() {
        // Reachability, not completeness: a source you cannot connect to,
        // whose health is bad, whose scope you cannot access, whose index is
        // out of date, or that nobody attempted to read. `scope_known` and
        // `retention_known` are about knowing how much is there, which is a
        // gap rather than a blindness.
        let fold = load().unwrap();
        let hard: Vec<&str> = Dimension::ALL
            .iter()
            .filter(|d| fold.is_hard(**d))
            .map(|d| d.as_str())
            .collect();
        assert_eq!(
            hard,
            [
                "source_connected",
                "source_healthy",
                "scope_accessible",
                "index_current",
                "retrieval_attempted"
            ]
        );
    }

    #[test]
    fn every_folded_dimension_keeps_the_rows_that_made_it() {
        // §46 again: a summary is a projection, and the source-specific
        // evidence behind it survives.
        let mut state = facet_base();
        let mut early = all(DimensionState::Yes);
        early.source_healthy = dimension(DimensionState::No, "2026-08-01T00:00:00Z");
        assessed(&mut state, "a1", SOURCE_A, early);
        let mut late = all(DimensionState::Yes);
        late.source_healthy = dimension(DimensionState::Yes, "2026-08-09T00:00:00Z");
        assessed(&mut state, "a2", SOURCE_B, late);

        let coverage = coverage_of(&state, &load().unwrap(), &only_facet(&state), None);
        let Coverage::Assessed { dimensions, .. } = &coverage else {
            panic!("assessed");
        };
        let health = &dimensions["source_healthy"];
        assert_eq!(health.state, "no");
        assert_eq!(health.inputs.len(), 2);
        assert_eq!(health.inputs[0].as_of, "2026-08-01T00:00:00Z");
        assert_eq!(health.inputs[1].as_of, "2026-08-09T00:00:00Z");
        assert_ne!(
            health.inputs[0].as_of, health.inputs[1].as_of,
            "no global timestamp — two sources assessed a week apart share no moment"
        );
    }

    #[test]
    fn an_assessment_about_another_subject_covers_nothing_here() {
        let mut state = facet_base();
        assessed(&mut state, "a1", SOURCE_A, all(DimensionState::Yes));
        state.coverage_assessments.get_mut("a1").unwrap().subject_id = Some("d".repeat(32));
        assert!(matches!(
            coverage_of(&state, &load().unwrap(), &only_facet(&state), None),
            Coverage::NoAssessments { .. }
        ));
    }

    /// THE defect this argument exists to close (M27.10).
    ///
    /// `best` was keyed by `source_id` alone while the reducer keys
    /// `coverage_current` by `(source, subject, predicate_class)`. One source
    /// assessing two classes about one subject therefore overwrote itself,
    /// and whichever class sorted last decided the facet's Coverage — so a
    /// facet about `ci_status` could read `observed` on the strength of
    /// somebody having looked at a shipping BOM. Saying "we looked" when the
    /// looking was at something else is the worst direction to be wrong in.
    #[test]
    fn an_assessment_scoped_to_another_predicate_class_covers_nothing_here() {
        let mut state = facet_base();
        // Blind about this facet's class, observed about another. One source,
        // one subject, two classes.
        assessed(&mut state, "a1", SOURCE_A, all(DimensionState::No));
        state
            .coverage_assessments
            .get_mut("a1")
            .unwrap()
            .predicate_class = Some("ci_status".into());
        assessed(&mut state, "a2", SOURCE_A, all(DimensionState::Yes));
        state
            .coverage_assessments
            .get_mut("a2")
            .unwrap()
            .predicate_class = Some("shipping_bom".into());
        state.coverage_current.insert(
            (
                SOURCE_A.into(),
                crate::assembly::fixture::FALCON.into(),
                "ci_status".into(),
            ),
            "a1".into(),
        );
        state.coverage_current.insert(
            (
                SOURCE_A.into(),
                crate::assembly::fixture::FALCON.into(),
                "shipping_bom".into(),
            ),
            "a2".into(),
        );

        let coverage = coverage_of(
            &state,
            &load().unwrap(),
            &only_facet(&state),
            Some("ci_status"),
        );
        assert_eq!(coverage.summary(), Summary::Blind);
        assert_eq!(
            coverage.assessment_ids(),
            ["a1"],
            "the BOM assessment answered a question this facet did not ask"
        );

        // And a facet whose class cannot be resolved reads neither of them:
        // a class-scoped answer is not a source-wide one.
        assert!(matches!(
            coverage_of(&state, &load().unwrap(), &only_facet(&state), None),
            Coverage::NoAssessments { .. }
        ));
    }

    /// A source-wide assessment still speaks for every class, which is what
    /// keeps the fix above from turning well-assessed facets blind.
    #[test]
    fn an_assessment_with_no_class_speaks_for_whatever_the_facet_is_about() {
        let mut state = facet_base();
        assessed(&mut state, "a1", SOURCE_A, all(DimensionState::Yes));
        for class in [None, Some("ci_status"), Some("anything_at_all")] {
            let coverage = coverage_of(&state, &load().unwrap(), &only_facet(&state), class);
            assert_eq!(coverage.assessment_ids(), ["a1"], "class {class:?}");
        }
    }

    #[test]
    fn a_superseded_assessment_does_not_speak() {
        let mut state = facet_base();
        assessed(&mut state, "a1", SOURCE_A, all(DimensionState::Yes));
        state.coverage_assessments.get_mut("a1").unwrap().superseded = true;
        assert!(matches!(
            coverage_of(&state, &load().unwrap(), &only_facet(&state), None),
            Coverage::NoAssessments { .. }
        ));
    }

    #[test]
    fn an_assessment_of_a_source_this_facet_never_used_covers_nothing() {
        let mut state = facet_base();
        assessed(
            &mut state,
            "a1",
            crate::assembly::fixture::SOURCE_C,
            all(DimensionState::Yes),
        );
        assert!(matches!(
            coverage_of(&state, &load().unwrap(), &only_facet(&state), None),
            Coverage::NoAssessments { .. }
        ));
    }

    /// Regenerate `shared/policy/coverage-fold.v1.sha256` after a DELIBERATE
    /// edit. Ignored, like every other digest here.
    #[test]
    #[ignore = "regeneration is a deliberate act — run with --ignored after editing the artifact"]
    fn write_coverage_fold_digest() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/policy/coverage-fold.v1.sha256");
        std::fs::write(&path, format!("{}\n", sha256_hex(FOLD_JSON.as_bytes()))).unwrap();
    }
}
