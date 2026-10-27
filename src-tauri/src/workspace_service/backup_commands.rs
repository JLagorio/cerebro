//! Finite native IPC surface; raw filesystem choices are never renderer inputs.
use super::backup_types::*;
use tauri::{AppHandle, WebviewWindow};
#[cfg(not(target_os = "macos"))]
fn unsupported() -> WorkspaceBackupRefusal {
    WorkspaceBackupRefusal {
        kind: WorkspaceBackupRefusalKind::UnsupportedPlatform,
        message: "Native backups are unavailable on this platform.".into(),
        authority: None,
        backup: None,
        output: WorkspaceBackupDisposition::NoneCreated,
    }
}
pub(crate) fn initialize(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if super::backup_coordinator::native::initialize(app).is_err() {
        log::warn!("Native backup ownership is unavailable");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
pub(crate) struct WindowLifecycle {
    #[cfg(target_os = "macos")]
    original: Option<super::backup_coordinator::native::WindowLifecycle>,
}
impl WindowLifecycle {
    pub(crate) fn retire(&self) {
        #[cfg(target_os = "macos")]
        if let Some(original) = &self.original {
            original.retire();
        }
    }
}
pub(crate) fn register(app: &AppHandle, window: &WebviewWindow) -> WindowLifecycle {
    #[cfg(target_os = "macos")]
    {
        let original = super::backup_coordinator::native::register(app, window).ok();
        if original.is_none() {
            log::warn!("Native backup window registration is unavailable");
        }
        WindowLifecycle { original }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window);
        WindowLifecycle {}
    }
}

#[tauri::command(async)]
pub(crate) fn workspace_backup_availability(
    app: AppHandle,
    window: WebviewWindow,
    expected_vault: Option<String>,
) -> WorkspaceBackupAvailability {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::availability(&app, &window, expected_vault.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, expected_vault);
        WorkspaceBackupAvailability::UnsupportedPlatform
    }
}

#[tauri::command(async)]
pub(crate) fn choose_workspace_backup(
    app: AppHandle,
    window: WebviewWindow,
    expected_vault: String,
) -> WorkspaceBackupChoiceResult {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::choose_backup(&app, &window, &expected_vault)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, expected_vault);
        WorkspaceBackupChoiceResult::Refused {
            refusal: unsupported(),
        }
    }
}

#[tauri::command(async)]
pub(crate) fn check_workspace_backup(
    app: AppHandle,
    window: WebviewWindow,
) -> WorkspaceBackupChoiceResult {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::check_backup(&app, &window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window);
        WorkspaceBackupChoiceResult::Refused {
            refusal: unsupported(),
        }
    }
}

#[tauri::command(async)]
pub(crate) fn choose_workspace_restore(
    app: AppHandle,
    window: WebviewWindow,
    token: String,
) -> WorkspaceBackupChoiceResult {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::choose_restore(&app, &window, &token)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, token);
        WorkspaceBackupChoiceResult::Refused {
            refusal: unsupported(),
        }
    }
}

#[tauri::command(async)]
pub(crate) fn commit_workspace_backup(
    app: AppHandle,
    window: WebviewWindow,
    token: String,
) -> WorkspaceBackupCommitResult {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::commit_backup(&app, &window, &token)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, token);
        WorkspaceBackupCommitResult::Refused {
            refusal: unsupported(),
        }
    }
}

#[tauri::command(async)]
pub(crate) fn commit_workspace_restore(
    app: AppHandle,
    window: WebviewWindow,
    token: String,
) -> WorkspaceBackupCommitResult {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::commit_restore(&app, &window, &token)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, token);
        WorkspaceBackupCommitResult::Refused {
            refusal: unsupported(),
        }
    }
}

#[tauri::command(async)]
pub(crate) fn cancel_workspace_backup_choice(
    app: AppHandle,
    window: WebviewWindow,
    token: String,
) -> WorkspaceBackupCancelResult {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::cancel(&app, &window, &token)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window, token);
        WorkspaceBackupCancelResult::Refused {
            refusal: unsupported(),
        }
    }
}

#[tauri::command(async)]
pub(crate) fn workspace_backup_operation(
    app: AppHandle,
    window: WebviewWindow,
) -> WorkspaceBackupOperation {
    #[cfg(target_os = "macos")]
    {
        super::backup_coordinator::native::status(&app, &window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, window);
        WorkspaceBackupOperation::Unavailable {
            refusal: unsupported(),
        }
    }
}
