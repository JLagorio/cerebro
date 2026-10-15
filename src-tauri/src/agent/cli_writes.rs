//! The paths a run's own Write and Edit calls wrote (M58.3).
//!
//! The CLI's own writers go past every Cerebro door, so `vault_writes` never
//! hears of them. A run's changeset still has to commit what they wrote, so
//! the reader feeds each event through [`CliWrites::observe`], which reads
//! the path from the call itself. Which tools write, and which input field
//! names their file, is the tool manifest's to say (`cli_tools` rows with
//! `writes: true`, and the `subject` M57.2's cards name them by): no list is
//! kept here. The path comes from the ToolStart's input preview, or, when the
//! preview cut it, from the whole input a ToolPayload carries (M56.8).
//!
//! A path is noted only when its call completes: a ToolDone without
//! `is_error`, matched to its ToolStart by tool id. A call Cerebro's gate
//! deferred (M57.1) has not run, so the run that deferred it claims nothing;
//! a failed Edit wrote nothing. The run that resumes a deferral never sees
//! its ToolStart (2.1.250's resumed stream opens with the tool_result), so
//! it starts [`holding`](CliWrites::holding) the held call, read from the
//! session file by [`held_call`]. A Task subagent's writes stay unseen: the
//! fold drops sidechain lines. Pure apart from that one read: nothing here
//! touches git or the registry; the caller notes each path on the run's
//! claim (`git::changeset::RunClaim::note_cli_write`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{AgentEvent, PayloadPart};

/// One run's watch on its CLI writes.
pub struct CliWrites {
    vault: PathBuf,
    /// Writer calls still running, by tool id, with the path each writes.
    started: HashMap<String, String>,
    /// Calls whose preview cut their path, by tool id, with the input field
    /// that names it: the ToolPayload that follows carries it whole.
    pending: HashMap<String, String>,
}

/// The call a resumed session's deferral holds: its id, tool and whole
/// input, as the session file recorded the assistant's tool_use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldCall {
    pub tool_id: String,
    pub tool_name: String,
    pub input: String,
}

impl CliWrites {
    pub fn new(vault: &Path) -> Self {
        Self {
            vault: vault.to_path_buf(),
            started: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    /// A resumed run's watch, already holding the call its deferral held
    /// (M57.1): its ToolDone, when the answer allowed it, notes its path.
    pub fn holding(mut self, held: Option<&HeldCall>) -> Self {
        if let Some(held) = held {
            self.observe(&AgentEvent::ToolStart {
                tool_name: held.tool_name.clone(),
                tool_id: held.tool_id.clone(),
                input: Some(held.input.clone()),
            });
        }
        self
    }

    /// The vault-relative path a writer's call just wrote, spelled as the
    /// scan lists it (`write::landing_path`), or None: not a writer's call,
    /// not done yet, failed, or a path outside the vault.
    pub fn observe(&mut self, event: &AgentEvent) -> Option<String> {
        match event {
            AgentEvent::ToolStart {
                tool_name,
                tool_id,
                input,
            } => {
                let tool = crate::policy::tools::cli_tool(tool_name).filter(|tool| tool.writes)?;
                let field = tool.subject.as_deref()?;
                match input.as_deref().and_then(|input| subject_of(input, field)) {
                    // A preview cuts a long string and ends it with `…`; the
                    // whole input follows as a ToolPayload.
                    Some(path) if !path.ends_with('\u{2026}') => {
                        if let Some(path) = self.land(&path) {
                            self.started.insert(tool_id.clone(), path);
                        }
                    }
                    _ => {
                        self.pending.insert(tool_id.clone(), field.to_string());
                    }
                }
                None
            }
            AgentEvent::ToolPayload {
                tool_id,
                part: PayloadPart::Input,
                text,
                ..
            } => {
                let field = self.pending.remove(tool_id)?;
                let path = self.land(&subject_of(text, &field)?)?;
                self.started.insert(tool_id.clone(), path);
                None
            }
            AgentEvent::ToolDone {
                tool_id, is_error, ..
            } => {
                self.pending.remove(tool_id);
                let path = self.started.remove(tool_id)?;
                (!is_error).then_some(path)
            }
            _ => None,
        }
    }

    /// Where `raw` lands in the vault: an absolute path inside the vault (the
    /// CLI's usual spelling) loses the vault's prefix, as given or canonical.
    fn land(&self, raw: &str) -> Option<String> {
        let path = Path::new(raw);
        let rel = if path.is_absolute() {
            let canonical = std::fs::canonicalize(&self.vault).ok();
            let inside = path
                .strip_prefix(&self.vault)
                .ok()
                .or_else(|| path.strip_prefix(canonical.as_ref()?).ok())?;
            inside
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        } else {
            raw.to_string()
        };
        if rel.is_empty() {
            return None;
        }
        crate::vault::write::landing_path(&self.vault, &rel)
    }
}

/// The string `field` holds in a call's JSON input, when it holds one.
fn subject_of(input: &str, field: &str) -> Option<String> {
    let value: Value = serde_json::from_str(input).ok()?;
    let subject = value.get(field)?.as_str()?.trim();
    (!subject.is_empty()).then(|| subject.to_string())
}

/// The call `tool_use_id` names in a session file's tail (the last
/// `transcript::DEFERRAL_TAIL_BYTES`, where the deferral marker is read
/// too): the last main-thread assistant line holding that tool_use. None
/// when the file cannot be read or holds no such call.
pub fn held_call(session_file: &Path, tool_use_id: &str) -> Option<HeldCall> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(session_file).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(
        len.saturating_sub(super::transcript::DEFERRAL_TAIL_BYTES),
    ))
    .ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    held_call_in(&String::from_utf8_lossy(&tail), tool_use_id)
}

/// [`held_call`] over the text, pure.
pub fn held_call_in(tail: &str, tool_use_id: &str) -> Option<HeldCall> {
    tail.lines().rev().find_map(|line| {
        if !line.contains(tool_use_id) {
            return None;
        }
        let value: Value = serde_json::from_str(line).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("assistant")
            || value.get("isSidechain").and_then(Value::as_bool) == Some(true)
        {
            return None;
        }
        let blocks = value.get("message")?.get("content")?.as_array()?;
        let block = blocks.iter().find(|block| {
            block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("id").and_then(Value::as_str) == Some(tool_use_id)
        })?;
        Some(HeldCall {
            tool_id: tool_use_id.to_string(),
            tool_name: block.get("name")?.as_str()?.to_string(),
            input: block.get("input")?.to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn start(name: &str, id: &str, input: Value) -> AgentEvent {
        AgentEvent::ToolStart {
            tool_name: name.into(),
            tool_id: id.into(),
            input: Some(input.to_string()),
        }
    }

    fn done(id: &str, is_error: bool) -> AgentEvent {
        AgentEvent::ToolDone {
            tool_id: id.into(),
            output: None,
            is_error,
        }
    }

    /// The path a call names, once it starts and then completes.
    fn wrote(watch: &mut CliWrites, name: &str, id: &str, input: Value) -> Option<String> {
        assert_eq!(
            watch.observe(&start(name, id, input)),
            None,
            "not before it runs"
        );
        watch.observe(&done(id, false))
    }

    #[test]
    fn a_write_tool_names_its_file_when_its_call_completes() {
        let vault = testutil::temp_vault("m58-cli-writes");
        testutil::write(&vault, "notes/a.md", "# A\n");
        let mut watch = CliWrites::new(&vault);
        let absolute = vault.join("notes/a.md");
        assert_eq!(
            wrote(
                &mut watch,
                "Write",
                "t-1",
                serde_json::json!({ "file_path": absolute, "content": "# A" })
            ),
            Some("notes/a.md".into())
        );
        assert_eq!(
            wrote(
                &mut watch,
                "Edit",
                "t-2",
                serde_json::json!({ "file_path": "./notes/new.md", "old_string": "x" })
            ),
            Some("notes/new.md".into())
        );
        // A path the preview cut waits for the whole input, then its done.
        let cut = format!("{}\u{2026}", "notes/very-long-".repeat(10));
        assert_eq!(
            watch.observe(&start(
                "MultiEdit",
                "t-3",
                serde_json::json!({ "file_path": cut })
            )),
            None
        );
        let whole = serde_json::json!({ "file_path": vault.join("notes/long.md") }).to_string();
        assert_eq!(
            watch.observe(&AgentEvent::ToolPayload {
                tool_id: "t-3".into(),
                part: PayloadPart::Input,
                bytes: whole.len() as u64,
                text: whole,
                truncated: false,
            }),
            None
        );
        assert_eq!(
            watch.observe(&done("t-3", false)),
            Some("notes/long.md".into())
        );
        // A notebook names its file by its own field.
        assert_eq!(
            wrote(
                &mut watch,
                "NotebookEdit",
                "t-4",
                serde_json::json!({ "notebook_path": "lab/run.ipynb" })
            ),
            Some("lab/run.ipynb".into())
        );
        // Each call is noted once.
        assert_eq!(watch.observe(&done("t-4", false)), None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// A failed call wrote nothing, and a call that never completes (one
    /// Cerebro's gate deferred) claims nothing in the run that deferred it.
    #[test]
    fn a_failed_or_deferred_call_names_nothing() {
        let vault = testutil::temp_vault("m58-cli-failed");
        let mut watch = CliWrites::new(&vault);
        let edit = serde_json::json!({ "file_path": "notes/a.md", "old_string": "x" });
        assert_eq!(watch.observe(&start("Edit", "t-1", edit.clone())), None);
        assert_eq!(watch.observe(&done("t-1", true)), None);
        assert_eq!(watch.observe(&start("Write", "t-2", edit)), None);
        assert_eq!(
            watch.observe(&AgentEvent::ToolDeferred {
                tool_id: "t-2".into(),
                tool_name: "Write".into(),
            }),
            None
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// The resumed run sees only the held call's tool_result: it starts
    /// holding the call the session file recorded, and notes the path when
    /// the result is not an error.
    #[test]
    fn a_resumed_run_holds_the_deferred_call() {
        let vault = testutil::temp_vault("m58-cli-held");
        let file = format!("{}/notes/held.md", vault.display());
        let session = [
            serde_json::json!({ "type": "user", "isSidechain": false,
                "message": { "role": "user", "content": "write it" } }),
            serde_json::json!({ "type": "assistant", "isSidechain": true,
                "message": { "content": [{ "type": "tool_use", "id": "toolu_held",
                    "name": "Write", "input": { "file_path": "elsewhere.md" } }] } }),
            serde_json::json!({ "type": "assistant", "isSidechain": false,
                "message": { "content": [{ "type": "tool_use", "id": "toolu_held",
                    "name": "Write", "input": { "file_path": file, "content": "# Held" } }] } }),
            serde_json::json!({ "type": "attachment", "isSidechain": false,
                "attachment": { "type": "hook_deferred_tool", "toolUseID": "toolu_held",
                    "toolName": "Write" } }),
        ]
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<String>();
        let path = vault.join("session.jsonl");
        std::fs::write(&path, &session).unwrap();
        let held = held_call(&path, "toolu_held").expect("the session file holds the call");
        assert_eq!(held.tool_name, "Write");
        assert!(held.input.contains("held.md"), "{}", held.input);
        assert_eq!(held_call_in(&session, "toolu_other"), None);

        let mut watch = CliWrites::new(&vault).holding(Some(&held));
        assert_eq!(
            watch.observe(&done("toolu_held", false)),
            Some("notes/held.md".into())
        );
        // Denied on resume: the tool_result is an error, and nothing is noted.
        let mut denied = CliWrites::new(&vault).holding(Some(&held));
        assert_eq!(denied.observe(&done("toolu_held", true)), None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn reads_and_cerebro_tools_name_nothing() {
        let vault = testutil::temp_vault("m58-cli-reads");
        let mut watch = CliWrites::new(&vault);
        let read = serde_json::json!({ "file_path": "notes/a.md" });
        assert_eq!(wrote(&mut watch, "Read", "t-1", read.clone()), None);
        assert_eq!(
            wrote(
                &mut watch,
                "Bash",
                "t-2",
                serde_json::json!({ "command": "ls" })
            ),
            None
        );
        assert_eq!(
            wrote(
                &mut watch,
                "mcp__cerebro__append_to_note",
                "t-3",
                serde_json::json!({ "path": "notes/a.md", "content": "x" })
            ),
            None
        );
        // A payload for a call nobody waits on names nothing either.
        assert_eq!(
            watch.observe(&AgentEvent::ToolPayload {
                tool_id: "t-1".into(),
                part: PayloadPart::Input,
                text: read.to_string(),
                bytes: 1,
                truncated: false,
            }),
            None
        );
        assert_eq!(watch.observe(&done("t-1", false)), None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_outside_path_is_dropped() {
        let vault = testutil::temp_vault("m58-cli-outside");
        let mut watch = CliWrites::new(&vault);
        for path in ["/etc/hosts", "../escape.md", "notes/../../escape.md"] {
            assert_eq!(
                wrote(
                    &mut watch,
                    "Write",
                    "t-1",
                    serde_json::json!({ "file_path": path, "content": "x" })
                ),
                None,
                "{path}"
            );
        }
        let _ = std::fs::remove_dir_all(&vault);
    }
}
