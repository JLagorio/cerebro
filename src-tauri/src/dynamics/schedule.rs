//! The deterministic freshness scheduler (M27.1c).
//!
//! **It emits what is DUE, and `as_of` is an argument.** The caller reads the
//! clock; this decides which facets have crossed a boundary since the last
//! transition anybody recorded, and stamps each crossing with a time derived
//! from pinned evidence and the versioned rule rather than from the moment it
//! noticed. That is the whole of "rebuild a week later must be
//! byte-identical": the emission MOMENT is wall-clock, the emitted CONTENT is
//! not.
//!
//! **Timer and launch catch-up are the same code.** There is no separate
//! catch-up path, because a catch-up path is a second implementation of
//! "what is due" — and the one thing it would have to get right, emitting
//! every boundary crossed while the app was closed, falls out of comparing
//! the derived state against the recorded one. Both may run; the duplicate
//! `dedupe_key` folds to nothing.
//!
//! **Nothing transitions INTO `unknown`, and that is a decision.** `unknown`
//! means "we cannot say", and there is no evidence-derived instant at which
//! being unable to say became true — the only stamp available would be the
//! wall clock this module exists to keep out of the ledger. A facet that
//! loses its rule or its anchor simply stops having its state re-asserted:
//! the recorded history stands, and the derived chip says `unknown` because
//! the derivation says so. The body still permits `to: unknown` because a
//! later producer with an honest time may have one; the test below pins that
//! THIS producer does not.

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    derive_freshness_dedupe_key, derive_freshness_transition_key, Actor, Freshness,
    FreshnessTransitioned, BODY_SCHEMA, KIND_FRESHNESS_TRANSITIONED,
};

use super::facet::{all_facets, BeliefFacetKey};
use super::freshness::{assess, Rules};

/// Who the scheduler signs as. A system actor: a boundary crossing is
/// arithmetic over recorded evidence, so nothing here should look like an
/// agent's judgement.
pub const ACTOR: &str = "system:freshness";

/// One crossing that has not been recorded yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub facet: BeliefFacetKey,
    pub from: Freshness,
    pub to: Freshness,
    pub effective_at: String,
    pub rule_version: String,
    pub dedupe_key: String,
}

impl Due {
    /// The event body this crossing would append.
    pub fn body(&self) -> FreshnessTransitioned {
        FreshnessTransitioned {
            schema: BODY_SCHEMA,
            batch_id: None,
            // Stamped by `append_once` from the key. Set here it would be
            // part of the canonical bytes twice over.
            idempotency_key: None,
            actor: Actor {
                id: ACTOR.to_string(),
            },
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            facet: self.facet.clone(),
            from: self.from,
            to: self.to,
            effective_at: self.effective_at.clone(),
            rule_version: self.rule_version.clone(),
            dedupe_key: self.dedupe_key.clone(),
        }
    }
}

fn stamp(at: chrono::DateTime<chrono::Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Every crossing that has happened and not been recorded, in the design's
/// order: `(effective_at, belief_id, revision, predicate, stage)`.
///
/// Deterministic and pure — it reads state, the rules, and `as_of`, and
/// touches nothing.
pub fn due(
    state: &EpistemicState,
    rules: &Rules,
    as_of: chrono::DateTime<chrono::Utc>,
) -> Vec<Due> {
    let mut out: Vec<Due> = Vec::new();
    for facet in all_facets(state) {
        let assessment = assess(state, rules, &facet, as_of);
        let facet_id = facet.key.facet_id();
        // What the store already says this facet is. With no recorded
        // transition that is the value it held AT its own anchor, which is
        // derived without a clock — the first crossing moves away from it.
        let from = match state.freshness.get(&facet_id) {
            Some(row) => row.state,
            None => assessment.initial(),
        };
        if assessment.freshness == from {
            continue;
        }
        // See the module note: this producer has no honest instant for
        // entering `unknown`, so it does not claim one.
        let effective_at = match assessment.freshness {
            Freshness::Stale => match assessment.effective_at {
                Some(at) => stamp(at),
                // Unreachable through `assess`: a derived `stale` always
                // carries the boundary it crossed. A `continue` rather than an
                // `expect`, because a scheduler that panicked would take the
                // whole ambient tick down over one facet.
                None => continue,
            },
            Freshness::Fresh => match &assessment.anchor {
                Some(anchor) => stamp(anchor.at),
                None => continue,
            },
            Freshness::Unknown => continue,
        };
        let Ok(dedupe_key) = derive_freshness_dedupe_key(
            &facet.key.belief_revision_event_id,
            &facet.key.predicate,
            facet.key.state_stage,
            &effective_at,
            &rules.rule_version,
        ) else {
            continue;
        };
        out.push(Due {
            facet: facet.key,
            from,
            to: assessment.freshness,
            effective_at,
            rule_version: rules.rule_version.clone(),
            dedupe_key,
        });
    }
    out.sort_by(|a, b| {
        (
            &a.effective_at,
            &a.facet.belief_id,
            &a.facet.belief_revision_event_id,
            &a.facet.predicate,
            a.facet.state_stage,
        )
            .cmp(&(
                &b.effective_at,
                &b.facet.belief_id,
                &b.facet.belief_revision_event_id,
                &b.facet.predicate,
                b.facet.state_stage,
            ))
    });
    out
}

/// What one scheduling pass did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Emitted {
    pub appended: usize,
    /// Crossings the store had already recorded — the ordinary outcome when
    /// the timer and launch catch-up both run.
    pub already_known: usize,
    /// Crossings that could not be appended, with the reason. Reported rather
    /// than swallowed: a scheduler that silently dropped a transition looks
    /// exactly like a base where nothing went stale.
    pub failed: Vec<(String, String)>,
}

/// Append every due crossing that is not already recorded.
///
/// The append seam is [`crate::conflict::emit::Append`] rather than a second
/// trait of the same shape. One `append_once` seam with one production
/// implementation is one thing to keep correct; two identical traits are two,
/// and they would drift on exactly the question of what a `Wrote` means.
pub fn emit<A: crate::conflict::emit::Append>(
    state: &EpistemicState,
    store_uuid: &str,
    rules: &Rules,
    as_of: chrono::DateTime<chrono::Utc>,
    appender: &A,
) -> Emitted {
    use crate::conflict::emit::Wrote;

    let mut out = Emitted::default();
    for crossing in due(state, rules, as_of) {
        let body = crossing.body();
        if let Err(detail) = body.validate() {
            out.failed.push((crossing.dedupe_key.clone(), detail));
            continue;
        }
        let value = match serde_json::to_value(&body) {
            Ok(value) => value,
            Err(error) => {
                out.failed
                    .push((crossing.dedupe_key.clone(), error.to_string()));
                continue;
            }
        };
        let key = derive_freshness_transition_key(store_uuid, &crossing.dedupe_key);
        match appender.append_once(&key, KIND_FRESHNESS_TRANSITIONED, value) {
            Ok(Wrote::Appended) => out.appended += 1,
            Ok(Wrote::AlreadyThere) => out.already_known += 1,
            Err(detail) => out.failed.push((crossing.dedupe_key, detail)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{B_ONE, OBS_AUTHORITY, OBS_INFERRED, REV_ONE};
    use crate::conflict::emit::{Append, Wrote};
    use crate::dynamics::facet::tests::{assertion_facet, base};
    use crate::dynamics::freshness;
    use crate::ledger::reduce::FreshnessRow;
    use crate::ledger::schema::{FacetPredicate, Stage, StateStage};
    use std::cell::RefCell;

    const STORE: &str = "cafebabecafebabecafebabecafebabe";

    #[derive(Default)]
    struct Spy {
        seen: RefCell<Vec<(String, serde_json::Value)>>,
        answer: Option<Wrote>,
        fail: bool,
    }

    impl Append for Spy {
        fn append_once(
            &self,
            key: &str,
            kind: &str,
            body: serde_json::Value,
        ) -> Result<Wrote, String> {
            // Whatever the scheduler hands the writer has to be a body the
            // writer would accept, and its key has to name its own dedupe key.
            let decoded = crate::ledger::schema::decode_body(kind, &body)
                .expect("a decodable body")
                .expect("a schema-v1 body");
            decoded.validate(STORE).expect("a valid body");
            assert!(
                key.ends_with(body["dedupe_key"].as_str().expect("a key")),
                "the idempotency key names a different transition than the body"
            );
            self.seen.borrow_mut().push((key.to_string(), body));
            if self.fail {
                return Err("the writer said no".into());
            }
            Ok(self.answer.unwrap_or(Wrote::Appended))
        }
    }

    fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    /// One belief whose single facet is a CI status anchored at 00:00, so it
    /// goes stale at 06:00.
    fn ci_base() -> EpistemicState {
        let mut state = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            let mut facet = assertion_facet("ci_status", Some(Stage::Implemented), "x");
            facet.observed_at = Some("2026-08-12T00:00:00Z".into());
            state.assertion_facets.insert(event.into(), facet);
        }
        state
    }

    #[test]
    fn a_facet_that_has_not_crossed_anything_is_not_due() {
        let rules = freshness::load().unwrap();
        assert!(due(&ci_base(), &rules, at("2026-08-12T05:59:59Z")).is_empty());
    }

    #[test]
    fn the_first_crossing_is_stamped_at_the_boundary_not_at_the_moment_it_was_noticed() {
        // The property the whole design rests on: an app opened three days
        // late records the transition at 06:00, not at the launch it noticed.
        let rules = freshness::load().unwrap();
        let crossings = due(&ci_base(), &rules, at("2026-08-15T11:22:33Z"));
        assert_eq!(crossings.len(), 1);
        assert_eq!(crossings[0].from, Freshness::Fresh);
        assert_eq!(crossings[0].to, Freshness::Stale);
        assert_eq!(crossings[0].effective_at, "2026-08-12T06:00:00.000Z");
    }

    #[test]
    fn asking_later_produces_byte_identical_bytes() {
        // "Rebuild a week later must be byte-identical" as an assertion.
        let rules = freshness::load().unwrap();
        let state = ci_base();
        let now = due(&state, &rules, at("2026-08-12T06:00:00Z"));
        let much_later = due(&state, &rules, at("2026-09-30T18:04:00Z"));
        assert_eq!(now, much_later);
        assert_eq!(
            serde_json::to_string(&now[0].body()).unwrap(),
            serde_json::to_string(&much_later[0].body()).unwrap()
        );
    }

    #[test]
    fn a_recorded_crossing_is_not_due_again() {
        let rules = freshness::load().unwrap();
        let mut state = ci_base();
        let crossing = due(&state, &rules, at("2026-08-13T00:00:00Z")).remove(0);
        let facet_id = crossing.facet.facet_id();
        state.freshness.insert(
            facet_id.clone(),
            FreshnessRow {
                facet_id,
                facet: crossing.facet.clone(),
                state: Freshness::Stale,
                effective_at: crossing.effective_at.clone(),
                rule_version: crossing.rule_version.clone(),
                event_id: "90000000000000000000000000000001".into(),
                folded: Default::default(),
            },
        );
        assert!(due(&state, &rules, at("2026-08-13T00:00:00Z")).is_empty());
    }

    #[test]
    fn newer_evidence_brings_a_stale_facet_back_at_its_own_anchor() {
        let rules = freshness::load().unwrap();
        let mut state = ci_base();
        let stale = due(&state, &rules, at("2026-08-13T00:00:00Z")).remove(0);
        let facet_id = stale.facet.facet_id();
        state.freshness.insert(
            facet_id.clone(),
            FreshnessRow {
                facet_id,
                facet: stale.facet.clone(),
                state: Freshness::Stale,
                effective_at: stale.effective_at,
                rule_version: stale.rule_version,
                event_id: "90000000000000000000000000000001".into(),
                folded: Default::default(),
            },
        );
        // A newer reading lands.
        let mut newer = assertion_facet("ci_status", Some(Stage::Implemented), "x");
        newer.observed_at = Some("2026-08-12T22:00:00Z".into());
        state.assertion_facets.insert(OBS_INFERRED.into(), newer);

        let crossings = due(&state, &rules, at("2026-08-13T00:00:00Z"));
        assert_eq!(crossings.len(), 1);
        assert_eq!(crossings[0].from, Freshness::Stale);
        assert_eq!(crossings[0].to, Freshness::Fresh);
        assert_eq!(
            crossings[0].effective_at, "2026-08-12T22:00:00.000Z",
            "fresh again AT the new anchor, not at the moment we noticed"
        );
    }

    #[test]
    fn nothing_ever_transitions_into_unknown() {
        // A facet whose predicate has no rule, and one whose rule matched but
        // whose anchor is missing. Neither has an honest instant at which
        // being unable to say became true, so neither is emitted.
        let rules = freshness::load().unwrap();
        let mut state = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state.assertion_facets.insert(
                event.into(),
                assertion_facet("status", None, "2026-08-01T00:00:00Z"),
            );
        }
        assert!(due(&state, &rules, at("2099-01-01T00:00:00Z")).is_empty());

        let mut anchorless = base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            // `ci_status` measures from occurred_at, and these have none.
            anchorless.assertion_facets.insert(
                event.into(),
                assertion_facet("ci_status", None, "2026-08-01T00:00:00Z"),
            );
        }
        assert!(due(&anchorless, &rules, at("2099-01-01T00:00:00Z")).is_empty());

        assert!(
            due(&ci_base(), &rules, at("2099-01-01T00:00:00Z"))
                .iter()
                .all(|crossing| crossing.to != Freshness::Unknown),
            "this producer has no honest time for entering unknown"
        );
    }

    #[test]
    fn crossings_come_out_in_the_designs_order() {
        let rules = freshness::load().unwrap();
        let mut state = ci_base();
        // A second facet on the same revision, staged differently and
        // anchored EARLIER, so effective-time order and stage order disagree.
        let mut earlier = assertion_facet("ci_status", Some(Stage::Shipping), "x");
        earlier.observed_at = Some("2026-08-11T00:00:00Z".into());
        state.assertion_facets.insert(OBS_INFERRED.into(), earlier);

        let crossings = due(&state, &rules, at("2026-08-13T00:00:00Z"));
        assert_eq!(crossings.len(), 2);
        assert!(
            crossings[0].effective_at < crossings[1].effective_at,
            "effective time leads the ordering"
        );
        assert_eq!(crossings[0].facet.state_stage, StateStage::Shipping);
    }

    #[test]
    fn every_crossing_is_appended_once_under_a_store_scoped_key() {
        let rules = freshness::load().unwrap();
        let spy = Spy::default();
        let out = emit(&ci_base(), STORE, &rules, at("2026-08-13T00:00:00Z"), &spy);
        assert_eq!(out.appended, 1);
        assert!(out.failed.is_empty());
        let seen = spy.seen.borrow();
        assert!(seen[0]
            .0
            .starts_with(&format!("freshness-transition:{STORE}:")));
    }

    #[test]
    fn the_durable_guard_answers_when_state_has_not_caught_up() {
        // The timer and launch catch-up both emit every due crossing. The
        // second one to arrive is the ordinary case, not an error.
        let rules = freshness::load().unwrap();
        let spy = Spy {
            answer: Some(Wrote::AlreadyThere),
            ..Spy::default()
        };
        let out = emit(&ci_base(), STORE, &rules, at("2026-08-13T00:00:00Z"), &spy);
        assert_eq!(out.already_known, 1);
        assert_eq!(out.appended, 0);
    }

    #[test]
    fn a_failed_append_is_reported_rather_than_swallowed() {
        let rules = freshness::load().unwrap();
        let spy = Spy {
            fail: true,
            ..Spy::default()
        };
        let out = emit(&ci_base(), STORE, &rules, at("2026-08-13T00:00:00Z"), &spy);
        assert_eq!(out.appended, 0);
        assert_eq!(out.failed.len(), 1);
        assert!(out.failed[0].1.contains("the writer said no"));
    }

    #[test]
    fn a_facet_key_with_no_predicate_still_schedules_nothing_rather_than_panicking() {
        let rules = freshness::load().unwrap();
        let mut state = base();
        state.beliefs.get_mut(B_ONE).unwrap().revisions[0].basis =
            crate::ledger::schema::BeliefBasis::Unsupported {
                reason: "nothing rests under this".into(),
            };
        let crossings = due(&state, &rules, at("2099-01-01T00:00:00Z"));
        assert!(crossings.is_empty());
        assert_eq!(
            crate::dynamics::facet::facets_of(&state, state.beliefs.get(B_ONE).unwrap())[0]
                .key
                .predicate,
            FacetPredicate::Unknown
        );
        let _ = REV_ONE;
    }
}
