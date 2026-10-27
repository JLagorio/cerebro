//! Authenticated credential lifecycle selectors. macOS uses the owned native import worker.
//! No wire value supplies an owner, person, ticket, backend or credential.
use crate::{
    actions::{
        ids::{AttemptId, ConnectionId},
        native_owner,
    },
    connections::{metadata::CredentialAcquisitionView, ConnectionError, GhSelection},
};

#[tauri::command]
pub(crate) async fn begin_gh_import(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    connection_id: ConnectionId,
    host: String,
    login: String,
    expected_revision: u64,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    tauri::async_runtime::spawn_blocking(move || {
        native_owner::credential_begin_owned(
            &app,
            &window,
            &GhSelection {
                connection_id,
                host,
                login,
            },
            expected_revision,
        )
    })
    .await
    .map_err(|_| ConnectionError::Unavailable)?
}

#[tauri::command]
pub(crate) async fn credential_acquisition(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    attempt_id: AttemptId,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    tauri::async_runtime::spawn_blocking(move || {
        native_owner::credential_poll(&app, &window, &attempt_id)
    })
    .await
    .map_err(|_| ConnectionError::Unavailable)?
}

#[tauri::command]
pub(crate) async fn cancel_credential_acquisition(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    attempt_id: AttemptId,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    tauri::async_runtime::spawn_blocking(move || {
        native_owner::credential_cancel(&app, &window, &attempt_id)
    })
    .await
    .map_err(|_| ConnectionError::Unavailable)?
}
