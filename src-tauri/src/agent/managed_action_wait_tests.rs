//! Actual interaction-book lifecycle tests. Seats/views are control metadata,
//! not native publication, person/window or action-execution authority.
use super::*;
const INVOCATION:&str="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn seat(book:&Interactions,run:&str,session:&str,vault:&str){
 let request:AgentRequest=serde_json::from_value(json!({"message":"review issue","system_prompt":"brief","session_id":null,"attended":true,"shell":false})).unwrap();
 book.open_seat(Seat::new(run,session,Path::new(vault),&request),None);
}
fn card()->InteractionCard{InteractionCard{id:"b".repeat(32),kind:Kind::ManagedAction,answering:Some(false),run:None,tool_name:"mcp__cerebro__prepare_action".into(),tool_id:String::new(),session_id:"session".into(),summary:"Create issue · fixture/repo".into(),family:None,subject:None,title:Some("Create issue".into()),target:Some("fixture/repo".into()),actor:None,questions:None,input:"Repository: fixture/repo\nTitle: Review\nBody: full reviewed body".into(),asked_at:"2026-10-26T00:00:00.000Z".into()}}
fn waiting()->(Interactions,ManagedCall){let book=Interactions::with_asks(vec![]);seat(&book,"run","session","/original");let wait=book.hold_managed("run",INVOCATION,Path::new("/original"),card(),Instant::now()+Duration::from_secs(30)).expect("original live call holds a card");(book,wait)}
#[test]
fn held_managed_wait_appears_once_without_a_cli_deferral_or_new_seat(){
 let(book,wait)=waiting();let shown=book.pending(Path::new("/original"));assert_eq!(shown.len(),1);assert_eq!(shown[0].id,wait.id());assert_eq!(shown[0].kind,Kind::ManagedAction);assert_eq!(shown[0].tool_id,"");assert_eq!(shown[0].input,card().input);
 assert!(book.pending(Path::new("/other")).is_empty());assert!(!book.close_seat("run"),"a held MCP call restores no resumed CLI answer");
 assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::OwnerGone)));assert!(book.pending(Path::new("/original")).is_empty());
}
#[test]
fn held_managed_answer_is_proposed_then_acknowledged_once_by_original_worker(){
 let(book,wait)=waiting();let pending=book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).unwrap();
 assert!(book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Deny{message:None},None).is_err());
 let ManagedReceive::Proposal(proposal)=wait.receive(Duration::from_millis(20))else{panic!("original caller must receive proposal")};
 assert_eq!(proposal.answer,PersonAnswer::Allow{remember:Remember::Once});assert!(proposal.edited_input.is_none());
 assert!(proposal.finish(Ok(())));assert!(pending.receive(Duration::from_millis(20)).unwrap().is_ok());assert!(book.pending(Path::new("/original")).is_empty());
 assert!(book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).is_err());
}
#[test]
fn held_managed_invalid_edit_returns_to_same_wait_without_answer_or_resume(){
 let(book,wait)=waiting();let edit=json!({"title":""});let pending=book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},Some(edit.clone())).unwrap();
 let ManagedReceive::Proposal(proposal)=wait.receive(Duration::from_millis(20))else{panic!("proposal")};assert_eq!(proposal.edited_input,Some(edit));
 assert!(proposal.finish(Err(Refusal{code:MALFORMED_ARGUMENTS,message:"Title is required.".into()})));
 assert_eq!(pending.receive(Duration::from_millis(20)).unwrap().unwrap_err().message,"Title is required.");assert_eq!(book.pending(Path::new("/original"))[0].id,wait.id());
 let denied=book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Deny{message:Some("Use a draft".into())},None).unwrap();
 let ManagedReceive::Proposal(proposal)=wait.receive(Duration::from_millis(20))else{panic!("second proposal")};assert_eq!(proposal.answer,PersonAnswer::Deny{message:Some("Use a draft".into())});assert!(proposal.finish(Ok(())));assert!(denied.receive(Duration::from_millis(20)).unwrap().is_ok());
}
#[test]
fn held_managed_cancel_wakes_original_and_refuses_late_person_answer(){
 let(book,wait)=waiting();assert!(book.cancel(wait.id(),CancelReason::Stopped));assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::Cancelled)));
 assert!(book.pending(Path::new("/original")).is_empty());assert!(book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).is_err());
}
#[test]
fn held_managed_vault_switch_and_shutdown_release_only_owned_waits(){
 let(book,wait)=waiting();seat(&book,"kept-run","kept-session","/kept");let mut kept=card();kept.id="c".repeat(32);kept.session_id="kept-session".into();
 let kept=book.hold_managed("kept-run",&"d".repeat(32),Path::new("/kept"),kept,Instant::now()+Duration::from_secs(30)).unwrap();
 assert_eq!(book.cancel_other_vaults(Path::new("/kept")),vec![wait.id().to_owned()]);assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(_)));assert_eq!(book.pending(Path::new("/kept")).len(),1);
 book.cancel_all();assert!(matches!(kept.receive(Duration::from_millis(20)),ManagedReceive::Closed(_)));assert!(book.pending(Path::new("/kept")).is_empty());
}
#[test]
fn held_managed_original_wait_drop_removes_card_and_cannot_be_reanswered(){
 let(book,wait)=waiting();let id=wait.id().to_owned();drop(wait);assert!(book.pending(Path::new("/original")).is_empty());assert!(book.propose_managed(Path::new("/original"),&id,PersonAnswer::Deny{message:None},None).is_err());
}
#[test]
fn held_managed_deadline_and_unseated_or_mismatched_source_never_register_a_wait(){
 let book=Interactions::with_asks(vec![]);let future=Instant::now()+Duration::from_secs(30);
 assert!(book.hold_managed("absent",INVOCATION,Path::new("/original"),card(),future).is_err());seat(&book,"run","session","/original");
 assert!(book.hold_managed("run",INVOCATION,Path::new("/other"),card(),future).is_err());let mut other=card();other.session_id="different".into();assert!(book.hold_managed("run",INVOCATION,Path::new("/original"),other,future).is_err());
 assert!(book.hold_managed("run",INVOCATION,Path::new("/original"),card(),Instant::now()).is_err());assert!(book.pending(Path::new("/original")).is_empty());
}
#[test]
fn held_managed_wrong_vault_cannot_take_or_remove_original_pending_card(){
 let(book,wait)=waiting();assert!(book.propose_managed(Path::new("/other"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).is_err());assert_eq!(book.pending(Path::new("/original")).len(),1);
}

#[test]
fn held_managed_expiry_removes_card_wakes_original_and_refuses_late_answer(){
 let book=Interactions::with_asks(vec![]);seat(&book,"run","session","/original");let now=Instant::now();
 let wait=book.hold_managed("run",INVOCATION,Path::new("/original"),card(),now+Duration::from_secs(30)).unwrap();
 book.expire_managed(now+Duration::from_secs(31));assert!(book.pending(Path::new("/original")).is_empty());
 assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::Expired)));
 assert!(book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).is_err());
}
#[test]
fn held_managed_duplicate_original_invocation_never_registers_a_second_wait(){
 let(book,wait)=waiting();let mut duplicate=card();duplicate.id="c".repeat(32);
 assert!(book.hold_managed("run",INVOCATION,Path::new("/original"),duplicate,Instant::now()+Duration::from_secs(30)).is_err());
 assert_eq!(book.pending(Path::new("/original")).len(),1);assert_eq!(book.pending(Path::new("/original"))[0].id,wait.id());
}
#[test]
fn held_managed_stop_during_answer_closes_original_wait_and_rejects_late_ack(){
 let(book,wait)=waiting();let pending=book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).unwrap();
 let ManagedReceive::Proposal(proposal)=wait.receive(Duration::from_millis(20))else{panic!("answer proposal")};
 assert!(book.cancel(wait.id(),CancelReason::Stopped));assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::Cancelled)));
 assert!(pending.receive(Duration::from_millis(20)).unwrap().is_err());assert!(!proposal.finish(Ok(())));assert!(book.pending(Path::new("/original")).is_empty());
}

#[test]
fn managed_card_serializes_absent_correlation_as_null_and_preserves_ordinary_real_tool_id(){
 let managed=serde_json::to_value(card()).unwrap();assert_eq!(managed["tool_id"],Value::Null);
 let mut ordinary=card();ordinary.kind=Kind::Permission;ordinary.tool_id="actual-cli-tool".into();
 assert_eq!(serde_json::to_value(ordinary).unwrap()["tool_id"],json!("actual-cli-tool"));
}

fn seats_available(book:&Interactions)->bool{match book.book.try_lock(){Ok(guard)=>{drop(guard);true},Err(std::sync::TryLockError::WouldBlock)=>false,Err(std::sync::TryLockError::Poisoned(_))=>panic!("fixture seat lock poisoned")}}
#[test]
fn held_registration_racing_original_seat_close_cannot_insert_after_retirement(){
 let book=Interactions::with_asks(vec![]);seat(&book,"run","session","/original");let copy=book.clone();
 let(paused,ready)=std::sync::mpsc::channel();let(release,resume)=std::sync::mpsc::channel();
 let worker=std::thread::spawn(move||{probes::on_hold(Box::new(move||{paused.send(()).unwrap();resume.recv_timeout(Duration::from_secs(2)).unwrap();}));copy.hold_managed("run",INVOCATION,Path::new("/original"),card(),Instant::now()+Duration::from_secs(30))});
 ready.recv_timeout(Duration::from_secs(2)).unwrap();let close_before=seats_available(&book);
 if close_before{book.close_seat("run");}release.send(()).unwrap();let call=worker.join().unwrap();
 if !close_before{book.close_seat("run");}
 assert!(book.pending(Path::new("/original")).is_empty(),"retired source inserted an orphan approval wait");
 if let Ok(call)=call{assert!(matches!(call.receive(Duration::from_millis(20)),ManagedReceive::Closed(_)));}
}
#[test]
fn held_registration_racing_cancel_all_cannot_survive_seat_clear(){
 let book=Interactions::with_asks(vec![]);seat(&book,"run","session","/original");let copy=book.clone();
 let(paused,ready)=std::sync::mpsc::channel();let(release,resume)=std::sync::mpsc::channel();
 let worker=std::thread::spawn(move||{probes::on_all(Box::new(move||{paused.send(()).unwrap();resume.recv_timeout(Duration::from_secs(2)).unwrap();}));copy.cancel_all();});
 ready.recv_timeout(Duration::from_secs(2)).unwrap();let call=if seats_available(&book){Some(book.hold_managed("run",INVOCATION,Path::new("/original"),card(),Instant::now()+Duration::from_secs(30)).unwrap())}else{None};
 release.send(()).unwrap();worker.join().unwrap();
 assert!(book.pending(Path::new("/original")).is_empty(),"late hold survived actual shutdown/opening retirement");
 assert!(book.hold_managed("run",INVOCATION,Path::new("/original"),card(),Instant::now()+Duration::from_secs(30)).is_err());
 if let Some(call)=call{assert!(matches!(call.receive(Duration::from_millis(20)),ManagedReceive::Closed(_)));}
}
#[test]
fn held_registration_racing_vault_switch_cannot_surface_after_original_vault_retirement(){
 let book=Interactions::with_asks(vec![]);seat(&book,"run","session","/original");let copy=book.clone();
 let(paused,ready)=std::sync::mpsc::channel();let(release,resume)=std::sync::mpsc::channel();
 let worker=std::thread::spawn(move||{probes::on_other(Box::new(move||{paused.send(()).unwrap();resume.recv_timeout(Duration::from_secs(2)).unwrap();}));copy.cancel_other_vaults(Path::new("/kept"));});
 ready.recv_timeout(Duration::from_secs(2)).unwrap();let call=if seats_available(&book){Some(book.hold_managed("run",INVOCATION,Path::new("/original"),card(),Instant::now()+Duration::from_secs(30)).unwrap())}else{None};
 release.send(()).unwrap();worker.join().unwrap();
 assert!(book.pending(Path::new("/original")).is_empty(),"late old-vault hold became visible after switching");
 assert!(book.hold_managed("run",INVOCATION,Path::new("/original"),card(),Instant::now()+Duration::from_secs(30)).is_err(),"old live legacy seat cannot register new managed waits after switch");
 if let Some(call)=call{assert!(matches!(call.receive(Duration::from_millis(20)),ManagedReceive::Closed(_)));}
}
#[test]
fn held_native_answer_in_flight_remains_visible_with_truthful_answering_metadata(){
 let(book,call)=waiting();let _pending=book.propose_managed(Path::new("/original"),call.id(),PersonAnswer::Allow{remember:Remember::Once},None).unwrap();
 let visible=book.pending(Path::new("/original"));assert_eq!(visible.len(),1,"reattach must see the actual in-flight person decision");
 assert_eq!(serde_json::to_value(&visible[0]).unwrap()["answering"],json!(true));
}

fn access_card()->InteractionCard{let mut card=card();card.kind=Kind::ManagedAccess;card.tool_name="mcp__cerebro__list_actions".into();card.title=Some("Choose access for this run".into());card.input=String::new();card}
fn access_waiting()->(Interactions,ManagedCall){let book=Interactions::with_asks(vec![]);seat(&book,"run","session","/original");let wait=book.hold_managed_access("run",Path::new("/original"),access_card(),Instant::now()+Duration::from_secs(30)).expect("actual original call holds access choice");(book,wait)}
#[test]
fn access_wait_has_original_card_but_no_fabricated_effect_invocation(){let(book,wait)=access_waiting();assert_eq!(book.managed_access_request("run"),Some(wait.id().into()));assert_eq!(book.pending(Path::new("/original"))[0].kind,Kind::ManagedAccess);assert!(book.managed_invocation(Path::new("/original"),wait.id()).is_none());assert!(book.managed_access_request("other").is_none());}
#[test]
fn access_done_requires_original_run_and_card_and_acknowledges_once(){let(book,wait)=access_waiting();assert!(!book.complete_managed_access("other",wait.id()));assert!(!book.complete_managed_access("run",&"c".repeat(32)));assert_eq!(book.pending(Path::new("/original")).len(),1);assert!(book.complete_managed_access("run",wait.id()));assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::AccessCompleted));assert!(book.pending(Path::new("/original")).is_empty());assert!(!book.complete_managed_access("run",wait.id()));assert!(book.managed_access_request("run").is_none());}
#[test]
fn access_choice_never_accepts_an_effect_allow_or_deny(){let(book,wait)=access_waiting();assert!(book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).is_err());assert!(book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Deny{message:None},None).is_err());assert!(matches!(wait.receive(Duration::from_millis(10)),ManagedReceive::Timeout));assert_eq!(book.pending(Path::new("/original")).len(),1);}
#[test]
fn completed_access_keeps_exact_rpc_cancellation_until_original_call_drop(){let(book,wait)=access_waiting();assert!(wait.bind_rpc("request-1".into()));assert!(book.complete_managed_access("run",wait.id()));assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::AccessCompleted));assert!(!book.cancel_managed_rpc("other","request-1"));assert!(!book.cancel_managed_rpc("run","request-2"));assert!(!wait.cancelled().load(Ordering::SeqCst));assert!(book.cancel_managed_rpc("run","request-1"));assert!(wait.cancelled().load(Ordering::SeqCst));}
#[test]
fn access_owner_loss_or_expiry_wakes_call_and_refuses_late_done(){let(book,wait)=access_waiting();book.close_seat("run");assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::OwnerGone)));assert!(!book.complete_managed_access("run",wait.id()));let(book,wait)=access_waiting();book.expire_managed(Instant::now()+Duration::from_secs(31));assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::Expired)));assert!(!book.complete_managed_access("run",wait.id()));}
#[test]
fn access_registration_requires_actual_seat_and_does_not_displace_effect_wait(){let book=Interactions::with_asks(vec![]);assert!(book.hold_managed_access("run",Path::new("/original"),access_card(),Instant::now()+Duration::from_secs(30)).is_err());let(book,effect)=waiting();assert!(book.hold_managed_access("run",Path::new("/original"),access_card(),Instant::now()+Duration::from_secs(30)).is_err());assert_eq!(book.pending(Path::new("/original"))[0].id,effect.id());}

fn acknowledged_edit()->(Interactions,ManagedCall){let(book,wait)=waiting();let pending=book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},Some(json!({"title":"Revised"}))).unwrap();let ManagedReceive::Proposal(proposal)=wait.receive(Duration::from_millis(20))else{panic!("original edit")};assert!(proposal.finish(Ok(())));assert!(pending.receive(Duration::from_millis(20)).unwrap().is_ok());(book,wait)}
fn revised_card()->InteractionCard{let mut revised=card();revised.id="e".repeat(32);revised.input="Full revised preview requiring its own Allow once".into();revised}
#[test]
fn edited_approval_rotates_card_on_same_call_and_requires_another_explicit_answer(){let(book,mut wait)=acknowledged_edit();let old=wait.id().to_owned();assert!(book.replace_managed_card(&mut wait,revised_card(),Instant::now()+Duration::from_secs(30)));assert_eq!(wait.id(),revised_card().id);let shown=book.pending(Path::new("/original"));assert_eq!(shown.len(),1);assert_eq!(shown[0].id,revised_card().id);assert_eq!(shown[0].input,revised_card().input);assert!(book.propose_managed(Path::new("/original"),&old,PersonAnswer::Allow{remember:Remember::Once},None).is_err());assert!(matches!(wait.receive(Duration::from_millis(10)),ManagedReceive::Timeout));let pending=book.propose_managed(Path::new("/original"),wait.id(),PersonAnswer::Allow{remember:Remember::Once},None).unwrap();let ManagedReceive::Proposal(proposal)=wait.receive(Duration::from_millis(20))else{panic!("second explicit answer")};assert!(proposal.edited_input.is_none());assert!(proposal.finish(Ok(())));assert!(pending.receive(Duration::from_millis(20)).unwrap().is_ok());}
#[test]
fn edited_approval_rotation_keeps_exact_original_rpc_cancellation_control(){let(book,mut wait)=acknowledged_edit();assert!(wait.bind_rpc("original-rpc".into()));let flag=wait.cancelled();assert!(book.replace_managed_card(&mut wait,revised_card(),Instant::now()+Duration::from_secs(30)));assert!(Arc::ptr_eq(&flag,&wait.cancelled()));assert!(!book.cancel_managed_rpc("other","original-rpc"));assert!(book.cancel_managed_rpc("run","original-rpc"));assert!(flag.load(Ordering::SeqCst));assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::Cancelled)));assert!(book.pending(Path::new("/original")).is_empty());}
#[test]
fn edit_rotation_never_renews_original_call_deadline(){let(book,mut wait)=acknowledged_edit();let deadline=Instant::now()+Duration::from_secs(3600);assert!(book.replace_managed_card(&mut wait,revised_card(),deadline));book.expire_managed(Instant::now()+Duration::from_secs(31));assert!(matches!(wait.receive(Duration::from_millis(20)),ManagedReceive::Closed(ManagedClose::Expired)));assert!(book.pending(Path::new("/original")).is_empty());}
#[test]
fn cancelled_original_or_access_completion_cannot_rotate_into_new_effect_approval(){let(book,mut wait)=acknowledged_edit();assert!(wait.bind_rpc("original-rpc".into()));assert!(book.cancel_managed_rpc("run","original-rpc"));assert!(!book.replace_managed_card(&mut wait,revised_card(),Instant::now()+Duration::from_secs(30)));assert!(book.pending(Path::new("/original")).is_empty());let(book,mut access)=access_waiting();assert!(book.complete_managed_access("run",access.id()));assert!(!book.replace_managed_card(&mut access,revised_card(),Instant::now()+Duration::from_secs(30)));}
