use std::path::Path;

use super::types::{LegacyRecordLocator, LegacyRecordSnapshot, StoreError, StoreErrorCode};

/// The existing human read door owns path containment, note kinds and source
/// bytes. This adapter neither re-joins a path nor grants an agent capability.
pub(crate) fn read_record(
    vault: &Path,
    record: &LegacyRecordLocator,
) -> Result<LegacyRecordSnapshot, StoreError> {
    crate::vault::write::read_note_source(vault, &record.path)
        .map(|source| LegacyRecordSnapshot {
            content: source.content,
            hash: source.hash,
        })
        .map_err(|message| StoreError {
            // The legacy reader returns words, not a typed cause. Do not guess
            // at its filesystem or refusal messages to promise automatic retry.
            code: StoreErrorCode::CapabilityUnavailable,
            message,
            retryable: false,
        })
}
