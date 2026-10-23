//! What one run's stream says about each of its connectors (M54.11).
//!
//! Pure: the reader feeds it every parsed line beside the meter's tally, with
//! the time it read the line, and after the run asks it for at most one
//! observation per connector the run merged. The meter records them
//! (`meter::record_connectors`) and Settings shows the newest.
//!
//! What CLI 2.1.250 says in `-p`, recorded on toy servers:
//!
//! - Init waits up to 30 s for each server, then names its status under the
//!   name the run's config gave it: `connected`; `needs-auth` for a 401 whose
//!   OAuth metadata resolves; `failed` for a closed port, a 401 with no
//!   metadata, or a server slower than the wait; `disabled` for one the
//!   person switched off in their own Claude Code config. `pending` never
//!   appeared for an http server, though the CLI's schema has the word.
//! - A tool's name carries the server's CLI name (`mcp__toy_v2__echo` for a
//!   server the config calls `toy.v2`).
//! - A failing tool comes back as a `tool_result` with `is_error`. So does a
//!   denied call, and the result's `permission_denials` names it. A call the
//!   run's grant allows is still denied when the person's own Claude Code
//!   rules ask about it, which nobody can answer in `-p`.
//! - No `mcp__<server>__authenticate` tool is offered, and the result carries
//!   no server-error key, so neither is a signal here.
//!
//! The same first init names each connector's status in the run's Reach
//! (M92.8, `connector_inits`), read by the one `server_init` the observer
//! reads it by.

use std::collections::HashMap;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;

use super::{content_blocks, server_init, RunConnectors, ServerInit};
use crate::runtime::connector_status::{Observation, Signal, State};

/// One connector a run loads, and the status its first init named it in
/// (M92.8): what the run's Reach says of it.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ConnectorInit {
    /// Its name in the vault's list, which init reports it under.
    pub name: String,
    /// Its status as that init spelled it (`ServerInit::word`): `absent`
    /// when the init's list leaves it out, `unreported` when the init has no
    /// list or no status for it.
    pub status: String,
}

/// Each of `names`, the connectors a run loads by their names in the vault's
/// list, in their order, with the status `init` names it in (M92.8).
pub(crate) fn connector_inits(names: &[String], init: &Value) -> Vec<ConnectorInit> {
    names
        .iter()
        .map(|name| ConnectorInit {
            name: name.clone(),
            status: server_init(init, name).word().to_string(),
        })
        .collect()
}

/// One server the run merged, and what its stream said about it.
struct Server {
    /// Its name in the vault's list: what init reports it under, and what
    /// its status is recorded by.
    name: String,
    /// The name the CLI hears, which its tools' names carry.
    cli: String,
    /// Its status in the run's first init.
    init: Option<ServerInit>,
    /// Calls the run sent it.
    sent: usize,
    /// When the first call it answered without an error came back.
    worked_at: Option<DateTime<Utc>>,
    /// Each call that came back an error, as (the tool's name, when).
    errors: Vec<(String, DateTime<Utc>)>,
}

/// Reads one run's stream for what it says about the run's connectors.
pub(crate) struct Observer {
    servers: Vec<Server>,
    /// The run's connector grant and denials, as its argv carried them.
    allow: Vec<String>,
    deny: Vec<String>,
    init_at: Option<DateTime<Utc>>,
    /// Each call to a merged server, by its tool_use id: the server's index
    /// and the tool's name.
    calls: HashMap<String, (usize, String)>,
    /// When the run's terminal result arrived.
    result_at: Option<DateTime<Utc>>,
}

/// The server part of a connector tool's name, `mcp__<server>__<tool>`, cut
/// at the first `__` as the CLI cuts it.
fn server_of(tool: &str) -> Option<&str> {
    let (server, name) = tool.strip_prefix("mcp__")?.split_once("__")?;
    (!server.is_empty() && !name.is_empty()).then_some(server)
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Observer {
    /// An observer for the servers `connectors` merged, keeping their grant.
    pub(crate) fn new(connectors: &RunConnectors) -> Self {
        Self {
            servers: connectors
                .servers
                .iter()
                .map(|(name, cli)| Server {
                    name: name.clone(),
                    cli: cli.clone(),
                    init: None,
                    sent: 0,
                    worked_at: None,
                    errors: Vec::new(),
                })
                .collect(),
            allow: connectors.allow.clone(),
            deny: connectors.deny.clone(),
            init_at: None,
            calls: HashMap::new(),
            result_at: None,
        }
    }

    /// The merged server a tool's name addresses. Tool names carry the CLI
    /// name exactly, so the match is exact: merged names never collide,
    /// case aside (`connectors::enabled_servers`).
    fn server_for(&self, tool: &str) -> Option<usize> {
        let cli = server_of(tool)?;
        self.servers.iter().position(|server| server.cli == cli)
    }

    /// Note one parsed stream line, read at `now`.
    pub(crate) fn observe(&mut self, event: &Value, now: DateTime<Utc>) {
        if self.servers.is_empty() {
            return;
        }
        match event.get("type").and_then(Value::as_str) {
            Some("system") => {
                let init = event.get("subtype").and_then(Value::as_str) == Some("init");
                if init && self.init_at.is_none() {
                    self.init_at = Some(now);
                    for server in &mut self.servers {
                        server.init = Some(server_init(event, &server.name));
                    }
                }
            }
            Some("assistant") => {
                for block in content_blocks(event) {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let (Some(id), Some(tool)) = (
                        block.get("id").and_then(Value::as_str),
                        block.get("name").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    if let Some(at) = self.server_for(tool) {
                        self.servers[at].sent += 1;
                        self.calls.insert(id.to_string(), (at, tool.to_string()));
                    }
                }
            }
            Some("user") => {
                for block in content_blocks(event) {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let Some((at, tool)) = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .and_then(|id| self.calls.remove(id))
                    else {
                        continue;
                    };
                    let server = &mut self.servers[at];
                    if block.get("is_error").and_then(Value::as_bool) == Some(true) {
                        server.errors.push((tool, now));
                    } else if server.worked_at.is_none() {
                        server.worked_at = Some(now);
                    }
                }
            }
            Some("result") => {
                self.result_at.get_or_insert(now);
            }
            _ => {}
        }
    }

    /// Does the run's grant allow `tool` on the server the CLI hears as
    /// `cli`? Matched case for case, as the CLI matches its rules.
    fn grants(&self, cli: &str, tool: &str) -> bool {
        let whole = format!("mcp__{cli}");
        self.allow
            .iter()
            .any(|entry| *entry == whole || entry == tool)
            && !self.deny.iter().any(|entry| entry == tool)
    }

    /// At most one observation per merged connector, from the first rule that
    /// holds:
    ///
    /// 1. a call came back without an error → working;
    /// 2. init said `needs-auth` → needs sign-in;
    /// 3. init said `failed`, or, once the run reached its result, every
    ///    call it got errored, none was denied, and init did not say
    ///    `connected` → failed;
    /// 4. the CLI denied a call the run's grant allowed → not approved;
    /// 5. init said `connected` → working;
    /// 6. otherwise (`pending`, `disabled`, silence) → nothing.
    ///
    /// `denied` is the result's denied tools (`Tally::denied_tools`). A
    /// denied call comes back as an error, so a server with any denial is
    /// never failed by its errors; and a denial the run's own narrowing
    /// explains changes nothing, since M54.9 already recorded it by name.
    pub(crate) fn finish(&self, denied: &[String]) -> Vec<Observation> {
        let mut out = Vec::new();
        for server in &self.servers {
            let denied_here: Vec<&String> = denied
                .iter()
                .filter(|tool| server_of(tool) == Some(server.cli.as_str()))
                .collect();
            let init = server.init.as_ref();
            let decided = if let Some(at) = server.worked_at {
                Some((State::Working, Signal::ToolResult, at))
            } else if let (Some(ServerInit::NeedsAuth), Some(at)) = (init, self.init_at) {
                Some((State::NeedsSignIn, Signal::Init, at))
            } else if let (Some(ServerInit::Failed), Some(at)) = (init, self.init_at) {
                Some((State::Failed, Signal::Init, at))
            } else if let Some(&(_, at)) = server.errors.last().filter(|_| {
                self.result_at.is_some()
                    && server.errors.len() == server.sent
                    && denied_here.is_empty()
                    && init != Some(&ServerInit::Connected)
            }) {
                Some((State::Failed, Signal::ToolErrors, at))
            } else if let Some(at) = self.result_at.filter(|_| {
                denied_here
                    .iter()
                    .any(|tool| self.grants(&server.cli, tool))
            }) {
                Some((State::NotApproved, Signal::PermissionDenial, at))
            } else if let (Some(ServerInit::Connected), Some(at)) = (init, self.init_at) {
                Some((State::Working, Signal::Init, at))
            } else {
                None
            };
            if let Some((state, signal, at)) = decided {
                out.push(Observation {
                    connector: server.name.clone(),
                    state,
                    signal,
                    seen_at: stamp(at),
                });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::run_connectors;
    use chrono::TimeZone;
    use serde_json::json;

    const INIT: &str = include_str!("../../fixtures/cli-stream/init-connectors.json");
    const RUN: &str = include_str!("../../fixtures/cli-stream/connector-run.json");

    fn owned(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    /// The `n`th second of a fixed test morning.
    fn at(n: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 13, 9, 0, n).unwrap()
    }

    /// The servers, each granted whole.
    fn whole(servers: &[&str]) -> RunConnectors {
        run_connectors(&owned(servers), None, None)
    }

    fn init(servers: &[(&str, &str)]) -> Value {
        let list: Vec<Value> = servers
            .iter()
            .map(|(name, status)| json!({ "name": name, "status": status }))
            .collect();
        json!({ "type": "system", "subtype": "init", "mcp_servers": list })
    }

    fn call(id: &str, tool: &str) -> Value {
        json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": id, "name": tool, "input": {} }
        ] } })
    }

    fn answer(id: &str, is_error: bool) -> Value {
        json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": id, "content": "x", "is_error": is_error }
        ] } })
    }

    fn result() -> Value {
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": "done" })
    }

    /// Feed `events`, the `n`th read at second `n`.
    fn fed(connectors: &RunConnectors, events: &[Value]) -> Observer {
        let mut observer = Observer::new(connectors);
        for (n, event) in events.iter().enumerate() {
            observer.observe(event, at(n as u32));
        }
        observer
    }

    /// Each observation as (connector, state, signal).
    fn verdicts(observations: &[Observation]) -> Vec<(&str, &str, &str)> {
        observations
            .iter()
            .map(|o| (o.connector.as_str(), o.state.as_str(), o.signal.as_str()))
            .collect()
    }

    #[test]
    fn init_statuses_map_to_states() {
        // Connected, needs-auth and failed were recorded on toy servers; a
        // server switched off in the person's own config read `disabled`.
        // `pending` is the schema's word, never seen for an http server.
        let event: Value = serde_json::from_str(INIT).unwrap();
        assert_eq!(event["claude_code_version"], "2.1.250");
        let connectors = whole(&["ok", "auth", "down", "slow", "off"]);
        let observer = fed(&connectors, &[event, result()]);
        let observations = observer.finish(&[]);
        assert_eq!(
            verdicts(&observations),
            [
                ("ok", "working", "init"),
                ("auth", "needs_sign_in", "init"),
                ("down", "failed", "init"),
            ],
            "pending and disabled say nothing either way"
        );
        assert!(observations
            .iter()
            .all(|o| o.seen_at == "2026-10-13T09:00:00.000Z"));
    }

    #[test]
    fn a_successful_call_proves_a_connector_works() {
        let connectors = whole(&["gmail", "slack"]);
        let observer = fed(
            &connectors,
            &[
                init(&[("gmail", "pending"), ("slack", "needs-auth")]),
                call("toolu_1", "mcp__gmail__search_threads"),
                call("toolu_2", "mcp__slack__search"),
                answer("toolu_1", true),
                call("toolu_3", "mcp__gmail__search_threads"),
                answer("toolu_3", false),
                answer("toolu_2", false),
            ],
        );
        let observations = observer.finish(&[]);
        assert_eq!(
            verdicts(&observations),
            [
                ("gmail", "working", "tool_result"),
                ("slack", "working", "tool_result")
            ],
            "a call that worked outranks every word init said"
        );
        assert_eq!(observations[0].seen_at, "2026-10-13T09:00:05.000Z");
        assert_eq!(observations[1].seen_at, "2026-10-13T09:00:06.000Z");
    }

    #[test]
    fn a_denial_inside_the_grant_is_not_approved_and_one_outside_it_changes_nothing() {
        // gmail is granted whole, slack only its `search`, and slack's
        // `trash` is denied outright. The person's own Claude Code rules
        // asked about gmail's `send` (recorded: denied in -p); slack's
        // `post` was never granted, and the run's narrowing explains it.
        let connectors = run_connectors(
            &owned(&["gmail", "slack", "linear"]),
            Some(&owned(&["mcp__gmail", "mcp__slack__search", "mcp__linear"])),
            Some(&owned(&["mcp__linear__delete"])),
        );
        let denied = owned(&[
            "mcp__gmail__send",
            "mcp__linear__delete",
            "mcp__slack__post",
        ]);
        let events = [
            init(&[
                ("gmail", "pending"),
                ("slack", "pending"),
                ("linear", "connected"),
            ]),
            call("toolu_1", "mcp__gmail__send"),
            call("toolu_2", "mcp__slack__post"),
            call("toolu_3", "mcp__linear__delete"),
            answer("toolu_1", true),
            answer("toolu_2", true),
            answer("toolu_3", true),
            result(),
        ];
        let observations = fed(&connectors, &events).finish(&denied);
        assert_eq!(
            verdicts(&observations),
            [
                ("gmail", "not_approved", "permission_denial"),
                ("linear", "working", "init"),
            ],
            "slack's denial is the run's own narrowing, and linear's deny is \
             the record's: neither says anything about the connector"
        );
        assert_eq!(observations[0].seen_at, "2026-10-13T09:00:07.000Z");
    }

    #[test]
    fn a_denied_call_is_not_counted_as_an_error() {
        // A denied call comes back as an error result. Here every call each
        // server got came back that way, and none of them is failed for it.
        let connectors = run_connectors(
            &owned(&["gmail", "slack"]),
            Some(&owned(&["mcp__gmail", "mcp__slack__search"])),
            None,
        );
        let events = [
            init(&[("gmail", "pending"), ("slack", "pending")]),
            call("toolu_1", "mcp__gmail__send"),
            call("toolu_2", "mcp__slack__post"),
            answer("toolu_1", true),
            answer("toolu_2", true),
            result(),
        ];
        let observations =
            fed(&connectors, &events).finish(&owned(&["mcp__gmail__send", "mcp__slack__post"]));
        assert_eq!(
            verdicts(&observations),
            [("gmail", "not_approved", "permission_denial")]
        );
    }

    #[test]
    fn grouped_errors_fail_only_an_unconnected_server_after_the_result() {
        let connectors = whole(&["quiet", "up", "mixed", "waiting"]);
        let mut events = vec![
            init(&[("quiet", "pending"), ("up", "connected")]),
            call("toolu_1", "mcp__quiet__a"),
            call("toolu_2", "mcp__quiet__b"),
            call("toolu_3", "mcp__up__a"),
            call("toolu_4", "mcp__mixed__a"),
            call("toolu_5", "mcp__mixed__b"),
            call("toolu_6", "mcp__waiting__a"),
            call("toolu_7", "mcp__waiting__b"),
            answer("toolu_1", true),
            answer("toolu_2", true),
            answer("toolu_3", true),
            answer("toolu_4", true),
            answer("toolu_5", false),
            answer("toolu_6", true),
        ];
        assert_eq!(
            verdicts(&fed(&connectors, &events).finish(&[])),
            [
                ("up", "working", "init"),
                ("mixed", "working", "tool_result")
            ],
            "before the result, errors fail nothing"
        );
        events.push(result());
        let observations = fed(&connectors, &events).finish(&[]);
        assert_eq!(
            verdicts(&observations),
            [
                ("quiet", "failed", "tool_errors"),
                ("up", "working", "init"),
                ("mixed", "working", "tool_result"),
            ],
            "a connected server keeps working through bad calls, and a call \
             that never came back is not an error"
        );
        assert_eq!(
            observations[0].seen_at, "2026-10-13T09:00:09.000Z",
            "seen when its last error came back"
        );
    }

    #[test]
    fn connector_inits_name_each_loaded_server_as_the_init_spells_it() {
        // M92.8: the Reach reads the run's first init by the vault's names,
        // as the observer does, and says what it left out rather than
        // guessing.
        let event: Value = serde_json::from_str(INIT).unwrap();
        let names = owned(&["ok", "auth", "down", "slow", "off", "gone"]);
        let statuses: Vec<(String, String)> = connector_inits(&names, &event)
            .into_iter()
            .map(|init| (init.name, init.status))
            .collect();
        let expected: Vec<(String, String)> = [
            ("ok", "connected"),
            ("auth", "needs-auth"),
            ("down", "failed"),
            ("slow", "pending"),
            ("off", "disabled"),
            ("gone", "absent"),
        ]
        .iter()
        .map(|(name, status)| (name.to_string(), status.to_string()))
        .collect();
        assert_eq!(statuses, expected);
        // A word this build does not know is kept as the CLI spelled it, and
        // an init with no list reports none.
        let odd = init(&[("toy", "reconnecting")]);
        assert_eq!(
            connector_inits(&owned(&["toy"]), &odd),
            [ConnectorInit {
                name: "toy".into(),
                status: "reconnecting".into()
            }]
        );
        let bare = json!({ "type": "system", "subtype": "init" });
        assert_eq!(
            connector_inits(&owned(&["toy"]), &bare)[0].status,
            "unreported"
        );
        assert!(connector_inits(&[], &odd).is_empty());
    }

    #[test]
    fn a_cli_name_maps_back_to_the_vault_name() {
        // Init names the server as the config does; its tools carry the
        // name the CLI hears.
        let connectors = whole(&["toy.v2", "my toy"]);
        assert_eq!(
            connectors.servers,
            [
                ("toy.v2".to_string(), "toy_v2".to_string()),
                ("my toy".to_string(), "my_toy".to_string())
            ]
        );
        let observations = fed(
            &connectors,
            &[
                init(&[("toy.v2", "pending"), ("my toy", "needs-auth")]),
                call("toolu_1", "mcp__toy_v2__echo"),
                answer("toolu_1", false),
            ],
        )
        .finish(&[]);
        assert_eq!(
            verdicts(&observations),
            [
                ("toy.v2", "working", "tool_result"),
                ("my toy", "needs_sign_in", "init")
            ]
        );
    }

    #[test]
    fn servers_outside_the_run_are_ignored() {
        let connectors = whole(&["gmail"]);
        let events = [
            init(&[
                ("cerebro", "connected"),
                ("stranger", "needs-auth"),
                ("gmail", "pending"),
            ]),
            call("toolu_1", "mcp__cerebro__get_note"),
            call("toolu_2", "mcp__stranger__x"),
            call("toolu_3", "Bash"),
            call("toolu_4", "mcp__Gmail__search"),
            answer("toolu_1", false),
            answer("toolu_2", false),
            answer("toolu_3", false),
            answer("toolu_4", false),
            result(),
        ];
        let observer = fed(&connectors, &events);
        assert!(
            observer
                .finish(&owned(&["mcp__stranger__y", "mcp__cerebro__z"]))
                .is_empty(),
            "only the run's own servers, by their exact CLI name"
        );
        // A run with no connectors observes nothing at all.
        assert!(fed(&RunConnectors::default(), &events)
            .finish(&[])
            .is_empty());
    }

    #[test]
    fn the_connector_run_fixture_yields_one_observation_per_server() {
        // Recorded on toy servers: ok answered echo and failed broken, and
        // its `other` was never granted; auth answered 401 with resolvable
        // OAuth metadata; down was a closed port; errs failed every call;
        // the person's own ask rule stopped asked's echo; narrow's grant
        // named only echo. The record's narrowing below grants exactly what
        // the recorded run's `--allowedTools` granted.
        let stream: Vec<Value> = serde_json::from_str(RUN).unwrap();
        assert_eq!(stream[0]["claude_code_version"], "2.1.250");
        let connectors = run_connectors(
            &owned(&["ok", "auth", "down", "errs", "asked", "narrow"]),
            Some(&owned(&[
                "mcp__ok__echo",
                "mcp__ok__broken",
                "mcp__auth",
                "mcp__down",
                "mcp__errs",
                "mcp__asked",
                "mcp__narrow__echo",
            ])),
            None,
        );
        assert_eq!(
            connectors.allow.join(","),
            "mcp__asked,mcp__auth,mcp__down,mcp__errs,mcp__narrow__echo,mcp__ok__broken,\
             mcp__ok__echo"
        );
        let mut tally = crate::agent::meter::Tally::default();
        let mut observer = Observer::new(&connectors);
        for (n, event) in stream.iter().enumerate() {
            tally.observe(event);
            observer.observe(event, at(n as u32));
        }
        let observations = observer.finish(tally.denied_tools());
        assert_eq!(
            verdicts(&observations),
            [
                ("ok", "working", "tool_result"),
                ("auth", "needs_sign_in", "init"),
                ("down", "failed", "init"),
                ("errs", "working", "init"),
                ("asked", "not_approved", "permission_denial"),
                ("narrow", "working", "init"),
            ]
        );
    }
}
