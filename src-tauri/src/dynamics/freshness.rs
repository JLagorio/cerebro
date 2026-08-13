//! Freshness: the versioned rules, and the clock-free derivation (M27.1).
//!
//! **The rules are data** — `shared/policy/freshness.v1.json`, digest-pinned
//! and compiled in, the same discipline `budget-defaults.v1.json` and
//! `cost-projection.v1.json` carry. A freshness rule written twice, once in
//! Rust and once in TypeScript, is the review-blocking defect AGENTS.md names;
//! written once in a file it is a table anybody can read and a change anybody
//! can see in a diff.
//!
//! **A predicate with no rule is `unknown`, never `fresh`.** This is the whole
//! reason there is no default rule in the artifact. "Fresh" is a claim that
//! the evidence behind a belief is still current, and nothing entitles us to
//! make it about a predicate for which no one has said how long current lasts.
//! The absence of a rule is the absence of policy, and it is reported as
//! exactly that.
//!
//! **`revision_bound` is not a column, and that is deliberate.** §45 asks for
//! shipping-BOM freshness to be days AND revision-bound; the revision binding
//! is already structural, because [`super::facet::BeliefFacetKey`] pins
//! `belief_revision_event_id`. A BOM claim on revision 3 is a different facet
//! from the same claim on revision 4, with its own anchor and its own clock. A
//! boolean that changed no behaviour would be worse than no boolean at all.
//!
//! **The anchor is a maximum over pinned evidence, never a model's choice.**
//! Each rule declares one closed `time_basis`; that basis is resolved for
//! every admissible support in the facet, missing candidates are DISCARDED
//! rather than treated as zero, and the maximum `(timestamp, event_id)` wins.
//! An unknown time on one support does not erase a known one on another, and
//! having no known candidate at all yields `unknown` — not "as old as
//! possible", which would be a manufactured staleness alarm.

use std::collections::BTreeMap;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::sha256_hex;

use super::facet::{BeliefFacetKey, Facet};

const FRESHNESS_JSON: &str = include_str!("../../../shared/policy/freshness.v1.json");
const FRESHNESS_DIGEST: &str = include_str!("../../../shared/policy/freshness.v1.sha256");

/// One of the three axes' values (D9). Closed, and `unknown` is a member
/// rather than an absence.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Fresh,
    Stale,
    Unknown,
}

impl Freshness {
    pub fn as_str(self) -> &'static str {
        match self {
            Freshness::Fresh => "fresh",
            Freshness::Stale => "stale",
            Freshness::Unknown => "unknown",
        }
    }

    pub const ALL: [Freshness; 3] = [Freshness::Fresh, Freshness::Stale, Freshness::Unknown];
}

/// Which recorded time a rule measures from. Closed: a fourth basis is an
/// artifact change plus a code change, which is the point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeBasis {
    /// The assertion's own `valid_from` — when the source says the claim
    /// STARTED being true.
    ValidFrom,
    /// The assertion's `occurred_at` — when the source says the event
    /// happened. Labeled and never trusted for ordering (D3), but a perfectly
    /// good anchor for "how old is this reading".
    OccurredAt,
    /// The frame stamp of the belief revision that used the evidence — the
    /// only one of the three the STORE wrote itself.
    BeliefRevisionTime,
}

/// What makes a facet go stale. Closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Staleness {
    /// Never. A charter's rationale does not expire because time passed; it
    /// expires when somebody changes the charter, which is a revision and
    /// therefore a different facet.
    Durable,
    After {
        seconds: u64,
    },
}

/// One predicate class's rule.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub predicate_class: String,
    pub predicates: Vec<String>,
    pub time_basis: TimeBasis,
    pub staleness: Staleness,
    /// Whether a CURRENT review attestation may contribute an anchor.
    ///
    /// Off by default and on for exactly one shipped class, because
    /// attestation is not evidence (D8/M22): a human saying "I checked this"
    /// can legitimately restart a rationale's clock, and cannot make a CI
    /// result from last week describe today's build.
    pub attestation_may_anchor: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    format: u64,
    artifact_version: u64,
    rule_version: String,
    rules: Vec<Rule>,
}

/// The loaded table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    pub artifact_version: u64,
    /// Stamped on every transition, so an event can be read against the rules
    /// that produced it. ONE version for the whole artifact: a per-rule
    /// version would make "the rules changed" ambiguous exactly when the
    /// re-evaluation sweep has to decide what to re-emit.
    pub rule_version: String,
    rules: Vec<Rule>,
    by_predicate: BTreeMap<String, usize>,
}

impl Rules {
    /// The rule for a predicate, or `None` — which means `unknown`, not a
    /// default.
    pub fn rule_for(&self, predicate: Option<&str>) -> Option<&Rule> {
        let predicate = predicate?;
        self.by_predicate.get(predicate).map(|i| &self.rules[*i])
    }

    pub fn all(&self) -> &[Rule] {
        &self.rules
    }
}

/// Load the shipped rules, with the artifact's bytes checked against the
/// committed digest.
pub fn load() -> Result<Rules, String> {
    let expected = FRESHNESS_DIGEST.trim();
    let actual = sha256_hex(FRESHNESS_JSON.as_bytes());
    if actual != expected {
        return Err(format!(
            "shared/policy/freshness.v1.json hashes to {actual}, and the committed digest says \
             {expected} — regenerate the digest deliberately, or find out who changed when this \
             app calls a belief stale"
        ));
    }
    let artifact: Artifact =
        serde_json::from_str(FRESHNESS_JSON).map_err(|e| format!("freshness.v1.json: {e}"))?;
    if artifact.format != 1 {
        return Err(format!(
            "freshness format {} is not one this build speaks",
            artifact.format
        ));
    }
    if artifact.rule_version.is_empty() {
        return Err("rule_version must be non-empty — every transition is stamped with it".into());
    }
    if artifact.rules.is_empty() {
        return Err(
            "freshness.v1.json declares no rules — an empty table is indistinguishable from a \
             failed load, and would silently make every belief's freshness unknown"
                .into(),
        );
    }

    let mut by_predicate: BTreeMap<String, usize> = BTreeMap::new();
    let mut classes: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for (index, rule) in artifact.rules.iter().enumerate() {
        if rule.predicate_class.is_empty() {
            return Err("a rule must name its predicate class".into());
        }
        if !classes.insert(rule.predicate_class.as_str()) {
            return Err(format!(
                "predicate class {:?} is declared twice",
                rule.predicate_class
            ));
        }
        if rule.predicates.is_empty() {
            return Err(format!(
                "predicate class {:?} matches no predicate — a rule nothing can match is not a \
                 rule, it is a comment",
                rule.predicate_class
            ));
        }
        if let Staleness::After { seconds } = rule.staleness {
            if seconds == 0 {
                return Err(format!(
                    "predicate class {:?} goes stale after zero seconds — a claim that is stale \
                     the instant it is recorded is the durable variant's opposite, and neither \
                     is what a zero means",
                    rule.predicate_class
                ));
            }
        }
        for predicate in &rule.predicates {
            if predicate.is_empty() {
                return Err(format!(
                    "predicate class {:?} lists an empty predicate",
                    rule.predicate_class
                ));
            }
            if by_predicate.insert(predicate.clone(), index).is_some() {
                return Err(format!(
                    "predicate {predicate:?} is claimed by two classes — one predicate, one \
                     freshness rule, or the answer depends on which row was read first"
                ));
            }
        }
    }

    Ok(Rules {
        artifact_version: artifact.artifact_version,
        rule_version: artifact.rule_version,
        rules: artifact.rules,
        by_predicate,
    })
}

/// One resolved anchor: the time a rule measures from, and the event that
/// supplied it.
///
/// The event id is carried because the maximum is over `(timestamp,
/// event_id)` — two supports recorded at the same instant must not have their
/// order decided by map iteration — and because a surface that says "stale
/// since Tuesday" should be able to say which piece of evidence Tuesday came
/// from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub at: chrono::DateTime<chrono::Utc>,
    pub event_id: String,
}

/// What a facet's freshness is, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    pub freshness: Freshness,
    /// `None` when no rule matched the predicate, or no candidate time was
    /// known — the two ways to arrive at `unknown`, kept distinguishable by
    /// [`Assessment::rule_matched`].
    pub anchor: Option<Anchor>,
    /// The instant the facet becomes stale, when it can. `None` for a durable
    /// rule, an unmatched predicate, or an unknown anchor.
    pub effective_at: Option<chrono::DateTime<chrono::Utc>>,
    pub predicate_class: Option<String>,
}

impl Assessment {
    pub fn rule_matched(&self) -> bool {
        self.predicate_class.is_some()
    }

    /// The value this facet held at its own anchor — the state a first
    /// transition moves AWAY from.
    ///
    /// Clock-free by construction: at the anchor, a matched rule with a known
    /// anchor is fresh and everything else is unknown.
    pub fn initial(&self) -> Freshness {
        match (self.rule_matched(), &self.anchor) {
            (true, Some(_)) => Freshness::Fresh,
            _ => Freshness::Unknown,
        }
    }
}

/// Derive one facet's freshness as of an explicit instant.
///
/// `as_of` is an argument for the reason the whole module says twice: a
/// derivation that read the wall clock would answer differently depending on
/// when it was asked, about a ledger that had not moved.
pub fn assess(
    state: &EpistemicState,
    rules: &Rules,
    facet: &Facet,
    as_of: chrono::DateTime<chrono::Utc>,
) -> Assessment {
    let Some(rule) = rules.rule_for(facet.key.predicate.value()) else {
        return Assessment {
            freshness: Freshness::Unknown,
            anchor: None,
            effective_at: None,
            predicate_class: None,
        };
    };
    let anchor = anchor_for(state, rule, facet);
    let effective_at = match (&anchor, rule.staleness) {
        (Some(anchor), Staleness::After { seconds }) => anchor
            .at
            .checked_add_signed(chrono::Duration::seconds(seconds as i64)),
        _ => None,
    };
    let freshness = match (&anchor, effective_at) {
        (None, _) => Freshness::Unknown,
        (Some(_), None) => Freshness::Fresh, // durable, and anchored
        (Some(_), Some(boundary)) if as_of >= boundary => Freshness::Stale,
        (Some(_), Some(_)) => Freshness::Fresh,
    };
    Assessment {
        freshness,
        anchor,
        effective_at,
        predicate_class: Some(rule.predicate_class.clone()),
    }
}

/// The maximum `(timestamp, event_id)` among the candidates a rule admits.
fn anchor_for(state: &EpistemicState, rule: &Rule, facet: &Facet) -> Option<Anchor> {
    let mut best: Option<Anchor> = None;
    let mut consider = |stamp: Option<&str>, event_id: &str| {
        let Some(stamp) = stamp else { return };
        // A time that will not parse is a missing candidate, not a zero. The
        // writer stamps RFC3339 and a source-supplied field could be
        // anything; guessing here would let one malformed string decide a
        // staleness alarm.
        let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(stamp) else {
            return;
        };
        let at = parsed.with_timezone(&chrono::Utc);
        let better = match &best {
            None => true,
            Some(current) => (at, event_id) > (current.at, current.event_id.as_str()),
        };
        if better {
            best = Some(Anchor {
                at,
                event_id: event_id.to_string(),
            });
        }
    };

    match rule.time_basis {
        TimeBasis::BeliefRevisionTime => {
            let revision = facet.key.belief_revision_event_id.as_str();
            consider(
                state
                    .belief_revision_times
                    .get(revision)
                    .map(String::as_str),
                revision,
            );
        }
        TimeBasis::ValidFrom | TimeBasis::OccurredAt => {
            for event_id in &facet.supports {
                let Some(assertion) = state.assertion_facets.get(event_id) else {
                    continue;
                };
                let stamp = match rule.time_basis {
                    TimeBasis::ValidFrom => assertion.valid_time.from.as_deref(),
                    TimeBasis::OccurredAt => assertion.observed_at.as_deref(),
                    TimeBasis::BeliefRevisionTime => unreachable!("handled above"),
                };
                consider(stamp, event_id);
            }
        }
    }

    if rule.attestation_may_anchor {
        // D8 channel 1, and ONLY where a rule says so. The attestation has to
        // be current — one that predates this revision says a human checked
        // something else. It never enters Support; this is a clock, not
        // evidence.
        if let Some(belief) = state.beliefs.get(&facet.key.belief_id) {
            if let Some((attestation_event, attested_revision)) = &belief.attested {
                if attested_revision == &facet.key.belief_revision_event_id {
                    consider(
                        state
                            .belief_attestation_times
                            .get(attestation_event)
                            .map(String::as_str),
                        attestation_event,
                    );
                }
            }
        }
    }

    best
}

/// Assess every facet of every live belief, in facet-key order.
pub fn assess_all(
    state: &EpistemicState,
    rules: &Rules,
    as_of: chrono::DateTime<chrono::Utc>,
) -> Vec<(BeliefFacetKey, Assessment)> {
    let mut out: Vec<(BeliefFacetKey, Assessment)> = super::facet::all_facets(state)
        .into_iter()
        .map(|facet| {
            let assessment = assess(state, rules, &facet, as_of);
            (facet.key, assessment)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture::{B_ONE, OBS_AUTHORITY, OBS_INFERRED, REV_ONE};
    use crate::dynamics::facet::{facets_of, tests::assertion_facet};
    use crate::ledger::schema::Stage;

    fn at(stamp: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn one_facet(state: &EpistemicState) -> Facet {
        let belief = state.beliefs.get(B_ONE).unwrap();
        let mut facets = facets_of(state, belief);
        assert_eq!(facets.len(), 1, "the fixture is one facet");
        facets.remove(0)
    }

    #[test]
    fn the_shipped_artifact_loads_and_its_digest_is_over_the_bytes_that_ship() {
        let rules = load().expect("the shipped rules");
        assert_eq!(rules.rule_version, "freshness-v1");
        assert_eq!(rules.all().len(), 3);
        assert_eq!(
            sha256_hex(FRESHNESS_JSON.as_bytes()),
            FRESHNESS_DIGEST.trim(),
            "regenerate shared/policy/freshness.v1.sha256"
        );
    }

    #[test]
    fn the_three_classes_are_the_designs_three() {
        // §45's named defaults: charter rationale durable, CI status hours,
        // shipping BOM days. If one of these changes, it changes here and in
        // the artifact together, deliberately.
        let rules = load().unwrap();
        let charter = rules.rule_for(Some("charter_rationale")).unwrap();
        assert_eq!(charter.staleness, Staleness::Durable);
        assert_eq!(charter.time_basis, TimeBasis::BeliefRevisionTime);
        assert!(charter.attestation_may_anchor);

        let ci = rules.rule_for(Some("ci_status")).unwrap();
        assert_eq!(ci.staleness, Staleness::After { seconds: 6 * 3600 });
        assert!(!ci.attestation_may_anchor);

        let bom = rules.rule_for(Some("bill_of_materials")).unwrap();
        assert_eq!(
            bom.staleness,
            Staleness::After {
                seconds: 7 * 24 * 3600
            }
        );
        assert_eq!(bom.time_basis, TimeBasis::ValidFrom);
    }

    #[test]
    fn a_predicate_with_no_rule_is_unknown_and_never_fresh() {
        // The load-bearing default. "Fresh" is a claim, and no rule means
        // nobody has authorised making it.
        let mut state = crate::dynamics::facet::tests::base();
        state.assertion_facets.insert(
            OBS_AUTHORITY.into(),
            assertion_facet("status", None, "2026-08-01T00:00:00Z"),
        );
        state.assertion_facets.insert(
            OBS_INFERRED.into(),
            assertion_facet("status", None, "2026-08-01T00:00:00Z"),
        );
        let rules = load().unwrap();
        let assessment = assess(
            &state,
            &rules,
            &one_facet(&state),
            at("2026-08-12T00:00:00Z"),
        );
        assert_eq!(assessment.freshness, Freshness::Unknown);
        assert!(!assessment.rule_matched());
        assert_eq!(assessment.effective_at, None);
    }

    #[test]
    fn a_matched_rule_with_no_known_time_is_unknown_rather_than_ancient() {
        // Treating a missing stamp as the epoch would manufacture a staleness
        // alarm out of a field nobody filled in.
        let mut state = crate::dynamics::facet::tests::base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            // `ci_status` measures from occurred_at, and this fixture's
            // assertions have none.
            state.assertion_facets.insert(
                event.into(),
                assertion_facet(
                    "ci_status",
                    Some(Stage::Implemented),
                    "2026-08-01T00:00:00Z",
                ),
            );
        }
        let rules = load().unwrap();
        let assessment = assess(
            &state,
            &rules,
            &one_facet(&state),
            at("2030-01-01T00:00:00Z"),
        );
        assert_eq!(assessment.freshness, Freshness::Unknown);
        assert!(
            assessment.rule_matched(),
            "the rule matched; the time did not"
        );
        assert_eq!(assessment.anchor, None);
    }

    #[test]
    fn the_boundary_is_inclusive_and_the_second_before_it_is_still_fresh() {
        let mut state = crate::dynamics::facet::tests::base();
        for (event, occurred) in [
            (OBS_AUTHORITY, "2026-08-12T00:00:00Z"),
            (OBS_INFERRED, "2026-08-12T03:00:00Z"),
        ] {
            let mut facet = assertion_facet("ci_status", Some(Stage::Implemented), occurred);
            facet.observed_at = Some(occurred.into());
            state.assertion_facets.insert(event.into(), facet);
        }
        let rules = load().unwrap();
        let facet = one_facet(&state);

        // Anchored on the NEWER of the two occurred_at stamps: 03:00 + 6h.
        let assessment = assess(&state, &rules, &facet, at("2026-08-12T08:59:59Z"));
        assert_eq!(assessment.freshness, Freshness::Fresh);
        assert_eq!(assessment.effective_at, Some(at("2026-08-12T09:00:00Z")));
        assert_eq!(
            assessment.anchor.as_ref().unwrap().event_id,
            OBS_INFERRED,
            "the maximum, not the first support walked"
        );

        assert_eq!(
            assess(&state, &rules, &facet, at("2026-08-12T09:00:00Z")).freshness,
            Freshness::Stale,
            "at the boundary it is stale — a rule that said `after 6h` and meant `after 6h and \
             one second` would be a different rule"
        );
    }

    #[test]
    fn one_unknown_support_does_not_erase_a_known_anchor() {
        let mut state = crate::dynamics::facet::tests::base();
        let mut known = assertion_facet(
            "ci_status",
            Some(Stage::Implemented),
            "2026-08-12T00:00:00Z",
        );
        known.observed_at = Some("2026-08-12T00:00:00Z".into());
        state.assertion_facets.insert(OBS_AUTHORITY.into(), known);
        state.assertion_facets.insert(
            OBS_INFERRED.into(),
            assertion_facet(
                "ci_status",
                Some(Stage::Implemented),
                "2026-08-12T00:00:00Z",
            ),
        );
        let rules = load().unwrap();
        let assessment = assess(
            &state,
            &rules,
            &one_facet(&state),
            at("2026-08-12T01:00:00Z"),
        );
        assert_eq!(assessment.freshness, Freshness::Fresh);
        assert_eq!(assessment.anchor.unwrap().event_id, OBS_AUTHORITY);
    }

    #[test]
    fn a_durable_rule_is_fresh_forever_and_schedules_nothing() {
        let mut state = crate::dynamics::facet::tests::base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state.assertion_facets.insert(
                event.into(),
                assertion_facet("charter_rationale", None, "2026-08-01T00:00:00Z"),
            );
        }
        state
            .belief_revision_times
            .insert(REV_ONE.into(), "2026-08-01T00:00:00Z".into());
        let rules = load().unwrap();
        let assessment = assess(
            &state,
            &rules,
            &one_facet(&state),
            at("2099-01-01T00:00:00Z"),
        );
        assert_eq!(assessment.freshness, Freshness::Fresh);
        assert_eq!(
            assessment.effective_at, None,
            "nothing to schedule — a durable facet never crosses a boundary"
        );
    }

    #[test]
    fn a_current_attestation_anchors_only_where_the_rule_permits_it() {
        // Attestation is not evidence. It may restart a rationale's clock
        // because the rule says so, and may never restart a CI result's.
        let mut state = crate::dynamics::facet::tests::base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state.assertion_facets.insert(
                event.into(),
                assertion_facet("charter_rationale", None, "2026-08-01T00:00:00Z"),
            );
        }
        state
            .belief_revision_times
            .insert(REV_ONE.into(), "2026-08-01T00:00:00Z".into());
        let attestation = "70000000000000000000000000000001";
        state
            .belief_attestation_times
            .insert(attestation.into(), "2026-08-09T00:00:00Z".into());
        state
            .beliefs
            .get_mut(B_ONE)
            .unwrap()
            .attested
            .replace((attestation.into(), REV_ONE.into()));

        let rules = load().unwrap();
        let assessment = assess(
            &state,
            &rules,
            &one_facet(&state),
            at("2026-08-12T00:00:00Z"),
        );
        assert_eq!(
            assessment.anchor.as_ref().unwrap().event_id,
            attestation,
            "the attestation is the newer anchor and the rule allows it"
        );

        // The same attestation against a rule that forbids it: ignored.
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            let mut facet = assertion_facet("ci_status", None, "2026-08-01T00:00:00Z");
            facet.observed_at = Some("2026-08-01T00:00:00Z".into());
            state.assertion_facets.insert(event.into(), facet);
        }
        let assessment = assess(
            &state,
            &rules,
            &one_facet(&state),
            at("2026-08-12T00:00:00Z"),
        );
        assert_ne!(
            assessment.anchor.as_ref().unwrap().event_id,
            attestation,
            "a CI result does not become current because somebody reviewed the belief"
        );
        assert_eq!(
            assessment.anchor.as_ref().unwrap().event_id,
            OBS_INFERRED,
            "the two supports carry the same stamp, so the event id breaks the tie — the \
             maximum is over (timestamp, event_id) precisely so map order cannot decide it"
        );
        assert_eq!(assessment.freshness, Freshness::Stale);
    }

    #[test]
    fn an_attestation_that_predates_the_revision_anchors_nothing() {
        let mut state = crate::dynamics::facet::tests::base();
        for event in [OBS_AUTHORITY, OBS_INFERRED] {
            state.assertion_facets.insert(
                event.into(),
                assertion_facet("charter_rationale", None, "2026-08-01T00:00:00Z"),
            );
        }
        state
            .belief_revision_times
            .insert(REV_ONE.into(), "2026-08-01T00:00:00Z".into());
        let attestation = "70000000000000000000000000000001";
        state
            .belief_attestation_times
            .insert(attestation.into(), "2026-08-09T00:00:00Z".into());
        state
            .beliefs
            .get_mut(B_ONE)
            .unwrap()
            .attested
            // Pinned to some OTHER revision: a human checked something else.
            .replace((
                attestation.into(),
                "10000000000000000000000000000009".into(),
            ));
        let rules = load().unwrap();
        let assessment = assess(
            &state,
            &rules,
            &one_facet(&state),
            at("2026-08-12T00:00:00Z"),
        );
        assert_eq!(assessment.anchor.unwrap().event_id, REV_ONE);
    }

    #[test]
    fn the_same_state_at_the_same_instant_assesses_identically() {
        let state = crate::dynamics::facet::tests::base();
        let rules = load().unwrap();
        let now = at("2026-08-12T00:00:00Z");
        assert_eq!(
            assess_all(&state, &rules, now),
            assess_all(&state, &rules, now)
        );
    }

    #[test]
    fn nothing_in_this_module_reads_the_clock() {
        // The rule the whole design rests on: freshness replay must be
        // byte-identical a week later, which is impossible if any of this
        // asks the operating system what time it is.
        let source = include_str!("freshness.rs");
        let body = source
            .split("#[cfg(test)]")
            .next()
            .expect("the non-test half")
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["Utc::now", "SystemTime::now", "Instant::now", "Local::now"] {
            assert!(
                !body.contains(forbidden),
                "{forbidden} appears in the freshness derivation — `as_of` is an argument"
            );
        }
    }

    /// Regenerate `shared/policy/freshness.v1.sha256` after a DELIBERATE edit
    /// to the rules. Ignored, like the policy and budget digests, so the suite
    /// never quietly blesses a change to when this app calls a belief stale.
    #[test]
    #[ignore = "regeneration is a deliberate act — run with --ignored after editing the artifact"]
    fn write_freshness_digest() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/policy/freshness.v1.sha256");
        std::fs::write(
            &path,
            format!("{}\n", sha256_hex(FRESHNESS_JSON.as_bytes())),
        )
        .unwrap();
    }
}
