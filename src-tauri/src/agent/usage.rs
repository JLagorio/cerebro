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
//! event union, the mock agent, and every panel listener — and a number that
//! is available in the renderer is a number that ends up in a run log and
//! then in a portable receipt. The reader thread already owns a run's
//! lifetime; it parses usage here and writes it straight to the runtime DB.
//! Telemetry stays on the operational side of D5 by construction rather than
//! by everyone remembering.
//!
//! **The wire format is external and drifts.** Every field is optional, a
//! non-numeric value is ignored rather than fatal, and a key this build has
//! never heard of is recorded in `operational_log` — once per run, not once
//! per event — so a CLI upgrade that starts reporting something new is
//! visible without being an outage.

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

    /// The assistant-turn fields. `None` when the event is not a turn.
    pub fn from_assistant(event: &Value) -> Option<RunFacts> {
        if event.get("type").and_then(Value::as_str) != Some("assistant") {
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

/// Keys inside the `usage` object this build does not recognize, sorted and
/// duplicate-free.
pub fn unknown_fields(event: &Value) -> Vec<String> {
    let Some(object) = usage_object(event).and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut unknown: Vec<String> = object
        .keys()
        .filter(|key| {
            !COUNTED.iter().any(|(known, _)| known == *key)
                && !FACTS_CONSUMED.contains(&key.as_str())
                && !KNOWN_UNCOUNTED.contains(&key.as_str())
        })
        .cloned()
        .collect();
    unknown.sort();
    unknown.dedup();
    unknown
}

/// Where usage lives on the two event shapes that carry it: a terminal
/// `result` event holds it at the top level, an `assistant` turn holds it
/// under `message`.
fn usage_object(event: &Value) -> Option<&Value> {
    event
        .get("usage")
        .or_else(|| event.get("message").and_then(|m| m.get("usage")))
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
