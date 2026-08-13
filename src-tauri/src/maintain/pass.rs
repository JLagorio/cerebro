//! The maintenance pass (M26.6b) — say it once, and let the base say when to
//! say it again.
//!
//! **The finding's key is its content.** `sha256("cerebro-maintenance-
//! finding-v1\0" + store + "\0" + kind + "\0" + canonical json)`. A finding
//! already in the ledger is one the pass has said, and re-deriving the same
//! key means nothing about the base changed — so it is not said twice. When
//! the underlying beliefs move, the key moves with them and the finding comes
//! back on its own.
//!
//! That is the whole suppression mechanism, and it is deliberately not a
//! clock. "Do not mention this again for a week" would be time deciding what
//! is worth attention, which is the shape silence-never-resolves exists to
//! forbid — see [`super::candidates`], whose non-test half cannot even name a
//! timestamp.
//!
//! **It proposes; it never applies.** The run reaches the M24 proposal tools
//! and nothing else. A CRITICAL `merge_entities` becomes a card a person
//! decides; a LOW `merge_beliefs_exact` does not need one. There is no
//! maintenance opcode and no maintenance bypass (§16).
//!
//! **Nothing new means no run.** A pass with nothing to say does not spend a
//! subprocess to say it.

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::sha256_hex;

use super::candidates::{self, Attention, Compress, ExactMerge, Findings};

/// The actor this pass's proposals are attributed to.
pub const ACTOR: &str = "agent:m26-maintenance";

/// The lane it spends from. Ambient: budgeted, gated, and refusable — unlike
/// the attended assembly, nobody is waiting for this.
pub const LANE: &str = "behind";

/// One thing the pass found, keyed by what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub key: String,
    pub kind: &'static str,
    /// The belief or entity it is about — what a surface groups by.
    pub subject_id: String,
    pub detail: serde_json::Value,
}

/// What the pass did.
#[derive(Debug, Clone, PartialEq)]
pub enum Tick {
    /// Nothing the base has not already been told.
    NothingNew,
    Ran {
        said: Vec<Finding>,
        /// Findings the pass re-derived and did not repeat.
        already_said: usize,
    },
}

/// What one run needs from the outside world. Injected for the reason
/// `ingest::cli` and `assembly::ask` inject theirs: the interesting failures
/// do not need a real subprocess to reproduce.
///
/// `run_id` is the DISPATCH lease's id, handed in rather than held by the
/// runner: the lease is claimed by [`super::schedule`] after the runner is
/// built, so a runner that carried its own id would carry the wrong one — and
/// the meter would book a real run's tokens against a row nobody owns.
pub trait Runner {
    fn run(&self, run_id: &str, prompt: &str) -> Result<(), String>;
}

pub struct Context<'a> {
    pub vault_id: &'a str,
    pub store_uuid: &'a str,
    pub chain_head: &'a str,
}

/// Look, say what is new, and remember having said it.
pub fn tick<R: Runner>(
    conn: &Connection,
    context: &Context<'_>,
    state: &EpistemicState,
    runner: &R,
    run_id: &str,
    now: DateTime<Utc>,
) -> Result<Tick, String> {
    let all = keyed(context.store_uuid, &candidates::find(state));
    let mut fresh = Vec::new();
    let mut already_said = 0usize;
    for finding in all {
        if said_before(conn, context, &finding.key)? {
            already_said += 1;
            continue;
        }
        fresh.push(finding);
    }
    if fresh.is_empty() {
        // A pass with nothing to say does not spend a subprocess saying it.
        return Ok(Tick::NothingNew);
    }

    runner.run(run_id, &super::prompt::render(&fresh).text)?;
    // Recorded AFTER the run, so a run that could not start is one the pass
    // will try again. Recording first would silence a finding nobody ever
    // heard.
    for finding in &fresh {
        record(conn, context, finding, now)?;
    }
    Ok(Tick::Ran {
        said: fresh,
        already_said,
    })
}

/// Give every finding its content-derived key.
pub fn keyed(store_uuid: &str, findings: &Findings) -> Vec<Finding> {
    let mut out = Vec::new();
    for merge in &findings.exact_merges {
        out.push(finding(store_uuid, "exact_merge", &merge.entity_id, merge));
    }
    for compress in &findings.compress {
        out.push(finding(
            store_uuid,
            "compress",
            &compress.belief_id,
            compress,
        ));
    }
    for attention in &findings.attention {
        out.push(finding(
            store_uuid,
            "attention",
            &attention.belief_id,
            attention,
        ));
    }
    out
}

fn finding<T: Detail>(
    store_uuid: &str,
    kind: &'static str,
    subject_id: &str,
    value: &T,
) -> Finding {
    let detail = value.detail();
    Finding {
        key: derive_key(store_uuid, kind, &detail),
        kind,
        subject_id: subject_id.to_string(),
        detail,
    }
}

/// `sha256("cerebro-maintenance-finding-v1\0" + store + "\0" + kind + "\0" +
/// canonical json)`.
pub fn derive_key(store_uuid: &str, kind: &str, detail: &serde_json::Value) -> String {
    let mut bytes = b"cerebro-maintenance-finding-v1\0".to_vec();
    for part in [store_uuid, kind, &detail.to_string()] {
        bytes.extend_from_slice(part.as_bytes());
        bytes.push(0);
    }
    sha256_hex(&bytes)
}

/// How a finding renders itself for hashing and for the prompt. Explicit
/// rather than `Serialize`, so the bytes the key is derived from are visible
/// in one place and a field added to a finder cannot silently change every
/// key that was ever recorded without somebody noticing here.
trait Detail {
    fn detail(&self) -> serde_json::Value;
}

impl Detail for ExactMerge {
    fn detail(&self) -> serde_json::Value {
        serde_json::json!({
            "entity_id": self.entity_id,
            "belief_ids": self.belief_ids,
            "source_id": self.source_id,
        })
    }
}

impl Detail for Compress {
    fn detail(&self) -> serde_json::Value {
        serde_json::json!({
            "belief_id": self.belief_id,
            "entity_id": self.entity_id,
            "superseded_by": self.superseded_by,
        })
    }
}

impl Detail for Attention {
    fn detail(&self) -> serde_json::Value {
        serde_json::json!({
            "belief_id": self.belief_id,
            "entity_id": self.entity_id,
            "signals": self
                .signals
                .iter()
                .map(|signal| signal.as_str())
                .collect::<Vec<_>>(),
        })
    }
}

pub(crate) fn said_before(
    conn: &Connection,
    context: &Context<'_>,
    key: &str,
) -> Result<bool, String> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM maintenance_findings \
             WHERE vault_id = ?1 AND store_uuid = ?2 AND finding_key = ?3",
            rusqlite::params![context.vault_id, context.store_uuid, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.is_some())
}

fn record(
    conn: &Connection,
    context: &Context<'_>,
    finding: &Finding,
    now: DateTime<Utc>,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO maintenance_findings \
         (vault_id, store_uuid, finding_key, kind, subject_id, detail, chain_head, surfaced_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            context.vault_id,
            context.store_uuid,
            finding.key,
            finding.kind,
            finding.subject_id,
            finding.detail.to_string(),
            context.chain_head,
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ],
    )
    .map_err(|e| format!("recording finding {}: {e}", finding.key))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::fixture;
    use crate::ledger::schema::{Qualification, TransitionCause};
    use crate::vault::testutil;
    use std::cell::RefCell;

    const STORE: &str = "cafebabecafebabecafebabecafebabe";
    const HEAD: &str = "90000000000000000000000000000001";
    const LEASE: &str = "a0000000000000000000000000000001";

    fn now() -> DateTime<Utc> {
        "2026-08-12T09:00:00Z".parse().unwrap()
    }

    struct Harness {
        conn: Connection,
        vault: std::path::PathBuf,
        vault_id: String,
    }

    impl Harness {
        fn open(name: &str) -> Harness {
            let vault = testutil::temp_vault(name);
            let conn = crate::runtime::open(&vault).unwrap();
            let vault_id = crate::runtime::scope::register(&conn, &vault).unwrap();
            Harness {
                conn,
                vault,
                vault_id,
            }
        }

        fn context(&self) -> Context<'_> {
            Context {
                vault_id: &self.vault_id,
                store_uuid: STORE,
                chain_head: HEAD,
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.vault);
        }
    }

    #[derive(Default)]
    struct Spy {
        prompts: RefCell<Vec<String>>,
    }

    impl Runner for Spy {
        fn run(&self, _: &str, prompt: &str) -> Result<(), String> {
            self.prompts.borrow_mut().push(prompt.to_string());
            Ok(())
        }
    }

    struct Broken;

    impl Runner for Broken {
        fn run(&self, _: &str, _: &str) -> Result<(), String> {
            Err("the CLI would not start".into())
        }
    }

    #[test]
    fn a_finding_is_said_once_and_then_remembered() {
        let harness = Harness::open("maintain-once");
        let state = fixture::state();
        let spy = Spy::default();

        let first = tick(
            &harness.conn,
            &harness.context(),
            &state,
            &spy,
            LEASE,
            now(),
        )
        .unwrap();
        let Tick::Ran { said, already_said } = first else {
            panic!("the fixture has findings");
        };
        assert!(!said.is_empty());
        assert_eq!(already_said, 0);

        // Same base, same findings, nothing new to say — and no second run.
        let second = tick(
            &harness.conn,
            &harness.context(),
            &state,
            &spy,
            LEASE,
            now(),
        )
        .unwrap();
        assert_eq!(second, Tick::NothingNew);
        assert_eq!(spy.prompts.borrow().len(), 1, "it did not spend twice");
    }

    #[test]
    fn a_finding_that_changes_comes_back_on_its_own() {
        // The suppression is the content, not a clock: when the base moves,
        // the key moves with it.
        let harness = Harness::open("maintain-changed");
        let mut state = fixture::state();
        let spy = Spy::default();
        tick(
            &harness.conn,
            &harness.context(),
            &state,
            &spy,
            LEASE,
            now(),
        )
        .unwrap();
        assert_eq!(
            tick(
                &harness.conn,
                &harness.context(),
                &state,
                &spy,
                LEASE,
                now()
            )
            .unwrap(),
            Tick::NothingNew
        );

        // Promote the unsupported belief: a new signal, so a new key.
        state.beliefs.get_mut(fixture::B_TWO).unwrap().qualification = Qualification::Qualified;
        let again = tick(
            &harness.conn,
            &harness.context(),
            &state,
            &spy,
            LEASE,
            now(),
        )
        .unwrap();
        let Tick::Ran { said, already_said } = again else {
            panic!("the changed belief is a new finding");
        };
        assert_eq!(said.len(), 1);
        assert!(already_said > 0, "the unchanged ones were not repeated");
        assert_eq!(spy.prompts.borrow().len(), 2);
    }

    #[test]
    fn a_run_that_could_not_start_leaves_the_finding_unsaid() {
        // Recorded AFTER the run, deliberately: recording first would silence
        // a finding nobody ever heard.
        let harness = Harness::open("maintain-broken");
        let state = fixture::state();
        tick(
            &harness.conn,
            &harness.context(),
            &state,
            &Broken,
            LEASE,
            now(),
        )
        .expect_err("the runner failed");
        let count: i64 = harness
            .conn
            .query_row("SELECT count(*) FROM maintenance_findings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);

        let spy = Spy::default();
        assert!(matches!(
            tick(
                &harness.conn,
                &harness.context(),
                &state,
                &spy,
                LEASE,
                now()
            )
            .unwrap(),
            Tick::Ran { .. }
        ));
    }

    #[test]
    fn a_base_with_nothing_wrong_never_spends_a_run() {
        let harness = Harness::open("maintain-quiet");
        let spy = Spy::default();
        let outcome = tick(
            &harness.conn,
            &harness.context(),
            &EpistemicState::default(),
            &spy,
            LEASE,
            now(),
        )
        .unwrap();
        assert_eq!(outcome, Tick::NothingNew);
        assert!(spy.prompts.borrow().is_empty());
    }

    #[test]
    fn the_key_is_the_content_and_two_stores_never_share_one() {
        let findings = candidates::find(&fixture::state());
        let mine = keyed(STORE, &findings);
        let theirs = keyed("beefbeefbeefbeefbeefbeefbeefbeef", &findings);
        assert_eq!(mine.len(), theirs.len());
        for (a, b) in mine.iter().zip(&theirs) {
            assert_ne!(a.key, b.key, "one vault's finding is not another's");
        }
        assert_eq!(mine, keyed(STORE, &findings), "and it is stable");
    }

    #[test]
    fn elapsed_time_can_never_carry_a_maintenance_transition() {
        // The regression this milestone owes: the pass is the thing
        // silence-never-resolves exists to constrain, so the rule is asserted
        // against the POLICY TABLE the pass's proposals go through, not just
        // against the finders.
        //
        // `merge_beliefs_exact`, `archive_belief`, `deprecate` and
        // `split_belief` are the maintenance verbs. None of their transitions
        // may be reached from a silence cause.
        let table = crate::policy::table::PolicyTable::load().unwrap();
        for cause in &table.silence.causes {
            assert!(
                matches!(cause.as_str(), "elapsed_time" | "absence_of_observations"),
                "unexpected silence cause {cause}"
            );
        }
        for op in [
            "merge_beliefs_exact",
            "merge_entities",
            "archive_belief",
            "deprecate",
            "split_belief",
        ] {
            let spec = table
                .ops
                .get(op)
                .unwrap_or_else(|| panic!("{op} is in the table"));
            for transition in &spec.allowed_transitions {
                assert!(
                    !table.silence.allowed_transitions.contains(transition),
                    "{op}'s {transition} is reachable under silence — time would be \
                     resolving something"
                );
            }
        }
        // And the cause the pass must never send is spellable, so the refusal
        // is a real path rather than a vocabulary gap.
        assert_eq!(TransitionCause::ElapsedTime.as_str(), "elapsed_time");
    }
}
