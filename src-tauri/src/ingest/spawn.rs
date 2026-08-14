//! Starting the real thing (M26.4i) — the [`Runner`] the tick actually uses.
//!
//! [`super::cli::CliRunner`] owns everything about a run that can be tested:
//! opening the window, deciding what silence means, closing the window
//! whatever happened. What it cannot own is the two things that need a live
//! process — minting a bearer on the running MCP endpoint, and spawning the
//! CLI against it. This module is those two closures and nothing else.
//!
//! **The wait is a blocking `recv()` and the watchdog is what ends it.** The
//! lease carries `elapsed_limit_seconds`; `agent::stream` arms the meter's
//! watchdog from it, and the watchdog is what sets the `aborted` flag the
//! completion signal reports. A `recv_timeout` here would give up on a run
//! that is still going, report an outcome it never had, and leave a live
//! child behind — so there is no timeout on this side by design.
//!
//! **`Mode::Supervised`, because the route decides.** The ambient meter would
//! finalize the lease on the CLI's exit status, and the item's destiny is not
//! the run's exit status: a window that ran cleanly and concluded "nothing
//! material" consumes its items, and a blocked one holds them visibly.
//! `ingest::pass` finalizes with the route it derived; the meter records
//! everything else and stops.
//!
//! **Unattended, scoped to nothing, and no connectors.** This run reads
//! vault bytes it did not choose and proposes through the M24 tools. It has
//! no business writing files directly, reaching the user's own MCP servers,
//! or inheriting the legacy open mode that only an attended run may have. All
//! three are absences a missing field would grant, so all three are stated.

use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;

use tauri::AppHandle;

use crate::agent::meter::{Meter, Mode, RunEnd};
use crate::agent::{AgentRequest, AgentState};
use crate::mcp::McpState;

use super::cli::{CliRunner, Session};
use super::pass::Runner;

/// The actor an ambient ingest run's MCP writes are attributed to.
///
/// The same id the closure's events carry, so a proposal submitted by a run
/// and the outcome that reports it name one author.
pub const ACTOR: &str = super::driver::ACTOR;

/// Everything a live spawn needs from the app.
pub struct Live<'a> {
    pub app: &'a AppHandle,
    pub agents: &'a AgentState,
    pub mcp: &'a McpState,
    pub vault: &'a Path,
    /// Where run configs are written. Swept every spawn; they carry secrets.
    pub config_dir: PathBuf,
    /// Where `runtime.db` lives — the meter's home.
    pub data_dir: PathBuf,
    pub vault_id: String,
    pub store_uuid: String,
}

/// Build the runner the tick spends its window through.
///
/// Returned as `impl Runner` rather than a named `CliRunner<_, _>`: the two
/// closures capture `live`, so writing the type out means writing two opaque
/// types the caller has no use for.
pub fn runner<'a>(live: &'a Live<'a>) -> impl Runner + 'a {
    CliRunner {
        mint_token: move || {
            // The endpoint must already be up: `ensure` retargets a running
            // server at this vault, and returns an error if none is running
            // rather than starting one behind the user's back.
            live.mcp.ensure(live.app, live.vault)?;
            // Scoped to nothing. An ingest run proposes; it does not write.
            // M31.1b: the grant carries the SAME narrowing the argv declares
            // — one list, so the boundary and the advice cannot disagree.
            live.mcp
                .run_token(Some(ACTOR), Some(vec![]), Some(declared_tools()))
        },
        spawn: move |session: &Session| {
            let url = live.mcp.ensure(live.app, live.vault)?.url;
            let (tx, rx) = sync_channel::<RunEnd>(1);
            crate::agent::stream(
                live.app.clone(),
                live.agents,
                live.vault,
                request(session, &url),
                &live.config_dir,
                Some(Meter {
                    data_dir: live.data_dir.clone(),
                    // The DISPATCH lease's id, so the run row the meter
                    // touches is the row the supervisor finalizes.
                    run_id: session.run_id.clone(),
                    mode: Mode::Supervised,
                    vault_id: Some(live.vault_id.clone()),
                    store_uuid: Some(live.store_uuid.clone()),
                    started_at: chrono::Utc::now(),
                    elapsed_limit_seconds: Some(session.elapsed_limit_seconds),
                }),
                Some(tx),
            )?;
            // Blocking, deliberately. See the module note.
            match rx.recv() {
                Ok(end) => Ok(end.usage),
                // The sender was dropped without a send: the reader thread is
                // gone. The run happened and said nothing, which is exactly
                // what `CliRunner` reads as blocked.
                Err(_) => Ok(None),
            }
        },
    }
}

/// The tools an ingest run holds — declared in the request's argv (M31.1a)
/// AND granted to its token (M31.1b) from this single list, so the two can
/// never disagree. An ingest run observes, extracts, resolves, and PROPOSES;
/// the proposal surface is derived from the policy table so this file never
/// carries a second inventory of it. It does not read the vault (every byte
/// it is entitled to is fenced into its prompt) and it does not write
/// directly — write_concept and cache_source are deliberately absent: a
/// direct writer here would bypass review, and a cached source authored by
/// this run would re-enter the next window at owner authority.
fn declared_tools() -> Vec<String> {
    let mut tools = crate::mcp::proposal_tool_names();
    tools.push(crate::mcp::REPORT_TOOL.into());
    tools.push(crate::mcp::ORGANIZE_TOOL.into());
    tools
}

fn request(session: &Session, url: &str) -> AgentRequest {
    AgentRequest {
        message: session.prompt.clone(),
        system_prompt: None,
        session_id: None,
        model: None,
        // Every one of these is an absence a missing field would GRANT. See
        // the module note; none of them is a default worth inheriting.
        shell: Some(false),
        connectors: Some(false),
        connector_names: Some(vec![]),
        attended: Some(false),
        mcp_url: Some(url.to_string()),
        mcp_token: Some(session.mcp_token.clone()),
        actor: Some(ACTOR.to_string()),
        approved_stdio: Some(vec![]),
        // Scoped to nothing: this run proposes, and a proposal is not a write.
        scope: Some(vec![]),
        // M31.1a — see `declared_tools` for what is granted and why. The
        // same list `mint_token` grants (M31.1b).
        allowed_tools: Some(declared_tools()),
        // Cerebro's own run, on cerebro's own schedule: the CLI's built-in
        // tools are withdrawn in build_args. Only the three internal spawn
        // sites ever set this.
        internal: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            mcp_token: "token".into(),
            run_id: "lease-run".into(),
            elapsed_limit_seconds: 600,
            prompt: "the rendered window".into(),
            prompt_version: "m26-ingest-v1",
        }
    }

    #[test]
    fn an_ingest_run_asks_for_nothing_it_does_not_need() {
        // Each of these is an absence that a MISSING field would grant, which
        // is why every one is stated rather than left off.
        let request = request(&session(), "http://127.0.0.1:1/mcp");
        assert_eq!(request.shell, Some(false), "it does not write files");
        assert_eq!(request.attended, Some(false), "nobody is watching");
        assert_eq!(
            request.connectors,
            Some(false),
            "and it does not reach other systems"
        );
        assert_eq!(request.connector_names, Some(vec![]));
        assert_eq!(request.approved_stdio, Some(vec![]));
        assert_eq!(
            request.scope,
            Some(vec![]),
            "scoped to nothing — it proposes, it does not write"
        );
    }

    #[test]
    fn the_run_carries_the_window_and_the_bearer_it_was_given() {
        let session = session();
        let request = request(&session, "http://127.0.0.1:1/mcp");
        assert_eq!(request.message, session.prompt);
        assert_eq!(request.mcp_token.as_deref(), Some("token"));
        assert_eq!(request.actor.as_deref(), Some(ACTOR));
    }

    #[test]
    fn the_tools_are_left_to_the_policy_rather_than_listed_twice() {
        // Inverted in M31.1a: the narrowing is now DECLARED, and it is derived
        // from the policy table rather than listed — the original test's
        // don't-drift concern, honored the other way around.
        let declared = request(&session(), "u")
            .allowed_tools
            .expect("an internal run declares its tools");
        assert!(
            declared.iter().any(|t| t == crate::mcp::COMMIT_TOOL),
            "the proposal surface is the point of the run"
        );
        assert!(
            declared.iter().any(|t| t.starts_with("propose_")),
            "at least one generated proposal op is granted"
        );
        assert!(
            declared.iter().any(|t| t == crate::mcp::REPORT_TOOL),
            "the ingest run reports its window outcome — the one name narrow() \
             would silently drop if a literal drifted"
        );
        assert!(
            !declared.iter().any(|t| t.contains("get_note")),
            "no internal run has a reason to read arbitrary notes"
        );
        assert!(
            !declared.iter().any(|t| t.contains("search_notes")),
            "retrieval is the assembler's job, not the run's"
        );
        assert!(
            !declared
                .iter()
                .any(|t| t == "write_concept" || t == "cache_source"),
            "no direct writers on an unattended run — a cached source authored \
             by this run would re-enter the next window at owner authority. \
             Exact names: propose_cache_source is the REVIEWED channel and is \
             a different tool (the propose_ prefix is injective by design)"
        );
    }

    #[test]
    fn the_argv_and_the_grant_are_one_list() {
        // M31.1b. `request` declares `declared_tools()` and the mint closure
        // grants `declared_tools()` — the invariant is that both draw from
        // the ONE function, so a second hand-written list cannot drift.
        assert_eq!(
            request(&session(), "u").allowed_tools,
            Some(declared_tools())
        );
    }

    #[test]
    fn an_ingest_run_is_marked_as_cerebros_own() {
        // The marker build_args keys the CLI built-in withdrawal on. Only the
        // three internal spawn sites ever set it.
        assert!(request(&session(), "u").internal);
    }
}
