//! Paths the person explicitly dropped. These reads are webview commands,
//! never MCP tools; capture text is bounded and non-files are never opened.
use serde::Serialize;
use std::{fs::OpenOptions, io::Read, path::Path};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size: Option<u64>,
    pub hidden: bool,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DroppedText {
    Text { content: String },
    TooLarge { size: u64, limit: u64 },
    NotText,
    NotFound,
    Folder,
}

pub fn inspect(paths: Vec<String>) -> Vec<DroppedFile> {
    paths
        .into_iter()
        .map(|path| {
            let p = Path::new(&path);
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&path)
                .to_owned();
            let metadata = p
                .is_absolute()
                .then(|| std::fs::metadata(p))
                .and_then(Result::ok);
            let (kind, size) = match metadata {
                Some(m) if m.is_file() => ("file", Some(m.len())),
                Some(m) if m.is_dir() => ("folder", None),
                _ => ("missing", None),
            };
            DroppedFile {
                hidden: crate::vault::scan::is_hidden(&name),
                path,
                name,
                kind,
                size,
            }
        })
        .collect()
}

pub fn read_text(path: &str) -> DroppedText {
    let path = Path::new(path);
    if !path.is_absolute() {
        return DroppedText::NotFound;
    }
    let Ok(metadata) = std::fs::metadata(path) else {
        return DroppedText::NotFound;
    };
    if metadata.is_dir() {
        return DroppedText::Folder;
    }
    if !metadata.is_file() {
        return DroppedText::NotFound;
    }
    let limit = match super::kinds::lookup(&path.to_string_lossy()).ingest {
        super::kinds::Ingest::Capture => super::kinds::limits().capture_max_bytes,
        super::kinds::Ingest::Import => super::kinds::limits().import_max_bytes,
        _ => return DroppedText::NotText,
    };
    if metadata.len() > limit {
        return DroppedText::TooLarge {
            size: metadata.len(),
            limit,
        };
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A file swapped to a FIFO between stat and open must not block the app.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let Ok(file) = options.open(path) else {
        return DroppedText::NotFound;
    };
    let Ok(metadata) = file.metadata() else {
        return DroppedText::NotFound;
    };
    if !metadata.is_file() {
        return DroppedText::NotFound;
    }
    if metadata.len() > limit {
        return DroppedText::TooLarge {
            size: metadata.len(),
            limit,
        };
    }
    let mut bytes = Vec::new();
    if file.take(limit + 1).read_to_end(&mut bytes).is_err() {
        return DroppedText::NotFound;
    }
    if bytes.len() as u64 > limit {
        return DroppedText::TooLarge {
            size: bytes.len() as u64,
            limit,
        };
    }
    if bytes.contains(&0) {
        return DroppedText::NotText;
    }
    match String::from_utf8(bytes) {
        Ok(content) => DroppedText::Text { content },
        Err(_) => DroppedText::NotText,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[test]
    fn replays_the_shared_dropped_cases() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../fixtures/dropped-cases.json")).unwrap();
        for case in cases {
            let root = crate::vault::testutil::temp_vault("dropped-case");
            let name = case["name"].as_str().unwrap();
            let target = root.join(name);
            let seed = &case["seed"];
            if seed["folder"] == true {
                std::fs::create_dir(&target).unwrap();
            } else if !seed.is_null() {
                let bytes = seed["bytes"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|n| n.as_u64().unwrap() as u8)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| seed["text"].as_str().unwrap_or("").as_bytes().to_vec());
                std::fs::write(&target, bytes).unwrap();
                if let Some(size) = seed["size"].as_u64() {
                    OpenOptions::new()
                        .write(true)
                        .open(&target)
                        .unwrap()
                        .set_len(size)
                        .unwrap();
                }
            }
            let path = if case["absolute"] == true {
                target.to_string_lossy().into_owned()
            } else {
                name.to_owned()
            };
            let actual = inspect(vec![path.clone()]).pop().unwrap();
            assert_eq!(
                json!({"kind": actual.kind, "size": actual.size, "hidden": actual.hidden}),
                case["inspect"],
                "{}",
                case["id"]
            );
            assert_eq!(
                serde_json::to_value(read_text(&path)).unwrap(),
                case["read"],
                "{}",
                case["id"]
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn read_text_reads_only_capture_kinds_and_follows_a_dropped_link() {
        let root = crate::vault::testutil::temp_vault("dropped-link");
        let source = root.join("note.md");
        std::fs::write(&source, "Source").unwrap();
        let image = root.join("image.png");
        std::fs::write(&image, "Text disguised as image").unwrap();
        assert!(matches!(
            read_text(image.to_str().unwrap()),
            DroppedText::NotText
        ));
        #[cfg(unix)]
        {
            let link = root.join("link.txt");
            std::os::unix::fs::symlink(source, &link).unwrap();
            assert!(
                matches!(read_text(link.to_str().unwrap()), DroppedText::Text { content } if content == "Source")
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn the_cap_is_the_kinds_tables() {
        assert_eq!(
            super::super::kinds::limits().capture_max_bytes,
            4 * 1024 * 1024
        );
    }
    #[test]
    fn the_main_window_hands_os_drops_to_the_router() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        // Tauri defaults dragDropEnabled to true. Its path event is needed by
        // the router because native webviews consume external HTML5 drops.
        for window in config["app"]["windows"].as_array().unwrap() {
            assert_ne!(window["dragDropEnabled"], false);
        }
        let shell = include_str!("../shell/mod.rs");
        assert!(!shell.contains(".disable_drag_drop_handler()"));
    }
}
