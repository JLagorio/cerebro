//! The human page's read-only GitHub door. No runtime record or receipt.
use crate::forge::{PrRead, PrReader};

#[tauri::command(async)]
pub fn pull_request_state(
    reader: tauri::State<'_, PrReader>,
    url: String,
    refresh: Option<bool>,
) -> PrRead {
    reader.read(&url, refresh.unwrap_or(false))
}
