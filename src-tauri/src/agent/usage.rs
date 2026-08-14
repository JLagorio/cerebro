//! Token usage off the CLI wire (M25.2).
//!
//! Until now every `usage` object the CLI emitted was discarded: `translate`
//! reads `session_id`, `is_error`, and `result` off a `result` event and
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

/// Keys this build has seen and deliberately does not store.
///
/// Distinct from "unknown" on purpose: logging a field we decided to ignore
/// on every single run would fill the operational log with noise and train
/// everyone to stop reading it, which is how the genuinely new field gets
/// missed.
const KNOWN_UNCOUNTED: [&str; 4] = [
    "server_tool_use",
    "service_tier",
    "cache_creation",
    "ephemeral_1h_input_tokens",
];

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

/// Does this terminal event describe a quota or rate-limit refusal?
///
/// The CLI has no typed code for it, so this reads the message — and the
/// consequence of a false negative is a run recorded as an ordinary failure
/// rather than one that sets a window backoff, which is the safe direction.
/// A false POSITIVE would pause ambient work for hours over a typo, so the
/// match is narrow and anchored on the two phrases the CLI actually uses.
pub fn is_quota_failure(event: &Value) -> bool {
    let text = event
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    text.contains("rate limit") || text.contains("usage limit") || text.contains("quota")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Recorded, sanitized CLI output. Never live CLI output in CI: the wire
    /// format is somebody else's and would make the suite fail on their
    /// release schedule.
    const RESULT_SUCCESS: &str = include_str!("../../fixtures/cli-stream/result-success.json");
    const RESULT_QUOTA: &str = include_str!("../../fixtures/cli-stream/result-quota.json");
    const ASSISTANT_TURN: &str = include_str!("../../fixtures/cli-stream/assistant-turn.json");
    const RESULT_FUTURE: &str = include_str!("../../fixtures/cli-stream/result-future-fields.json");

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
        assert!(!is_quota_failure(&event));
        assert!(
            unknown_fields(&event).is_empty(),
            "{:?}",
            unknown_fields(&event)
        );
    }

    #[test]
    fn a_quota_death_still_reports_exact_usage() {
        // The whole point of the honest-failure path: a run that died on
        // quota SPENT tokens, and recording it as zero would let the next
        // dispatch spend them again.
        let event = fixture(RESULT_QUOTA);
        assert!(is_failure(&event));
        assert!(is_quota_failure(&event));
        let usage = parse(&event).expect("a quota failure still carries usage");
        assert!(usage.total() > 0, "a failed run is not a free run");
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
    fn known_but_uncounted_fields_are_not_reported_as_unknown() {
        // Otherwise every single run logs the same two lines and the log
        // becomes something nobody reads.
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
