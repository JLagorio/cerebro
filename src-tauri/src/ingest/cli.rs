//! The [`Runner`](super::pass::Runner) that talks to a real CLI session
//! (M26.4h).
//!
//! Two things are injected because neither can run in a test: minting a run
//! token from the live MCP endpoint, and spawning the subprocess. Everything
//! between them — opening the window, deciding what silence means, closing
//! the window whatever happened — is here and tested.
//!
//! **Silence is BLOCKED, never "nothing material".** A run that ends without
//! calling `report_window_outcome` has told us nothing, and the difference
//! between a window nobody assessed and a window assessed as quiet is the
//! whole of §17. Reading silence as `non_material` would consume the items
//! and charge the day for a verdict no one reached.
//!
//! **The window closes on every path.** The report is taken even when the
//! spawn failed, because a window left open leaks a session that can never
//! be reported and holds a run id that will never come back.

use crate::agent::usage::Usage;
use crate::ledger::schema::BlockedReason;
use crate::mcp;

use super::outcome::RunResult;
use super::pass::{Report, RunRequest, Runner};

/// What the app needs in order to actually start a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    /// The bearer the CLI presents. Its derived id is what the MCP server
    /// knows this run as — not the dispatch lease's id, which the server
    /// never sees.
    pub mcp_token: String,
    pub prompt: String,
    pub prompt_version: &'static str,
}

/// Mint a run token on the live endpoint, and spawn a session against it.
pub struct CliRunner<M, S> {
    pub mint_token: M,
    pub spawn: S,
}

impl<M, S> Runner for CliRunner<M, S>
where
    M: Fn() -> Result<String, String>,
    S: Fn(&Session) -> Result<Option<Usage>, String>,
{
    fn run(&self, request: &RunRequest) -> Result<Report, String> {
        let token = match (self.mint_token)() {
            Ok(token) => token,
            // No token means no session and no window was ever opened, so
            // there is nothing to close.
            Err(detail) => return Ok(blocked(BlockedReason::RuntimeUnavailable, detail, None)),
        };
        // The MCP server knows this run by its token, not by the dispatch
        // lease. Opening the window under the wrong id would mean the run's
        // report lands somewhere nothing ever reads.
        let mcp_run_id = mcp::run_id_of(&token);
        mcp::open_window(&mcp_run_id, &request.batch_key);

        let spawned = (self.spawn)(&Session {
            mcp_token: token,
            prompt: request.prompt.clone(),
            prompt_version: request.prompt_version,
        });
        // Taken on EVERY path: an open window is a leak, and a window whose
        // run has ended can never be reported anyway.
        let reported = mcp::take_window_report(&mcp_run_id);

        Ok(match (spawned, reported) {
            (Err(detail), _) => blocked(BlockedReason::RuntimeUnavailable, detail, None),
            (Ok(usage), Some(result)) => Report { usage, result },
            (Ok(usage), None) => blocked(
                BlockedReason::SemanticValidationFailed,
                "the run ended without reporting what it concluded".into(),
                usage,
            ),
        })
    }
}

fn blocked(reason: BlockedReason, detail: String, usage: Option<Usage>) -> Report {
    Report {
        usage,
        result: RunResult::Blocked {
            reason,
            // A run that did not report did not tell us what it looked at
            // either, and `undetermined` is the one outcome not required to
            // claim a look it may not have taken.
            evaluated_dimensions: vec![],
            explanation: detail,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::ledger::schema::MaterialDimension;

    fn request(batch_key: &str) -> RunRequest {
        RunRequest {
            run_id: "dispatch-lease-run".into(),
            batch_key: batch_key.into(),
            prompt: "the rendered window".into(),
            prompt_version: "m26-ingest-v1",
        }
    }

    fn usage() -> Usage {
        Usage {
            input_tokens: 100,
            output_tokens: 20,
            cache_read: 0,
            cache_write: 0,
        }
    }

    /// A spawn that reports through the real server registry, exactly as a
    /// CLI session would.
    fn reporting_spawn(result: RunResult) -> impl Fn(&Session) -> Result<Option<Usage>, String> {
        let result = RefCell::new(Some(result));
        move |session: &Session| {
            let run_id = mcp::run_id_of(&session.mcp_token);
            mcp::test_report_window(&run_id, result.borrow_mut().take().unwrap());
            Ok(Some(usage()))
        }
    }

    fn mint(token: &'static str) -> impl Fn() -> Result<String, String> {
        move || Ok(token.to_string())
    }

    #[test]
    fn a_reported_outcome_comes_back_with_the_runs_usage() {
        let runner = CliRunner {
            mint_token: mint("cli-token-reported"),
            spawn: reporting_spawn(RunResult::NonMaterial {
                evaluated_dimensions: vec![MaterialDimension::WorldState],
                explanation: "a heading was renamed".into(),
            }),
        };
        let report = runner.run(&request("window-1")).unwrap();
        assert_eq!(report.usage, Some(usage()));
        assert!(matches!(report.result, RunResult::NonMaterial { .. }));
    }

    #[test]
    fn silence_is_blocked_and_never_a_guessed_non_material() {
        // The difference between a window nobody assessed and one assessed
        // as quiet is the whole of §17. Reading silence as non_material
        // would consume the items and charge the day for a verdict nobody
        // reached.
        let runner = CliRunner {
            mint_token: mint("cli-token-silent"),
            spawn: |_: &Session| Ok(Some(usage())),
        };
        let report = runner.run(&request("window-2")).unwrap();
        let RunResult::Blocked { reason, .. } = report.result else {
            panic!("silence must not be a verdict");
        };
        assert_eq!(reason, BlockedReason::SemanticValidationFailed);
        // The spend is still recorded: the run happened, whatever it said.
        assert_eq!(report.usage, Some(usage()));
    }

    #[test]
    fn a_spawn_that_fails_is_a_runtime_block_and_claims_no_spend() {
        let runner = CliRunner {
            mint_token: mint("cli-token-nospawn"),
            spawn: |_: &Session| Err("the binary is not on this machine".into()),
        };
        let report = runner.run(&request("window-3")).unwrap();
        let RunResult::Blocked {
            reason,
            explanation,
            ..
        } = report.result
        else {
            panic!("expected a block");
        };
        assert_eq!(reason, BlockedReason::RuntimeUnavailable);
        assert!(explanation.contains("not on this machine"));
        assert_eq!(report.usage, None, "missing usage is unknown, never zero");
    }

    #[test]
    fn no_token_means_no_window_was_ever_opened() {
        let runner = CliRunner {
            mint_token: || Err("the MCP endpoint is not running".to_string()),
            spawn: |_: &Session| panic!("must not spawn without a token"),
        };
        let report = runner.run(&request("window-4")).unwrap();
        assert!(matches!(
            report.result,
            RunResult::Blocked {
                reason: BlockedReason::RuntimeUnavailable,
                ..
            }
        ));
    }

    #[test]
    fn the_window_is_closed_even_when_the_spawn_failed() {
        // An open window leaks a session that can never be reported.
        let token = "cli-token-leak";
        let runner = CliRunner {
            mint_token: mint(token),
            spawn: |_: &Session| Err("died".into()),
        };
        runner.run(&request("window-5")).unwrap();
        assert!(
            mcp::take_window_report(&mcp::run_id_of(token)).is_none(),
            "the window is gone, not merely empty"
        );
    }

    #[test]
    fn the_session_carries_the_token_the_window_was_opened_under() {
        // Opening under the dispatch lease's id instead would put the run's
        // report where nothing ever reads it.
        let seen: RefCell<Option<String>> = RefCell::new(None);
        let runner = CliRunner {
            mint_token: mint("cli-token-identity"),
            spawn: |session: &Session| {
                *seen.borrow_mut() = Some(session.mcp_token.clone());
                Ok(None)
            },
        };
        let request = request("window-6");
        runner.run(&request).unwrap();
        let token = seen.borrow().clone().unwrap();
        assert_ne!(mcp::run_id_of(&token), request.run_id);
    }
}
