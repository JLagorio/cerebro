//! Starting a real maintenance run (M26.6c) — the [`Runner`] the app uses.
//!
//! [`super::schedule`] owns the lease and [`super::pass`] owns what is said;
//! this is the two things that need a live process — minting a bearer on the
//! running MCP endpoint, and spawning the CLI against it.
//!
//! **`Mode::Supervised`, because the schedule finalizes.** The lease is
//! claimed and released by `schedule::attempt`, which knows whether the pass
//! actually said anything; the meter records usage and stops short of
//! finalizing, exactly as it does for the ingest driver. Two finalizations
//! would have the second refused after the first had already decided.
//!
//! **Unattended, scoped to nothing, no connectors.** This run proposes
//! through the M24 tools and does nothing else, and every one of those is an
//! absence a missing field would grant — so every one is stated.

use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;

use tauri::AppHandle;

use crate::agent::meter::{Meter, Mode, RunEnd};
use crate::agent::{AgentRequest, AgentState};
use crate::mcp::McpState;

use super::pass::{Runner, ACTOR};

/// Everything a live maintenance spawn needs from the app.
pub struct Live<'a> {
    pub app: &'a AppHandle,
    pub agents: &'a AgentState,
    pub mcp: &'a McpState,
    pub vault: &'a Path,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub vault_id: String,
    pub store_uuid: String,
    pub elapsed_limit_seconds: u64,
}

impl Runner for Live<'_> {
    fn run(&self, run_id: &str, prompt: &str) -> Result<(), String> {
        // The endpoint must already be up: `ensure` retargets a running server
        // and errors if none is running, rather than starting one behind the
        // user's back.
        let url = self.mcp.ensure(self.app, self.vault)?.url;
        let token = self.mcp.run_token(Some(ACTOR), Some(vec![]))?;
        let (tx, rx) = sync_channel::<RunEnd>(1);
        crate::agent::stream(
            self.app.clone(),
            self.agents,
            self.vault,
            request(prompt, &token, &url),
            &self.config_dir,
            Some(Meter {
                data_dir: self.data_dir.clone(),
                // The DISPATCH lease's id, so the row the meter touches is the
                // row `schedule::attempt` finalizes.
                run_id: run_id.to_string(),
                mode: Mode::Supervised,
                vault_id: Some(self.vault_id.clone()),
                store_uuid: Some(self.store_uuid.clone()),
                started_at: chrono::Utc::now(),
                elapsed_limit_seconds: Some(self.elapsed_limit_seconds),
            }),
            Some(tx),
        )?;
        // Blocking, deliberately: a timeout here would report an outcome the
        // run never had and leave a live child behind.
        let _ = rx.recv();
        Ok(())
    }
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
        attended: Some(false),
        mcp_url: Some(url.to_string()),
        mcp_token: Some(token.to_string()),
        actor: Some(ACTOR.to_string()),
        approved_stdio: Some(vec![]),
        // Scoped to nothing: this run proposes, and a proposal is not a write.
        scope: Some(vec![]),
        // Left to `policy::submit`; a second list here would be a second place
        // for that decision to drift.
        allowed_tools: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_maintenance_run_asks_for_nothing_it_does_not_need() {
        let request = request("the findings", "token", "http://127.0.0.1:1/mcp");
        assert_eq!(request.shell, Some(false), "it writes no files");
        assert_eq!(request.attended, Some(false), "nobody is watching");
        assert_eq!(request.connectors, Some(false));
        assert_eq!(request.connector_names, Some(vec![]));
        assert_eq!(request.approved_stdio, Some(vec![]));
        assert_eq!(
            request.scope,
            Some(vec![]),
            "scoped to nothing — it proposes, it does not write"
        );
        assert_eq!(request.actor.as_deref(), Some(ACTOR));
    }

    #[test]
    fn the_tools_are_left_to_the_policy_rather_than_listed_twice() {
        assert_eq!(request("f", "t", "u").allowed_tools, None);
    }
}
