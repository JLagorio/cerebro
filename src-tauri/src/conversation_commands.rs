//! IPC selectors only; the native original-opening owner admits every operation.
use tauri::{AppHandle,WebviewWindow};
use crate::{actions::{native_owner as native,SafeCounter},conversations::transport::*};
#[tauri::command]
pub(crate) async fn conversation_context(app:AppHandle,window:WebviewWindow)->Result<ArchiveContext,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_context(&app,&window)).await.map_err(|_|ArchiveError::unavailable())?}
#[tauri::command]
pub(crate) async fn conversation_retention(app:AppHandle,window:WebviewWindow,context:ArchiveContext)->Result<ArchiveSetting,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_retention(&app,&window,context)).await.map_err(|_|ArchiveError::unavailable())?}
#[tauri::command]
pub(crate) async fn conversation_set_retention(app:AppHandle,window:WebviewWindow,context:ArchiveContext,choice:RetentionChoice,expected_revision:SafeCounter)->Result<ArchiveSetting,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_set_retention(&app,&window,context,choice,expected_revision)).await.map_err(|_|ArchiveError::unavailable())?}
#[tauri::command]
pub(crate) async fn conversation_list(app:AppHandle,window:WebviewWindow,context:ArchiveContext,after:Option<String>,query:Option<String>,limit:u32)->Result<ThreadPage,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_list(&app,&window,context,after,query,limit)).await.map_err(|_|ArchiveError::unavailable())?}
#[tauri::command]
pub(crate) async fn conversation_messages(app:AppHandle,window:WebviewWindow,context:ArchiveContext,thread_id:String,before:Option<String>,limit:u32)->Result<MessagePage,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_messages(&app,&window,context,thread_id,before,limit)).await.map_err(|_|ArchiveError::unavailable())?}
#[tauri::command]
pub(crate) async fn conversation_delete(app:AppHandle,window:WebviewWindow,context:ArchiveContext,thread_id:String)->Result<DeleteResult,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_delete(&app,&window,context,thread_id)).await.map_err(|_|ArchiveError::unavailable())?}
#[tauri::command]
pub(crate) async fn conversation_prune(app:AppHandle,window:WebviewWindow,context:ArchiveContext)->Result<PruneResult,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_prune(&app,&window,context)).await.map_err(|_|ArchiveError::unavailable())?}
#[tauri::command]
pub(crate) async fn conversation_export(app:AppHandle,window:WebviewWindow,context:ArchiveContext,thread_id:String,format:ExportFormat)->Result<ExportResult,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_export(&app,&window,context,thread_id,format)).await.map_err(|_|ArchiveError::unavailable())?}

#[tauri::command]
pub(crate) async fn conversation_import(app:AppHandle,window:WebviewWindow,context:ArchiveContext,batch:crate::runtime::conversations::legacy::ImportBatch)->Result<ImportResult,ArchiveError>{tauri::async_runtime::spawn_blocking(move||native::conversation_import(&app,&window,context,batch)).await.map_err(|_|ArchiveError::unavailable())?}
