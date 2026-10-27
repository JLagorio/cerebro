use super::*;
use crate::agent::{fold, AgentEvent};
use serde_json::json;
fn collect(events: &[AgentEvent]) -> ArchiveTurnV1 {
    let mut collector=Collector::default();
    for event in events { collector.observe(event); }
    collector.finish()
}
// Catches dropping folded words, copying reasoning/raw payloads, child overwrite,
// or retaining both deltas and finalized text. Uses the actual CLI fold.
#[test]
fn archive_codec_retains_ordered_folded_words_without_reasoning_or_payloads() {
    let lines=vec![
        json!({"type":"assistant","uuid":"a","message":{"id":"m","role":"assistant","content":[{"type":"thinking","thinking":"PRIVATE_REASONING"},{"type":"text","text":"Before."},{"type":"tool_use","id":"t","name":"Read","input":{"file_path":"RAW_ARGUMENT"}}]}}),
        json!({"type":"user","uuid":"b","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"RAW_RESULT"}]}}),
        json!({"type":"assistant","uuid":"c","message":{"id":"n","role":"assistant","content":[{"type":"text","text":"After."}]}}),
    ];
    let folded=fold::fold_lines(&lines);
    let turn=collect(&folded.events);
    let words:Vec<&str>=turn.blocks.iter().filter_map(|b|match b { Block::Text {text,..}=>Some(text.as_str()),_=>None }).collect();
    assert_eq!(words,vec!["Before.","After."],"archive must preserve actual folded text order");
    let serialized=serde_json::to_string(&turn).unwrap();
    for secret in ["PRIVATE_REASONING","RAW_ARGUMENT","RAW_RESULT"] { assert!(!serialized.contains(secret)); }
    assert_eq!(turn.availability,Availability::Complete);
}
#[test]
fn archive_codec_never_promotes_child_words_to_parent_answer() {
    let turn=collect(&[
        AgentEvent::Text {message_id:"child".into(),text:"FULL_CHILD_TRACE".into(),parent:Some("agent-call".into()),at:None},
        AgentEvent::Text {message_id:"parent".into(),text:"Parent answer".into(),parent:None,at:None},
    ]);
    assert!(matches!(turn.blocks.as_slice(),[Block::Text {text,..}] if text=="Parent answer"));
}
#[test]
fn archive_codec_overflow_is_partial_and_never_keeps_unbounded_words() {
    let turn=collect(&[AgentEvent::Text {message_id:"m".into(),text:"x".repeat(crate::agent::journal::RUN_BYTES+1),parent:None,at:None}]);
    assert_eq!(turn.availability,Availability::Partial);
    assert!(serde_json::to_vec(&turn).unwrap().len()<crate::agent::journal::RUN_BYTES);
}

#[test]
fn archive_codec_unknown_child_denial_and_deferral_are_not_parent_tools() {
    let turn=collect(&[
        AgentEvent::ToolDenied {tool_id:"child-only".into(),tool_name:"Write".into(),message:"PRIVATE_CHILD_RESULT".into()},
        AgentEvent::ToolDeferred {tool_id:"child-wait".into(),tool_name:"Write".into(),duration_ms:None},
        AgentEvent::Text {message_id:"parent".into(),text:"Parent answer".into(),parent:None,at:None},
    ]);
    assert!(matches!(turn.blocks.as_slice(),[Block::Text {text,..}] if text=="Parent answer"));
}
#[test]
fn archive_codec_final_serialization_is_bounded_after_tool_growth_and_escaping() {
    let mut collector=Collector::default();
    collector.observe(&AgentEvent::Text {message_id:"large".into(),text:"\"".repeat((crate::agent::journal::RUN_BYTES-4096)/2),parent:None,at:None});
    for index in 0..200 {
        collector.observe(&AgentEvent::ToolStart {tool_id:format!("tool-{index}"),tool_name:"x".repeat(128),input:Some("PRIVATE_RAW".into()),parent:None,at:None});
        collector.observe(&AgentEvent::ToolDone {tool_id:format!("tool-{index}"),output:Some("PRIVATE_RESULT".into()),is_error:false,parent:None,at:None});
    }
    let turn=collector.finish();
    assert!(turn.checked(),"final carrier must always be safe for the writer");
    assert_eq!(turn.availability,Availability::Partial);
    let encoded=serde_json::to_vec(&turn).unwrap();assert!(encoded.len()<=crate::agent::journal::RUN_BYTES);
    let encoded=String::from_utf8(encoded).unwrap();assert!(!encoded.contains("PRIVATE_RAW")&&!encoded.contains("PRIVATE_RESULT"));
}

#[test]
fn archive_codec_records_only_actual_fold_turn_end_anchor() {
    let anchor="11111111-1111-4111-8111-111111111111";
    let turn=collect(&[AgentEvent::Text {message_id:"answer".into(),text:"Answer".into(),parent:None,at:None},AgentEvent::TurnEnded {stop_reason:None,last_uuid:Some(anchor.into())}]);
    assert_eq!(serde_json::to_value(&turn).unwrap()["lastUuid"],anchor,"retain actual main-thread turn-end identity for archive branching");
    let malformed=collect(&[AgentEvent::TurnEnded {stop_reason:None,last_uuid:Some("../../not-an-anchor".into())}]);
    assert!(serde_json::to_value(&malformed).unwrap()["lastUuid"].is_null(),"malformed metadata cannot become a branch point");
}

#[test]
fn archive_codec_invalid_optional_anchor_does_not_discard_complete_body(){
 let turn=collect(&[AgentEvent::Text {message_id:"original-body".into(),text:"Fully retained words".into(),parent:None,at:None},AgentEvent::TurnEnded {stop_reason:None,last_uuid:Some("not-an-actual-uuid".into())}]);
 assert_eq!(turn.availability,Availability::Complete,"availability describes retained content, not optional branch-point presence");assert!(turn.last_uuid.is_none());assert!(matches!(turn.blocks.as_slice(),[Block::Text {text,..}] if text=="Fully retained words"));assert!(turn.checked());
}
