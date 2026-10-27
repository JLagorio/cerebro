//! Selected-format admission. A staged workspace is never a legacy workspace.
use super::stage::{canonical_root, error, read_bounded, rules, StageResult};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
pub const FORMAT_MARKER: &str = ".cerebro/workspace-format.json";
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Marker {
    format: u32,
    authority: String,
    pub state: String,
    pub manifest_hash: Option<String>,
}
pub(super) fn marker_bytes(state: &str, hash: Option<String>) -> StageResult<Vec<u8>> {
    serde_json::to_vec(&Marker {
        format: rules().format,
        authority: rules().authority.clone(),
        state: state.into(),
        manifest_hash: hash,
    })
    .map_err(|_| error("invalid_format", "Format marker cannot be encoded."))
}
pub(super) fn read_marker(root: &Path) -> StageResult<Option<Marker>> {
    let root = canonical_root(root)?;
    // Do not treat a broken symlink or non-directory parent as an absent marker.
    let mut path = root.clone();
    for component in Path::new(FORMAT_MARKER).components() {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(error("invalid_format", "Format path is a symlink."))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(error(
                    "invalid_format",
                    "Format marker cannot be inspected.",
                ))
            }
        }
    }
    let bytes = read_bounded(&root, FORMAT_MARKER, rules().limits.marker_bytes)
        .map_err(|_| error("invalid_format", "Format marker cannot be read."))?;
    #[derive(Deserialize)]
    struct Header {
        format: u32,
    }
    let header: Header = serde_json::from_slice(&bytes)
        .map_err(|_| error("invalid_format", "Format marker is malformed."))?;
    if header.format != rules().format {
        return Err(error(
            "unsupported_format",
            "This workspace format is unsupported.",
        ));
    }
    let marker: Marker = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            "invalid_format",
            "Selected format marker has invalid fields.",
        )
    })?;
    if marker.authority != rules().authority
        || !matches!(marker.state.as_str(), "preparing" | "staged_inactive")
        || (marker.state == "preparing" && marker.manifest_hash.is_some())
        || (marker.state == "staged_inactive"
            && !marker.manifest_hash.as_ref().is_some_and(|h| {
                h.len() == 64
                    && h.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }))
    {
        return Err(error(
            "invalid_format",
            "Selected format/state is unsupported or incomplete.",
        ));
    }
    Ok(Some(marker))
}
/// Consumers which have not adopted the selected authority must call this
/// before any metadata access. Integration into every old consumer remains gated.
pub fn guard_legacy_access(root: &Path) -> StageResult<()> {
    match read_marker(root)? {
        None => Ok(()),
        Some(marker) if marker.state == "preparing" => Err(error(
            "inactive_workspace",
            "Selected workspace preparation is incomplete.",
        )),
        Some(_) => Err(error(
            "selected_authority_required",
            "This workspace requires the selected metadata authority.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn newer_format_refuses_before_any_legacy_read_and_preserves_marker_bytes() {
        let root = crate::vault::testutil::temp_vault("m99-newer-format");
        fs::create_dir_all(root.join(".cerebro")).unwrap();
        let raw = br#"{"format":999,"authority":"sqlite_metadata","future":{"unknown":true}}"#;
        fs::write(root.join(FORMAT_MARKER), raw).unwrap();
        assert_eq!(
            guard_legacy_access(&root).unwrap_err().kind,
            "unsupported_format"
        );
        assert_eq!(fs::read(root.join(FORMAT_MARKER)).unwrap(), raw);
    }
    #[test]
    fn absent_marker_is_legacy_but_malformed_or_incomplete_marker_is_never_legacy() {
        let root = crate::vault::testutil::temp_vault("m99-format-missing");
        guard_legacy_access(&root).unwrap();
        fs::create_dir_all(root.join(".cerebro")).unwrap();
        fs::write(root.join(FORMAT_MARKER), b"{broken").unwrap();
        assert_eq!(
            guard_legacy_access(&root).unwrap_err().kind,
            "invalid_format"
        );
        fs::write(
            root.join(FORMAT_MARKER),
            br#"{"format":1,"authority":"sqlite_metadata","state":"preparing"}"#,
        )
        .unwrap();
        assert_eq!(
            guard_legacy_access(&root).unwrap_err().kind,
            "inactive_workspace"
        );
    }
}
