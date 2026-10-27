//! Display-only native references. No raw source body, effect input or artifact preview.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Reference {
    Source {
        #[serde(rename = "toolId")]
        tool_id: String,
        url: String,
    },
    Effect {
        #[serde(rename = "invocationId")]
        invocation_id: String,
    },
    Artifact {
        path: String,
    },
}
impl Reference {
    pub(crate) fn checked(&self) -> bool {
        match self {
            Self::Source { tool_id, url } => {
                !tool_id.is_empty() && tool_id.len() <= 128 && web(url)
            }
            Self::Effect { invocation_id } => {
                invocation_id.len() == 32
                    && invocation_id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }
            Self::Artifact { path } => relative(path),
        }
    }
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && !path
            .split('/')
            .any(|part| part == ".." || part == ".git" || part == ".cerebro")
}
fn web(value: &str) -> bool {
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return false;
    }
    tauri::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "https" | "http")
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some()
    })
}
#[derive(Default)]
pub(crate) struct Collector {
    references: Vec<Reference>,
    bytes: usize,
    partial: bool,
}
impl Collector {
    pub(crate) fn push(&mut self, reference: Reference, budget: usize) {
        if self.partial {
            return;
        }
        if !reference.checked() || self.references.contains(&reference) {
            return;
        }
        let bytes = serde_json::to_vec(&reference)
            .map(|bytes| bytes.len().saturating_add(1))
            .unwrap_or(usize::MAX);
        let Some(next) = self
            .bytes
            .checked_add(bytes)
            .filter(|next| *next <= budget && self.references.len() < super::journal::RUN_EVENTS)
        else {
            self.partial = true;
            return;
        };
        self.bytes = next;
        self.references.push(reference);
    }
    #[cfg(test)]
    pub(crate) fn observe(&mut self, event: &super::AgentEvent) {
        self.observe_with_limit(event, super::journal::RUN_BYTES);
    }
    pub(crate) fn observe_with_limit(&mut self, event: &super::AgentEvent, budget: usize) {
        use super::{AgentEvent, ToolResultData};
        match event {
            AgentEvent::ToolResult {
                tool_id,
                parent: None,
                data: ToolResultData::WebFetch { url, .. },
            } if web(url) && !tool_id.is_empty() && tool_id.len() <= 128 => {
                self.push(
                    Reference::Source {
                        tool_id: tool_id.clone(),
                        url: url.clone(),
                    },
                    budget,
                );
            }
            AgentEvent::ToolResult {
                tool_id,
                parent: None,
                data: ToolResultData::WebSearch { results, .. },
            } => {
                for result in results.iter().take(super::journal::RUN_EVENTS) {
                    if web(&result.url) && !tool_id.is_empty() && tool_id.len() <= 128 {
                        self.push(
                            Reference::Source {
                                tool_id: tool_id.clone(),
                                url: result.url.clone(),
                            },
                            budget,
                        );
                    }
                }
            }
            AgentEvent::Changeset { changeset } => {
                use crate::git::changeset::RunChangeset;
                match changeset {
                    RunChangeset::Committed { files, .. } => {
                        if files.len() > super::journal::RUN_EVENTS {
                            self.partial = true;
                        }
                        for file in files.iter().take(super::journal::RUN_EVENTS) {
                            if relative(&file.path) {
                                self.push(
                                    Reference::Artifact {
                                        path: file.path.clone(),
                                    },
                                    budget,
                                );
                            }
                        }
                    }
                    RunChangeset::NotRecorded { files, .. }
                    | RunChangeset::NotARepo { files, .. }
                    | RunChangeset::Unavailable { files, .. } => {
                        if files.len() > super::journal::RUN_EVENTS {
                            self.partial = true;
                        }
                        for path in files.iter().take(super::journal::RUN_EVENTS) {
                            if relative(path) {
                                self.push(Reference::Artifact { path: path.clone() }, budget);
                            }
                        }
                    }
                    RunChangeset::Nothing { .. } => {}
                }
            }
            _ => {}
        }
    }
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
    pub(crate) fn partial(&self) -> bool {
        self.partial
    }
    pub(crate) fn finish(self) -> Vec<Reference> {
        self.references
    }
}
#[cfg(test)]
#[path = "archive_reference_tests.rs"]
mod tests;
