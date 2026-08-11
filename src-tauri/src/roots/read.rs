//! Reading one file, with the three guards that keep this from being an
//! arbitrary-file-read primitive.
//!
//! `mcp.rs` exposes tools to a CLI subprocess, so an unguarded reader reachable
//! from a command is a real exposure, not a theoretical one. All three guards
//! ship with the function — none is a follow-up.

use serde::Serialize;
use std::path::Path;

/// 2 MB. Large enough for any source file worth reading in a viewer, small
/// enough that a stray database dump cannot exhaust memory.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// How much of the file to sniff for NUL before deciding it is binary.
const SNIFF_BYTES: usize = 8 * 1024;

/// The result of a read. Refusals are VALUES, not error strings: the viewer
/// renders a different placeholder for each, and a string would force it to
/// pattern-match prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileText {
    Text { content: String },
    TooLarge { size: u64, limit: u64 },
    Binary,
    NotFound,
}

/// Read one text file from inside a root.
///
/// Guard order matters: containment first (never touch a file outside the
/// root), then size (never load one that could exhaust memory), then binary
/// (never hand the UI bytes it cannot render).
pub fn read_file_text(root: &Path, rel: &str) -> FileText {
    let Ok(path) = super::tree::resolve_within(root, rel) else {
        return FileText::NotFound;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return FileText::NotFound;
    };
    if !meta.is_file() {
        return FileText::NotFound;
    }
    if meta.len() > MAX_BYTES {
        return FileText::TooLarge {
            size: meta.len(),
            limit: MAX_BYTES,
        };
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return FileText::NotFound;
    };
    if bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0) {
        return FileText::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(content) => FileText::Text { content },
        // Valid non-UTF-8 bytes with no NUL — still not something to render.
        Err(_) => FileText::Binary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn reads_a_text_file() {
        let dir = testutil::temp_vault("read-text");
        testutil::write(&dir, "hello.md", "# Hello");
        assert_eq!(
            read_file_text(&dir, "hello.md"),
            FileText::Text {
                content: "# Hello".to_string()
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_path_escaping_the_root() {
        let dir = testutil::temp_vault("read-escape");
        testutil::write(&dir, "inside.md", "x");
        assert_eq!(read_file_text(&dir, "../../etc/passwd"), FileText::NotFound);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_pointing_outside_the_root() {
        let dir = testutil::temp_vault("read-symlink");
        let outside = testutil::temp_vault("read-symlink-outside");
        testutil::write(&outside, "secret.md", "classified");
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("link.md")).unwrap();

        assert_eq!(read_file_text(&dir, "link.md"), FileText::NotFound);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn refuses_a_file_over_the_size_cap() {
        let dir = testutil::temp_vault("read-large");
        let big = "x".repeat((MAX_BYTES + 1) as usize);
        testutil::write(&dir, "big.txt", &big);
        match read_file_text(&dir, "big.txt") {
            FileText::TooLarge { size, limit } => {
                assert!(size > MAX_BYTES);
                assert_eq!(limit, MAX_BYTES);
            }
            other => panic!("expected TooLarge, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_binary_file() {
        let dir = testutil::temp_vault("read-binary");
        std::fs::write(dir.join("image.png"), [0x89, b'P', b'N', b'G', 0x00, 0x1a]).unwrap();
        assert_eq!(read_file_text(&dir, "image.png"), FileText::Binary);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = testutil::temp_vault("read-missing");
        assert_eq!(read_file_text(&dir, "nope.md"), FileText::NotFound);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_is_not_a_readable_file() {
        let dir = testutil::temp_vault("read-dir");
        testutil::write(&dir, "sub/inner.md", "x");
        assert_eq!(read_file_text(&dir, "sub"), FileText::NotFound);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
