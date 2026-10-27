//! Checked allowlist over the existing fold, never a serialized journal or CLI log.
use serde::{Deserialize, Serialize};
use super::{AgentEvent, ToolResultData};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum Block {
    Text { #[serde(rename="messageId")] message_id: String, text: String },
    Tool { #[serde(rename="toolId")] tool_id: String, name: String, state: String },
    Child { #[serde(rename="toolId")] tool_id: String, summary: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum Availability { Complete, Partial, Unavailable }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveTurnV1 {
    #[cfg_attr(test,schemars(schema_with="crate::conversations::transport::version_schema"))]
    pub version: u8,
    pub blocks: Vec<Block>,
    pub availability: Availability,
    pub references:Vec<super::archive_references::Reference>,
    /// Actual main-thread TurnEnded identity; never inferred from text/run IDs.
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub last_uuid:Option<String>,
}
impl ArchiveTurnV1 {
    pub(crate) fn unavailable() -> Self {
        Self { version: 1, blocks: Vec::new(), availability: Availability::Unavailable, references:Vec::new(),last_uuid:None }
    }
    pub(crate) fn append_references(&mut self,references:impl IntoIterator<Item=super::archive_references::Reference>) {
        let mut remaining=super::journal::RUN_BYTES.saturating_sub(encoded_size(self).unwrap_or(super::journal::RUN_BYTES));
        for reference in references {
            if !reference.checked()||self.references.contains(&reference){continue;}
            let bytes=encoded_size(&reference).unwrap_or(super::journal::RUN_BYTES).saturating_add(1);
            if bytes>remaining||self.blocks.len().saturating_add(self.references.len())>=super::journal::RUN_EVENTS {self.availability=Availability::Partial;continue;}
            remaining-=bytes;self.references.push(reference);
        }
    }
    pub(crate) fn search_text(&self) -> String {
        self.blocks.iter().filter_map(|block| match block {
            Block::Text { text, .. } => Some(text.as_str()), _ => None,
        }).collect::<Vec<_>>().join("\n")
    }
    pub(crate) fn checked(&self) -> bool {
        self.version == 1 && self.last_uuid.as_ref().is_none_or(|value|super::transcript::parse_session_id(value).is_some()) && self.blocks.len().saturating_add(self.references.len()) <= super::journal::RUN_EVENTS
            && self.references.iter().all(super::archive_references::Reference::checked)
            && self.blocks.iter().all(|block| match block {
                Block::Text {message_id,text} => id(message_id) && text.len() <= super::journal::RUN_BYTES,
                Block::Tool {tool_id,name,state} => id(tool_id) && id(name) && matches!(state.as_str(),"running"|"completed"|"failed"|"denied"|"deferred"),
                Block::Child {tool_id,summary} => id(tool_id) && summary.chars().count() <= 500,
            }) && encoded_size(self).is_some()
    }
}
fn id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control) }
// Count JSON escaping without allocating an unbounded serialization first.
struct Count(usize);
impl std::io::Write for Count {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).filter(|n|*n <= super::journal::RUN_BYTES)
            .ok_or_else(||std::io::Error::other("archive carrier cap"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
fn encoded_size(value: &impl Serialize) -> Option<usize> {
    let mut count = Count(0); serde_json::to_writer(&mut count,value).ok()?; Some(count.0)
}
#[derive(Default)]
pub(crate) struct Collector {
    blocks: Vec<Block>,
    bytes: usize,
    events: usize,
    references: super::archive_references::Collector,
    partial: bool,
    pending_delta: bool,
    last_uuid:Option<String>,
}
impl Collector {
    fn push(&mut self, block: Block) {
        let Some(bytes) = encoded_size(&block) else {self.partial=true; return};
        let Some(next) = self.bytes.checked_add(bytes.saturating_add(3)).filter(|n|n.saturating_add(self.references.bytes()) < super::journal::RUN_BYTES-256) else {self.partial=true; return};
        self.bytes=next; self.blocks.push(block);
    }
    pub(crate) fn observe(&mut self, event: &AgentEvent) {
        self.events=self.events.saturating_add(1);
        if self.events>super::journal::RUN_EVENTS { self.partial=true; return; }
        self.references.observe_with_limit(event,super::journal::RUN_BYTES.saturating_sub(self.bytes.saturating_add(256)));
        match event {
            AgentEvent::TurnEnded {last_uuid,..} => {
                self.last_uuid=last_uuid.as_deref().and_then(super::transcript::parse_session_id);
            }
            AgentEvent::TextDelta { .. } => self.pending_delta=true,
            AgentEvent::Text {message_id,text,parent:None,..} => {
                self.pending_delta=false;
                if !id(message_id) || text.len()>super::journal::RUN_BYTES {self.partial=true;return;}
                if !text.is_empty() {self.push(Block::Text {message_id:message_id.clone(),text:text.clone()});}
            }
            AgentEvent::ToolStart {tool_id,tool_name,parent:None,..} => {
                if !id(tool_id)||!id(tool_name) {self.partial=true;return;}
                self.push(Block::Tool {tool_id:tool_id.clone(),name:tool_name.clone(),state:"running".into()});
            }
            AgentEvent::ToolDone {tool_id,is_error,parent:None,..} => self.tool_state(tool_id,if *is_error {"failed"} else {"completed"},true),
            AgentEvent::ToolDenied {tool_id,..} => self.tool_state(tool_id,"denied",false),
            AgentEvent::ToolDeferred {tool_id,..} => self.tool_state(tool_id,"deferred",false),
            AgentEvent::ToolResult {tool_id,parent:None,data:ToolResultData::Agent {summary:Some(summary),..}} => {
                if !id(tool_id) {self.partial=true;return;}
                self.push(Block::Child {tool_id:tool_id.clone(),summary:summary.chars().take(500).collect()});
            }
            AgentEvent::Result {text,..} if !self.blocks.iter().any(|block|matches!(block,Block::Text {..})) && !text.is_empty() => {
                if text.len()>super::journal::RUN_BYTES {self.partial=true;return;}
                self.push(Block::Text {message_id:"result".into(),text:text.clone()}); self.pending_delta=false;
            }
            // Deliberately no reasoning, UserPrompt, raw input/output, child text,
            // context usage, system/outgoing prompts or credential-bearing reach.
            _ => {}
        }
    }
    fn tool_state(&mut self, tool_id: &str, next: &str, parent_result: bool) {
        if let Some(Block::Tool {state,..})=self.blocks.iter_mut().rev().find(|block|matches!(block,Block::Tool {tool_id:id,..} if id==tool_id)) {
            if state!="denied"||next!="failed" {*state=next.into();}
        } else if parent_result && id(tool_id) {
            self.push(Block::Tool {tool_id:tool_id.into(),name:"not recorded".into(),state:next.into()});
        }
    }
    pub(crate) fn finish(self) -> ArchiveTurnV1 {
        let availability=if self.partial||self.pending_delta||self.references.partial() {Availability::Partial}
            else if self.blocks.is_empty() {Availability::Unavailable} else {Availability::Complete};
        let turn=ArchiveTurnV1 {version:1,blocks:self.blocks,availability,references:self.references.finish(),last_uuid:self.last_uuid};
        // Tool-state replacements and JSON escaping are checked again against
        // the exact final carrier, not trusted to the incremental estimate.
        if turn.checked() {turn} else {ArchiveTurnV1 {version:1,blocks:Vec::new(),availability:Availability::Partial,references:Vec::new(),last_uuid:None}}
    }
}
#[cfg(test)]
#[path = "archive_codec_tests.rs"]
mod tests;
