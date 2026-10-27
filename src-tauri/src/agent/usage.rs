//! Token usage off the CLI wire (M25.2).
//!
//! Until then every `usage` object the CLI emitted was discarded: the stream
//! reader read `session_id`, `is_error`, and `result` off a `result` event and
//! nothing else (and the normalized `AgentEvent` vocabulary has no member
//! that could carry a token count anyway). The app therefore could not
//! measure its own spend, which is why nothing ambient could be turned on.
//!
//! **Usage does not travel on the UI event channel, deliberately.** Widening
//! `AgentEvent` would push token counts through the Tauri emitter, the TS
//! event union, the mock agent, every panel listener and the re-attach
//! journal — and a number that rides the channel is a number that ends up in
//! a run log and then in a portable receipt. The reader thread already owns
//! a run's lifetime; it parses usage here and writes it straight to the
//! runtime DB. What a run spent stays on the operational side of D5 by
//! construction rather than by everyone remembering.
//!
//! **Two of a run's numbers reach the renderer, and neither says what it
//! spent** (the owner's narrowings of the rule above). How much of its
//! model's context window a conversation has used, [`context_used`] of the
//! run's latest turn (M91.5), with Claude Code's own breakdown of that window
//! when a seated run answered its context ask (M92.13,
//! `meter::ContextBreakdown`), reaches it only when it asks: the reader files
//! it in a memory-only book (`meter::ContextBook`), and the composer pulls it
//! with `agent_context_usage` when a turn ends, a thread opens or a branch
//! starts, so it is never emitted, journaled, logged or stored. How long
//! Claude Code worked on a turn, its result's `duration_ms` (M92.2, O4), does
//! ride the channel: the fold carries it on the event the result folds to,
//! so it is journaled with that event, and a thread saves each reply's sum
//! for its "Worked for" line. [`RunFacts::duration_ms`] is the same count,
//! booked on the run's row.
//!
//! **The wire format is external and drifts.** Every field is optional, a
//! non-numeric value is ignored rather than fatal, and a key this build has
//! never heard of is recorded in `operational_log` — once per run, not once
//! per event — so a CLI upgrade that starts reporting something new is
//! visible without being an outage.
//!
//! **A run's subagents spend outside its `usage`** (M91.2c). The result's
//! `usage` counts the run's own thread; its `modelUsage`, one entry per
//! model, counts every call the run made, its subagents' included. The meter
//! books the sum over `modelUsage` when that is a measurement of this run
//! alone, else `usage`; a run that called the subagent tool without one
//! spent an amount nobody recorded, booked as neither its own thread's share
//! nor zero. From 2.1.277 a resumed session's `modelUsage` starts from the
//! totals its transcript saved, so it is this run's alone only on a CLI
//! before that release.

use serde_json::Value;

/// The four disjoint token counts the budget sums. Named for what they are on
/// our side, mapped from the CLI's spelling in [`parse`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    /// What a day's `ambient_tokens_used` accumulates. The four fields are
    /// disjoint on this wire — cached reads are not also counted as input —
    /// so the total is a sum and not a max.
    pub fn total(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
    }

    /// Field by field, saturating like [`Usage::total`].
    fn plus(self, other: Usage) -> Usage {
        Usage {
            input_tokens: self.input_tokens.saturating_add(other.input_tokens),
            output_tokens: self.output_tokens.saturating_add(other.output_tokens),
            cache_read: self.cache_read.saturating_add(other.cache_read),
            cache_write: self.cache_write.saturating_add(other.cache_write),
        }
    }
}

/// One wire key and where its count lands.
type Counted = (&'static str, fn(&mut Usage, u64));

/// CLI spelling → our field. The one place the mapping exists.
const COUNTED: [Counted; 4] = [
    ("input_tokens", |u, v| u.input_tokens = v),
    ("output_tokens", |u, v| u.output_tokens = v),
    ("cache_read_input_tokens", |u, v| u.cache_read = v),
    ("cache_creation_input_tokens", |u, v| u.cache_write = v),
];

/// Keys consumed by RunFacts (M31.5) — not counts, so not COUNTED, but
/// known and read; unknown_fields must not report them.
const FACTS_CONSUMED: [&str; 4] = [
    "service_tier",
    "cache_creation",
    "ephemeral_1h_input_tokens",
    "server_tool_use",
];

/// The result stop reasons that say a hook deferred the run's last call
/// (M57.1, CLI 2.1.250): the call was held, or its tool was gone on resume.
pub const DEFERRED_STOPS: [&str; 2] = ["tool_deferred", "tool_deferred_unavailable"];

/// Keys seen and deliberately not stored. Emptied by M31.5 — everything we
/// used to shrug at is now consumed by RunFacts. The const and this doc
/// stay so the logger's contract (report what is in NEITHER list) remains
/// visible, and so the next suppressed key has a place to land with a
/// reason.
const KNOWN_UNCOUNTED: [&str; 0] = [];

/// The result's per-model counts (M91.2c), keyed by model, and the prefix
/// `unknown_fields` names an unread key of theirs under.
const MODEL_USAGE: &str = "modelUsage";

/// A `modelUsage` entry's spelling of the four counts → our field.
const MODEL_COUNTED: [Counted; 4] = [
    ("inputTokens", |u, v| u.input_tokens = v),
    ("outputTokens", |u, v| u.output_tokens = v),
    ("cacheReadInputTokens", |u, v| u.cache_read = v),
    ("cacheCreationInputTokens", |u, v| u.cache_write = v),
];

/// The first Claude Code release whose headless `--resume` and fork restore
/// a session's saved totals (changelog 2.1.277): from it on, a resumed run's
/// `modelUsage` already carries the session's earlier turns, and booking it
/// would charge every thread turn for all the turns before it again.
const RESUME_RESTORES_TOTALS: (u64, u64, u64) = (2, 1, 277);

/// The rest of a `modelUsage` entry, as 2.1.250's schema declares it, known
/// and not stored: what the calls cost and how they were priced, the web
/// searches among them, and the model's output limit. The budget books
/// tokens, and the run's cost is already the result's `total_cost_usd`.
const MODEL_KNOWN_UNCOUNTED: [&str; 6] = [
    "webSearchRequests",
    "costUSD",
    "maxOutputTokens",
    "canonicalModel",
    "provider",
    "costBasis",
];

/// A `modelUsage` entry's model context window (M91.5), which
/// [`context_window`] reads for the composer's Context: known and read, so
/// `unknown_fields` must not report it, and never booked.
const CONTEXT_WINDOW: &str = "contextWindow";

/// An `assistant` line's counts of what its request sent (M91.5): together,
/// everything the model had in its context window for that turn. Its output
/// is not among them; it joins the context on the next request.
const CONTEXT_COUNTED: [&str; 3] = [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
];

/// The non-count facts a run's stream already carries (M31.5).
///
/// Every field is best-effort `Option`, deliberately: measurement records
/// what happened and must never become a second way for the run to fail. A
/// value the wire spelled in a way this build cannot read degrades that ONE
/// field to absent — and absent is never zero.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunFacts {
    /// From the last `assistant` turn that names a model. A `<synthetic>`
    /// line, the CLI's own reply after an API error, never counts (M56.5): no
    /// model wrote it.
    pub model_id: Option<String>,
    /// From the last `assistant` turn, unless the result names a deferral
    /// (M57.1): `tool_deferred` or `tool_deferred_unavailable` on the result
    /// is the run's stop reason, since its last turn only asked for the call
    /// a hook then held.
    pub stop_reason: Option<String>,
    pub service_tier: Option<String>,
    /// `total_cost_usd` × 1e6, rounded. Only a finite, non-negative number
    /// is a cost; anything else is absent.
    pub total_cost_micros: Option<u64>,
    pub num_turns: Option<u64>,
    pub duration_ms: Option<u64>,
    pub duration_api_ms: Option<u64>,
    /// `usage.cache_creation.ephemeral_5m_input_tokens`.
    pub cache_write_5m: Option<u64>,
    /// `usage.cache_creation.ephemeral_1h_input_tokens`.
    pub cache_write_1h: Option<u64>,
    /// Length of the `permission_denials` array. Missing is `None`; an empty
    /// array is `Some(0)` — different answers on purpose.
    pub permission_denials: Option<u64>,
    /// The tools those denials name (M54.9): each denial's `tool_name`,
    /// sorted and once each. Missing array is `None`, an empty one
    /// `Some(vec![])`, as for the count. A tool outside a run's grant is
    /// denied by the CLI and named here; one in its `--disallowedTools` is
    /// withdrawn from the run instead, and never appears (recorded on
    /// 2.1.250).
    pub denied_tools: Option<Vec<String>>,
    /// Sum of the `usage.server_tool_use` object's numeric values; absent
    /// when the object is absent.
    pub server_tool_use: Option<u64>,
}

impl RunFacts {
    /// The result-event fields. `None` when the event is not terminal.
    pub fn parse(event: &Value) -> Option<RunFacts> {
        if !is_result(event) {
            return None;
        }
        let usage = usage_object(event).and_then(Value::as_object);
        Some(RunFacts {
            model_id: None,
            stop_reason: event
                .get("stop_reason")
                .and_then(Value::as_str)
                .filter(|stop| DEFERRED_STOPS.contains(stop))
                .map(str::to_string),
            service_tier: usage
                .and_then(|u| u.get("service_tier"))
                .and_then(Value::as_str)
                .map(str::to_string),
            total_cost_micros: event
                .get("total_cost_usd")
                .and_then(Value::as_f64)
                .filter(|usd| usd.is_finite() && *usd >= 0.0)
                .map(|usd| (usd * 1e6).round() as u64),
            num_turns: event.get("num_turns").and_then(Value::as_u64),
            duration_ms: event.get("duration_ms").and_then(Value::as_u64),
            duration_api_ms: event.get("duration_api_ms").and_then(Value::as_u64),
            cache_write_5m: cache_creation(usage, "ephemeral_5m_input_tokens"),
            cache_write_1h: cache_creation(usage, "ephemeral_1h_input_tokens"),
            permission_denials: event
                .get("permission_denials")
                .and_then(Value::as_array)
                .map(|denials| denials.len() as u64),
            denied_tools: event
                .get("permission_denials")
                .and_then(Value::as_array)
                .map(|denials| {
                    let mut names: Vec<String> = denials
                        .iter()
                        .filter_map(|denial| denial.get("tool_name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect();
                    names.sort();
                    names.dedup();
                    names
                }),
            server_tool_use: usage
                .and_then(|u| u.get("server_tool_use"))
                .and_then(Value::as_object)
                .map(|calls| {
                    calls
                        .values()
                        .filter_map(Value::as_u64)
                        .fold(0u64, u64::saturating_add)
                }),
        })
    }

    /// The assistant-turn fields. `None` when the event is not a turn of the
    /// run's own: a subagent's line (M91.3b) names the model and stop reason
    /// of the subagent, never the run's.
    pub fn from_assistant(event: &Value) -> Option<RunFacts> {
        if !is_own_turn(event) {
            return None;
        }
        let message = event.get("message")?;
        Some(RunFacts {
            // A value in angle brackets is a placeholder, not a model.
            model_id: message
                .get("model")
                .and_then(Value::as_str)
                .filter(|m| !m.trim().is_empty() && !m.starts_with('<'))
                .map(str::to_string),
            stop_reason: message
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            ..RunFacts::default()
        })
    }

    /// Fold a later reading over this one, field-wise: a present field wins,
    /// an absent one never erases what an earlier event said. Fed every
    /// turn, this is what makes the FINAL turn's `stop_reason` the run's,
    /// and a deferred result's stop reason win over it.
    pub fn merge(&mut self, newer: RunFacts) {
        self.model_id = newer.model_id.or_else(|| self.model_id.take());
        self.stop_reason = newer.stop_reason.or_else(|| self.stop_reason.take());
        self.service_tier = newer.service_tier.or_else(|| self.service_tier.take());
        self.total_cost_micros = newer.total_cost_micros.or(self.total_cost_micros);
        self.num_turns = newer.num_turns.or(self.num_turns);
        self.duration_ms = newer.duration_ms.or(self.duration_ms);
        self.duration_api_ms = newer.duration_api_ms.or(self.duration_api_ms);
        self.cache_write_5m = newer.cache_write_5m.or(self.cache_write_5m);
        self.cache_write_1h = newer.cache_write_1h.or(self.cache_write_1h);
        self.permission_denials = newer.permission_denials.or(self.permission_denials);
        self.denied_tools = newer.denied_tools.or_else(|| self.denied_tools.take());
        self.server_tool_use = newer.server_tool_use.or(self.server_tool_use);
    }
}

/// One TTL bucket of the `usage.cache_creation` object, absent when the
/// object (or the bucket) is absent.
fn cache_creation(usage: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<u64> {
    usage?
        .get("cache_creation")?
        .get(key)
        .and_then(Value::as_u64)
}

/// The `usage` object of one CLI event, or `None` when the event carries no
/// usage at all.
///
/// A negative or fractional count is not a token count; it is ignored, and
/// the field simply stays zero rather than poisoning the day's arithmetic
/// with a value the provider could not have meant.
pub fn parse(event: &Value) -> Option<Usage> {
    let object = usage_object(event)?.as_object()?;
    let mut usage = Usage::default();
    for (key, set) in COUNTED {
        if let Some(count) = object.get(key).and_then(Value::as_u64) {
            set(&mut usage, count);
        }
    }
    Some(usage)
}

/// The whole tree's counts (M91.2c): the sum over a result's `modelUsage`,
/// which counts every call the run made, its subagents' included. `None`
/// unless that is a measurement: a non-empty object whose every entry
/// carries all four counts as token counts, summing above zero. An empty or
/// missing one never sums to zero, a sum that skipped an unreadable entry
/// would read as a smaller bill than the one paid, and a crash or startup
/// error's result may carry zeroed counts for calls that were made.
pub fn whole_tree(event: &Value) -> Option<Usage> {
    let models = event.get(MODEL_USAGE)?.as_object()?;
    let sum = models.values().try_fold(Usage::default(), |sum, entry| {
        let entry = entry.as_object()?;
        let mut usage = Usage::default();
        for (key, set) in MODEL_COUNTED {
            set(&mut usage, entry.get(key)?.as_u64()?);
        }
        Some(sum.plus(usage))
    })?;
    (sum.total() > 0).then_some(sum)
}

/// Does a run on Claude Code `version` (its init's `claude_code_version`)
/// report a `modelUsage` that counts this run alone? Only a release before
/// [`RESUME_RESTORES_TOTALS`] does for a resumed session; a version nobody
/// could read is not known to.
pub(crate) fn model_usage_is_the_runs(version: Option<&str>) -> bool {
    version
        .and_then(crate::policy::tool_approval::version_triple)
        .is_some_and(|found| found < RESUME_RESTORES_TOTALS)
}

/// Does `event` belong to a subagent? A session file marks its sidechain
/// lines, and the stream names the Agent call each of a subagent's lines
/// came from. The fold's rule (M91.3b), so the meter and the fold agree on
/// whose a line is.
pub(crate) fn from_a_subagent(event: &Value) -> bool {
    event.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || event
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null())
}

/// Is `event` an `assistant` turn of the run's own thread?
fn is_own_turn(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("assistant") && !from_a_subagent(event)
}

/// How much of its model's context window the run's own thread used at
/// `event` (M91.5): the sum of an `assistant` line's [`CONTEXT_COUNTED`],
/// which is everything that turn's request sent. `None` unless `event` is a
/// turn of the run's own thread whose three counts are all token counts
/// summing above zero. A subagent's line measures its own context, never
/// the run's (M91.3b, [`from_a_subagent`]); a `<synthetic>` line is the
/// CLI's own reply to an API error, which no model read; and a line that
/// left a count out, or counts nothing, would read smaller than the context
/// was, which is worse than no reading (CV-05).
///
/// A line's own usage is that one request's, so this holds on any release:
/// the totals Claude Code 2.1.277 restores into a resumed session's result
/// (see [`model_usage_is_the_runs`]) never reach a line.
pub(crate) fn context_used(event: &Value) -> Option<u64> {
    if !is_own_turn(event) {
        return None;
    }
    let message = event.get("message")?;
    if message
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| model.starts_with('<'))
    {
        return None;
    }
    let usage = message.get("usage")?.as_object()?;
    let used = CONTEXT_COUNTED.iter().try_fold(0u64, |sum, key| {
        Some(sum.saturating_add(usage.get(*key)?.as_u64()?))
    })?;
    (used > 0).then_some(used)
}

/// The context window `model` ran in, as a terminal result's `modelUsage`
/// reports it (M91.5): the entry keyed by `model` itself, when its
/// `contextWindow` is a token count above zero. `None` for any other event,
/// another model's entry, or a window nobody could read. The window is the
/// model's limit, not a total, so a resumed session's restored totals
/// (2.1.277) leave it as it was.
pub(crate) fn context_window(event: &Value, model: &str) -> Option<u64> {
    if !is_result(event) {
        return None;
    }
    event
        .get(MODEL_USAGE)?
        .get(model)?
        .get(CONTEXT_WINDOW)?
        .as_u64()
        .filter(|window| *window > 0)
}

/// Does `event`, a turn of the run's own thread, call the subagent tool, by
/// any name the manifest gives it (M91.2c)? What its subagents spend is
/// then outside the result's `usage`.
pub(crate) fn calls_subagent_tool(event: &Value) -> bool {
    if !is_own_turn(event) {
        return false;
    }
    let Some(subagent) = super::cli_agents::delegate_tool() else {
        return false;
    };
    event
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks.iter().any(|block| {
                block.get("type").and_then(Value::as_str) == Some("tool_use")
                    && block
                        .get("name")
                        .and_then(Value::as_str)
                        .and_then(crate::policy::tools::cli_tool)
                        .is_some_and(|tool| tool.name == subagent.name)
            })
        })
}

/// Keys this build does not recognize, sorted and duplicate-free: inside the
/// `usage` object, and inside each `modelUsage` entry, named
/// `modelUsage.<key>` (M91.2c).
pub fn unknown_fields(event: &Value) -> Vec<String> {
    let usage = usage_object(event)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|object| object.keys())
        .filter(|key| {
            !COUNTED.iter().any(|(known, _)| known == *key)
                && !FACTS_CONSUMED.contains(&key.as_str())
                && !KNOWN_UNCOUNTED.contains(&key.as_str())
        })
        .cloned();
    let models = event
        .get(MODEL_USAGE)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|models| models.values())
        .filter_map(Value::as_object)
        .flat_map(|entry| entry.keys())
        .filter(|key| {
            !MODEL_COUNTED.iter().any(|(known, _)| known == *key)
                && !MODEL_KNOWN_UNCOUNTED.contains(&key.as_str())
                && key.as_str() != CONTEXT_WINDOW
        })
        .map(|key| format!("{MODEL_USAGE}.{key}"));
    let mut unknown: Vec<String> = usage.chain(models).collect();
    unknown.sort();
    unknown.dedup();
    unknown
}

/// Where usage lives on the two event shapes that carry it: a terminal
/// `result` event holds it at the top level, an `assistant` turn holds it
/// under `message`. Any other line's `usage` is not one: a subagent's
/// `system/task_progress` and `task_notification` (M91.3b) carry its running
/// total, tool uses and time, and its tokens reach the books through the
/// result's `modelUsage`.
fn usage_object(event: &Value) -> Option<&Value> {
    match event.get("type").and_then(Value::as_str) {
        Some("result") => event.get("usage"),
        Some("assistant") => event.get("message").and_then(|m| m.get("usage")),
        _ => None,
    }
}

/// Is this the CLI's terminal event for a run?
///
/// The `result` event is the authority for a run's usage: it is cumulative
/// across every turn, where an `assistant` event's usage is that turn's
/// alone. A meter that summed the per-turn objects would double-count the
/// cached prefix on every turn after the first.
pub fn is_result(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("result")
}

/// Did the CLI report this run as a failure?
///
/// `is_error` is the only boolean, but `subtype` carries the reason, and
/// `error_max_turns` is a failure the boolean does not always mark. Both are
/// consulted so a truncated run is not recorded as a clean success.
pub fn is_failure(event: &Value) -> bool {
    if event.get("is_error").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    matches!(
        event.get("subtype").and_then(Value::as_str),
        Some("error_max_turns") | Some("error_during_execution")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_deferred_result_names_its_stop_reason() {
        let lines: Vec<Value> = serde_json::from_str(include_str!(
            "../../fixtures/cli-stream/transcript-deferred.stream.json"
        ))
        .unwrap();
        let mut facts = RunFacts::default();
        for line in &lines {
            if let Some(turn) = RunFacts::from_assistant(line) {
                facts.merge(turn);
            }
            if let Some(terminal) = RunFacts::parse(line) {
                facts.merge(terminal);
            }
        }
        assert_eq!(facts.stop_reason.as_deref(), Some("tool_deferred"));
        let gone = json!({ "type": "result", "subtype": "success", "is_error": true,
            "stop_reason": "tool_deferred_unavailable" });
        assert_eq!(
            RunFacts::parse(&gone).unwrap().stop_reason.as_deref(),
            Some("tool_deferred_unavailable")
        );
        // Any other result stop reason leaves the last turn's in place.
        let mut facts = RunFacts::from_assistant(&json!({ "type": "assistant",
            "message": { "stop_reason": "end_turn" } }))
        .unwrap();
        facts.merge(
            RunFacts::parse(&json!({ "type": "result", "stop_reason": "end_turn" })).unwrap(),
        );
        facts.merge(RunFacts::parse(&json!({ "type": "result" })).unwrap());
        assert_eq!(facts.stop_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn a_synthetic_error_line_never_names_the_runs_model() {
        let answered = json!({ "type": "assistant", "message": {
            "model": "claude-sonnet-5", "stop_reason": "end_turn" } });
        let synthetic = json!({ "type": "assistant", "message": {
            "model": "<synthetic>", "stop_reason": "stop_sequence" } });
        let mut facts = RunFacts::from_assistant(&answered).unwrap();
        let after = RunFacts::from_assistant(&synthetic).unwrap();
        assert_eq!(after.model_id, None);
        facts.merge(after);
        assert_eq!(facts.model_id.as_deref(), Some("claude-sonnet-5"));
        // A run whose only line was the error names no model at all.
        assert_eq!(RunFacts::from_assistant(&synthetic).unwrap().model_id, None);
    }

    #[test]
    fn a_subagents_line_never_names_the_runs_model() {
        // M91.3b: the stream forwards a subagent's lines beside the run's,
        // and the last assistant line can be one of them; a session file's
        // sidechain line is one too.
        let mut facts = RunFacts::default();
        for line in [
            json!({ "type": "assistant", "parent_tool_use_id": null,
                "message": { "model": "claude-sonnet-5", "stop_reason": "end_turn" } }),
            json!({ "type": "assistant", "parent_tool_use_id": "toolu_000000000000000000000001",
                "message": { "model": "claude-haiku-4-5-20251001", "stop_reason": "tool_use" } }),
            json!({ "type": "assistant", "isSidechain": true,
                "message": { "model": "claude-haiku-4-5-20251001", "stop_reason": "tool_use" } }),
        ] {
            if let Some(turn) = RunFacts::from_assistant(&line) {
                facts.merge(turn);
            }
        }
        assert_eq!(facts.model_id.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(facts.stop_reason.as_deref(), Some("end_turn"));
    }

    /// CLI output shaped by hand from real runs and reduced to the fields
    /// these tests read (the top of cli-stream/), except where a fixture says
    /// it was recorded. Never live CLI output in CI: the wire format is
    /// somebody else's and would make the suite fail on their release
    /// schedule.
    const RESULT_SUCCESS: &str = include_str!("../../fixtures/cli-stream/result-success.json");
    /// Hand-built in 2.1.250's shape until a recording exists (M56.4): a
    /// weekly limit refused the first request.
    const USAGE_LIMIT_STREAM: &str =
        include_str!("../../fixtures/cli-stream/usage-limit-stream.json");
    const ASSISTANT_TURN: &str = include_str!("../../fixtures/cli-stream/assistant-turn.json");
    const RESULT_FUTURE: &str = include_str!("../../fixtures/cli-stream/result-future-fields.json");
    const RESULT_CACHE_TTL: &str = include_str!("../../fixtures/cli-stream/result-cache-ttl.json");
    /// M54.9, recorded on 2.1.250 against a toy server whose `echo` alone
    /// was granted: the run called `other` twice and Bash once.
    const CONNECTOR_DENIALS: &str =
        include_str!("../../fixtures/cli-stream/result-connector-denials.json");

    fn fixture(raw: &str) -> Value {
        serde_json::from_str(raw).expect("fixture is valid json")
    }

    #[test]
    fn a_recorded_result_event_yields_its_four_counts() {
        let event = fixture(RESULT_SUCCESS);
        assert!(is_result(&event));
        let usage = parse(&event).expect("a result event carries usage");
        assert_eq!(
            usage,
            Usage {
                input_tokens: 4,
                output_tokens: 271,
                cache_read: 14_678,
                cache_write: 1_205,
            }
        );
        assert_eq!(usage.total(), 4 + 271 + 14_678 + 1_205);
        assert!(!is_failure(&event));
        assert!(
            unknown_fields(&event).is_empty(),
            "{:?}",
            unknown_fields(&event)
        );
    }

    #[test]
    fn a_quota_death_still_reports_its_usage() {
        // The honest-failure path: a run that died on quota reports what it
        // spent, so the books never read it as unknown. A first request the
        // limit refused spent nothing, and the result says so: reported, not
        // above zero. Whether it was quota is the fold's call (M56.4).
        let stream: Value = fixture(USAGE_LIMIT_STREAM);
        let event = stream["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|line| is_result(line))
            .expect("the stream ends in its result")
            .clone();
        assert!(is_failure(&event));
        assert!(
            parse(&event).is_some(),
            "a quota failure still carries usage"
        );
    }

    #[test]
    fn an_assistant_turn_carries_its_own_usage_under_message() {
        let event = fixture(ASSISTANT_TURN);
        assert!(!is_result(&event));
        assert_eq!(
            parse(&event),
            Some(Usage {
                input_tokens: 3,
                output_tokens: 88,
                cache_read: 14_678,
                cache_write: 0,
            })
        );
    }

    #[test]
    fn a_field_this_build_has_never_seen_is_noted_and_never_fatal() {
        let event = fixture(RESULT_FUTURE);
        assert_eq!(
            parse(&event),
            Some(Usage {
                input_tokens: 10,
                output_tokens: 20,
                cache_read: 0,
                cache_write: 0,
            }),
            "the counts this build knows still land"
        );
        assert_eq!(
            unknown_fields(&event),
            vec!["quantum_tokens".to_string(), "zeta_tokens".to_string()],
            "sorted, so two runs report the same thing"
        );
    }

    #[test]
    fn fields_consumed_by_run_facts_are_not_reported_as_unknown() {
        // These keys are read by RunFacts (M31.5), not counted by the budget
        // — but they are known, and reporting them would log the same two
        // lines on every run until nobody reads the log at all.
        let event = json!({
            "type": "result",
            "usage": { "input_tokens": 1, "service_tier": "standard", "server_tool_use": {} }
        });
        assert!(unknown_fields(&event).is_empty());
    }

    /// A result whose `modelUsage` holds two models (M91.2c): the run's own
    /// thread's and its subagent's, the first with every key 2.1.250's
    /// schema declares.
    fn two_models() -> Value {
        json!({
            "type": "result",
            "usage": { "input_tokens": 14, "output_tokens": 150,
                "cache_read_input_tokens": 6200, "cache_creation_input_tokens": 0 },
            "modelUsage": {
                "claude-sonnet-5": { "inputTokens": 14, "outputTokens": 150,
                    "cacheReadInputTokens": 6200, "cacheCreationInputTokens": 0,
                    "webSearchRequests": 0, "costUSD": 0.0123, "contextWindow": 200000,
                    "maxOutputTokens": 32000, "canonicalModel": "claude-sonnet-5",
                    "provider": "firstParty", "costBasis": "list" },
                "claude-haiku-4-5-20251001": { "inputTokens": 2950, "outputTokens": 170,
                    "cacheReadInputTokens": 0, "cacheCreationInputTokens": 1200,
                    "webSearchRequests": 0, "costUSD": 0.0042, "contextWindow": 200000,
                    "maxOutputTokens": 32000 }
            }
        })
    }

    #[test]
    fn the_whole_tree_sums_every_model_the_run_called() {
        let event = two_models();
        assert_eq!(
            whole_tree(&event),
            Some(Usage {
                input_tokens: 2_964,
                output_tokens: 320,
                cache_read: 6_200,
                cache_write: 1_200,
            }),
            "the subagent's model counts beside the run's own"
        );
        assert_eq!(
            parse(&event).map(|usage| usage.total()),
            Some(14 + 150 + 6_200),
            "`usage` is the run's own thread alone"
        );
        assert!(
            unknown_fields(&event).is_empty(),
            "{:?}",
            unknown_fields(&event)
        );
    }

    #[test]
    fn a_model_usage_that_measures_nothing_is_none_never_zero() {
        let entry = || {
            json!({ "inputTokens": 1, "outputTokens": 2, "cacheReadInputTokens": 3,
                "cacheCreationInputTokens": 4 })
        };
        let spoilt = |key: &str, value: Value| {
            let mut spoilt = entry();
            spoilt[key] = value;
            json!({ "claude-sonnet-5": spoilt })
        };
        let mut short = entry();
        short
            .as_object_mut()
            .unwrap()
            .remove("cacheCreationInputTokens");
        for (case, model_usage) in [
            ("empty", json!({})),
            ("not an object", json!([entry()])),
            (
                "an entry that is not an object",
                json!({ "claude-sonnet-5": 7 }),
            ),
            ("a count missing", json!({ "claude-sonnet-5": short })),
            ("a negative count", spoilt("inputTokens", json!(-1))),
            ("a fractional count", spoilt("outputTokens", json!(1.5))),
            (
                "a count as text",
                spoilt("cacheReadInputTokens", json!("3")),
            ),
            (
                "a readable entry beside an unreadable one",
                json!({ "claude-sonnet-5": entry(), "claude-haiku-4-5": { "inputTokens": 1 } }),
            ),
        ] {
            let event = json!({ "type": "result", "modelUsage": model_usage });
            assert_eq!(whole_tree(&event), None, "{case}");
        }
        assert_eq!(whole_tree(&json!({ "type": "result" })), None, "missing");
        // A crash or startup error's result may carry zeroed counts for calls
        // that were made: the tree never reads as free.
        let zeros = json!({ "type": "result", "is_error": true, "modelUsage": {
            "claude-sonnet-5": { "inputTokens": 0, "outputTokens": 0,
                "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0 } } });
        assert_eq!(whole_tree(&zeros), None, "zeroed");
    }

    #[test]
    fn model_usage_counts_the_run_alone_only_before_resumes_restored_totals() {
        // 2.1.277 started restoring a resumed or forked session's saved
        // totals, so a later release's `modelUsage` on a thread's next turn
        // holds every turn before it.
        assert!(model_usage_is_the_runs(Some("2.1.250")));
        assert!(model_usage_is_the_runs(Some("2.1.276")));
        assert!(!model_usage_is_the_runs(Some("2.1.277")));
        assert!(!model_usage_is_the_runs(Some("2.1.308")));
        assert!(!model_usage_is_the_runs(Some("3.0.0")));
        assert!(!model_usage_is_the_runs(Some("next")), "unreadable");
        assert!(!model_usage_is_the_runs(None), "not named");
    }

    #[test]
    fn a_model_entrys_known_keys_are_not_reported_and_a_new_one_is() {
        let mut event = two_models();
        event["modelUsage"]["claude-sonnet-5"]["quantumTokens"] = json!(1);
        event["modelUsage"]["claude-haiku-4-5-20251001"]["quantumTokens"] = json!(2);
        event["usage"]["zeta_tokens"] = json!(3);
        assert_eq!(
            unknown_fields(&event),
            vec![
                "modelUsage.quantumTokens".to_string(),
                "zeta_tokens".to_string()
            ],
            "once, under the object that holds it"
        );
        // Each object is read in its own spelling.
        let crossed = json!({ "type": "result", "usage": { "costUSD": 1 },
            "modelUsage": { "claude-sonnet-5": { "service_tier": "standard" } } });
        assert_eq!(
            unknown_fields(&crossed),
            vec!["costUSD".to_string(), "modelUsage.service_tier".to_string()]
        );
    }

    #[test]
    fn a_subagents_progress_is_not_token_usage() {
        // 2.1.250 (measured): a subagent's task lines carry a `usage` of
        // their own, its running total, tool uses and time. Its tokens reach
        // the books through the result's `modelUsage`, never through these.
        for subtype in ["task_progress", "task_notification"] {
            let line = json!({ "type": "system", "subtype": subtype,
                "tool_use_id": "toolu_000000000000000000000001",
                "usage": { "total_tokens": 9, "tool_uses": 2, "duration_ms": 900 } });
            assert_eq!(parse(&line), None, "{subtype}");
            assert!(unknown_fields(&line).is_empty(), "{subtype}");
        }
    }

    #[test]
    fn only_the_runs_own_call_to_the_subagent_tool_is_a_delegation() {
        let call = |name: &str| {
            json!({ "type": "assistant", "message": { "content": [
                { "type": "text", "text": "Looking." },
                { "type": "tool_use", "id": "toolu_000000000000000000000001", "name": name,
                  "input": {} } ] } })
        };
        assert!(calls_subagent_tool(&call("Agent")));
        assert!(
            calls_subagent_tool(&call("Task")),
            "the name an init lists it under"
        );
        assert!(!calls_subagent_tool(&call("Read")));
        assert!(
            !calls_subagent_tool(&call("mcp__cerebro__hand_to")),
            "a hand-off is another run, with books of its own"
        );
        let mut nested = call("Agent");
        nested["parent_tool_use_id"] = json!("toolu_000000000000000000000002");
        assert!(
            !calls_subagent_tool(&nested),
            "a subagent's own call: the run's call that started it already counted"
        );
        let mut sidechain = call("Agent");
        sidechain["isSidechain"] = json!(true);
        assert!(!calls_subagent_tool(&sidechain));
        let echoed = json!({ "type": "user", "message": { "content": [
            { "type": "tool_use", "id": "toolu_000000000000000000000001", "name": "Agent" } ] } });
        assert!(!calls_subagent_tool(&echoed), "only a turn calls a tool");
    }

    // --- M91.5: what a turn's context held -----------------------------------

    /// A turn of the run's own thread whose request sent `input` new tokens,
    /// wrote `write` to the cache and read `read` from it.
    fn turn_sending(input: u64, write: u64, read: u64) -> Value {
        json!({ "type": "assistant", "parent_tool_use_id": null, "message": {
            "id": "msg_000000000000000000000001", "model": "claude-sonnet-5",
            "usage": { "input_tokens": input, "cache_creation_input_tokens": write,
                "cache_read_input_tokens": read, "output_tokens": 40 } } })
    }

    #[test]
    fn a_turns_context_is_everything_its_request_sent() {
        assert_eq!(context_used(&turn_sending(8, 6_300, 0)), Some(6_308));
        assert_eq!(
            context_used(&turn_sending(6, 0, 6_100)),
            Some(6_106),
            "what the cache served is in the context too"
        );
        // The committed turn: its output joins the context on the next
        // request, not this one.
        assert_eq!(context_used(&fixture(ASSISTANT_TURN)), Some(3 + 14_678));
        assert_eq!(
            context_used(&fixture(RESULT_SUCCESS)),
            None,
            "a result is not a turn"
        );
    }

    #[test]
    fn only_a_whole_reading_of_the_runs_own_turn_is_its_context() {
        let mut forwarded = turn_sending(2_950, 1_200, 0);
        forwarded["parent_tool_use_id"] = json!("toolu_000000000000000000000001");
        assert_eq!(
            context_used(&forwarded),
            None,
            "a subagent's context is its own"
        );
        let mut sidechain = turn_sending(2_950, 1_200, 0);
        sidechain["isSidechain"] = json!(true);
        assert_eq!(context_used(&sidechain), None);
        let mut synthetic = turn_sending(1, 0, 0);
        synthetic["message"]["model"] = json!("<synthetic>");
        assert_eq!(
            context_used(&synthetic),
            None,
            "no model read an API error's reply"
        );
        assert_eq!(
            context_used(&turn_sending(0, 0, 0)),
            None,
            "every request sends something, so nothing is not a reading"
        );
        for key in CONTEXT_COUNTED {
            let mut short = turn_sending(8, 6_300, 0);
            short["message"]["usage"]
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert_eq!(context_used(&short), None, "{key} missing");
            let mut spoilt = turn_sending(8, 6_300, 0);
            spoilt["message"]["usage"][key] = json!(-1);
            assert_eq!(context_used(&spoilt), None, "{key} negative");
            spoilt["message"]["usage"][key] = json!("8");
            assert_eq!(context_used(&spoilt), None, "{key} as text");
        }
        let mut bare = turn_sending(8, 6_300, 0);
        bare["message"].as_object_mut().unwrap().remove("usage");
        assert_eq!(context_used(&bare), None, "no usage at all");
    }

    #[test]
    fn a_window_is_the_named_models_own_and_only_a_results() {
        let event = two_models();
        assert_eq!(context_window(&event, "claude-sonnet-5"), Some(200_000));
        assert_eq!(
            context_window(&event, "claude-opus-5"),
            None,
            "a model the result does not name"
        );
        let mut spoilt = two_models();
        spoilt["modelUsage"]["claude-sonnet-5"]["contextWindow"] = json!("200000");
        assert_eq!(
            context_window(&spoilt, "claude-sonnet-5"),
            None,
            "text is not a window"
        );
        spoilt["modelUsage"]["claude-sonnet-5"]["contextWindow"] = json!(0);
        assert_eq!(
            context_window(&spoilt, "claude-sonnet-5"),
            None,
            "nor is nothing"
        );
        spoilt["modelUsage"]["claude-sonnet-5"]
            .as_object_mut()
            .unwrap()
            .remove("contextWindow");
        assert_eq!(context_window(&spoilt, "claude-sonnet-5"), None);
        assert_eq!(
            context_window(
                &json!({ "type": "result", "modelUsage": {} }),
                "claude-sonnet-5"
            ),
            None,
            "the empty object the committed recordings carry"
        );
        let mut turn = two_models();
        turn["type"] = json!("assistant");
        assert_eq!(context_window(&turn, "claude-sonnet-5"), None);
        // Read, so never reported as a key this build does not know.
        assert!(!unknown_fields(&event)
            .iter()
            .any(|key| key.contains(CONTEXT_WINDOW)));
    }

    #[test]
    fn an_event_with_no_usage_is_none_rather_than_zero() {
        // Zero and unknown are different answers, and the difference decides
        // whether the day's accounting stays exact.
        assert_eq!(parse(&json!({ "type": "system", "subtype": "init" })), None);
        assert_eq!(parse(&json!({ "type": "result" })), None);
        assert_eq!(parse(&json!({ "type": "result", "usage": 7 })), None);
    }

    #[test]
    fn the_terminal_event_yields_the_run_facts_we_already_receive() {
        let event = fixture(RESULT_SUCCESS);
        let facts = RunFacts::parse(&event).expect("the terminal event carries facts");
        // Pinned to the committed fixture's actual bytes.
        assert_eq!(
            facts.total_cost_micros,
            Some(41_200),
            "0.0412 USD in micros"
        );
        assert_eq!(facts.num_turns, Some(3));
        assert_eq!(facts.duration_ms, Some(8_421));
        assert_eq!(facts.duration_api_ms, Some(7_994));
        assert_eq!(facts.service_tier.as_deref(), Some("standard"));
        assert_eq!(
            facts.permission_denials,
            Some(0),
            "an empty array is zero, present — not absent"
        );
        assert_eq!(facts.denied_tools, Some(vec![]));
        assert_eq!(
            facts.server_tool_use,
            Some(0),
            "the fixture's server_tool_use object sums to zero"
        );
        // result-success.json carries NO usage.cache_creation object — absent
        // is absent, never zero. The TTL split gets its OWN fixture below.
        assert_eq!(facts.cache_write_5m, None);
        assert_eq!(facts.cache_write_1h, None);
        // A result event has no assistant-message fields.
        assert_eq!(facts.model_id, None);
        assert_eq!(facts.stop_reason, None);
    }

    #[test]
    fn the_cache_ttl_split_parses_when_the_wire_carries_it() {
        let event = fixture(RESULT_CACHE_TTL);
        let facts = RunFacts::parse(&event).unwrap();
        assert_eq!(
            facts.cache_write_5m,
            Some(1_105),
            "the split the NEW fixture carries"
        );
        assert_eq!(facts.cache_write_1h, Some(100));
        assert_eq!(facts.total_cost_micros, Some(53_800));
        assert_eq!(facts.server_tool_use, Some(2), "two web searches, summed");
        assert!(
            unknown_fields(&event).is_empty(),
            "cache_creation is consumed, not unknown: {:?}",
            unknown_fields(&event)
        );
    }

    #[test]
    fn denied_tool_names_are_read_sorted_and_deduped() {
        let stream: Vec<Value> = serde_json::from_str(CONNECTOR_DENIALS).expect("a stream");
        let result = stream
            .iter()
            .find(|event| is_result(event))
            .expect("the stream ends in a result");
        let facts = RunFacts::parse(result).unwrap();
        assert_eq!(facts.permission_denials, Some(3), "three calls were denied");
        assert_eq!(
            facts.denied_tools,
            Some(vec!["Bash".to_string(), "mcp__toy__other".to_string()]),
            "two tools, each named once"
        );
        // A later reading without the array keeps what the result said.
        let mut merged = facts.clone();
        merged.merge(RunFacts::default());
        assert_eq!(merged.denied_tools, facts.denied_tools);
    }

    #[test]
    fn a_missing_denial_array_is_none_and_an_empty_one_is_empty() {
        let missing = RunFacts::parse(&json!({ "type": "result" })).unwrap();
        assert_eq!(missing.denied_tools, None);
        let empty =
            RunFacts::parse(&json!({ "type": "result", "permission_denials": [] })).unwrap();
        assert_eq!(empty.denied_tools, Some(vec![]));
        // A denial without a tool name still counts, and names nothing.
        let unnamed = RunFacts::parse(&json!({
            "type": "result", "permission_denials": [{ "tool_use_id": "toolu_0000000001" }]
        }))
        .unwrap();
        assert_eq!(unnamed.permission_denials, Some(1));
        assert_eq!(unnamed.denied_tools, Some(vec![]));
    }

    #[test]
    fn the_assistant_event_yields_model_and_stop_reason() {
        let event = fixture(ASSISTANT_TURN);
        let facts = RunFacts::from_assistant(&event).unwrap();
        assert_eq!(facts.model_id.as_deref(), Some("claude-opus-5"));
        assert_eq!(facts.stop_reason.as_deref(), Some("tool_use"));
    }

    #[test]
    fn a_malformed_cost_is_absent_and_never_zero() {
        let event = json!({ "type": "result", "total_cost_usd": "banana" });
        assert_eq!(RunFacts::parse(&event).unwrap().total_cost_micros, None);
        let negative = json!({ "type": "result", "total_cost_usd": -0.5 });
        assert_eq!(RunFacts::parse(&negative).unwrap().total_cost_micros, None);
    }

    #[test]
    fn a_nonsense_count_is_ignored_rather_than_believed() {
        let event = json!({
            "type": "result",
            "usage": { "input_tokens": -5, "output_tokens": 1.5, "cache_read_input_tokens": 9 }
        });
        assert_eq!(
            parse(&event),
            Some(Usage {
                input_tokens: 0,
                output_tokens: 0,
                cache_read: 9,
                cache_write: 0,
            })
        );
    }

    #[test]
    fn a_max_turns_termination_is_a_failure_even_without_the_boolean() {
        let event = json!({ "type": "result", "subtype": "error_max_turns" });
        assert!(is_failure(&event));
    }

    #[test]
    fn the_total_saturates_rather_than_wrapping() {
        let usage = Usage {
            input_tokens: u64::MAX,
            output_tokens: 1,
            cache_read: 1,
            cache_write: 1,
        };
        assert_eq!(usage.total(), u64::MAX);
    }
}
