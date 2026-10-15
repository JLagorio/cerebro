//! Bounded, read-only Office extraction. The descriptor, archive, XML and
//! workbook boundaries are shared by captures and the agent document reader.
pub mod docx;
pub mod markdown;
mod materialize;
pub mod package;
pub mod pptx;
#[cfg(test)]
pub(crate) mod testdocs;
pub mod xlsx;
pub mod xml;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path},
};

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub file_bytes: u64,
    pub zip_entries: usize,
    pub part_bytes: u64,
    pub total_parts_bytes: u64,
    pub scanned_cells: usize,
    pub capture_bytes: usize,
    pub capture_rows: usize,
    pub capture_columns: usize,
    pub capture_sheets: usize,
}
impl Limits {
    pub const SHIPPED: Self = Self {
        file_bytes: 256 * 1024 * 1024,
        zip_entries: 10_000,
        part_bytes: 64 * 1024 * 1024,
        total_parts_bytes: 256 * 1024 * 1024,
        scanned_cells: 2_000_000,
        capture_bytes: 1024 * 1024,
        capture_rows: 200,
        capture_columns: 20,
        capture_sheets: 10,
    };
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Failure {
    Encrypted,
    TooLarge { detail: String },
    Corrupt { detail: String },
    Unsupported { detail: String },
}
impl Failure {
    pub fn corrupt(detail: impl Into<String>) -> Self {
        Self::Corrupt {
            detail: detail.into(),
        }
    }
    pub fn too_large(detail: impl Into<String>) -> Self {
        Self::TooLarge {
            detail: detail.into(),
        }
    }
    pub fn unsupported(detail: impl Into<String>) -> Self {
        Self::Unsupported {
            detail: detail.into(),
        }
    }
    pub fn detail(&self) -> &str {
        match self {
            Self::Encrypted => "it needs a password",
            Self::TooLarge { detail } | Self::Corrupt { detail } | Self::Unsupported { detail } => {
                detail
            }
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Docx,
    Pptx,
    Xlsx,
}
impl Format {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "docx" => Some(Self::Docx),
            "pptx" => Some(Self::Pptx),
            "xlsx" => Some(Self::Xlsx),
            _ => None,
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Xlsx => "xlsx",
        }
    }
    pub fn noun(self) -> &'static str {
        match self {
            Self::Docx => "Word document",
            Self::Pptx => "PowerPoint deck",
            Self::Xlsx => "Excel workbook",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Inline {
    Text { text: String },
    Link { text: String, url: String },
}
impl Inline {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableCell {
    pub text: String,
    pub colspan: usize,
    pub rowspan: usize,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
    Paragraph {
        runs: Vec<Inline>,
    },
    Heading {
        level: u8,
        runs: Vec<Inline>,
    },
    List {
        level: u8,
        label: String,
        runs: Vec<Inline>,
    },
    Table {
        rows: Vec<Vec<TableCell>>,
    },
    Picture {
        alt: String,
        part: String,
    },
    Chart {
        name: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PicturePlace {
    Block { block: usize },
    Slide { slide: usize },
    Workbook { sheet: String, anchor: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Picture {
    pub part: String,
    pub alt: String,
    pub place: PicturePlace,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slide {
    pub title: String,
    pub hidden: bool,
    pub blocks: Vec<Block>,
    pub notes: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CellValue {
    Text(String),
    Number(f64),
    Bool(bool),
    Date(String),
    Duration(String),
    Error(String),
    Empty,
}
impl CellValue {
    pub fn words(&self) -> String {
        match self {
            Self::Text(s) | Self::Date(s) | Self::Duration(s) | Self::Error(s) => s.clone(),
            Self::Number(n) => n.to_string(),
            Self::Bool(b) => b.to_string(),
            Self::Empty => String::new(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub name: String,
    pub hidden: bool,
    pub used: Option<((u32, u32), (u32, u32))>,
    /// Sparse cells only. Coordinate gaps never allocate a grid.
    pub cells: BTreeMap<(u32, u32), CellValue>,
    pub formulas: BTreeMap<(u32, u32), String>,
    pub merges: Vec<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Document {
    Word(Vec<Block>),
    Presentation(Vec<Slide>),
    Workbook(Vec<Sheet>),
}
pub struct OpenedDocument {
    pub format: Format,
    pub sha256: String,
    pub bytes: u64,
    pub document: Document,
    pub pictures: Vec<Picture>,
    pub not_carried: Vec<String>,
    pub package: package::Package,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Outcome {
    Extracted {
        markdown: String,
        not_carried: Vec<String>,
        truncated: bool,
    },
    Encrypted,
    TooLarge {
        detail: String,
    },
    Corrupt {
        detail: String,
    },
    Unsupported {
        detail: String,
    },
}
impl From<Failure> for Outcome {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Encrypted => Self::Encrypted,
            Failure::TooLarge { detail } => Self::TooLarge { detail },
            Failure::Corrupt { detail } => Self::Corrupt { detail },
            Failure::Unsupported { detail } => Self::Unsupported { detail },
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Extraction {
    pub format: String,
    pub sha256: String,
    pub bytes: u64,
    pub outcome: Outcome,
}

pub fn vault_file(vault: &Path, rel: &str) -> Result<super::bytes::OpenedFile, String> {
    if rel.is_empty()
        || rel.contains('\\')
        || rel.chars().any(char::is_control)
        || rel
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || Path::new(rel)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || rel.as_bytes().get(1) == Some(&b':')
    {
        return Err(format!("path escapes the vault: {rel}"));
    }
    if rel.split('/').any(|c| c.starts_with('.')) {
        return Err("dot-folders and dotfiles are not readable here".into());
    }
    let opened = super::bytes::open_in(vault, "0", rel).map_err(|err| match err.code.as_str() {
        "outside" | "bad_address" => format!("path escapes the vault: {rel}"),
        "folder" => format!("{rel} is a folder, not a file"),
        _ => format!("no file at {rel}"),
    })?;
    let canonical = opened
        .path
        .strip_prefix(&opened.root)
        .map_err(|_| format!("path escapes the vault: {rel}"))?;
    if canonical
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Err("dot-folders and dotfiles are not readable here".into());
    }
    Ok(opened)
}
pub fn open(bytes: Vec<u8>, format: Format, limits: Limits) -> Result<OpenedDocument, Failure> {
    if bytes.len() as u64 > limits.file_bytes {
        return Err(Failure::too_large("the file exceeds 256 MiB"));
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let size = bytes.len() as u64;
    std::panic::catch_unwind(|| {
        let mut package = package::Package::new(bytes, format.extension(), limits)?;
        // Even an unused Office part cannot conceal a DTD or exceed the budget.
        package.verify_all()?;
        let (document, pictures, not_carried) = match format {
            Format::Docx => docx::read(&mut package, limits)?,
            Format::Pptx => pptx::read(&mut package, limits)?,
            Format::Xlsx => xlsx::read(&mut package, limits)?,
        };
        Ok(OpenedDocument {
            format,
            sha256,
            bytes: size,
            document,
            pictures,
            not_carried,
            package,
        })
    })
    .unwrap_or_else(|_| Err(Failure::corrupt("the reader stopped on this file")))
}
pub fn capture(vault: &Path, rel: &str, limits: Limits) -> Result<Extraction, String> {
    let mut file = vault_file(vault, rel)?;
    let ext = Path::new(rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let size = file
        .file
        .metadata()
        .map_err(|_| format!("no file at {rel}"))?
        .len();
    // Hash the descriptor's bytes even when parsing is refused; never allocate
    // an over-cap file. The hash belongs to these exact bytes, not an old stat.
    let mut hasher = Sha256::new();
    let mut bytes = Vec::new();
    let mut count = 0_u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file
            .file
            .read(&mut buffer)
            .map_err(|_| format!("could not read {rel}"))?;
        if n == 0 {
            break;
        }
        count = count.saturating_add(n as u64);
        hasher.update(&buffer[..n]);
        if count <= limits.file_bytes {
            bytes.extend_from_slice(&buffer[..n]);
        }
    }
    let sha256 = format!("{:x}", hasher.finalize());
    let format = super::kinds::lookup(rel)
        .extractor
        .and_then(|reader| Format::from_extension(reader.as_str()));
    let outcome = if size > limits.file_bytes || count > limits.file_bytes {
        Failure::too_large("the file exceeds 256 MiB").into()
    } else if let Some(format) = format {
        match open(bytes, format, limits) {
            Ok(doc) => {
                let (markdown, truncated) = markdown::capture_markdown(&doc.document, limits);
                Outcome::Extracted {
                    markdown,
                    not_carried: doc.not_carried,
                    truncated,
                }
            }
            Err(failure) => failure.into(),
        }
    } else {
        Failure::unsupported(format!("Cerebro has no text reader for .{ext} files")).into()
    };
    Ok(Extraction {
        format: format.map(|f| f.extension().to_owned()).unwrap_or(ext),
        sha256,
        bytes: count,
        outcome,
    })
}

type Parsed = (Document, Vec<Picture>, Vec<String>);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vault_file_replays_the_shared_path_cases() {
        let temp = testdocs::TempDir::new();
        std::fs::create_dir(temp.path().join("docs")).unwrap();
        std::fs::write(temp.path().join("docs/report.docx"), b"bytes").unwrap();
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/document-paths.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let path = case["path"].as_str().unwrap();
            let result = vault_file(temp.path(), path);
            if let Some(error) = case["error"].as_str() {
                assert_eq!(result.unwrap_err(), error, "{path}");
            } else {
                assert!(result.is_ok(), "{path}");
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_vault_and_into_a_dot_folder_refuse() {
        let vault = testdocs::TempDir::new();
        let outside = testdocs::TempDir::new();
        std::fs::write(outside.path().join("doc.docx"), b"outside").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("doc.docx"),
            vault.path().join("out.docx"),
        )
        .unwrap();
        std::fs::create_dir(vault.path().join(".hidden")).unwrap();
        std::fs::write(vault.path().join(".hidden/doc.docx"), b"inside").unwrap();
        std::os::unix::fs::symlink(
            vault.path().join(".hidden/doc.docx"),
            vault.path().join("hidden.docx"),
        )
        .unwrap();
        assert_eq!(
            vault_file(vault.path(), "out.docx").unwrap_err(),
            "path escapes the vault: out.docx"
        );
        assert_eq!(
            vault_file(vault.path(), "hidden.docx").unwrap_err(),
            "dot-folders and dotfiles are not readable here"
        );
    }
    #[test]
    fn pictures_name_their_part_alt_and_place() {
        for (bytes, format, part, place) in [
            (
                testdocs::docx(),
                Format::Docx,
                "word/media/picture.png",
                "block",
            ),
            (
                testdocs::pptx(),
                Format::Pptx,
                "ppt/media/image.png",
                "slide",
            ),
            (
                testdocs::xlsx(),
                Format::Xlsx,
                "xl/media/image.png",
                "workbook",
            ),
        ] {
            let mut doc = open(bytes, format, Limits::SHIPPED).unwrap();
            assert_eq!(doc.pictures[0].part, part);
            assert!(!doc.pictures[0].alt.is_empty());
            assert_eq!(
                serde_json::to_value(&doc.pictures[0].place).unwrap()["kind"],
                place
            );
            assert_eq!(doc.package.read_part(part, 1024).unwrap(), testdocs::PNG);
        }
    }
    #[test]
    fn every_office_extractor_in_the_kinds_table_has_a_reader() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../../../../shared/files/kinds.v1.json")).unwrap();
        let mut seen = Vec::new();
        for row in table["kinds"].as_array().unwrap() {
            if let Some(reader) = row["extractor"]
                .as_str()
                .filter(|s| matches!(*s, "docx" | "pptx" | "xlsx"))
            {
                assert!(Format::from_extension(reader).is_some());
                seen.push(reader);
            }
        }
        assert_eq!(seen, ["docx", "pptx", "xlsx", "xlsx"]);
        // Full table classification is asserted by the kinds reader; this pins
        // each Office parser to a real successfully readable package.
        for (format, bytes) in [
            (Format::Docx, testdocs::docx()),
            (Format::Pptx, testdocs::pptx()),
            (Format::Xlsx, testdocs::xlsx()),
        ] {
            assert!(open(bytes, format, Limits::SHIPPED).is_ok());
        }
    }
    #[test]
    fn the_wire_shape_is_the_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/extract-wire.json")).unwrap();
        let parsed: Extraction = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), fixture);
    }
    #[test]
    fn capture_names_a_kind_with_no_reader() {
        let vault = testdocs::TempDir::new();
        std::fs::write(vault.path().join("item.pdf"), b"%PDF").unwrap();
        let capture = capture(vault.path(), "item.pdf", Limits::SHIPPED).unwrap();
        assert_eq!(capture.bytes, 4);
        assert_eq!(capture.sha256, format!("{:x}", Sha256::digest(b"%PDF")));
        assert_eq!(
            capture.outcome,
            Outcome::Unsupported {
                detail: "Cerebro has no text reader for .pdf files".into()
            }
        );
    }
    #[test]
    fn capture_selects_the_xlsm_reader_from_the_kinds_table() {
        let vault = testdocs::TempDir::new();
        std::fs::write(vault.path().join("book.xlsm"), testdocs::xlsx()).unwrap();
        let result = capture(vault.path(), "book.xlsm", Limits::SHIPPED).unwrap();
        assert_eq!(result.format, "xlsx");
        assert!(matches!(result.outcome, Outcome::Extracted { .. }));
    }
}
