//! The paths a run's own Write and Edit calls name (M58.3).
//!
//! The CLI's own writers go past every Cerebro door, so `vault_writes` never
//! hears of them. A run's changeset still has to commit what they wrote, so
//! the reader feeds each event through [`CliWrites::observe`], which reads
//! the path from the call itself. Which tools write, and which input field
//! names their file, is the tool manifest's to say (`cli_tools` rows with
//! `writes: true`, and the `subject` M57.2's cards name them by): no list is
//! kept here. The path comes from the ToolStart's input preview, or, when the
//! preview cut it, from the whole input a ToolPayload carries (M56.8). Pure:
//! nothing here touches git or the registry; the caller notes each path on
//! the run's claim (`git::changeset::RunClaim::note_cli_write`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{AgentEvent, PayloadPart};

/// One run's watch on its CLI writes.
pub struct CliWrites {
    vault: PathBuf,
    /// Calls whose preview cut their path, by tool id, with the input field
    /// that names it: the ToolPayload that follows carries it whole.
    pending: HashMap<String, String>,
}

impl CliWrites {
    pub fn new(vault: &Path) -> Self {
        Self {
            vault: vault.to_path_buf(),
            pending: HashMap::new(),
        }
    }

    /// The vault-relative path `event` says a writer is writing, spelled as
    /// the scan lists it (`write::landing_path`), or None: not a writer's
    /// call, no path yet, or a path outside the vault.
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
                    Some(path) if !path.ends_with('\u{2026}') => self.land(&path),
                    _ => {
                        self.pending.insert(tool_id.clone(), field.to_string());
                        None
                    }
                }
            }
            AgentEvent::ToolPayload {
                tool_id,
                part: PayloadPart::Input,
                text,
                ..
            } => {
                let field = self.pending.remove(tool_id)?;
                let path = subject_of(text, &field)?;
                self.land(&path)
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

    #[test]
    fn a_write_tool_names_its_file_from_the_start_or_the_payload() {
        let vault = testutil::temp_vault("m58-cli-writes");
        testutil::write(&vault, "notes/a.md", "# A\n");
        let mut watch = CliWrites::new(&vault);
        let absolute = vault.join("notes/a.md");
        assert_eq!(
            watch.observe(&start(
                "Write",
                "t-1",
                serde_json::json!({ "file_path": absolute, "content": "# A" })
            )),
            Some("notes/a.md".into())
        );
        assert_eq!(
            watch.observe(&start(
                "Edit",
                "t-2",
                serde_json::json!({ "file_path": "./notes/new.md", "old_string": "x" })
            )),
            Some("notes/new.md".into())
        );
        // A path the preview cut waits for the whole input.
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
            Some("notes/long.md".into())
        );
        // A notebook names its file by its own field.
        assert_eq!(
            watch.observe(&start(
                "NotebookEdit",
                "t-4",
                serde_json::json!({ "notebook_path": "lab/run.ipynb" })
            )),
            Some("lab/run.ipynb".into())
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn reads_and_cerebro_tools_name_nothing() {
        let vault = testutil::temp_vault("m58-cli-reads");
        let mut watch = CliWrites::new(&vault);
        let read = serde_json::json!({ "file_path": "notes/a.md" });
        assert_eq!(watch.observe(&start("Read", "t-1", read.clone())), None);
        assert_eq!(
            watch.observe(&start(
                "Bash",
                "t-2",
                serde_json::json!({ "command": "ls" })
            )),
            None
        );
        assert_eq!(
            watch.observe(&start(
                "mcp__cerebro__append_to_note",
                "t-3",
                serde_json::json!({ "path": "notes/a.md", "content": "x" })
            )),
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
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn an_outside_path_is_dropped() {
        let vault = testutil::temp_vault("m58-cli-outside");
        let mut watch = CliWrites::new(&vault);
        for path in ["/etc/hosts", "../escape.md", "notes/../../escape.md"] {
            assert_eq!(
                watch.observe(&start(
                    "Write",
                    "t-1",
                    serde_json::json!({ "file_path": path, "content": "x" })
                )),
                None,
                "{path}"
            );
        }
        let _ = std::fs::remove_dir_all(&vault);
    }
}
