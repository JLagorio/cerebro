//! Starting a real attended run (M26.5e) — the [`Spawn`] the app uses.
//!
//! [`super::ask`] owns everything about the pass that can be tested: what to
//! assemble, when the receipt becomes durable, what silence means. What it
//! cannot own is the two things that need a live process — minting a bearer on
//! the running MCP endpoint, and spawning the CLI against it. This module is
//! those two, and nothing else.
//!
//! **`Mode::Attended`: metered, never gated.** A person is waiting for this
//! answer. It is not competing with the morning's ingest for a daily-run
//! ceiling or a token budget, and there is deliberately no `max_daily_runs`
//! anywhere on this path. What bounds it is the assembly's three caps, which
//! have already done their work by the time anything spawns.
//!
//! **A synthesis run writes NOTHING.** Not files, not proposals, not the
//! knowledge bundle. Everything it is entitled to say goes through
//! `submit_answer` — and since M31.1a/M31.1b every capability, read or
//! write, is stated. The WRITE capabilities were stated absences from day
//! one (a scope of nothing); the READ surface was served to any live bearer
//! until M31.1a narrowed the declaration to exactly `submit_answer` and
//! M31.1b made the grant enforce it at dispatch.

use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;

use tauri::AppHandle;

use crate::agent::meter::{Meter, Mode, RunEnd};
use crate::agent::{AgentRequest, AgentState};
use crate::mcp::McpState;

use super::ask::{Spawn, ACTOR};

/// Everything a live attended spawn needs from the app.
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
    /// The durable run id the meter books this run against — and, since
    /// M31.2a, the id the run's grant carries.
    pub run_id: String,
}

impl Spawn for Live<'_> {
    fn mint_token(&self) -> Result<String, String> {
        // The endpoint must already be up: `ensure` retargets a running server
        // at this vault and errors if none is running, rather than starting
        // one behind the user's back.
        self.mcp.ensure(self.app, self.vault)?;
        // Scoped to nothing. A synthesis run answers; it does not write.
        // M31.1b: the grant carries the SAME narrowing the argv declares —
        // one list, so the boundary and the advice cannot disagree.
        // M31.2a: and the SAME durable id the meter books, so the run has one
        // id from mint to meter to grant.
        self.mcp.run_token(
            Some(ACTOR),
            Some(vec![]),
            // M34.4: the internal constructs read the whole vault by design —
            // ingest and maintenance ARE whole-vault passes; their bound is
            // the declared tool list, not a folder.
            None,
            Some(declared_tools()),
            self.run_id.clone(),
        )
    }

    fn run_id(&self) -> &str {
        &self.run_id
    }

    fn run(&self, token: &str, prompt: &str) -> Result<(), String> {
        let url = self.mcp.ensure(self.app, self.vault)?.url;
        let (tx, rx) = sync_channel::<RunEnd>(1);
        crate::agent::stream(
            self.app.clone(),
            self.agents,
            self.vault,
            request(prompt, token, &url),
            &self.config_dir,
            Some(Meter {
                data_dir: self.data_dir.clone(),
                run_id: self.run_id.clone(),
                mode: Mode::Attended,
                vault_id: Some(self.vault_id.clone()),
                store_uuid: Some(self.store_uuid.clone()),
                started_at: chrono::Utc::now(),
                // No elapsed limit: a person is waiting and can stop it
                // themselves. A watchdog here would kill an answer somebody is
                // watching arrive.
                elapsed_limit_seconds: None,
                // M33.1 — attended, so this meter writes the row itself. The
                // construct is attributed by its existing actor rather than a
                // persona: the fleet shows what assembly has run, never a
                // standing agent with a face (D6).
                actor: Some(super::ask::ACTOR.to_string()),
                // Root by construction (M34.3): no tool call started this run.
                parent_run_id: None,
            }),
            Some(tx),
        )?;
        // Blocking, deliberately: a `recv_timeout` would report an outcome the
        // run never had and leave a live child behind.
        match rx.recv() {
            Ok(_) => Ok(()),
            // The sender was dropped without a send: the reader thread is
            // gone. The run happened and said nothing, which `ask` reads as
            // unanswered — never as an answer.
            Err(_) => Ok(()),
        }
    }
}

/// The one tool a synthesis run holds — declared in the request's argv
/// (M31.1a) AND granted to its token (M31.1b) from this single list, so the
/// two can never disagree. The constant, not a literal: `SUBMIT_TOOL` exists
/// so the prompt and the served surface cannot disagree about the name, and
/// a "submit_answer" string here would be a third spelling. `pub(crate)` so
/// mcp's `test_submit_answer` fixture models the REAL grant rather than
/// hand-writing a copy of it.
pub(crate) fn declared_tools() -> Vec<String> {
    vec![crate::assembly::prompt::SUBMIT_TOOL.to_string()]
}

fn request(prompt: &str, token: &str, url: &str) -> AgentRequest {
    AgentRequest {
        message: prompt.to_string(),
        system_prompt: None,
        session_id: None,
        model: None,
        // Every one of these is an absence a MISSING field would grant.
        shell: Some(false),
        connectors: Some(false),
        connector_names: Some(vec![]),
        // True, and this is the one place it differs from ingest: a person is
        // waiting, which is what `Mode::Attended` means to the meter and what
        // the legacy open mode is for.
        attended: Some(true),
        mcp_url: Some(url.to_string()),
        mcp_token: Some(token.to_string()),
        actor: Some(ACTOR.to_string()),
        approved_stdio: Some(vec![]),
        // Scoped to nothing: this run answers, and an answer is not a write.
        scope: Some(vec![]),
        // M34.4: reads unbounded by folder — see the mint above.
        read_scope: None,
        // M31.1a — a synthesis run answers from the manifest and nothing
        // else. That was always the design (prompt::RULES); until now it was
        // a sentence. The same list `mint_token` grants (M31.1b).
        allowed_tools: Some(declared_tools()),
        // No lane: an attended synthesis run is metered, never gated
        // (M34.2.4's lane field is the unattended path to the dispatcher).
        lane: None,
        // Cerebro's own run: attended means a person awaits the ANSWER, not
        // that anybody supervises the child, so the CLI built-ins are
        // withdrawn here too. Only the three internal spawn sites set this.
        internal: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_synthesis_run_asks_for_nothing_it_does_not_need() {
        let request = request("the rendered question", "token", "http://127.0.0.1:1/mcp");
        assert_eq!(request.shell, Some(false), "it writes no files");
        assert_eq!(request.connectors, Some(false), "and reaches no systems");
        assert_eq!(request.connector_names, Some(vec![]));
        assert_eq!(request.approved_stdio, Some(vec![]));
        assert_eq!(
            request.scope,
            Some(vec![]),
            "scoped to nothing — it answers, it does not write"
        );
    }

    #[test]
    fn a_person_is_waiting_and_the_run_says_so() {
        // The one field that differs from an ingest run, and the reason the
        // meter never gates this path.
        let request = request("q", "token", "http://127.0.0.1:1/mcp");
        assert_eq!(request.attended, Some(true));
        assert_eq!(request.actor.as_deref(), Some(ACTOR));
    }

    #[test]
    fn the_tools_are_left_to_the_policy_rather_than_listed_twice() {
        // Inverted in M31.1a: the narrowing is now DECLARED — one tool,
        // spelled via the constant the prompt and the server already share.
        // A synthesis run answers from the manifest and nothing else.
        assert_eq!(
            request("q", "t", "u").allowed_tools,
            Some(vec![crate::assembly::prompt::SUBMIT_TOOL.to_string()])
        );
    }

    #[test]
    fn the_argv_and_the_grant_are_one_list() {
        // M31.1b. `request` declares `declared_tools()` and `mint_token`
        // grants `declared_tools()` — the invariant is that both draw from
        // the ONE function, so a second hand-written list cannot drift.
        assert_eq!(request("q", "t", "u").allowed_tools, Some(declared_tools()));
    }

    #[test]
    fn a_synthesis_run_is_marked_as_cerebros_own_though_a_person_waits() {
        // Attended is a METERING fact — someone awaits the answer; nobody
        // supervises the child. The internal marker, not attendance, is what
        // keys the CLI built-in withdrawal in build_args.
        let request = request("q", "t", "u");
        assert!(request.internal);
        assert_eq!(request.attended, Some(true));
    }
}
