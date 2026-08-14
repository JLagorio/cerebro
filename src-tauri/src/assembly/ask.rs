//! The attended pass (M26.5e) — assemble, ask, and keep the receipt.
//!
//! **Everything except the subprocess.** [`Spawn`] is two operations — mint a
//! bearer, run a prompt against it — and every decision around them lives
//! here, where a test can drive it. That split is the one `ingest::cli` uses,
//! for the same reason: the interesting failures are the ones where the run
//! says nothing, or says something the manifest refuses, and neither of those
//! needs a real CLI to reproduce.
//!
//! **The manifest is recorded BEFORE the run.** A question that was assembled
//! and then crashed still has a receipt saying what the base would have shown
//! — which is the difference between "we never asked" and "we asked and lost
//! the answer". It also means the run's own answer is validated against a
//! manifest that was durable before the run existed.
//!
//! **Silence is not an answer.** A run that finishes without calling
//! `submit_answer` produces [`Outcome::Unanswered`], never an empty answer and
//! never a guess. The manifest is still there, so a person can see exactly
//! what was in front of it.
//!
//! **Attended: bounded, metered, never budgeted.** No daily-run gate, no token
//! ceiling, no yesterday's ambient spend. See the module note on `assembly`.

use chrono::{DateTime, Utc};
use rusqlite::Connection;

use crate::ledger::reduce::{reduce, EpistemicState};

use super::answer::SynthesisAnswer;
use super::assemble::{self, Assembly, Expansion, Refusal, Request};
use super::corpus::Corpus;
use super::manifest::WorkingMemoryManifest;
use super::{prompt, store};

/// The actor an attended synthesis run's MCP calls are attributed to.
pub const ACTOR: &str = "agent:m26-synthesis";

/// What one run needs from the outside world.
pub trait Spawn {
    /// A bearer for this run. The run id is derived from it, so the caller
    /// cannot name its own.
    fn mint_token(&self) -> Result<String, String>;
    /// Run the prompt. Returns when the run is over, however it ended.
    fn run(&self, token: &str, prompt: &str) -> Result<(), String>;
}

/// What the pass produced.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Answered {
        manifest: Box<WorkingMemoryManifest>,
        answer: Box<SynthesisAnswer>,
    },
    /// The run happened and never submitted. A real outcome with a real
    /// receipt — the manifest says what it was shown.
    Unanswered {
        manifest: Box<WorkingMemoryManifest>,
        detail: String,
    },
}

impl Outcome {
    pub fn manifest(&self) -> &WorkingMemoryManifest {
        match self {
            Outcome::Answered { manifest, .. } | Outcome::Unanswered { manifest, .. } => manifest,
        }
    }
}

/// Everything the pass needs about where it is running.
pub struct Context<'a> {
    pub vault: &'a std::path::Path,
    pub vault_id: &'a str,
    pub store_uuid: &'a str,
}

/// Read the ledger once: the projection to select from, the corpus to render
/// from, and the head both were taken at.
///
/// One read, so the three cannot describe different moments. An assembly built
/// from a projection at one head and a corpus at another would be a receipt
/// for a base that never existed.
pub fn read(
    vault: &std::path::Path,
    store_uuid: &str,
) -> Result<(EpistemicState, Corpus, String), String> {
    let read = crate::ledger::read_ledger(&crate::ledger::ledger_dir(vault))
        .map_err(|e| format!("ledger: {e}"))?;
    let head = read
        .frames
        .last()
        .map(|frame| frame.event_id.clone())
        .unwrap_or_else(|| format!("genesis:{store_uuid}"));
    let state = reduce(&read.frames, store_uuid);
    let corpus = Corpus::from_frames(&read.frames);
    Ok((state, corpus, head))
}

/// Ask one question.
///
/// `Err(Refusal)` means there is no manifest and nothing ran — see
/// [`Refusal`]. Every other ending, including a run that said nothing, comes
/// back as an [`Outcome`] with its receipt.
pub fn ask<S: Spawn>(
    conn: &Connection,
    context: &Context<'_>,
    state: &EpistemicState,
    corpus: &Corpus,
    request: &Request<'_>,
    spawner: &S,
    now: DateTime<Utc>,
) -> Result<Outcome, Refusal> {
    let assembly = assemble::assemble(state, corpus, &Expansion, request)?;
    keep(conn, context, request, &assembly, now)?;
    let manifest = Box::new(assembly.manifest.clone());

    let token = match spawner.mint_token() {
        Ok(token) => token,
        Err(detail) => {
            return Ok(Outcome::Unanswered {
                manifest,
                detail: format!("no run could be started: {detail}"),
            })
        }
    };
    let run_id = crate::mcp::run_id_of(&token);
    crate::mcp::open_question(&run_id, &assembly.manifest);

    let rendered = prompt::render(&prompt::Context {
        question: request.question,
        manifest: &assembly.manifest,
        rendered: &assembly.rendered,
        as_of: &stamp(now),
    });

    let ran = spawner.run(&token, &rendered.text);
    // Taken whatever happened: a run that answered and THEN failed still
    // answered, and leaving the question open would leak the session.
    let answer = crate::mcp::take_answer(&run_id);

    Ok(match (answer, ran) {
        (Some(answer), _) => {
            record_plan(conn, context, &assembly.manifest, &answer, now);
            Outcome::Answered {
                manifest,
                answer: Box::new(answer),
            }
        }
        (None, Err(detail)) => Outcome::Unanswered {
            manifest,
            detail: format!("the run failed: {detail}"),
        },
        (None, Ok(())) => Outcome::Unanswered {
            manifest,
            detail: "the run finished without submitting an answer. Silence is not an answer, \
                     and this is not a guess at what it would have said."
                .to_string(),
        },
    })
}

/// Keep the receipt before anything spends money on it.
fn keep(
    conn: &Connection,
    context: &Context<'_>,
    request: &Request<'_>,
    assembly: &Assembly,
    now: DateTime<Utc>,
) -> Result<(), Refusal> {
    store::record(
        conn,
        context.vault_id,
        context.store_uuid,
        request.chain_head,
        &assembly.manifest,
        now,
    )
    .map(|_| ())
    .map_err(|detail| Refusal::Invalid { detail })
}

/// Open whatever discovery the answer proposed.
///
/// Best-effort and non-fatal: the answer is already valid and already the
/// user's, and losing a worklist row is not a reason to throw it away. The
/// failure is reported to the operator rather than to the person who asked.
fn record_plan(
    conn: &Connection,
    context: &Context<'_>,
    manifest: &WorkingMemoryManifest,
    answer: &SynthesisAnswer,
    now: DateTime<Utc>,
) {
    let Some(plan) = &answer.next_evidence.discovery_plan else {
        return;
    };
    if let Err(detail) = store::open(
        conn,
        context.vault_id,
        context.store_uuid,
        &plan.plan_id,
        &manifest.assembly_id,
        now,
    ) {
        eprintln!(
            "attended synthesis: discovery plan {}: {detail}",
            plan.plan_id
        );
    }
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::answer::tests as answers;
    use crate::assembly::fixture;
    use crate::vault::testutil;
    use std::cell::RefCell;

    const STORE: &str = "cafebabecafebabecafebabecafebabe";

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
                vault: &self.vault,
                vault_id: &self.vault_id,
                store_uuid: STORE,
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.vault);
        }
    }

    /// A run that answers by calling the real registry the MCP tool writes to,
    /// so the pass is exercised against the actual channel rather than a
    /// second one that could disagree with it.
    /// How a run decides what to submit, given the manifest the pass opened.
    type Compose = Box<dyn Fn(&WorkingMemoryManifest) -> SynthesisAnswer>;

    struct Answers {
        answer: RefCell<Option<Compose>>,
        token: String,
    }

    impl Answers {
        fn with(
            token: &str,
            build: impl Fn(&WorkingMemoryManifest) -> SynthesisAnswer + 'static,
        ) -> Answers {
            Answers {
                answer: RefCell::new(Some(Box::new(build))),
                token: token.to_string(),
            }
        }

        fn silent(token: &str) -> Answers {
            Answers {
                answer: RefCell::new(None),
                token: token.to_string(),
            }
        }
    }

    impl Spawn for Answers {
        fn mint_token(&self) -> Result<String, String> {
            Ok(self.token.clone())
        }

        fn run(&self, token: &str, _: &str) -> Result<(), String> {
            let Some(build) = self.answer.borrow_mut().take() else {
                return Ok(());
            };
            let run_id = crate::mcp::run_id_of(token);
            let manifest = crate::mcp::test_open_manifest(&run_id).expect("the pass opened it");
            crate::mcp::test_submit_answer(&run_id, build(&manifest))
        }
    }

    struct Unstartable;

    impl Spawn for Unstartable {
        fn mint_token(&self) -> Result<String, String> {
            Err("the MCP endpoint is not running".into())
        }
        fn run(&self, _: &str, _: &str) -> Result<(), String> {
            unreachable!("nothing was minted")
        }
    }

    fn asked<S: Spawn>(harness: &Harness, spawner: &S) -> Result<Outcome, Refusal> {
        ask(
            &harness.conn,
            &harness.context(),
            &fixture::state(),
            &fixture::corpus(),
            &fixture::request(fixture::shipping(), fixture::wide()),
            spawner,
            now(),
        )
    }

    #[test]
    fn an_answered_question_comes_back_with_its_receipt() {
        let harness = Harness::open("ask-answered");
        let outcome = asked(&harness, &Answers::with("tok-answered", answers::valid_for)).unwrap();
        let Outcome::Answered { manifest, answer } = outcome else {
            panic!("expected an answer");
        };
        assert_eq!(answer.working_memory_manifest_id, manifest.assembly_id);
        // And the receipt is durable, independently of the answer.
        let kept = store::get(
            &harness.conn,
            &harness.vault_id,
            STORE,
            &manifest.assembly_id,
        )
        .unwrap()
        .expect("the manifest was kept");
        assert_eq!(kept.manifest, *manifest);
    }

    #[test]
    fn a_run_that_says_nothing_produces_no_answer_and_still_leaves_a_receipt() {
        // The difference between "we never asked" and "we asked and it said
        // nothing" is the whole reason the manifest is recorded first.
        let harness = Harness::open("ask-silent");
        let outcome = asked(&harness, &Answers::silent("tok-silent")).unwrap();
        let Outcome::Unanswered { manifest, detail } = outcome else {
            panic!("expected silence");
        };
        assert!(detail.contains("Silence is not an answer"), "{detail}");
        assert!(store::get(
            &harness.conn,
            &harness.vault_id,
            STORE,
            &manifest.assembly_id
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn a_run_that_could_not_start_is_unanswered_rather_than_a_refusal() {
        // The assembly succeeded and its receipt is real; only the spending
        // failed. Reporting that as a refusal would lose the receipt.
        let harness = Harness::open("ask-unstartable");
        let outcome = asked(&harness, &Unstartable).unwrap();
        let Outcome::Unanswered { detail, .. } = outcome else {
            panic!("expected unanswered");
        };
        assert!(detail.contains("no run could be started"), "{detail}");
    }

    #[test]
    fn the_receipt_is_written_before_the_run_is_started() {
        // Proven by a spawner that inspects the row from inside `run`.
        struct Checks<'a> {
            harness: &'a Harness,
            saw: RefCell<bool>,
        }
        impl Spawn for Checks<'_> {
            fn mint_token(&self) -> Result<String, String> {
                Ok("tok-order".into())
            }
            fn run(&self, _: &str, _: &str) -> Result<(), String> {
                let count: i64 = self
                    .harness
                    .conn
                    .query_row("SELECT count(*) FROM working_memory_manifests", [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                *self.saw.borrow_mut() = count == 1;
                Ok(())
            }
        }
        let harness = Harness::open("ask-order");
        let spawner = Checks {
            harness: &harness,
            saw: RefCell::new(false),
        };
        asked(&harness, &spawner).unwrap();
        assert!(
            *spawner.saw.borrow(),
            "the manifest has to be durable before anything spends money on it"
        );
    }

    #[test]
    fn a_refused_assembly_never_starts_a_run_and_never_keeps_a_receipt() {
        let harness = Harness::open("ask-refused");
        struct NeverRuns;
        impl Spawn for NeverRuns {
            fn mint_token(&self) -> Result<String, String> {
                panic!("a refused assembly must not reach the spawner")
            }
            fn run(&self, _: &str, _: &str) -> Result<(), String> {
                unreachable!()
            }
        }
        // A cap too small for the counterevidence: §22's hard stop.
        let request = fixture::request(
            fixture::shipping(),
            crate::assembly::manifest::Limits {
                max_sources_per_run: 10,
                max_context_bytes: 10,
                max_evidence_items: 100,
            },
        );
        let refusal = ask(
            &harness.conn,
            &harness.context(),
            &fixture::state(),
            &fixture::corpus(),
            &request,
            &NeverRuns,
            now(),
        )
        .expect_err("no manifest, no run");
        assert!(matches!(refusal, Refusal::CapConflict { .. }));
        let count: i64 = harness
            .conn
            .query_row("SELECT count(*) FROM working_memory_manifests", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn an_answer_the_manifest_refuses_leaves_the_question_unanswered() {
        // The tool refused it, so the registry holds nothing, so the pass
        // reports silence rather than an answer nobody validated.
        let harness = Harness::open("ask-bad-answer");
        let spawner = Answers::with("tok-bad", |manifest| {
            let mut answer = answers::valid_for(manifest);
            answer.working_memory_manifest_id = "another-assembly-entirely".into();
            answer
        });
        let outcome = asked(&harness, &spawner).unwrap();
        assert!(matches!(outcome, Outcome::Unanswered { .. }));
    }
}
