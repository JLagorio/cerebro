//! Convergence synthesis (M26.8a) — believed-then against believed-now.
//!
//! **A window is two sequence numbers, never two times.** The ledger's own
//! order is the only order this milestone trusts (D3), and a convergence run
//! bounded by wall-clock would be asking a question whose answer changes with
//! the clock. Nothing in this module reads one.
//!
//! **The two M27-gated sections are live as of M27.5d.** They shipped as a
//! typed "not yet available" precisely so that turning them on would be a
//! change of VALUE rather than a change of shape — an output that had omitted
//! them would have read identically to one whose base had no certainty
//! changes, and those are opposite findings.
//!
//! **Certainty shift is Support only, and that is a deliberate cut.** D9's
//! third axis is Validity, whose freshness half needs an explicit instant
//! this module refuses to take — see the discipline test below. Its other two halves
//! already have rows here: a contest opening or closing is a
//! [`ChangeKind`], and so is a lifecycle change. What was missing was the
//! ground under a claim moving, and that is what this reports.
//!
//! **Staleness here is movement, not a verdict.** Whether a belief is stale
//! depends on freshness rules that are M27's shared artifact
//! (`freshness.v1.json`), so what M26 can honestly report is that the
//! evidence behind a belief got newer, or that a belief gained or lost its
//! support entirely. A threshold crossing is deliberately not computed —
//! inventing a threshold here would put D9's rules in the wrong module and
//! then have to be unwound.
//!
//! **This produces no epistemic event and has no identity across runs.** A
//! convergence output is a reading of the ledger, not a claim about the
//! world; §31's earned-persistence trigger stands, and deleting a stored
//! output causes recomputation and nothing else.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::ledger::frame::Frame;
use crate::ledger::reduce::{reduce, BeliefState, EpistemicState};
use crate::ledger::sha256_hex;
use crate::policy::authority::AuthorityRoutesV1;

/// The output shape's version, so a stored row can be read against the rules
/// that produced it.
pub const SCHEMA_VERSION: &str = "convergence-v1";

/// The half-open window a run covers: what the base believed at `from_seq`
/// against what it believes at `to_seq`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Window {
    pub from_seq: u64,
    pub to_seq: u64,
}

/// What moved about one belief. Several can be true at once, which is why a
/// belief gets one row carrying all of them rather than one row each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Created,
    Revised,
    Tombstoned,
    QualificationChanged,
    LifecycleChanged,
    ContestOpened,
    ContestClosed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MaterialChange {
    pub belief_id: String,
    pub entity_id: String,
    /// Sorted and duplicate-free.
    pub kinds: Vec<ChangeKind>,
    /// The revision that was current then, and the one that is current now.
    /// Equal when nothing about the content moved — a governance-only change.
    pub revision_then: Option<String>,
    pub revision_now: Option<String>,
}

/// What the base can and cannot see that it could not or could before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Blindness {
    /// Every assessment naming this subject was superseded and none replaced
    /// it. §90's distinction, arriving as news: "all known sources
    /// considered" is not "all sources known".
    SubjectBecameBlind { entity_id: String },
    SubjectNoLongerBlind {
        entity_id: String,
        assessments_now: u32,
    },
    GapOpened {
        gap_id: String,
        source_id: Option<String>,
    },
    GapClosed {
        gap_id: String,
        source_id: Option<String>,
    },
}

/// Movement in the evidence behind a belief. Never a verdict — see the module
/// note on why a threshold crossing is M27's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Staleness {
    EvidenceRefreshed {
        belief_id: String,
        from: String,
        to: String,
    },
    BecameSupported {
        belief_id: String,
        newest_evidence_at: String,
    },
    LostSupport {
        belief_id: String,
    },
}

/// A change in what rests under one belief facet (M27.5d).
///
/// **Keyed by scope, not by facet key.** A facet key pins a REVISION, so a
/// belief that was revised inside the window has an entirely different key at
/// each end and every facet would read as new. What a person is asking is
/// "did the ground under this claim move", and the claim is
/// `(belief, predicate, stage)` — the same scope on both sides of the window.
///
/// `from` is `None` when this scope had no facet then: the belief is new, or
/// it grew a claim about a predicate it did not make before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CertaintyShift {
    pub belief_id: String,
    /// `None` when the supporting assertions recorded no predicate — the
    /// `unknown/unknown` facet, which is a row and not an absence.
    pub predicate: Option<String>,
    pub state_stage: String,
    pub from: Option<String>,
    pub to: String,
}

/// A contradiction edge that opened inside the window (M27.5d).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Contestation {
    pub edge_id: String,
    pub left_belief_id: String,
    pub right_belief_id: String,
    /// `genuine_direct`, `partial` or `conditional` — the three unresolved
    /// classes. The other five outcomes resolve the pair apart and open
    /// nothing, which is the whole point of the gauntlet.
    pub kind: &'static str,
    /// Every reason the classification named, in its own order.
    pub reason_codes: Vec<String>,
    /// `deterministic` or `agent_supplied`. A semantic verdict a model
    /// proposed must never read as a reducer fact, so the word travels.
    pub classified_by: &'static str,
}

/// One convergence run's whole answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Output {
    pub schema_version: &'static str,
    pub window: Window,
    pub material_changes: Vec<MaterialChange>,
    pub blindness: Vec<Blindness>,
    pub staleness: Vec<Staleness>,
    pub certainty_shift: Vec<CertaintyShift>,
    pub new_contestation: Vec<Contestation>,
}

impl Output {
    /// Did anything at all move? A run over a quiet window is a real answer
    /// and worth storing; a caller that wants to skip rendering one asks
    /// here rather than counting sections itself.
    pub fn quiet(&self) -> bool {
        self.material_changes.is_empty()
            && self.blindness.is_empty()
            && self.staleness.is_empty()
            // M27.5d: a window whose only news is a contradiction opening, or
            // the ground under a claim moving, is not a quiet window. While
            // these two were gated they could not make it loud; now they can.
            && self.certainty_shift.is_empty()
            && self.new_contestation.is_empty()
    }

    /// SHA-256 over canonical JSON. Two runs over the same window produce the
    /// same bytes, which is what lets a stored row be recognized as a repeat
    /// rather than stored twice.
    pub fn content_hash(&self) -> Result<String, String> {
        let canonical = serde_json::to_string(self).map_err(|e| e.to_string())?;
        Ok(sha256_hex(canonical.as_bytes()))
    }
}

/// Fold the same store twice: once through `from_seq`, once through
/// `to_seq`.
///
/// Two full folds rather than an incremental diff, and deliberately so. The
/// reducer is the only thing that knows what an event MEANS, and a convergence
/// run that reimplemented "what does this event change" would be a second
/// reducer — the exact twin implementation this codebase refuses everywhere
/// else. It is a read of a file that is already on disk.
pub fn states(
    frames: &[Frame],
    store_uuid: &str,
    window: Window,
) -> Result<(EpistemicState, EpistemicState), String> {
    if window.from_seq > window.to_seq {
        return Err(format!(
            "a window from {} to {} runs backwards",
            window.from_seq, window.to_seq
        ));
    }
    let take = |limit: u64| -> Vec<Frame> {
        frames
            .iter()
            .filter(|frame| frame.seq <= limit)
            .cloned()
            .collect()
    };
    Ok((
        reduce(&take(window.from_seq), store_uuid),
        reduce(&take(window.to_seq), store_uuid),
    ))
}

/// Compute what changed between two folds of one store.
///
/// `routes` arrives as an argument rather than being loaded here so this stays
/// a pure function of two states: the authority artifacts are versioned data,
/// and a function that read them off disk mid-diff could answer differently
/// about the same two folds.
pub fn compute(
    then: &EpistemicState,
    now: &EpistemicState,
    window: Window,
    routes: &[AuthorityRoutesV1],
) -> Output {
    Output {
        schema_version: SCHEMA_VERSION,
        window,
        material_changes: material_changes(then, now),
        blindness: blindness(then, now),
        staleness: staleness(then, now),
        certainty_shift: certainty_shift(then, now, routes),
        new_contestation: new_contestation(then, now),
    }
}

/// Support levels by scope, for every live belief.
///
/// Clock-free by construction: Support asks what rests underneath, and
/// nothing in that question needs a time. Coverage and freshness are
/// deliberately absent from this section — freshness needs an instant this
/// module refuses to take, and the module's discipline test enforces that.
fn support_levels(
    state: &EpistemicState,
    routes: &[AuthorityRoutesV1],
) -> BTreeMap<(String, Option<String>, &'static str), String> {
    let mut out = BTreeMap::new();
    for belief in state.beliefs.values() {
        if belief.tombstoned_by.is_some() {
            continue;
        }
        for facet in crate::dynamics::facet::facets_of(state, belief) {
            let scope = (
                belief.belief_id.clone(),
                facet.key.predicate.value().map(str::to_string),
                facet.key.state_stage.as_str(),
            );
            let derived = crate::dynamics::support::support_of(state, routes, &facet);
            out.insert(scope, derived.support.level().to_string());
        }
    }
    out
}

fn certainty_shift(
    then: &EpistemicState,
    now: &EpistemicState,
    routes: &[AuthorityRoutesV1],
) -> Vec<CertaintyShift> {
    let before = support_levels(then, routes);
    let after = support_levels(now, routes);
    let mut out = Vec::new();
    for ((belief_id, predicate, state_stage), level) in &after {
        let was = before.get(&(belief_id.clone(), predicate.clone(), state_stage));
        // A scope that vanished is not reported here. Losing the last support
        // is `Staleness::LostSupport`, and a belief that was tombstoned is a
        // material change — saying it a third time would triple-count one
        // event across three sections.
        if was == Some(level) {
            continue;
        }
        out.push(CertaintyShift {
            belief_id: belief_id.clone(),
            predicate: predicate.clone(),
            state_stage: state_stage.to_string(),
            from: was.cloned(),
            to: level.clone(),
        });
    }
    out
}

fn new_contestation(then: &EpistemicState, now: &EpistemicState) -> Vec<Contestation> {
    let mut out = Vec::new();
    for (edge_id, edge) in &now.contradiction_edges {
        if then.contradiction_edges.contains_key(edge_id) {
            continue;
        }
        // An edge that opened AND closed inside one window is not new
        // contestation — it is a disagreement somebody already addressed, and
        // reporting it as news would send a reader after a settled thing.
        if edge.closed.is_some() {
            continue;
        }
        let classification = now.conflict_classifications.get(&edge.comparison_id);
        out.push(Contestation {
            edge_id: edge_id.clone(),
            left_belief_id: edge.left_belief_id.clone(),
            right_belief_id: edge.right_belief_id.clone(),
            kind: edge.kind.as_str(),
            reason_codes: classification
                .map(|row| {
                    row.reason_codes
                        .iter()
                        .map(|code| code.as_str().to_string())
                        .collect()
                })
                .unwrap_or_default(),
            classified_by: match classification.map(|row| &row.classification) {
                Some(crate::ledger::schema::Classification::AgentSupplied { .. }) => {
                    "agent_supplied"
                }
                // An edge with no classification row cannot exist — one is
                // required to open it — but the fold is total and says the
                // deterministic word rather than panicking on a shape the
                // reducer already refuses.
                _ => "deterministic",
            },
        });
    }
    out
}

fn material_changes(then: &EpistemicState, now: &EpistemicState) -> Vec<MaterialChange> {
    let mut out = Vec::new();
    for (belief_id, belief) in &now.beliefs {
        let before = then.beliefs.get(belief_id);
        let mut kinds: Vec<ChangeKind> = Vec::new();
        match before {
            None => kinds.push(ChangeKind::Created),
            Some(before) => {
                if before.current().event_id != belief.current().event_id {
                    kinds.push(ChangeKind::Revised);
                }
                if before.tombstoned_by.is_none() && belief.tombstoned_by.is_some() {
                    kinds.push(ChangeKind::Tombstoned);
                }
                if before.qualification != belief.qualification {
                    kinds.push(ChangeKind::QualificationChanged);
                }
                if before.lifecycle != belief.lifecycle {
                    kinds.push(ChangeKind::LifecycleChanged);
                }
                match (
                    before.open_contest_event.is_some(),
                    belief.open_contest_event.is_some(),
                ) {
                    (false, true) => kinds.push(ChangeKind::ContestOpened),
                    (true, false) => kinds.push(ChangeKind::ContestClosed),
                    _ => {}
                }
            }
        }
        // A belief created AND tombstoned inside one window says both, in a
        // stable order, once.
        if before.is_none() && belief.tombstoned_by.is_some() {
            kinds.push(ChangeKind::Tombstoned);
        }
        if kinds.is_empty() {
            continue;
        }
        kinds.sort_unstable();
        kinds.dedup();
        out.push(MaterialChange {
            belief_id: belief_id.clone(),
            entity_id: belief.entity_id.clone(),
            kinds,
            revision_then: before.map(|b| b.current().event_id.clone()),
            revision_now: Some(belief.current().event_id.clone()),
        });
    }
    out
}

/// Live assessments per subject, and open gaps by id.
fn coverage(state: &EpistemicState) -> (BTreeMap<String, u32>, BTreeMap<String, Option<String>>) {
    let mut assessments: BTreeMap<String, u32> = BTreeMap::new();
    for assessment in state.coverage_assessments.values() {
        if assessment.superseded {
            continue;
        }
        if let Some(subject) = &assessment.subject_id {
            *assessments.entry(subject.clone()).or_default() += 1;
        }
    }
    let gaps = state
        .coverage_gaps
        .values()
        .filter(|gap| !gap.closed)
        .map(|gap| (gap.gap_id.clone(), gap.source_id.clone()))
        .collect();
    (assessments, gaps)
}

fn blindness(then: &EpistemicState, now: &EpistemicState) -> Vec<Blindness> {
    let (then_assessments, then_gaps) = coverage(then);
    let (now_assessments, now_gaps) = coverage(now);
    let mut out = Vec::new();

    let subjects: BTreeSet<&String> = then_assessments
        .keys()
        .chain(now_assessments.keys())
        .collect();
    for subject in subjects {
        let before = *then_assessments.get(subject).unwrap_or(&0);
        let after = *now_assessments.get(subject).unwrap_or(&0);
        if before > 0 && after == 0 {
            out.push(Blindness::SubjectBecameBlind {
                entity_id: subject.clone(),
            });
        } else if before == 0 && after > 0 {
            out.push(Blindness::SubjectNoLongerBlind {
                entity_id: subject.clone(),
                assessments_now: after,
            });
        }
    }
    for (gap_id, source_id) in &now_gaps {
        if !then_gaps.contains_key(gap_id) {
            out.push(Blindness::GapOpened {
                gap_id: gap_id.clone(),
                source_id: source_id.clone(),
            });
        }
    }
    for (gap_id, source_id) in &then_gaps {
        if !now_gaps.contains_key(gap_id) {
            out.push(Blindness::GapClosed {
                gap_id: gap_id.clone(),
                source_id: source_id.clone(),
            });
        }
    }
    out
}

fn newest(state: &EpistemicState, belief: &BeliefState) -> Option<String> {
    crate::attention::signals::newest_evidence(state, belief).map(str::to_string)
}

fn staleness(then: &EpistemicState, now: &EpistemicState) -> Vec<Staleness> {
    let mut out = Vec::new();
    for (belief_id, belief) in &now.beliefs {
        if belief.tombstoned_by.is_some() {
            continue;
        }
        let after = newest(now, belief);
        let before = then.beliefs.get(belief_id).and_then(|b| newest(then, b));
        match (before, after) {
            (Some(before), Some(after)) if after > before => {
                out.push(Staleness::EvidenceRefreshed {
                    belief_id: belief_id.clone(),
                    from: before,
                    to: after,
                })
            }
            (None, Some(after)) => out.push(Staleness::BecameSupported {
                belief_id: belief_id.clone(),
                newest_evidence_at: after,
            }),
            (Some(_), None) => out.push(Staleness::LostSupport {
                belief_id: belief_id.clone(),
            }),
            _ => {}
        }
    }
    out
}

/// The window question is a SEQUENCE question. A convergence run bounded by
/// wall-clock would give a different answer depending on when it was asked,
/// about a ledger whose order never changed.
#[cfg(test)]
mod discipline {
    #[test]
    fn nothing_in_the_diff_reads_a_clock() {
        let source = include_str!("diff.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half");
        for forbidden in ["Utc::now", "SystemTime", "Local::now", "as_of"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden:?} appears in the convergence diff — a window is two sequence \
                 numbers, and the answer must not depend on when it was asked"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{
        belief, linked, observation, revision, unsupported, B_KESTREL, B_ONE, B_TWO, FALCON,
        OBS_AUTHORITY, OBS_INFERRED, REV_ONE, REV_ONE_OLD, REV_TWO,
    };
    use crate::ledger::reduce::AssertionFacet;
    use crate::ledger::schema::{
        self, derive_value_hash, AuthorityProvenance, Lifecycle, Qualification, Scope, TypedValue,
        ValidInterval,
    };

    fn routes() -> Vec<AuthorityRoutesV1> {
        crate::policy::authority::resolvable().expect("the shipped artifacts")
    }

    const WINDOW: Window = Window {
        from_seq: 10,
        to_seq: 20,
    };

    fn facet(recorded_at: &str) -> AssertionFacet {
        AssertionFacet {
            predicate: "cutover_status".into(),
            value_hash: derive_value_hash(&TypedValue::string("on track")).unwrap(),
            value: TypedValue::string("on track"),
            scope: Scope::empty(),
            valid_time: ValidInterval {
                from: None,
                to: None,
            },
            recorded_at: recorded_at.into(),
            observed_at: None,
            relationship_role: crate::ledger::schema::SubjectRole::Unknown,
            source_artifact_hash: None,
            raw_pointer: None,
        }
    }

    fn with_evidence(state: &mut EpistemicState, event: &str, recorded_at: &str) {
        state.observations.insert(
            event.into(),
            observation(
                event,
                FALCON,
                crate::assembly::fixture::SOURCE_A,
                AuthorityProvenance::RegisteredDirectArtifact,
            ),
        );
        state
            .assertion_facets
            .insert(event.into(), facet(recorded_at));
    }

    /// One supported belief and one unsupported one.
    fn then() -> EpistemicState {
        let mut state = EpistemicState::default();
        state.beliefs.insert(
            B_ONE.into(),
            belief(
                B_ONE,
                FALCON,
                vec![revision(
                    1,
                    REV_ONE_OLD,
                    "on track",
                    linked(&[OBS_AUTHORITY]),
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
        with_evidence(&mut state, OBS_AUTHORITY, "2026-08-01T00:00:00.000Z");
        state
    }

    fn kinds<'a>(output: &'a Output, belief_id: &str) -> &'a [ChangeKind] {
        &output
            .material_changes
            .iter()
            .find(|c| c.belief_id == belief_id)
            .expect("a row for the changed belief")
            .kinds
    }

    #[test]
    fn a_window_with_nothing_in_it_is_quiet_and_still_an_answer() {
        let state = then();
        let output = compute(&state, &state, WINDOW, &routes());
        assert!(output.quiet());
        assert_eq!(output.material_changes, vec![]);
        assert_eq!(output.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn a_new_belief_and_a_revised_one_are_told_apart() {
        let then = then();
        let mut now = then.clone();
        now.beliefs.get_mut(B_ONE).unwrap().revisions.push(revision(
            2,
            REV_ONE,
            "on track, confirmed",
            linked(&[OBS_AUTHORITY]),
        ));
        now.beliefs.insert(
            B_KESTREL.into(),
            belief(
                B_KESTREL,
                FALCON,
                vec![revision(1, REV_TWO, "after", unsupported())],
            ),
        );
        let output = compute(&then, &now, WINDOW, &routes());
        assert_eq!(kinds(&output, B_ONE), [ChangeKind::Revised]);
        assert_eq!(kinds(&output, B_KESTREL), [ChangeKind::Created]);
        let revised = output
            .material_changes
            .iter()
            .find(|c| c.belief_id == B_ONE)
            .unwrap();
        assert_eq!(revised.revision_then.as_deref(), Some(REV_ONE_OLD));
        assert_eq!(revised.revision_now.as_deref(), Some(REV_ONE));
    }

    #[test]
    fn a_governance_only_change_is_still_a_change() {
        // Nothing about the content moved, and the base still believes
        // something different about it than it did.
        let then = then();
        let mut now = then.clone();
        let belief = now.beliefs.get_mut(B_TWO).unwrap();
        belief.qualification = Qualification::Qualified;
        belief.lifecycle = Lifecycle::Superseded;
        let output = compute(&then, &now, WINDOW, &routes());
        assert_eq!(
            kinds(&output, B_TWO),
            [
                ChangeKind::QualificationChanged,
                ChangeKind::LifecycleChanged
            ]
        );
        let row = &output.material_changes[0];
        assert_eq!(
            row.revision_then, row.revision_now,
            "the content did not move, and the row says so by repeating itself"
        );
    }

    #[test]
    fn several_things_moving_about_one_belief_is_one_row() {
        let then = then();
        let mut now = then.clone();
        let belief = now.beliefs.get_mut(B_ONE).unwrap();
        belief
            .revisions
            .push(revision(2, REV_ONE, "on track", linked(&[OBS_AUTHORITY])));
        belief.tombstoned_by = Some("90000000000000000000000000000009".into());
        belief.open_contest_event = Some("90000000000000000000000000000008".into());
        let output = compute(&then, &now, WINDOW, &routes());
        assert_eq!(
            output.material_changes.len(),
            1,
            "one belief, one row, whatever happened to it"
        );
        assert_eq!(
            kinds(&output, B_ONE),
            [
                ChangeKind::Revised,
                ChangeKind::Tombstoned,
                ChangeKind::ContestOpened
            ]
        );
    }

    #[test]
    fn evidence_getting_newer_is_reported_as_movement_not_as_a_verdict() {
        let then = then();
        let mut now = then.clone();
        with_evidence(&mut now, OBS_INFERRED, "2026-08-11T00:00:00.000Z");
        now.beliefs.get_mut(B_ONE).unwrap().revisions.push(revision(
            2,
            REV_ONE,
            "on track",
            linked(&[OBS_AUTHORITY, OBS_INFERRED]),
        ));
        let output = compute(&then, &now, WINDOW, &routes());
        assert_eq!(
            output.staleness,
            vec![Staleness::EvidenceRefreshed {
                belief_id: B_ONE.into(),
                from: "2026-08-01T00:00:00.000Z".into(),
                to: "2026-08-11T00:00:00.000Z".into(),
            }]
        );
    }

    #[test]
    fn gaining_and_losing_support_are_different_findings() {
        let then = then();
        let mut now = then.clone();
        // B_TWO gains its first evidence.
        with_evidence(&mut now, OBS_INFERRED, "2026-08-11T00:00:00.000Z");
        now.beliefs.get_mut(B_TWO).unwrap().revisions.push(revision(
            2,
            REV_ONE,
            "slipped",
            linked(&[OBS_INFERRED]),
        ));
        // B_ONE loses all of it.
        now.beliefs.get_mut(B_ONE).unwrap().revisions.push(revision(
            2,
            REV_TWO,
            "on track",
            unsupported(),
        ));
        let output = compute(&then, &now, WINDOW, &routes());
        assert!(output.staleness.contains(&Staleness::BecameSupported {
            belief_id: B_TWO.into(),
            newest_evidence_at: "2026-08-11T00:00:00.000Z".into(),
        }));
        assert!(output.staleness.contains(&Staleness::LostSupport {
            belief_id: B_ONE.into()
        }));
    }

    /// One classified, open edge between the two beliefs.
    fn contest(state: &mut EpistemicState, kind: schema::EdgeKind, agent: bool) -> String {
        let comparison_id = "c".repeat(32);
        let edge_id = schema::derive_edge_id(&comparison_id, kind);
        state.contradiction_edges.insert(
            edge_id.clone(),
            crate::ledger::reduce::ContradictionEdgeRow {
                edge_id: edge_id.clone(),
                comparison_id: comparison_id.clone(),
                kind,
                left_belief_id: B_ONE.into(),
                right_belief_id: B_TWO.into(),
                opened_event_id: "e".repeat(32),
                classified_event_id: "f".repeat(32),
                closed: None,
            },
        );
        state.conflict_classifications.insert(
            comparison_id.clone(),
            crate::ledger::reduce::ClassificationRow {
                comparison_id,
                event_id: "f".repeat(32),
                outcome: schema::ConflictOutcome::GenuineDirect,
                classification: if agent {
                    schema::Classification::AgentSupplied {
                        proposal_id: "a".repeat(32),
                        model_id: "claude-opus".into(),
                        prompt_version: "v1".into(),
                    }
                } else {
                    schema::Classification::Deterministic {
                        rule_version: "contradiction-declared-v1".into(),
                    }
                },
                reason_codes: vec![schema::ConflictReasonCode::IncompatibleValues],
                evidence_event_ids: vec![],
            },
        );
        edge_id
    }

    #[test]
    fn the_two_m27_sections_are_live_and_an_empty_one_means_nothing_moved() {
        // They shipped as a typed "not yet available" so that activating them
        // would change a VALUE and not a shape. This is that change: the
        // words are gone, and an empty list now honestly means nothing moved.
        let state = then();
        let output = compute(&state, &state, WINDOW, &routes());
        let rendered = serde_json::to_string(&output).unwrap();
        assert!(!rendered.contains("not_yet_available"));
        assert_eq!(output.certainty_shift, vec![]);
        assert_eq!(output.new_contestation, vec![]);
        assert!(output.quiet());
    }

    #[test]
    fn certainty_shift_reports_the_ground_under_a_claim_moving() {
        // The belief was revised and the revision rests on a second source.
        // Support goes single-source → corroborated, keyed on the SCOPE: a
        // facet key pins a revision, so keying on that would call every facet
        // of a revised belief new.
        let then = then();
        let mut now = then.clone();
        // A DIFFERENT source saying a DIFFERENT thing about the same
        // predicate. Same source and same value would be one family, not two
        // — repetition does not reinforce, which is the whole of M27.2's
        // lineage hygiene.
        now.observations.insert(
            OBS_INFERRED.into(),
            observation(
                OBS_INFERRED,
                FALCON,
                crate::assembly::fixture::SOURCE_B,
                AuthorityProvenance::AgentInferred,
            ),
        );
        let mut second = facet("2026-08-02T00:00:00.000Z");
        second.value = TypedValue::string("on track, confirmed");
        second.value_hash = derive_value_hash(&second.value).unwrap();
        now.assertion_facets.insert(OBS_INFERRED.into(), second);
        now.beliefs.get_mut(B_ONE).unwrap().revisions.push(revision(
            2,
            REV_ONE,
            "on track",
            linked(&[OBS_AUTHORITY, OBS_INFERRED]),
        ));
        // Two families with a positive proof between them. Without the proof
        // this is two sources whose independence is UNKNOWN, which is still
        // single-source — the distinction M27.2 exists to keep.
        now.independence.insert(
            (OBS_AUTHORITY.into(), OBS_INFERRED.into()),
            crate::ledger::reduce::IndependenceRow {
                event_id: "9".repeat(32),
                proof_kind: "independent_system_artifact".into(),
                proof: schema::IndependenceProof::IndependentSystemArtifact {
                    left_source_registration_event_id: crate::assembly::fixture::REG.into(),
                    right_source_registration_event_id: crate::assembly::fixture::REG.into(),
                    rule_version: "independence-rules-v1".into(),
                },
            },
        );

        let output = compute(&then, &now, WINDOW, &routes());
        let shift = output
            .certainty_shift
            .iter()
            .find(|s| s.belief_id == B_ONE)
            .expect("the belief whose support moved");
        assert_eq!(shift.from.as_deref(), Some("single_source"));
        assert_eq!(shift.to, "corroborated");
        assert_eq!(
            shift.predicate.as_deref(),
            Some("cutover_status"),
            "the scope is named, so a two-facet belief could not report one merged verdict"
        );
        assert!(
            !output.certainty_shift.iter().any(|s| s.belief_id == B_TWO),
            "the belief nobody touched is not a shift"
        );
    }

    #[test]
    fn a_revision_that_changes_no_support_is_not_a_certainty_shift() {
        // Revising the words of a claim is a material change and says so
        // there. Reporting it here too would tell a reader the ground moved
        // when only the sentence did.
        let then = then();
        let mut now = then.clone();
        now.beliefs.get_mut(B_ONE).unwrap().revisions.push(revision(
            2,
            REV_ONE,
            "still on track",
            linked(&[OBS_AUTHORITY]),
        ));
        let output = compute(&then, &now, WINDOW, &routes());
        assert_eq!(output.certainty_shift, vec![]);
        assert!(!output.quiet(), "the revision itself is still news");
    }

    #[test]
    fn a_contest_that_opened_is_news_and_one_already_open_is_not() {
        let mut then = then();
        let mut now = then.clone();
        let edge_id = contest(&mut now, schema::EdgeKind::Partial, false);

        let output = compute(&then, &now, WINDOW, &routes());
        assert_eq!(output.new_contestation.len(), 1);
        let row = &output.new_contestation[0];
        assert_eq!(row.edge_id, edge_id);
        assert_eq!(row.kind, "partial");
        assert_eq!(row.classified_by, "deterministic");
        assert_eq!(row.reason_codes, vec!["incompatible_values"]);
        assert!(!output.quiet(), "an opened contest is not a quiet window");

        // The same edge on both sides is not news a second time.
        contest(&mut then, schema::EdgeKind::Partial, false);
        assert_eq!(
            compute(&then, &now, WINDOW, &routes()).new_contestation,
            vec![]
        );
    }

    #[test]
    fn a_contest_opened_and_addressed_inside_one_window_is_not_new_contestation() {
        // Somebody already dealt with it. Reporting it as news would send a
        // reader after a settled thing.
        let then = then();
        let mut now = then.clone();
        let edge_id = contest(&mut now, schema::EdgeKind::GenuineDirect, false);
        now.contradiction_edges.get_mut(&edge_id).unwrap().closed =
            Some(crate::ledger::reduce::EdgeClosure {
                event_id: "1".repeat(32),
                addressed_by_event_id: "2".repeat(32),
                disposition: schema::CloseDisposition::ResolvedWithEvidence,
                evidence_event_ids: vec!["3".repeat(32)],
            });
        assert_eq!(
            compute(&then, &now, WINDOW, &routes()).new_contestation,
            vec![]
        );
    }

    #[test]
    fn an_agent_supplied_verdict_says_so_rather_than_reading_as_a_reducer_fact() {
        let then = then();
        let mut now = then.clone();
        contest(&mut now, schema::EdgeKind::Conditional, true);
        let output = compute(&then, &now, WINDOW, &routes());
        assert_eq!(output.new_contestation[0].classified_by, "agent_supplied");
    }

    #[test]
    fn the_same_window_over_the_same_base_hashes_the_same() {
        let then = then();
        let mut now = then.clone();
        now.beliefs.get_mut(B_ONE).unwrap().revisions.push(revision(
            2,
            REV_ONE,
            "on track",
            linked(&[OBS_AUTHORITY]),
        ));
        let one = compute(&then, &now, WINDOW, &routes())
            .content_hash()
            .unwrap();
        let two = compute(&then, &now, WINDOW, &routes())
            .content_hash()
            .unwrap();
        assert_eq!(one, two);
        // A different window is a different reading, even of the same states.
        let other = compute(
            &then,
            &now,
            Window {
                from_seq: 11,
                to_seq: 20,
            },
            &routes(),
        )
        .content_hash()
        .unwrap();
        assert_ne!(one, other);
    }

    #[test]
    fn a_backwards_window_is_refused_rather_than_swapped() {
        let detail = states(
            &[],
            "cafebabecafebabecafebabecafebabe",
            Window {
                from_seq: 20,
                to_seq: 10,
            },
        )
        .unwrap_err();
        assert!(detail.contains("runs backwards"), "{detail}");
    }
}
