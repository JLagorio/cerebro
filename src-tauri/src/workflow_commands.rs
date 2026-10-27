//! Authenticated workflow selectors. No caller-supplied vault path or authority.
use crate::{actions::native_owner,workflows::transport::*};
fn unavailable()->WorkflowError{WorkflowError{code:WorkflowErrorCode::Unavailable,diagnostics:Vec::new()}}
#[tauri::command]
pub(crate) async fn workflow_context(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<WorkflowContext,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_context(&app,&window)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_catalog(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,after:Option<String>)->Result<WorkflowCatalog,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_catalog(&app,&window,context,after)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_document(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,workflow_id:String)->Result<WorkflowDocument,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_document(&app,&window,context,workflow_id)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_version(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,version:WorkflowVersionRef)->Result<WorkflowDraft,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_version(&app,&window,context,version)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_save(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowSaveRequest)->Result<WorkflowDraftSnapshot,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_save(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_publish(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowPublishRequest)->Result<WorkflowPublication,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_publish(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_validate(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,draft:WorkflowDraft)->Result<WorkflowValidation,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_validate(&app,&window,context,draft)).await.map_err(|_|unavailable())?}

#[tauri::command]
pub(crate) async fn workflow_actions(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext)->Result<Vec<crate::actions::read_types::ActionDefinition>,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_actions(&app,&window,context)).await.map_err(|_|unavailable())?}

#[tauri::command]
pub(crate) async fn workflow_start(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowStartRequest)->Result<WorkflowStartAck,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_start(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_continue(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowRunRequest)->Result<WorkflowStartAck,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_continue(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_reauthorize(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowReauthorizeRequest)->Result<WorkflowStartAck,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_reauthorize(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_cancel(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowRunRequest)->Result<WorkflowRunView,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_cancel(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_runs(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,after:Option<String>)->Result<WorkflowRunCatalog,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_runs(&app,&window,context,after)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_run(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,run_id:String)->Result<WorkflowRunView,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_run(&app,&window,context,run_id)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_value(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowValueRequest)->Result<WorkflowValueDetail,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_value(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_action_details(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,run_id:String,invocation_id:String)->Result<crate::actions::ActionEffectDetails,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_action_details(&app,&window,context,run_id,invocation_id)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_answer_action(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowActionAnswer)->Result<WorkflowRunView,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_answer_action(&app,&window,request)).await.map_err(|_|unavailable())?}
#[tauri::command]
pub(crate) async fn workflow_answer_wait(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowWaitAnswer)->Result<WorkflowRunView,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_answer_wait(&app,&window,request)).await.map_err(|_|unavailable())?}

#[tauri::command]
pub(crate) async fn workflow_access(app:tauri::AppHandle,window:tauri::WebviewWindow,context:WorkflowContext,run_id:String)->Result<WorkflowAccessView,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_access(&app,&window,context,run_id)).await.map_err(|_|unavailable())?}

#[tauri::command]
pub(crate) async fn workflow_schedule(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    context: WorkflowContext, workflow: String,
) -> Result<WorkflowScheduleView, WorkflowError> {
    tauri::async_runtime::spawn_blocking(move || native_owner::workflow_schedule(&app, &window, context, workflow))
        .await.map_err(|_| unavailable())?
}

#[tauri::command]
pub(crate) async fn workflow_schedule_enable(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: WorkflowScheduleEnableRequest,
) -> Result<WorkflowScheduleAck, WorkflowError> {
    tauri::async_runtime::spawn_blocking(move || native_owner::workflow_schedule_enable(&app, &window, request))
        .await.map_err(|_| unavailable())?
}

#[tauri::command]
pub(crate) async fn workflow_schedule_pause(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: WorkflowScheduleChangeRequest,
) -> Result<WorkflowScheduleAck, WorkflowError> {
    tauri::async_runtime::spawn_blocking(move || native_owner::workflow_schedule_pause(&app, &window, request))
        .await.map_err(|_| unavailable())?
}

#[tauri::command]
pub(crate) async fn workflow_schedule_remove(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: WorkflowScheduleChangeRequest,
) -> Result<WorkflowScheduleAck, WorkflowError> {
    tauri::async_runtime::spawn_blocking(move || native_owner::workflow_schedule_remove(&app, &window, request))
        .await.map_err(|_| unavailable())?
}

#[tauri::command]
pub(crate) async fn workflow_schedule_preview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    context: WorkflowContext, workflow: String,
) -> Result<WorkflowSchedulePreview, WorkflowError> {
    tauri::async_runtime::spawn_blocking(move || native_owner::workflow_schedule_preview(&app, &window, context, workflow))
        .await.map_err(|_| unavailable())?
}

#[tauri::command]
pub(crate) async fn workflow_schedule_wake(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    context: WorkflowContext,
) -> Result<WorkflowScheduleMonitorAck, WorkflowError> {
    tauri::async_runtime::spawn_blocking(move || native_owner::workflow_schedule_wake(&app, &window, context))
        .await.map_err(|_| unavailable())?
}

#[tauri::command]
pub(crate) async fn workflow_unpublish(app:tauri::AppHandle,window:tauri::WebviewWindow,request:WorkflowUnpublishRequest)->Result<WorkflowUnpublishAck,WorkflowError>{tauri::async_runtime::spawn_blocking(move||native_owner::workflow_unpublish(&app,&window,request)).await.map_err(|_|unavailable())?}
