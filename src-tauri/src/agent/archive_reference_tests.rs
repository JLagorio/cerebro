use super::*;
use crate::agent::{AgentEvent,ToolResultData};
#[test]
fn archive_references_source_comes_from_actual_typed_fold_result_only(){
    let mut collector=Collector::default();
    collector.observe(&AgentEvent::ToolResult {tool_id:"fetch".into(),parent:None,data:ToolResultData::WebFetch {url:"https://example.test/report".into(),code:Some(200),bytes:Some(30),duration_ms:None}});
    collector.observe(&AgentEvent::ToolPayload {tool_id:"fetch".into(),part:crate::agent::PayloadPart::Output,text:"PRIVATE_RAW_SOURCE_BODY".into(),bytes:23,truncated:false,parent:None});
    assert_eq!(collector.finish(),vec![Reference::Source {tool_id:"fetch".into(),url:"https://example.test/report".into()}]);
}
#[test]
fn archive_references_artifact_is_a_path_from_actual_changeset_without_preview(){
    let mut collector=Collector::default();
    collector.observe(&AgentEvent::Changeset {changeset:crate::git::changeset::RunChangeset::NotARepo {kept_out_of_git:Some(0),run_id:"original".into(),files:vec!["notes/report.md".into()],shell_unrecorded:None}});
    assert_eq!(collector.finish(),vec![Reference::Artifact {path:"notes/report.md".into()}]);
}
#[test]
fn archive_references_never_retains_url_user_credentials_or_child_sources(){
    let mut collector=Collector::default();
    for (url,parent) in [("https://person:PRIVATE_PASSWORD@example.test/report",None),("https://example.test/child",Some("child-call".into()))] {
        collector.observe(&AgentEvent::ToolResult {tool_id:"fetch".into(),parent,data:ToolResultData::WebFetch {url:url.into(),code:Some(200),bytes:Some(30),duration_ms:None}});
    }
    assert!(collector.finish().is_empty());
}
