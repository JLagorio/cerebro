//! `shared/policy/goldens/*.json` — proposal + preconditions → expected
//! verdict + destiny (M24.1).
//!
//! The goldens are the parity mechanism. Rust and TS each have an
//! interpreter over the shared table; what stops the two from drifting is
//! not review but this fixture set, replayed identically by `cargo test`
//! and `pnpm test:run` from the same files.
//!
//! They land BEFORE the Rust interpreter on purpose: writing the expected
//! verdicts as data first forces the table's semantics to be settled as
//! data, rather than discovered as whatever the first engine happened to do.
//!
//! Each fixture carries a full `ProposalV1` body per the frozen M24 schema.
//! M24.1 reads the table-decidable projection of it (op, transition,
//! declared risk, target classes, transition cause, payload discriminators);
//! M24.3 additionally deserializes the whole body into real types, and M24.4
//! replays them through the state-aware interpreter. The files are authored
//! once and asserted harder each phase.
//!
//! `rust_only: true` marks a fixture whose expectation depends on CAS,
//! ancestry, or logical-batch semantics that are deliberately out of the
//! mock's scope — declared, never silently omitted. What the TS runner still
//! asserts over those files is the ARTIFACT: that the op declares the code
//! possible, and that the code declares a destiny. That is the half parity
//! is actually about.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::risk::{SignalValue, Signals};
use super::table::{Destiny, PolicyTable, Risk};
use super::verdict::{table_verdict, ProposalFacts, Verdict};

pub const GOLDENS_DIR: &str = "shared/policy/goldens";

/// The escalator signal as a fixture writes it: exactly one shape, so a
/// typo cannot silently become "no signal".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub enum GoldenSignal {
    Flag(bool),
    Count(u64),
}

impl From<&GoldenSignal> for SignalValue {
    fn from(signal: &GoldenSignal) -> SignalValue {
        match signal {
            GoldenSignal::Flag(flag) => SignalValue::Flag(*flag),
            GoldenSignal::Count(count) => SignalValue::Count(*count),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoldenExpectation {
    /// `applied | queued | rejected`.
    pub verdict: String,
    /// Absent when the refusal happened before risk resolved.
    #[serde(default)]
    pub effective_risk: Option<Risk>,
    #[serde(default)]
    pub escalated_by: Vec<String>,
    #[serde(default)]
    pub rejection: Option<String>,
    #[serde(default)]
    pub destiny: Option<Destiny>,
    /// The `risk_ladder` review mode, for the CRITICAL diff rung.
    #[serde(default)]
    pub review: Option<String>,
}

/// The support graph a self-ancestry fixture evaluates against (M26.3).
///
/// Three explicit hop kinds, exactly the ones `ancestry::no_self_ancestry`
/// walks — nothing here infers a dependency from similarity or timing. The
/// reached-revision's-own-basis hop is deliberately NOT expressible from a
/// fixture: it needs a whole `BeliefState`, and its vectors live in
/// `ancestry.rs` where the graph can be built in code. These files exist to
/// pin the BINDING, not to re-litigate the walk.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoldenAncestry {
    /// `<belief-revision event id>` -> the Belief it is a revision of.
    #[serde(default)]
    pub belief_revisions: BTreeMap<String, String>,
    /// `<observation event id>` -> the belief revisions it was derived FROM.
    #[serde(default)]
    pub derived_from: BTreeMap<String, Vec<String>>,
    /// `<observation event id>` -> its lineage parents.
    #[serde(default)]
    pub lineage: BTreeMap<String, Vec<String>>,
}

impl GoldenAncestry {
    fn is_empty(&self) -> bool {
        self.belief_revisions.is_empty() && self.derived_from.is_empty() && self.lineage.is_empty()
    }

    /// The reducer state this graph describes.
    fn state(&self) -> crate::ledger::reduce::EpistemicState {
        use crate::ledger::reduce::{EpistemicState, ObservationState};
        use crate::ledger::schema::{LineageKind, ObservationKind, SubjectRef};

        let mut state = EpistemicState::default();
        for (revision_event, belief_id) in &self.belief_revisions {
            state
                .belief_revision_events
                .insert(revision_event.clone(), (belief_id.clone(), 1));
        }
        for (observation, revisions) in &self.derived_from {
            for revision in revisions {
                state
                    .derived_belief_sources
                    .push((observation.clone(), revision.clone()));
            }
        }
        for (observation, parents) in &self.lineage {
            state.observations.insert(
                observation.clone(),
                ObservationState {
                    event_id: observation.clone(),
                    seq: 1,
                    kind: ObservationKind::DerivedContent,
                    source_id: String::new(),
                    source_registration_event_id: String::new(),
                    subject: SubjectRef::None,
                    effective_entity: None,
                    effective_resolution_event: None,
                    authority: None,
                    assertion_basis: None,
                    absence: None,
                    actor: String::new(),
                    lineage_parents: parents
                        .iter()
                        .map(|parent| (LineageKind::DerivedFrom, parent.clone()))
                        .collect(),
                },
            );
        }
        state
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Golden {
    pub name: String,
    /// Why this fixture exists — read by whoever changes the table next.
    pub why: String,
    #[serde(default)]
    pub rust_only: bool,
    /// Server-derived escalator signals, already folded across targets.
    #[serde(default)]
    pub signals: BTreeMap<String, GoldenSignal>,
    /// `"<class>/<id>" -> version` — the M22 `state_versions` this fixture
    /// evaluates its expected-version CAS against. A fixture that sets this
    /// must be `rust_only`: CAS is out of the mock's scope by declaration,
    /// and the mark is what says so out loud (M24.5).
    #[serde(default)]
    pub versions: BTreeMap<String, u64>,
    /// The support graph the preventive anti-self-ancestry walk runs over
    /// (M26.3). Like `versions`, declaring one makes the fixture `rust_only`:
    /// the walk reads reducer state the mock has no counterpart for.
    #[serde(default)]
    pub ancestry: GoldenAncestry,
    /// A complete `ProposalV1` body.
    pub proposal: serde_json::Value,
    pub expect: GoldenExpectation,
}

fn string_at(value: &serde_json::Value, pointer: &str) -> Result<String, String> {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("proposal has no string at {pointer}"))
}

impl Golden {
    /// The table-decidable projection of the fixture's proposal. Identical
    /// extraction in TS — the shape is the frozen schema's, not this
    /// module's invention.
    pub fn facts(&self, table: &PolicyTable) -> Result<ProposalFacts, String> {
        let op = string_at(&self.proposal, "/op/kind")?;
        let declared_risk: Risk = serde_json::from_value(
            self.proposal
                .pointer("/declared_risk")
                .cloned()
                .ok_or("proposal has no declared_risk")?,
        )
        .map_err(|e| format!("declared_risk: {e}"))?;
        let transition_cause = string_at(&self.proposal, "/basis/transition_cause")?;

        let targets = self
            .proposal
            .pointer("/targets")
            .and_then(serde_json::Value::as_array)
            .ok_or("proposal has no targets array")?;
        let mut target_classes: Vec<String> = targets
            .iter()
            .map(|t| string_at(t, "/target_class"))
            .collect::<Result<_, _>>()?;
        target_classes.sort();
        target_classes.dedup();

        // Payload discriminators: the string-valued leaves of the payload,
        // which is all a `conditional_capabilities.when` or a
        // `transition_selector.field` may match on.
        let payload_conditions: BTreeMap<String, String> = self
            .proposal
            .pointer("/op/payload")
            .and_then(serde_json::Value::as_object)
            .map(|payload| {
                payload
                    .iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        let transition = table
            .transition_for(&op, &payload_conditions)
            .ok_or_else(|| format!("{op}: the payload selects no transition"))?;

        let signals: Signals = self
            .signals
            .iter()
            .map(|(name, signal)| (name.clone(), SignalValue::from(signal)))
            .collect();

        Ok(ProposalFacts {
            op,
            transition,
            declared_risk,
            target_classes,
            transition_cause,
            payload_conditions,
            signals,
        })
    }

    /// Assert this fixture against the shipped table. Returns the resolved
    /// verdict so a caller can report more than pass/fail.
    pub fn check(&self, table: &PolicyTable) -> Result<Verdict, String> {
        let facts = self
            .facts(table)
            .map_err(|e| format!("{}: {e}", self.name))?;

        // The preventive walk, when the fixture declares a support graph.
        // It runs before CAS because the ops' sorted `requires` lists put
        // `no_self_ancestry` ahead of `versions_current` — precedence is the
        // artifact's here exactly as it is in `preconditions::check`. And it
        // runs before the table verdict because this refusal does not depend
        // on risk: reporting an effective risk for a proposal that can never
        // apply would describe a ladder nobody climbed.
        if !self.ancestry.is_empty() {
            let proposal: crate::ledger::schema::ProposalV1 =
                serde_json::from_value(self.proposal.clone())
                    .map_err(|e| format!("{}: {e}", self.name))?;
            let outcome =
                crate::policy::ancestry::no_self_ancestry(&self.ancestry.state(), &proposal);
            let code = outcome.as_ref().err().map(|failure| failure.code);
            if code.map(str::to_string) != self.expect.rejection {
                return Err(format!(
                    "{}: expected rejection {:?}, the ancestry walk gave {code:?}",
                    self.name, self.expect.rejection
                ));
            }
            if let Err(failure) = outcome {
                return Ok(Verdict::Rejected {
                    rejection: crate::policy::verdict::Rejection {
                        code: failure.code.to_string(),
                        destiny: table
                            .destiny(failure.code)
                            .ok_or_else(|| format!("{} has no destiny", failure.code))?,
                    },
                    risk: None,
                });
            }
        }

        // The state-dependent half, when the fixture declares a world. CAS
        // runs BEFORE the table verdict is reported, because a proposal
        // aimed at a version that moved was never about today's world.
        if !self.versions.is_empty() {
            let proposal: crate::ledger::schema::ProposalV1 =
                serde_json::from_value(self.proposal.clone())
                    .map_err(|e| format!("{}: {e}", self.name))?;
            let mut state = crate::ledger::reduce::EpistemicState::default();
            for (target, version) in &self.versions {
                let (class, id) = target
                    .split_once('/')
                    .ok_or_else(|| format!("{}: {target:?} is not <class>/<id>", self.name))?;
                state.versions.insert(
                    (class.to_string(), id.to_string()),
                    (*version, String::new()),
                );
            }
            if let Err(failure) = crate::policy::preconditions::versions_current(&state, &proposal)
            {
                if Some(failure.code.to_string()) != self.expect.rejection {
                    return Err(format!(
                        "{}: expected rejection {:?}, CAS gave {:?}",
                        self.name, self.expect.rejection, failure.code
                    ));
                }
                return Ok(Verdict::Rejected {
                    rejection: crate::policy::verdict::Rejection {
                        code: failure.code.to_string(),
                        destiny: table
                            .destiny(failure.code)
                            .ok_or_else(|| format!("{} has no destiny", failure.code))?,
                    },
                    risk: None,
                });
            }
        }
        let verdict = table_verdict(table, &facts)
            .map_err(|e| format!("{}: structural failure {e:?}", self.name))?;

        let label = &self.name;
        if verdict.kind() != self.expect.verdict {
            return Err(format!(
                "{label}: expected verdict {:?}, got {:?}",
                self.expect.verdict,
                verdict.kind()
            ));
        }
        if verdict.effective_risk() != self.expect.effective_risk {
            return Err(format!(
                "{label}: expected effective risk {:?}, got {:?}",
                self.expect.effective_risk,
                verdict.effective_risk()
            ));
        }
        if verdict.escalated_by() != self.expect.escalated_by {
            return Err(format!(
                "{label}: expected escalators {:?}, got {:?}",
                self.expect.escalated_by,
                verdict.escalated_by()
            ));
        }
        let code = verdict.rejection().map(|r| r.code.clone());
        if code != self.expect.rejection {
            return Err(format!(
                "{label}: expected rejection {:?}, got {code:?}",
                self.expect.rejection
            ));
        }
        let destiny = verdict.rejection().map(|r| r.destiny);
        if destiny != self.expect.destiny {
            return Err(format!(
                "{label}: expected destiny {:?}, got {destiny:?}",
                self.expect.destiny
            ));
        }
        let review = match &verdict {
            Verdict::Queued { review, .. } => review.clone(),
            _ => None,
        };
        if review != self.expect.review {
            return Err(format!(
                "{label}: expected review {:?}, got {review:?}",
                self.expect.review
            ));
        }
        Ok(verdict)
    }
}

pub fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(GOLDENS_DIR)
}

/// Load every committed fixture, sorted by file name.
pub fn load_all() -> Result<Vec<(String, Golden)>, String> {
    let dir = goldens_dir();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let raw = std::fs::read_to_string(&path).map_err(|e| format!("{name}: {e}"))?;
            let golden: Golden = serde_json::from_str(&raw).map_err(|e| format!("{name}: {e}"))?;
            Ok((name, golden))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn every_golden_holds_against_the_shipped_table() {
        let table = PolicyTable::load().unwrap();
        let goldens = load_all().expect("goldens load");
        assert!(!goldens.is_empty(), "no goldens committed");
        for (file, golden) in &goldens {
            golden
                .check(&table)
                .unwrap_or_else(|e| panic!("{file}: {e}"));
        }
    }

    #[test]
    fn a_fixture_that_declares_a_world_declares_itself_rust_only() {
        // BY DECLARATION, NOT OMISSION. CAS, ancestry, and logical-batch
        // semantics are out of the mock's scope; a fixture that depends on
        // them says so in the file, so the TS runner skips it loudly instead
        // of the directory quietly missing the case.
        for (file, golden) in load_all().unwrap() {
            if !golden.versions.is_empty() {
                assert!(
                    golden.rust_only,
                    "{file} declares state versions but is not marked rust_only"
                );
            }
            if !golden.ancestry.is_empty() {
                assert!(
                    golden.rust_only,
                    "{file} declares a support graph but is not marked rust_only"
                );
            }
        }
    }

    #[test]
    fn the_self_ancestry_fixtures_are_present_rather_than_assumed() {
        // The refusal and its CONTROL. A directory that lost the control
        // would still pass everything else while a gate that refused every
        // proposal looked correct.
        let names: BTreeSet<String> = load_all()
            .unwrap()
            .into_iter()
            .filter(|(_, g)| !g.ancestry.is_empty())
            .map(|(_, g)| g.name)
            .collect();
        for required in [
            "evidence-derived-from-the-belief-it-would-support-is-refused",
            "a-restatement-of-the-bases-own-output-is-refused-too",
            "evidence-derived-from-another-belief-lets-the-verdict-through",
        ] {
            assert!(names.contains(required), "the {required} fixture is gone");
        }
    }

    #[test]
    fn the_cas_fixtures_are_present_rather_than_assumed() {
        // A directory that lost its version-conflict cases would still pass
        // every other assertion here, which is exactly why this one names
        // them.
        let names: BTreeSet<String> = load_all()
            .unwrap()
            .into_iter()
            .filter(|(_, g)| !g.versions.is_empty())
            .map(|(_, g)| g.name)
            .collect();
        for required in [
            "a-null-expected-version-against-something-that-exists-is-refused",
            "a-target-whose-version-moved-is-refused",
            "a-version-that-agrees-lets-the-verdict-through",
        ] {
            assert!(names.contains(required), "the {required} fixture is gone");
        }
    }

    #[test]
    fn a_goldens_declared_name_matches_its_file() {
        // The file name is what a failure message shows first; a fixture
        // whose `name` disagrees sends the reader to the wrong file.
        for (file, golden) in load_all().unwrap() {
            assert_eq!(
                format!("{}.json", golden.name),
                file,
                "fixture name and file name disagree"
            );
        }
    }

    #[test]
    fn a_rejection_expectation_always_declares_its_destiny() {
        // The D5 split is the point: a rejection with no declared destiny
        // is exactly the telemetry leak the milestone is guarding against.
        for (file, golden) in load_all().unwrap() {
            assert_eq!(
                golden.expect.rejection.is_some(),
                golden.expect.destiny.is_some(),
                "{file}: rejection and destiny must be declared together"
            );
        }
    }

    #[test]
    fn the_goldens_exercise_every_escalator_and_both_destinies() {
        // The design requires a golden per escalator; a destiny with no
        // fixture is a routing rule nobody has ever run.
        let table = PolicyTable::load().unwrap();
        let goldens = load_all().unwrap();
        for escalator in &table.escalators {
            assert!(
                goldens
                    .iter()
                    .any(|(_, g)| g.expect.escalated_by.contains(&escalator.signal)),
                "no golden fires the {:?} escalator",
                escalator.signal
            );
        }
        let destinies: BTreeSet<Destiny> = goldens
            .iter()
            .filter_map(|(_, g)| g.expect.destiny)
            .collect();
        assert!(
            destinies.contains(&Destiny::Ledger),
            "no ledger-destined golden"
        );
        assert!(
            destinies.contains(&Destiny::Operational),
            "no operational-destined golden"
        );
    }

    #[test]
    fn every_golden_rejection_is_one_its_op_declares_possible() {
        // A fixture asserting a code the op's `possible_rejections` omits
        // would mean the table's per-op set is a lie.
        let table = PolicyTable::load().unwrap();
        for (file, golden) in load_all().unwrap() {
            let Some(code) = &golden.expect.rejection else {
                continue;
            };
            let facts = golden.facts(&table).unwrap();
            let rule = table.op(&facts.op).unwrap();
            assert!(
                rule.possible_rejections.contains(code),
                "{file}: {} does not declare {code} possible",
                facts.op
            );
        }
    }
}
