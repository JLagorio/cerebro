//! Fixed isolated native/MCP journey. No native authority/window/subject factory.
use super::*;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{net::TcpStream,sync::Mutex};
#[derive(Clone,Copy,Serialize,PartialEq,Eq)]
#[serde(rename_all="snake_case")]
pub(super) enum Scenario{Allow,Stop,Window}
impl Scenario{
 pub(super) fn parse(value:&std::ffi::OsStr)->Option<Self>{match value.to_str()?{"--managed-action-allow"|"--quit-managed-action-allow"=>Some(Self::Allow),"--managed-action-stop"|"--quit-managed-action-stop"=>Some(Self::Stop),"--managed-action-window"|"--quit-managed-action-window"=>Some(Self::Window),_=>None}}
}
struct Session{handle:crate::RunHandle,known:SettingsRuntime,child_launch_sha256:String,cases:Vec<Case>,card:Option<String>,access:Option<String>,answered:bool,decision_observed:bool,progress:Vec<Progress>}
/// Called only at the original successful publication while Started owns Child.
/// No sampled PID, supplied launch identity, native capability or grant enters.
pub(super) fn record_child_launch(config_dir:&Path,run:u64,child:&crate::spawn::Handle)->std::io::Result<()>{
 let args:Vec<_>=std::env::args_os().collect();
 let [_,root,profile]=args.as_slice() else{return Ok(());};
 let Some(scenario)=Scenario::parse(profile)else{return Ok(());};
 let root=PathBuf::from(root);
 if run!=0||config_dir!=root.join("config")||fs::canonicalize(&root)?!=root{
  return Err(std::io::Error::other("Original managed launch context differs."));
 }
 let identity=child.native_action_identity()?;
 let bytes=serde_json::to_vec(&json!({"format":1,"observer":"native-owned-managed-cli-launch","profile":"managed-action","scenario":scenario,"nativePid":std::process::id(),"run":run,"child":identity}))
  .map_err(std::io::Error::other)?;
 if bytes.len()>4096{return Err(std::io::Error::other("Original managed launch receipt exceeded its bound."));}
 create(&root.join("managed-child-launch.json"),&bytes)
}
fn original_child_launch(paths:&SmokePaths,run:u64,scenario:Scenario)->Result<String,&'static str>{
 let bytes=private_bytes(&paths.root.join("managed-child-launch.json"),4096)?;
 let value:Value=serde_json::from_slice(&bytes).map_err(|_|"managed-child-launch-json")?;
 let child=&value["child"];let pid=child["pid"].as_u64().ok_or("managed-child-launch-pid")?;
 if value.as_object().map(|row|row.len())!=Some(7)||child.as_object().map(|row|row.len())!=Some(6)
  ||value["format"]!=1||value["observer"]!="native-owned-managed-cli-launch"||value["profile"]!="managed-action"
  ||value["scenario"]!=serde_json::to_value(scenario).map_err(|_|"managed-child-launch-scenario")?
  ||value["nativePid"]!=std::process::id()||value["run"]!=run||run!=0||pid<=1||pid>i32::MAX as u64||pid==u64::from(std::process::id())
  ||child["parent_pid"]!=std::process::id()||child["group_pid"].as_u64()!=Some(pid)||child["uid"]!=effective_uid()
  ||!child["start_seconds"].as_u64().is_some_and(|value|value>0)||!child["start_micros"].as_u64().is_some_and(|value|value<1_000_000){return Err("managed-child-launch-identity");}
 Ok(format!("{:x}",Sha256::digest(bytes)))
}
#[derive(Default)]pub(super) struct State(Mutex<Option<Session>>);
pub(super) fn enabled(app:&AppHandle)->bool{app.try_state::<SmokePaths>().is_some_and(|paths|paths.managed_action.is_some())}
fn request_tools()->Vec<String>{crate::policy::tools::manifest().tools.iter().filter(|row|row.toolset.as_deref()==Some("managed")).map(|row|format!("mcp__cerebro__{}",row.name)).collect()}
pub(super) async fn bootstrap(app:AppHandle,window:WebviewWindow)->Result<Value,&'static str>{
 let copy=app.clone();let result=tauri::async_runtime::spawn_blocking(move||{
  let paths=app.state::<SmokePaths>();let scenario=paths.managed_action.ok_or("managed-profile-absent")?;
  if paths.started.swap(true,Ordering::SeqCst){return Err("managed-profile-repeated");}
  open(&app,&window,&paths.vault_a)?;
  let request=serde_json::from_value(json!({"message":"","attended":true,"connectors":false,"connector_names":[],"allowed_tools":request_tools(),"scope":[],"read_scope":[],"ask_first":true,"shell":"off","web":false,"delegate":"off"})).map_err(|_|"managed-request-shape")?;
  let vault=paths.vault_a.to_str().ok_or("managed-vault-text")?.to_owned();
  let started=checked("run_agent",json!({"vault":vault}),||crate::run_agent(app.clone(),window.clone(),app.state(),vault.clone(),request,None,None,None,None))?.map_err(|_|"managed-original-start")?;
  let crate::RunStart::Started(handle)=started else{return Err("managed-original-not-started");};
  if handle.run!=0{return Err("managed-first-run-not-zero");}
  let child_launch_sha256=original_child_launch(&paths,handle.run,scenario)?;
  if app.state::<crate::agent::AgentState>().native_action_read(handle.run).is_none(){return Err("managed-original-native-install");}
  crate::actions::native_owner::seed_native_action_smoke(&app,&window,handle.run).map_err(|_|"managed-fixed-metadata-seed")?;
  let known=SettingsRuntime::capture(&paths)?;
  let mut cases=Vec::new();observed(&mut cases,"managed-original-publication",true,"actual-installed-original-run")?;observed(&mut cases,"managed-first-run-zero",true,"zero-is-an-actual-original-handle")?;
  let run=handle.run;let session_id=handle.session_id.clone();
  let profile_state=app.state::<State>();let mut session=profile_state.0.lock().map_err(|_|"managed-profile-poison")?;if session.is_some(){return Err("managed-profile-repeated");}
  *session=Some(Session{handle,known,child_launch_sha256,cases,card:None,access:None,answered:false,decision_observed:false,progress:Vec::new()});drop(session);
  create(&paths.root.join("managed-action-ready"),b"ready\n").map_err(|_|"managed-child-release")?;
  Ok(json!({"profile":"managed-action","scenario":scenario,"run":run,"sessionId":session_id,"vault":vault,"input":crate::actions::native_owner::native_action_smoke_input()}))
 }).await.map_err(|_|"managed-bootstrap-worker")?;
 if let Err(stage)=result{finish(&copy,Some(stage));}result
}
#[derive(Deserialize)]#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
enum Probe{Progress{stage:Progress},Access{card_id:String},BeforeAnswer{card_id:String},Answered{card_id:String,answered_id:String},Stopped{card_id:String,refused:bool},DestroyWindow{card_id:String},Finish,Fail{stage:String}}
// Fixed bounded diagnostics only; not an admission, effect or acceptance case.
#[derive(Deserialize,Serialize)]#[serde(rename_all="snake_case")]
enum Progress{AccessMountRequested,MountWait,MountReady,ClickDispatched,AccessCallback,AccessReadReturned,AccessWriteReturned}
#[derive(Serialize)]struct Audit{runs:i64,native_runs:i64,connections:i64,grants:i64,invocations:i64,attempts:i64,receipts:i64,provider_entries:u64,state:Option<String>,invocation:Option<String>}
fn audit(app:&AppHandle,session:&Session)->Result<Audit,&'static str>{
 let paths=app.state::<SmokePaths>();session.known.recheck(&paths)?;
 let read=crate::runtime::ReadOnly::open(&paths.config).map_err(|_|"managed-audit-open")?;session.known.recheck(&paths)?;
 let (runs,native_runs,connections,grants,invocations,attempts,receipts):(i64,i64,i64,i64,i64,i64,i64)=read.query_row("SELECT (SELECT count(*) FROM runs),(SELECT count(*) FROM action_native_runs),(SELECT count(*) FROM managed_connections),(SELECT count(*) FROM action_account_grants),(SELECT count(*) FROM action_invocations),(SELECT count(*) FROM action_attempts),(SELECT count(*) FROM action_attempts WHERE json_extract(payload,'$.receiptId') IS NOT NULL)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).map_err(|_|"managed-audit-counts")?;
 if runs!=1||native_runs!=1||connections!=1||grants>1||invocations>1||attempts>1||receipts>1{return Err("managed-audit-extra-owner-or-effect");}
 let (state,invocation)=if invocations==1{let(state,id,original):(String,String,String)=read.query_row("SELECT state,invocation_id,json_extract(payload,'$.scope.runId') FROM action_invocations",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"managed-audit-invocation")?;if original!=session.handle.run_id{return Err("managed-audit-foreign-invocation");}(Some(state),Some(id))}else{(None,None)};
 drop(read);session.known.recheck(&paths)?;let provider_entries=crate::actions::native_owner::native_action_smoke_entries(app).map_err(|_|"managed-provider-count")?;
 Ok(Audit{runs,native_runs,connections,grants,invocations,attempts,receipts,provider_entries,state,invocation})
}
fn card(app:&AppHandle,session:&Session,id:&str,kind:crate::agent::interaction::Kind)->Result<crate::agent::interaction::InteractionCard,&'static str>{
 let paths=app.state::<SmokePaths>();let cards=app.state::<crate::agent::AgentState>().interactions().pending(&crate::agent::vault_key(&paths.vault_a));
 let found=cards.into_iter().find(|card|card.id==id).ok_or("managed-card-not-pending")?;
 if found.kind!=kind||found.run.as_ref().map(|run|run.get())!=Some(session.handle.run)||!found.tool_id.is_empty()||found.session_id!=session.handle.session_id{return Err("managed-card-foreign-owner");}Ok(found)
}
fn has_event(app:&AppHandle,session:&Session,id:&str,closed:bool)->Result<bool,&'static str>{
 let value=serde_json::to_value(app.state::<crate::agent::AgentState>().events_since(session.handle.run,&session.handle.run_id,0)).map_err(|_|"managed-journal-encode")?;
 let events=value.get("events").and_then(Value::as_array).ok_or("managed-journal-not-held")?;
 let mut seq=0;for event in events{let next=event.get("seq").and_then(Value::as_u64).ok_or("managed-journal-seq")?;if next<=seq||event.get("run").and_then(Value::as_u64)!=Some(session.handle.run){return Err("managed-journal-owner");}seq=next;}
 Ok(events.iter().any(|event|if closed{event["kind"]=="InteractionClosed"&&event["interaction_id"]==id}else{event["kind"]=="Interaction"&&event["interaction"]["id"]==id}))
}
fn wait_child(app:&AppHandle)->Result<Value,&'static str>{
 let paths=app.state::<SmokePaths>();let path=paths.root.join("managed-child-result.json");let deadline=Instant::now()+Duration::from_secs(15);
 loop{if !settings_absent(&path){let identity=settings_identity(&path,false)?;let file=fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK).open(&path).map_err(|_|"managed-child-result-open")?;let mut bytes=Vec::new();file.take(16385).read_to_end(&mut bytes).map_err(|_|"managed-child-result-read")?;if bytes.len()>16384||settings_identity(&path,false)?!=identity{return Err("managed-child-result-bound");}return serde_json::from_slice(&bytes).map_err(|_|"managed-child-result-json");}if Instant::now()>=deadline{return Err("managed-child-result-timeout");}std::thread::sleep(Duration::from_millis(10));}
}
fn wait_cancelled(app:&AppHandle,session:&Session)->Result<Audit,&'static str>{
 let until=Instant::now()+Duration::from_secs(3);loop{let value=audit(app,session)?;if value.state.as_deref()==Some("cancelled"){return Ok(value);}if Instant::now()>=until{return Err("managed-cancel-settlement-timeout");}std::thread::sleep(Duration::from_millis(10));}
}
pub(super) async fn probe(app:AppHandle,window:WebviewWindow,value:Value)->Result<Value,&'static str>{
 let copy=app.clone();let parsed:Probe=serde_json::from_value(value).map_err(|_|"managed-probe-shape")?;let finishing=matches!(&parsed,Probe::Finish|Probe::DestroyWindow{..});
 let result=tauri::async_runtime::spawn_blocking(move||{
  if !enabled(&app){return Err("managed-profile-absent");}
  let state=app.state::<State>();let mut seat=state.0.lock().map_err(|_|"managed-profile-poison")?;let session=seat.as_mut().ok_or("managed-profile-not-started")?;
  match parsed{
   Probe::Progress{stage}=>{if session.progress.len()>=16{return Err("managed-progress-bound");}session.progress.push(stage);},
   Probe::Access{card_id}=>{card(&app,session,&card_id,crate::agent::interaction::Kind::ManagedAccess)?;let a=audit(&app,session)?;if a.invocations!=0||a.attempts!=0||a.provider_entries!=0{return Err("managed-access-no-effect");}session.access=Some(card_id);observed(&mut session.cases,"managed-access-held",true,"original-run-null-correlation-zero-effects")?;},
   Probe::BeforeAnswer{card_id}=>{card(&app,session,&card_id,crate::agent::interaction::Kind::ManagedAction)?;let a=audit(&app,session)?;if a.grants!=1||a.state.as_deref()!=Some("awaiting_approval")||a.attempts!=0||a.receipts!=0||a.provider_entries!=0||!has_event(&app,session,&card_id,false)?{return Err("managed-effect-not-genuinely-held");}session.card=Some(card_id);observed(&mut session.cases,"managed-effect-held",true,"original-interaction-zero-provider-before-answer")?;},
   Probe::Answered{card_id,answered_id}=>{if app.state::<SmokePaths>().managed_action!=Some(Scenario::Allow){return Err("managed-wrong-scenario-answer");}if session.card.as_deref()!=Some(card_id.as_str())||card_id!=answered_id{return Err("managed-answer-owner");}session.answered=true;session.decision_observed=true;observed(&mut session.cases,"managed-person-answer",true,"finite-original-answered-no-resumed-handle")?;},
   Probe::Stopped{card_id,refused}=>{if app.state::<SmokePaths>().managed_action!=Some(Scenario::Stop){return Err("managed-wrong-scenario-stop");}if session.card.as_deref()!=Some(card_id.as_str())||!refused{return Err("managed-late-answer-not-refused");}session.decision_observed=true;observed(&mut session.cases,"managed-late-answer",true,"refused-no-new-owner")?;},
   Probe::DestroyWindow{card_id}=>{if app.state::<SmokePaths>().managed_action!=Some(Scenario::Window){return Err("managed-wrong-scenario-window");}if session.card.as_deref()!=Some(card_id.as_str()){return Err("managed-window-card-owner");}window.destroy().map_err(|_|"managed-window-destroy")?;let until=Instant::now()+Duration::from_secs(3);while app.get_webview_window(crate::shell::MAIN_WINDOW).is_some(){if Instant::now()>=until{return Err("managed-window-destroy-timeout");}std::thread::sleep(Duration::from_millis(10));}
    let wire=serde_json::from_value(json!({"kind":"allow"})).map_err(|_|"managed-wire-answer")?;let vault=app.state::<SmokePaths>().vault_a.to_str().ok_or("managed-vault-text")?.to_owned();
    let answer=checked("answer_interaction",json!({"vault":vault,"id":card_id,"answer":{"kind":"allow"},"updatedInput":null}),||crate::answer_interaction(app.clone(),window.clone(),app.state(),app.state(),vault,card_id,wire,None))?.map_err(|_|"managed-window-answer-command")?;
    if !matches!(answer,crate::AnswerResult::Refused{..}){return Err("managed-destroyed-window-accepted");}session.decision_observed=true;
    crate::stop_agent(app.state(),session.handle.run).map_err(|_|"managed-window-stop")?;observed(&mut session.cases,"managed-late-answer",true,"refused-no-new-owner")?;let a=wait_cancelled(&app,session)?;if a.attempts!=0||a.receipts!=0||a.provider_entries!=0{return Err("managed-window-effect-truth");}observed(&mut session.cases,"managed-stopped-effect",true,"cancelled-before-submit-zero-provider")?;
   },
   Probe::Fail{stage}=>{return Err(match stage.as_str(){"access-command"=>"managed-renderer-access-command","answer-command"=>"managed-renderer-answer-command","effect-card"=>"managed-renderer-effect-card","stop-command"=>"managed-renderer-stop-command","window-command"=>"managed-renderer-window-command","completed-result"=>"managed-renderer-completed-result",_=>"managed-renderer-mounted-card"});},
   Probe::Finish=>{
    let scenario=app.state::<SmokePaths>().managed_action.ok_or("managed-profile-absent")?;
    if scenario==Scenario::Allow{
     if !session.answered{return Err("managed-answer-ack-missing");}let child=wait_child(&app)?;let a=audit(&app,session)?;
     if child["state"]!="succeeded"||a.state.as_deref()!=Some("succeeded"){return Err("managed-allow-succeeded");}
     if a.attempts!=1||a.receipts!=1||a.provider_entries!=1||child["invocationId"].as_str()!=a.invocation.as_deref()||child["outputState"]!="available"||child["outputDigest"].as_str()!=Some(crate::actions::native_owner::native_action_smoke_output_digest().map_err(|_|"managed-fixed-output-digest")?.as_str()){return Err("managed-original-result-receipt");}
     if app.state::<crate::agent::AgentState>().native_action_read(session.handle.run).is_none()||!has_event(&app,session,session.card.as_deref().ok_or("managed-card-missing")?,true)?||!has_event(&app,session,session.access.as_deref().ok_or("managed-access-missing")?,true)?{return Err("managed-original-stream-closure");}
     observed(&mut session.cases,"managed-completed-effect",true,"one-original-attempt-receipt-and-canonical-output")?;
    }else{let a=wait_cancelled(&app,session)?;if a.attempts!=0||a.receipts!=0||a.provider_entries!=0||a.state.as_deref()!=Some("cancelled"){return Err("managed-stopped-effect-truth");}observed(&mut session.cases,"managed-stopped-effect",true,"cancelled-before-submit-zero-provider")?;}
   },
  }Ok(Value::Null)
 }).await.map_err(|_|"managed-probe-worker")?;
 match result{Ok(value)=>{if finishing{finish(&copy,None);}Ok(value)},Err(stage)=>{finish(&copy,Some(stage));Err(stage)}}
}
pub(super) fn finish(app:&AppHandle,failed:Option<&'static str>){
 let paths=app.state::<SmokePaths>();if paths.finished.swap(true,Ordering::SeqCst){return;}
 let state=app.state::<State>();let seat=state.0.lock().ok();let session=seat.as_ref().and_then(|seat|seat.as_ref());let a=session.and_then(|session|audit(app,session).ok());
 let mut required=vec!["managed-original-publication","managed-first-run-zero","managed-access-held","managed-effect-held"];if paths.managed_action==Some(Scenario::Allow){required.extend(["managed-person-answer","managed-completed-effect"]);}else{required.extend(["managed-late-answer","managed-stopped-effect"]);}
 let names=session.map(|session|session.cases.iter().map(|case|case.name).collect::<Vec<_>>()).unwrap_or_default();
 let failed=failed.or(if names!=required{Some("managed-case-sequence-incomplete")}else if a.is_none(){Some("managed-final-audit-unavailable")}else{None});
 let report=json!({"format":1,"observer":"native-original-attended-managed-action-smoke","profile":"managed-action","scenario":paths.managed_action,"nativePid":std::process::id(),"childLaunchSha256":session.map(|session|session.child_launch_sha256.as_str()),"passed":failed.is_none(),"failedStage":failed,"cases":session.map(|session|session.cases.as_slice()).unwrap_or(&[]),"audit":a,"diagnosticProgress":session.map(|session|session.progress.as_slice()).unwrap_or(&[]),"compiledInputs":compiled_inputs(),"claims":{"actualMacosWindow":paths.started.load(Ordering::SeqCst),"actualOriginalPublication":session.is_some(),"actualLoopbackManagedCall":session.is_some_and(|session|session.card.is_some()),"actualPersonAnswerCommand":session.is_some_and(|session|session.decision_observed),"fixedFakeProviderOnly":true,"credentialAccess":false,"providerNetwork":false,"realAccount":false,"realClaudeCode":false,"realPersonBehavior":false,"packagedSigningAcceptance":false}});
 drop(seat);app.state::<crate::agent::AgentState>().shut_down();let _=crate::vault::watcher::stop(app.state::<crate::vault::watcher::WatcherState>().inner());
 let bytes=serde_json::to_vec_pretty(&report).unwrap_or_default();let saved=!bytes.is_empty()&&bytes.len()<=65536&&create(&paths.root.join("report.json"),&bytes).is_ok();app.exit(if saved&&failed.is_none(){0}else{2});
}
fn effective_uid()->u32{
 // SAFETY: geteuid observes this process identity and has no side effects.
 unsafe{libc::geteuid()}
}
fn private_bytes(path:&Path,limit:u64)->Result<Vec<u8>,&'static str>{
 let meta=fs::symlink_metadata(path).map_err(|_|"managed-child-file-metadata")?;if !meta.is_file()||meta.uid()!=effective_uid()||meta.mode()&0o077!=0||meta.len()>limit{return Err("managed-child-file-private");}
 let file=fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW|libc::O_NONBLOCK).open(path).map_err(|_|"managed-child-file-open")?;let actual=file.metadata().map_err(|_|"managed-child-file-stat")?;if actual.dev()!=meta.dev()||actual.ino()!=meta.ino(){return Err("managed-child-file-changed");}let mut bytes=Vec::new();file.take(limit+1).read_to_end(&mut bytes).map_err(|_|"managed-child-file-read")?;if bytes.len()as u64>limit{return Err("managed-child-file-bound");}Ok(bytes)
}
fn post(endpoint:&str,authorization:&str,request:&Value)->Result<Value,&'static str>{
 let endpoint=endpoint.strip_prefix("http://127.0.0.1:").and_then(|rest|rest.strip_suffix("/mcp")).ok_or("managed-child-fixed-loopback")?;let port:u16=endpoint.parse().map_err(|_|"managed-child-port")?;if port==0||authorization.is_empty()||authorization.len()>512||authorization.bytes().any(|b|b.is_ascii_control()){return Err("managed-child-config-values");}
 let mut stream=TcpStream::connect((std::net::Ipv4Addr::LOCALHOST,port)).map_err(|_|"managed-child-connect")?;stream.set_read_timeout(Some(Duration::from_secs(35))).map_err(|_|"managed-child-timeout")?;stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|_|"managed-child-timeout")?;
 let body=request.to_string();let head=format!("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {authorization}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",body.len());stream.write_all(head.as_bytes()).and_then(|_|stream.write_all(body.as_bytes())).map_err(|_|"managed-child-send")?;
 let mut bytes=Vec::new();stream.take(65537).read_to_end(&mut bytes).map_err(|_|"managed-child-receive")?;if bytes.len()>65536{return Err("managed-child-response-bound");}let text=std::str::from_utf8(&bytes).map_err(|_|"managed-child-response-text")?;let(head,body)=text.split_once("\r\n\r\n").ok_or("managed-child-response-frame")?;if !head.lines().next().is_some_and(|line|line.starts_with("HTTP/1.1 200 ")||line.starts_with("HTTP/1.0 200 ")){return Err("managed-child-response-status");}let value:Value=serde_json::from_str(body).map_err(|_|"managed-child-response-json")?;if value.get("id")!=request.get("id"){return Err("managed-child-response-owner");}Ok(value)
}
fn content(value:&Value)->Result<Value,&'static str>{if value.get("error").is_some()||value["result"]["isError"]==true{return Err("managed-child-rpc-refused");}let text=value["result"]["content"].as_array().and_then(|items|items.first()).and_then(|item|item["text"].as_str()).ok_or("managed-child-content")?;serde_json::from_str(text).map_err(|_|"managed-child-content-json")}
/// The copied original CLI fixture owns its own private generated config. No
/// bearer, receipt or selected request is accepted from the renderer/controller.
pub(super) fn child(args:&[std::ffi::OsString])->bool{
 let Some(dir)=std::env::var_os("CLAUDE_CONFIG_DIR")else{return false;};let Some(root)=Path::new(&dir).parent()else{return false;};if settings_absent(&root.join("managed-action.marker")){return false;}
 // Independent whole-child bound survives loss of the native supervisor;
 // the real AgentState still owns normal kill/reap. No child process is spawned.
 std::thread::spawn(||{std::thread::sleep(Duration::from_secs(45));std::process::exit(2);});
 let result=(||->Result<Value,&'static str>{
  private_bytes(&root.join("managed-action.marker"),32)?;
  let at=args.iter().position(|arg|arg=="--mcp-config").ok_or("managed-child-config-arg")?;let config=PathBuf::from(args.get(at+1).ok_or("managed-child-config-arg")?);let canonical=fs::canonicalize(&config).map_err(|_|"managed-child-config-canonical")?;
  if canonical!=config||config.parent()!=Some(root.join("config").as_path())||!config.file_name().and_then(|s|s.to_str()).is_some_and(|s|s.starts_with("mcp-config-")&&s.ends_with(".json")){return Err("managed-child-config-origin");}
  let config:Value=serde_json::from_slice(&private_bytes(&config,65536)?).map_err(|_|"managed-child-config-json")?;let server=&config["mcpServers"]["cerebro"];let endpoint=server["url"].as_str().ok_or("managed-child-endpoint")?;let auth=server["headers"]["Authorization"].as_str().filter(|s|s.starts_with("Bearer ")).ok_or("managed-child-bearer")?;
  let deadline=Instant::now()+Duration::from_secs(15);while settings_absent(&root.join("managed-action-ready")){if Instant::now()>=deadline{return Err("managed-child-ready-timeout");}std::thread::sleep(Duration::from_millis(10));}private_bytes(&root.join("managed-action-ready"),32)?;
  let names=post(endpoint,auth,&json!({"jsonrpc":"2.0","id":"names","method":"tools/list","params":{}}))?;let listed=names["result"]["tools"].as_array().ok_or("managed-child-tools-list")?;for row in crate::policy::tools::manifest().tools.iter().filter(|row|row.toolset.as_deref()==Some("managed")){if !listed.iter().any(|value|value["name"]==row.name){return Err("managed-child-tools-hidden");}}
  let catalog=content(&post(endpoint,auth,&json!({"jsonrpc":"2.0","id":"access","method":"tools/call","params":{"name":"list_actions","arguments":{}}}))?)?;
  let binding=catalog["bindings"].as_array().and_then(|rows|rows.iter().find(|row|row["actionId"]=="github.issue.create")).ok_or("managed-child-create-binding")?;
  let prepared=content(&post(endpoint,auth,&json!({"jsonrpc":"2.0","id":"prepare","method":"tools/call","params":{"name":"prepare_action","arguments":{"actionId":binding["actionId"],"definitionDigest":binding["definitionDigest"],"connectionId":binding["connectionId"],"accountId":binding["accountId"],"snapshotDigest":catalog["catalog"]["snapshotDigest"],"input":crate::actions::native_owner::native_action_smoke_input(),"requestKey":"m96-native-original-fixed-request"}}}))?)?;
  let output=prepared["output"]["json"].as_str();Ok(json!({"state":prepared["effect"]["state"],"invocationId":prepared["effect"]["invocationId"],"outputState":prepared["output"]["state"],"outputDigest":output.map(|body|format!("{:x}",Sha256::digest(body.as_bytes())))}))
 })();
 let value=match result{Ok(value)=>value,Err(stage)=>json!({"failedStage":stage})};let bytes=serde_json::to_vec(&value).unwrap_or_default();if bytes.len()<=16384{let _=create(&root.join("managed-child-result.json"),&bytes);}std::thread::sleep(Duration::from_secs(45));true
}
