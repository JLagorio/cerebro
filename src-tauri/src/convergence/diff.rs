//! Convergence synthesis (M26.8a) — believed-then against believed-now.
//!
//! **A window is two sequence numbers, never two times.** The ledger's own
//! order is the only order this milestone trusts (D3), and a convergence run
//! bounded by wall-clock would be asking a question whose answer changes with
//! the clock. Nothing in this module reads one.
//!
//! **The M27-gated sections are PRESENT and inactive, not absent.** Certainty
//! shift and new contestation need D9's Support and Validity, which M27.5
//! builds. An output that simply omitted them would read identically to an
//! output whose base had no certainty changes — and those are opposite
//! findings. So they ship as a typed "not yet available", with the milestone
//! that activates them named in the value.
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

/// A section this build cannot compute yet.
///
/// Typed rather than omitted: an absent section and an empty one read
/// identically, and here they mean "we cannot tell you" and "nothing
/// changed" — which are opposite answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Gated {
    NotYetAvailable {
        activates_in: &'static str,
        needs: &'static str,
    },
}

impl Gated {
    fn certainty() -> Gated {
        Gated::NotYetAvailable {
            activates_in: "M27.5",
            needs: "D9 Support and Validity, which do not exist yet — an empty list here \
                    would claim nothing changed",
        }
    }

    fn contestation() -> Gated {
        Gated::NotYetAvailable {
            activates_in: "M27.5",
            needs: "M27 contradiction edges; M26 detects comparisons but classifies none, \
                    so it cannot say a contest opened",
        }
    }
}

/// One convergence run's whole answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Output {
    pub schema_version: &'static str,
    pub window: Window,
    pub material_changes: Vec<MaterialChange>,
    pub blindness: Vec<Blindness>,
    pub staleness: Vec<Staleness>,
    pub certainty_shift: Gated,
    pub new_contestation: Gated,
}

impl Output {
    /// Did anything at all move? A run over a quiet window is a real answer
    /// and worth storing; a caller that wants to skip rendering one asks
    /// here rather than counting sections itself.
    pub fn quiet(&self) -> bool {
        self.material_changes.is_empty() && self.blindness.is_empty() && self.staleness.is_empty()
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
pub fn compute(then: &EpistemicState, now: &EpistemicState, window: Window) -> Output {
    Output {
        schema_version: SCHEMA_VERSION,
        window,
        material_changes: material_changes(then, now),
        blindness: blindness(then, now),
        staleness: staleness(then, now),
        certainty_shift: Gated::certainty(),
        new_contestation: Gated::contestation(),
    }
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
        derive_value_hash, AuthorityProvenance, Lifecycle, Qualification, Scope, TypedValue,
        ValidInterval,
    };

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
        let output = compute(&state, &state, WINDOW);
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
        let output = compute(&then, &now, WINDOW);
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
        let output = compute(&then, &now, WINDOW);
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
        let output = compute(&then, &now, WINDOW);
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
        let output = compute(&then, &now, WINDOW);
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
        let output = compute(&then, &now, WINDOW);
        assert!(output.staleness.contains(&Staleness::BecameSupported {
            belief_id: B_TWO.into(),
            newest_evidence_at: "2026-08-11T00:00:00.000Z".into(),
        }));
        assert!(output.staleness.contains(&Staleness::LostSupport {
            belief_id: B_ONE.into()
        }));
    }

    #[test]
    fn the_gated_sections_say_they_are_gated_rather_than_saying_nothing() {
        // An absent section and an empty one read identically, and here they
        // mean "we cannot tell you" and "nothing changed".
        let state = then();
        let output = compute(&state, &state, WINDOW);
        let rendered = serde_json::to_string(&output).unwrap();
        assert!(rendered.contains("not_yet_available"));
        assert!(rendered.contains("M27.5"));
        assert!(
            !rendered.contains("\"certainty_shift\":[]"),
            "an empty list here would claim nothing changed"
        );
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
        let one = compute(&then, &now, WINDOW).content_hash().unwrap();
        let two = compute(&then, &now, WINDOW).content_hash().unwrap();
        assert_eq!(one, two);
        // A different window is a different reading, even of the same states.
        let other = compute(
            &then,
            &now,
            Window {
                from_seq: 11,
                to_seq: 20,
            },
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
