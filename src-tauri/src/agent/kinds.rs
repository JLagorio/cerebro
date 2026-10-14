//! Every kind of line Claude Code writes, to its stream and to its session
//! file, and what this build does with it (M56.2, M56.3).
//!
//! The fold (`super::fold`) reads some kinds into events and drops the rest.
//! Before this table a dropped kind went without a word, so a CLI that renamed
//! a kind, or started sending a new one, changed what the panel showed and
//! nothing said so. Now each kind is one row: Translated, or Ignored with the
//! reason it is safe to drop. A kind with no row is unclassified, and three
//! things notice it: the fold classes the line Unclassified, `recordings.rs`
//! fails on any kind a real recording shows that has no row, and the meter
//! writes one `agent.stream` row per run that met one, so drift shows in the
//! field as well as in CI.
//!
//! Whoever changes what the fold reads changes this table in the same commit;
//! the fold takes its ignore reasons from here, and `recordings.rs` holds the
//! two to each other on every real line.

use serde_json::Value;

/// What this build does with one kind of stream line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Handling {
    /// The fold reads it into events.
    Translated,
    /// Dropped on purpose, for the reason given.
    Ignored(&'static str),
}

use Handling::{Ignored, Translated};

const STREAM_JSON_ONLY: &str =
    "only the long-lived stream-json transport (D4 (b)) speaks the control protocol; a per-turn run never sees one";

const BOOKKEEPING: &str = "the CLI's own bookkeeping for the session, with nothing to show";

/// One row per kind, sorted. Seeded from the sanitized recordings in
/// `fixtures/cli-stream/real/` (CLI 2.1.250) and the kinds that CLI's schema
/// names beside them; the session-file kinds (M56.3) from the 2.1.250 session
/// files' own records.
pub(crate) const STREAM_KINDS: &[(&str, Handling)] = &[
    (
        "agent-color",
        Ignored("the colour a subagent's name is drawn in"),
    ),
    ("agent-name", Ignored("a subagent's display name")),
    (
        "ai-title",
        Ignored("the title the CLI's own picker shows; the panel titles the thread itself"),
    ),
    (
        "assistant/redacted_thinking",
        Ignored("encrypted reasoning, which no person can read"),
    ),
    ("assistant/text", Translated),
    (
        "assistant/thinking",
        Ignored("the model's reasoning, which the panel never shows as the reply; live, it arrives as thinking_delta events"),
    ),
    ("assistant/tool_use", Translated),
    (
        "atis-latch",
        Ignored(BOOKKEEPING),
    ),
    (
        "attachment",
        Ignored("context the CLI attached for the model, such as tool and skill listings, other than a deferral"),
    ),
    // M57.1: a PreToolUse hook deferred a call; the session file's mark that
    // the turn is suspended on it, folded as the stream's deferred result is.
    ("attachment/hook_deferred_tool", Translated),
    ("control_cancel_request", Ignored(STREAM_JSON_ONLY)),
    ("control_request", Ignored(STREAM_JSON_ONLY)),
    ("control_response", Ignored(STREAM_JSON_ONLY)),
    ("cost-state", Ignored(BOOKKEEPING)),
    (
        "custom-title",
        Ignored("a title set in the CLI's own picker; the panel keeps its own"),
    ),
    (
        "file-history-delta",
        Ignored("the CLI's copy of a file its own edit changed, for its rewind"),
    ),
    (
        "file-history-snapshot",
        Ignored("the CLI's copies of files its own edits changed, for its rewind"),
    ),
    (
        "keep_alive",
        Ignored("a heartbeat of the stream-json transport, with nothing to show"),
    ),
    (
        "last-prompt",
        Ignored("the last prompt again, for the CLI's own resume picker"),
    ),
    (
        "mode",
        Ignored("the permission mode the CLI's own UI was in"),
    ),
    ("pr-link", Translated),
    (
        "queue-operation",
        Ignored("a prompt entering or leaving the CLI's queue; the prompt line follows"),
    ),
    // M56.4: read for the failure notice (`super::failure`), with no event
    // of their own.
    ("rate_limit_event", Translated),
    (
        "relocated",
        Ignored("a note that the session moved, with nothing to show"),
    ),
    ("result/error_during_execution", Translated),
    ("result/error_max_budget_usd", Translated),
    ("result/error_max_structured_output_retries", Translated),
    ("result/error_max_turns", Translated),
    ("result/success", Translated),
    (
        "stream_event/content_block_delta/input_json_delta",
        Ignored("a tool call's input in pieces; the assistant line carries it whole"),
    ),
    (
        "stream_event/content_block_delta/signature_delta",
        Ignored("a thinking block's signature, with nothing to show"),
    ),
    ("stream_event/content_block_delta/text_delta", Translated),
    ("stream_event/content_block_delta/thinking_delta", Translated),
    (
        "stream_event/content_block_start",
        Ignored("a block opening; its content follows as deltas, or whole on the assistant line"),
    ),
    (
        "stream_event/content_block_stop",
        Ignored("a block closing, with nothing new in it"),
    ),
    (
        "stream_event/message_delta",
        Ignored("the turn's stop reason and running usage; the assistant line and the result carry both"),
    ),
    (
        "stream_event/message_start",
        Ignored("the turn's model and opening usage; the assistant line and the result carry both"),
    ),
    (
        "stream_event/message_stop",
        Ignored("the turn's end, with nothing new in it"),
    ),
    (
        "summary",
        Ignored("an older CLI's session summary, with nothing to show"),
    ),
    ("system/api_error", Translated),
    ("system/api_retry", Translated),
    (
        "system/compact_boundary",
        Ignored("the CLI compacted its context, which the transcript does not show"),
    ),
    ("system/init", Translated),
    (
        "system/local_command",
        Ignored("a command typed into the CLI's own UI, never a panel turn"),
    ),
    (
        "system/status",
        Ignored("a progress word such as requesting; the panel shows its own"),
    ),
    (
        "system/stop_hook_summary",
        Ignored("what the CLI's Stop hooks said, which belongs to the CLI's own UI"),
    ),
    (
        "tool_progress",
        Ignored("a long tool's heartbeat; its result follows"),
    ),
    (
        "user/image",
        Ignored("an image the person attached in the CLI; the panel sends none"),
    ),
    ("user/string", Translated),
    ("user/text", Translated),
    ("user/tool_result", Translated),
];

/// The kinds one line shows: `system/<subtype>`, `result/<subtype>`,
/// `stream_event/<event>` (a delta as `stream_event/content_block_delta/<delta>`),
/// one `assistant/<block>` or `user/<block>` per content block, with
/// `assistant/string` and `assistant/empty` for content that is a bare string
/// or holds no block, a deferral marker as `attachment/hook_deferred_tool`,
/// any other line as `<type>` or `<type>/<subtype>`, and `-` for a line with
/// no type.
pub(crate) fn kinds_of(line: &Value) -> Vec<String> {
    let Some(kind) = line.get("type").and_then(Value::as_str) else {
        return vec!["-".into()];
    };
    let word = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or("-").to_string();
    match kind {
        "stream_event" => {
            let event = line.get("event").unwrap_or(&Value::Null);
            let event_type = word(event.get("type"));
            if event_type == "content_block_delta" {
                let delta = event.get("delta").unwrap_or(&Value::Null);
                vec![format!(
                    "stream_event/content_block_delta/{}",
                    word(delta.get("type"))
                )]
            } else {
                vec![format!("stream_event/{event_type}")]
            }
        }
        "assistant" | "user" => match line.get("message").and_then(|m| m.get("content")) {
            Some(Value::String(_)) => vec![format!("{kind}/string")],
            Some(Value::Array(blocks)) if !blocks.is_empty() => blocks
                .iter()
                .map(|block| format!("{kind}/{}", word(block.get("type"))))
                .collect(),
            _ => vec![format!("{kind}/empty")],
        },
        // Only the deferral marker is told apart (M57.1); every other
        // attachment stays one ignored kind, whatever its own type says.
        "attachment"
            if line.pointer("/attachment/type").and_then(Value::as_str)
                == Some("hook_deferred_tool") =>
        {
            vec!["attachment/hook_deferred_tool".into()]
        }
        _ => match line.get("subtype").and_then(Value::as_str) {
            Some(subtype) => vec![format!("{kind}/{subtype}")],
            None => vec![kind.to_string()],
        },
    }
}

/// What this build does with `kind`, or None when the table has no row.
pub(crate) fn handling(kind: &str) -> Option<Handling> {
    STREAM_KINDS
        .binary_search_by(|(row, _)| (*row).cmp(kind))
        .ok()
        .map(|at| STREAM_KINDS[at].1)
}

/// Why `kind` is safe to drop. A kind the table reads, or has no row for, has
/// no reason, and says so: the fold only asks for kinds it ignores.
pub(crate) fn ignored_reason(kind: &str) -> &'static str {
    match handling(kind) {
        Some(Ignored(reason)) => reason,
        Some(Translated) => "a kind this build reads, met where it carried nothing to read",
        None => "a kind this build does not list",
    }
}

/// The kinds `line` shows that the table has no row for, sorted and once each.
pub(crate) fn unclassified(line: &Value) -> Vec<String> {
    let mut found: Vec<String> = kinds_of(line)
        .into_iter()
        .filter(|kind| handling(kind).is_none())
        .collect();
    found.sort();
    found.dedup();
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_kind_table_is_sorted_unique_and_reasoned() {
        for pair in STREAM_KINDS.windows(2) {
            assert!(
                pair[0].0 < pair[1].0,
                "{} must sort before {}, once",
                pair[0].0,
                pair[1].0
            );
        }
        for (kind, handled) in STREAM_KINDS {
            assert!(!kind.is_empty() && !kind.contains(' '), "{kind:?}");
            if let Ignored(reason) = handled {
                assert!(
                    reason.len() > 10 && !reason.ends_with('.'),
                    "{kind}: an ignored kind says why, as a clause: {reason:?}"
                );
            }
            assert_eq!(handling(kind), Some(*handled), "{kind} is found");
        }
    }

    #[test]
    fn kinds_of_names_every_shape() {
        let cases = [
            (
                json!({ "type": "system", "subtype": "init", "session_id": "s" }),
                vec!["system/init"],
            ),
            (
                json!({ "type": "stream_event", "event": { "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "he" } } }),
                vec!["stream_event/content_block_delta/text_delta"],
            ),
            (
                json!({ "type": "stream_event", "event": { "type": "content_block_delta",
                    "delta": { "type": "input_json_delta", "partial_json": "{" } } }),
                vec!["stream_event/content_block_delta/input_json_delta"],
            ),
            (
                json!({ "type": "stream_event", "event": { "type": "message_stop" } }),
                vec!["stream_event/message_stop"],
            ),
            (
                json!({ "type": "assistant", "message": { "content": [
                    { "type": "text", "text": "Reading both." },
                    { "type": "tool_use", "id": "t1", "name": "get_note", "input": {} },
                    { "type": "tool_use", "id": "t2", "name": "get_note", "input": {} }
                ] } }),
                vec!["assistant/text", "assistant/tool_use", "assistant/tool_use"],
            ),
            (
                json!({ "type": "user", "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "ok" }
                ] } }),
                vec!["user/tool_result"],
            ),
            (
                json!({ "type": "result", "subtype": "success", "is_error": false }),
                vec!["result/success"],
            ),
            (
                json!({ "type": "assistant", "message": { "content": [] } }),
                vec!["assistant/empty"],
            ),
            (
                json!({ "type": "assistant", "message": {} }),
                vec!["assistant/empty"],
            ),
            (
                json!({ "type": "user", "message": { "content": "a prompt" } }),
                vec!["user/string"],
            ),
            (
                json!({ "type": "rate_limit_event" }),
                vec!["rate_limit_event"],
            ),
            (json!({ "event": "no type" }), vec!["-"]),
            (json!(42), vec!["-"]),
        ];
        for (line, expected) in cases {
            assert_eq!(kinds_of(&line), expected, "{line}");
        }
    }

    #[test]
    fn the_deferral_marker_is_its_own_translated_kind() {
        let marker = json!({ "type": "attachment", "attachment": {
            "type": "hook_deferred_tool", "toolUseID": "toolu_1", "toolName": "Bash" } });
        assert_eq!(kinds_of(&marker), vec!["attachment/hook_deferred_tool"]);
        assert_eq!(handling("attachment/hook_deferred_tool"), Some(Translated));
        // Every other attachment stays the one ignored kind.
        for other in ["deferred_tools_delta", "skill_listing", "hook_success"] {
            let line = json!({ "type": "attachment", "attachment": { "type": other } });
            assert_eq!(kinds_of(&line), vec!["attachment"], "{other}");
            assert!(matches!(handling("attachment"), Some(Ignored(_))));
        }
        assert_eq!(
            kinds_of(&json!({ "type": "attachment" })),
            vec!["attachment"]
        );
    }

    #[test]
    fn an_unknown_type_is_unclassified() {
        assert_eq!(
            unclassified(&json!({ "type": "teleport", "subtype": "begin" })),
            vec!["teleport/begin".to_string()]
        );
        assert_eq!(
            unclassified(&json!({ "type": "assistant", "message": { "content": [
                { "type": "hologram" }, { "type": "text" }, { "type": "hologram" }
            ] } })),
            vec!["assistant/hologram".to_string()],
            "sorted, once each, and the classified block left out"
        );
        assert_eq!(unclassified(&json!({ "nothing": true })), vec!["-"]);
        assert!(unclassified(&json!({ "type": "system", "subtype": "init" })).is_empty());
    }
}
