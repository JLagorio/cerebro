//! Retrospective lineage hygiene (M27.2d) — §78 and §80.
//!
//! **M26's check is preventive; this one is archaeological.** `policy::ancestry`
//! refuses a self-supporting basis at proposal apply, which protects
//! everything written since it landed and nothing written before. A base that
//! was migrated from an Obsidian vault, or built during M22–M25, or edited by
//! a person through a path that never went near a proposal, can hold exactly
//! the loops that gate exists to stop. This finds them and says so; it never
//! deletes anything.
//!
//! **Three findings, all deterministic** (§78/§80):
//!
//! - **circular support** — a belief supported through a cycle in its own
//!   lineage. The same reachability question `policy::ancestry` asks, asked of
//!   what is already committed instead of what is proposed.
//! - **duplicated lineage family** — one family contributing more than one
//!   support to a single facet. That is not a defect on its own, and the
//!   finding does not call it one: it is what the collapse in
//!   [`super::support`] is FOR, and the reason to surface it is that a person
//!   reading "three sources" should be able to see that two of them were the
//!   same message twice.
//! - **descendant-only reinforcement** — a belief whose entire support traces
//!   back to its own descendants. Strictly worse than a single cycle: nothing
//!   outside the belief's own output holds it up.
//!
//! **Never an LLM judgement, and never a clock read.** A finding is a graph
//! fact about committed state; asking a model whether reasoning "looks
//! circular" would make the answer depend on which model ran, and asking the
//! clock would make it depend on when.
//!
//! **These feed the debt lane (M27.6), not a refusal.** History cannot be
//! un-written, and a base that refused to load because it once read its own
//! handwriting back would be useless. The honest response is to show the
//! person what rests on what.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{BasisRole, BeliefBasis};

use super::facet::all_facets;
use super::support::families_of;

/// What kind of hygiene problem this is. Closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    CircularSupport,
    DuplicatedLineageFamily,
    DescendantOnlyReinforcement,
}

impl FindingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FindingKind::CircularSupport => "circular_support",
            FindingKind::DuplicatedLineageFamily => "duplicated_lineage_family",
            FindingKind::DescendantOnlyReinforcement => "descendant_only_reinforcement",
        }
    }

    pub const ALL: [FindingKind; 3] = [
        FindingKind::CircularSupport,
        FindingKind::DuplicatedLineageFamily,
        FindingKind::DescendantOnlyReinforcement,
    ];
}

/// One finding. Every field is a pinned id, so a surface can show the walk
/// rather than assert a conclusion.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
pub struct Finding {
    pub kind: FindingKind,
    pub belief_id: String,
    pub belief_revision_event_id: String,
    /// The supports implicated. Sorted, duplicate-free.
    pub assertion_event_ids: Vec<String>,
    /// The revision of THIS belief that the support traces back to, when
    /// there is one — the evidence that the loop is real.
    pub reached_revision_event_id: Option<String>,
}

/// The rules version, so a stored finding can be read against the walk that
/// produced it.
pub const HYGIENE_VERSION: &str = "lineage-hygiene-v1";

/// Every support link of a revision, `supports` role only — the same
/// admissibility the axes use.
fn supports(basis: &BeliefBasis) -> Vec<String> {
    match basis {
        BeliefBasis::Unsupported { .. } => Vec::new(),
        BeliefBasis::Linked { links } => links
            .iter()
            .filter(|link| link.role == BasisRole::Supports)
            .map(|link| link.observation_event_id.clone())
            .collect(),
    }
}

/// Does this Observation trace back to any revision of `belief_id`?
///
/// The three hops `policy::ancestry` walks, over committed state: Observation
/// lineage, `derived_from` belief revisions, and everything a reached revision
/// itself cited. Cycle-safe by a visited set rather than a depth limit — a
/// depth limit silently passes a loop one hop longer than the number somebody
/// picked.
fn reaches_belief(state: &EpistemicState, observation: &str, belief_id: &str) -> Option<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: std::collections::VecDeque<String> =
        std::collections::VecDeque::from([observation.to_string()]);

    while let Some(current) = queue.pop_front() {
        if !seen.insert(current.clone()) {
            continue;
        }
        for (source_observation, revision_event) in &state.derived_belief_sources {
            if source_observation != &current {
                continue;
            }
            if let Some((reached_belief, _)) = state.belief_revision_events.get(revision_event) {
                if reached_belief == belief_id {
                    return Some(revision_event.clone());
                }
                if let Some(belief) = state.beliefs.get(reached_belief) {
                    for revision in &belief.revisions {
                        if &revision.event_id != revision_event {
                            continue;
                        }
                        for id in supports(&revision.basis) {
                            queue.push_back(id);
                        }
                    }
                }
            }
        }
        if let Some(row) = state.observations.get(&current) {
            for (_, parent) in &row.lineage_parents {
                queue.push_back(parent.clone());
            }
        }
    }
    None
}

/// Every hygiene finding over the whole base, in a stable order.
pub fn scan(state: &EpistemicState) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();

    for facet in all_facets(state) {
        let belief_id = facet.key.belief_id.clone();
        let revision = facet.key.belief_revision_event_id.clone();

        // §78, second half: one family contributing more than one support.
        // Reported per family so a surface can name the copies.
        for family in families_of(state, &facet) {
            if family.members.len() > 1 {
                out.push(Finding {
                    kind: FindingKind::DuplicatedLineageFamily,
                    belief_id: belief_id.clone(),
                    belief_revision_event_id: revision.clone(),
                    assertion_event_ids: family.members.clone(),
                    reached_revision_event_id: None,
                });
            }
        }

        if facet.supports.is_empty() {
            continue;
        }

        // §78, first half, and §80. Both are the same reachability question
        // asked with different quantifiers — ANY support that loops is
        // circular; EVERY support that loops is descendant-only, and the
        // second is strictly worse because nothing outside the belief's own
        // output holds it up.
        let mut looping: Vec<String> = Vec::new();
        let mut reached: Option<String> = None;
        for support in &facet.supports {
            if let Some(revision_event) = reaches_belief(state, support, &belief_id) {
                looping.push(support.clone());
                reached.get_or_insert(revision_event);
            }
        }
        if looping.is_empty() {
            continue;
        }
        let kind = if looping.len() == facet.supports.len() {
            FindingKind::DescendantOnlyReinforcement
        } else {
            FindingKind::CircularSupport
        };
        out.push(Finding {
            kind,
            belief_id,
            belief_revision_event_id: revision,
            assertion_event_ids: looping,
            reached_revision_event_id: reached,
        });
    }

    out.sort();
    out.dedup();
    out
}

/// Findings grouped by belief, for a lane that lists beliefs rather than
/// findings.
pub fn by_belief(findings: &[Finding]) -> BTreeMap<String, Vec<&Finding>> {
    let mut out: BTreeMap<String, Vec<&Finding>> = BTreeMap::new();
    for finding in findings {
        out.entry(finding.belief_id.clone())
            .or_default()
            .push(finding);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{
        belief, linked, observation, revision, unsupported, B_ONE, B_TWO, FALCON, OBS_AUTHORITY,
        OBS_INFERRED, OBS_PLANNED, REV_ONE, REV_TWO, SOURCE_A, SOURCE_B,
    };
    use crate::dynamics::facet::tests::assertion_facet;
    use crate::ledger::schema::{AuthorityProvenance, LineageKind};

    /// One belief on two supports from two sources; one belief on nothing.
    fn base() -> EpistemicState {
        let mut state = EpistemicState::default();
        state.beliefs.insert(
            B_ONE.into(),
            belief(
                B_ONE,
                FALCON,
                vec![revision(
                    1,
                    REV_ONE,
                    "on track",
                    linked(&[OBS_AUTHORITY, OBS_INFERRED]),
                )],
            ),
        );
        state.beliefs.insert(
            B_TWO.into(),
            belief(
                B_TWO,
                FALCON,
                vec![revision(1, REV_TWO, "slipped", unsupported())],
            ),
        );
        for (event, source) in [(OBS_AUTHORITY, SOURCE_A), (OBS_INFERRED, SOURCE_B)] {
            state.observations.insert(
                event.into(),
                observation(
                    event,
                    FALCON,
                    source,
                    AuthorityProvenance::RegisteredDirectArtifact,
                ),
            );
            state.assertion_facets.insert(
                event.into(),
                assertion_facet("ci_status", None, "2026-08-01T00:00:00Z"),
            );
        }
        state
            .belief_revision_events
            .insert(REV_ONE.into(), (B_ONE.into(), 1));
        state
            .belief_revision_events
            .insert(REV_TWO.into(), (B_TWO.into(), 1));
        state
    }

    fn kinds(state: &EpistemicState) -> Vec<&'static str> {
        scan(state).iter().map(|f| f.kind.as_str()).collect()
    }

    #[test]
    fn a_clean_base_reports_nothing() {
        assert!(scan(&base()).is_empty());
    }

    #[test]
    fn one_support_derived_from_the_belief_it_supports_is_circular() {
        // The §78 shape: the base read its own handwriting back, once.
        let mut state = base();
        state
            .derived_belief_sources
            .push((OBS_AUTHORITY.into(), REV_ONE.into()));
        let findings = scan(&state);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::CircularSupport);
        assert_eq!(findings[0].belief_id, B_ONE);
        assert_eq!(findings[0].assertion_event_ids, vec![OBS_AUTHORITY]);
        assert_eq!(
            findings[0].reached_revision_event_id.as_deref(),
            Some(REV_ONE),
            "a finding shows the walk rather than asserting a conclusion"
        );
    }

    #[test]
    fn every_support_looping_is_descendant_only_and_that_is_the_worse_finding() {
        // §80: nothing outside the belief's own output holds it up.
        let mut state = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state
                .derived_belief_sources
                .push((event.into(), REV_ONE.into()));
        }
        let findings = scan(&state);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::DescendantOnlyReinforcement);
        assert_eq!(
            findings[0].assertion_event_ids,
            vec![OBS_AUTHORITY, OBS_INFERRED]
        );
    }

    #[test]
    fn the_loop_is_found_through_lineage_as_well_as_directly() {
        // Hop 1 plus hop 2: the support is a copy of something derived from
        // this belief. A depth-limited walk of the wrong depth would miss it.
        let mut state = base();
        let derived = "20000000000000000000000000000009";
        state.observations.insert(
            derived.into(),
            observation(
                derived,
                FALCON,
                SOURCE_A,
                AuthorityProvenance::RegisteredDirectArtifact,
            ),
        );
        state
            .derived_belief_sources
            .push((derived.into(), REV_ONE.into()));
        state
            .observations
            .get_mut(OBS_AUTHORITY)
            .unwrap()
            .lineage_parents
            .push((LineageKind::SummarizedFrom, derived.into()));
        assert_eq!(kinds(&state), vec!["circular_support"]);
    }

    #[test]
    fn a_support_derived_from_another_belief_entirely_is_not_a_loop() {
        // The control. Building on somebody else's conclusion is how a base
        // is supposed to work.
        let mut state = base();
        state
            .derived_belief_sources
            .push((OBS_AUTHORITY.into(), REV_TWO.into()));
        assert!(scan(&state).is_empty());
    }

    #[test]
    fn two_supports_in_one_family_are_reported_as_a_duplicated_family() {
        // Not a defect on its own — it is what the collapse is FOR — and the
        // reason to surface it is that "two sources" should not read as two
        // pieces of evidence when it was one message twice.
        let mut state = base();
        state.observations.get_mut(OBS_INFERRED).unwrap().source_id = SOURCE_A.into();
        let findings = scan(&state);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::DuplicatedLineageFamily);
        assert_eq!(
            findings[0].assertion_event_ids,
            vec![OBS_AUTHORITY, OBS_INFERRED]
        );
    }

    #[test]
    fn identical_content_on_two_sources_is_not_a_duplicated_family() {
        // Corroboration survives the hygiene pass, exactly as it survives the
        // collapse.
        assert!(scan(&base()).is_empty());
    }

    #[test]
    fn an_unsupported_revision_has_nothing_to_be_circular_about() {
        let state = base();
        assert!(scan(&state)
            .iter()
            .all(|finding| finding.belief_id != B_TWO));
    }

    #[test]
    fn a_cycle_in_the_lineage_itself_terminates() {
        // Cycle-safe by a visited set. Without one this hangs rather than
        // failing, which is why the test exists at all.
        let mut state = base();
        state
            .observations
            .get_mut(OBS_AUTHORITY)
            .unwrap()
            .lineage_parents
            .push((LineageKind::CopiedFrom, OBS_INFERRED.into()));
        state
            .observations
            .get_mut(OBS_INFERRED)
            .unwrap()
            .lineage_parents
            .push((LineageKind::CopiedFrom, OBS_AUTHORITY.into()));
        let findings = scan(&state);
        // They are one family now (shared ancestry), so the duplication
        // finding fires and the walk terminated, which is the point.
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, FindingKind::DuplicatedLineageFamily);
    }

    #[test]
    fn a_tombstoned_belief_is_not_scanned() {
        let mut state = base();
        state
            .derived_belief_sources
            .push((OBS_AUTHORITY.into(), REV_ONE.into()));
        state
            .beliefs
            .get_mut(B_ONE)
            .unwrap()
            .tombstoned_by
            .replace("90000000000000000000000000000009".into());
        assert!(scan(&state).is_empty());
    }

    #[test]
    fn the_same_base_scans_identically() {
        let mut state = base();
        state
            .derived_belief_sources
            .push((OBS_AUTHORITY.into(), REV_ONE.into()));
        assert_eq!(scan(&state), scan(&state));
    }

    #[test]
    fn findings_group_by_belief_for_a_lane_that_lists_beliefs() {
        let mut state = base();
        state.beliefs.insert(
            B_TWO.into(),
            belief(
                B_TWO,
                FALCON,
                vec![revision(1, REV_TWO, "slipped", linked(&[OBS_PLANNED]))],
            ),
        );
        state.observations.insert(
            OBS_PLANNED.into(),
            observation(
                OBS_PLANNED,
                FALCON,
                SOURCE_A,
                AuthorityProvenance::RegisteredDirectArtifact,
            ),
        );
        state
            .derived_belief_sources
            .push((OBS_AUTHORITY.into(), REV_ONE.into()));
        state
            .derived_belief_sources
            .push((OBS_PLANNED.into(), REV_TWO.into()));
        let findings = scan(&state);
        let grouped = by_belief(&findings);
        assert_eq!(grouped.len(), 2);
        assert!(grouped.contains_key(B_ONE) && grouped.contains_key(B_TWO));
    }

    #[test]
    fn nothing_here_reads_a_clock_or_asks_a_model() {
        // A finding is a graph fact about committed state. A clock would make
        // it depend on when it was asked, and a model on which one ran.
        let source = include_str!("hygiene.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half")
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["Utc::now", "SystemTime::now", "prompt", "model_id"] {
            assert!(!body.contains(forbidden), "{forbidden} appears in the walk");
        }
    }

    #[test]
    fn every_finding_kind_is_reachable() {
        let mut reached: BTreeSet<FindingKind> = BTreeSet::new();
        let mut circular = base();
        circular
            .derived_belief_sources
            .push((OBS_AUTHORITY.into(), REV_ONE.into()));
        reached.extend(scan(&circular).iter().map(|f| f.kind));

        let mut descendant = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            descendant
                .derived_belief_sources
                .push((event.into(), REV_ONE.into()));
        }
        reached.extend(scan(&descendant).iter().map(|f| f.kind));

        let mut duplicated = base();
        duplicated
            .observations
            .get_mut(OBS_INFERRED)
            .unwrap()
            .source_id = SOURCE_A.into();
        reached.extend(scan(&duplicated).iter().map(|f| f.kind));

        assert_eq!(reached.len(), FindingKind::ALL.len());
    }
}
