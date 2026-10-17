//! Generated structure is markdown; imported strings are always inert text.
use super::{xlsx, Block, Document, Inline, Limits, Sheet};

pub fn inert_line(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        match c {
            '\n' | '\r' | '\t' => out.push(' '),
            c if c.is_control() => {}
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\\' | '[' | ']' | '(' | ')' | '*' | '_' | '`' | '#' | '!' | '|' | '~' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            ':' => out.push_str("&#58;"),
            '@' => out.push_str("&#64;"),
            '📅' => out.push_str("&#128197;"),
            _ => out.push(c),
        }
    }
    let trimmed = out.trim_start();
    if trimmed.starts_with(['-', '+', '='])
        || trimmed.chars().take_while(char::is_ascii_digit).count() > 0
            && trimmed
                .trim_start_matches(|c: char| c.is_ascii_digit())
                .starts_with(['.', ')'])
    {
        let at = out.len() - trimmed.len();
        out.insert(at, '\\');
    }
    out
}
pub fn inert_cell(text: &str) -> String {
    inert_line(text)
}
fn runs(runs: &[Inline]) -> String {
    runs.iter()
        .map(|run| match run {
            Inline::Text { text } => inert_line(text),
            Inline::Link { text, url } => {
                // The reader already checked the scheme; encode delimiter bytes so
                // an untrusted target cannot terminate its generated destination.
                if !super::docx::safe_link(url) {
                    return inert_line(text);
                }
                let target = url
                    .replace('%', "%25")
                    .replace(' ', "%20")
                    .replace('(', "%28")
                    .replace(')', "%29")
                    .replace('<', "%3C")
                    .replace('>', "%3E")
                    .replace('\\', "%5C")
                    .replace(['\r', '\n'], "");
                format!("[{}]({target})", inert_line(text))
            }
        })
        .collect()
}
pub fn block_markdown(block: &Block, limits: Limits) -> String {
    match block {
        Block::Paragraph { runs: r } => runs(r),
        Block::Heading { level, runs: r } => format!(
            "{} {}",
            "#".repeat(usize::from((*level + 1).min(6))),
            runs(r)
        ),
        Block::List {
            level,
            label,
            runs: r,
        } => {
            let prefix = if label
                .strip_suffix('.')
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
            {
                label.clone()
            } else if matches!(label.as_str(), "•" | "-" | "●" | "○" | "▪") {
                "-".into()
            } else {
                format!("- {}", inert_line(label))
            };
            format!("{}{} {}", "  ".repeat(usize::from(*level)), prefix, runs(r))
        }
        Block::Picture { alt, .. } => format!(
            "*Image: {}*",
            inert_line(if alt.is_empty() {
                "no description"
            } else {
                alt
            })
        ),
        Block::Chart { name } => format!("Chart: {}", inert_line(name)),
        Block::Table { rows } => {
            if rows.is_empty() {
                return String::new();
            }
            let width = rows
                .iter()
                .map(|row| row.iter().map(|c| c.colspan).sum::<usize>())
                .max()
                .unwrap_or(0)
                .min(limits.capture_columns);
            let mut lines = Vec::new();
            for (index, row) in rows.iter().take(limits.capture_rows).enumerate() {
                let mut cells = Vec::new();
                for cell in row {
                    if cells.len() >= width {
                        break;
                    }
                    cells.push(inert_cell(&cell.text));
                    for _ in 1..cell.colspan.min(width) {
                        if cells.len() < width {
                            cells.push(String::new());
                        }
                    }
                }
                cells.resize(width, String::new());
                lines.push(format!("| {} |", cells.join(" | ")));
                if index == 0 {
                    lines.push(format!("| {} |", vec!["---"; width].join(" | ")));
                }
            }
            if rows.len() > limits.capture_rows {
                lines.push(format!(
                    "\nRows {}–{} of this table stay in the original.",
                    limits.capture_rows + 1,
                    rows.len()
                ));
            }
            lines.join("\n")
        }
    }
}
pub fn sheet_markdown(sheet: &Sheet, start: (u32, u32), end: (u32, u32)) -> String {
    let mut lines = vec![
        format!(
            "|  | {} |",
            (start.1..=end.1)
                .map(xlsx::column_name)
                .collect::<Vec<_>>()
                .join(" | ")
        ),
        format!(
            "| --- | {} |",
            vec!["---"; (end.1 - start.1 + 1) as usize].join(" | ")
        ),
    ];
    for row in start.0..=end.0 {
        let values = (start.1..=end.1)
            .map(|column| {
                sheet
                    .cells
                    .get(&(row, column))
                    .map(|v| inert_cell(&v.words()))
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        lines.push(format!("| {} | {} |", row + 1, values.join(" | ")));
    }
    lines.join("\n")
}
pub fn capture_markdown(document: &Document, limits: Limits) -> (String, bool) {
    let mut chunks = Vec::new();
    match document {
        Document::Word(blocks) => chunks.extend(blocks.iter().map(|b| block_markdown(b, limits))),
        Document::Presentation(slides) => {
            for (index, slide) in slides.iter().enumerate() {
                chunks.push(format!(
                    "## Slide {}: {}{}",
                    index + 1,
                    inert_line(&slide.title),
                    if slide.hidden { " (hidden)" } else { "" }
                ));
                chunks.extend(slide.blocks.iter().map(|b| block_markdown(b, limits)));
                if !slide.notes.is_empty() {
                    chunks.push(format!(
                        "### Notes\n\n{}",
                        slide
                            .notes
                            .lines()
                            .map(inert_line)
                            .collect::<Vec<_>>()
                            .join("\n")
                    ));
                }
            }
        }
        Document::Workbook(sheets) => {
            for sheet in sheets.iter().take(limits.capture_sheets) {
                chunks.push(format!(
                    "## Sheet: {}{}",
                    inert_line(&sheet.name),
                    if sheet.hidden { " (hidden)" } else { "" }
                ));
                let Some((start, last)) = sheet.used else {
                    chunks.push("Used range: none; the sheet is empty.".into());
                    continue;
                };
                chunks.push(format!("Used range: {}.", xlsx::range_name(sheet.used)));
                let end = (
                    last.0.min(
                        start
                            .0
                            .saturating_add(limits.capture_rows.saturating_sub(1) as u32),
                    ),
                    last.1.min(
                        start
                            .1
                            .saturating_add(limits.capture_columns.saturating_sub(1) as u32),
                    ),
                );
                chunks.push(sheet_markdown(sheet, start, end));
                if end != last {
                    let rows =
                        (end.0 < last.0).then(|| format!("Rows {}–{}", end.0 + 2, last.0 + 1));
                    let columns = (end.1 < last.1).then(|| {
                        format!(
                            "columns {}–{}",
                            xlsx::column_name(end.1 + 1),
                            xlsx::column_name(last.1)
                        )
                    });
                    let omitted = [rows, columns]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" and ");
                    chunks.push(format!(
                        "{omitted} are not shown here; the original has them."
                    ));
                }
                if !sheet.formulas.is_empty() {
                    chunks.push("Formulas show their last calculated value.".into());
                }
            }
            if sheets.len() > limits.capture_sheets {
                chunks.push(format!(
                    "Sheets {}–{} stay in the original.",
                    limits.capture_sheets + 1,
                    sheets.len()
                ));
            }
        }
    }
    let mut out = String::new();
    let mut truncated = false;
    for chunk in chunks.into_iter().filter(|c| !c.is_empty()) {
        let separator = if out.is_empty() { 0 } else { 2 };
        if out
            .len()
            .saturating_add(separator)
            .saturating_add(chunk.len())
            > limits.capture_bytes
        {
            truncated = true;
            break;
        }
        if separator > 0 {
            out.push_str("\n\n");
        }
        out.push_str(&chunk);
    }
    if truncated {
        let words = "The text stops at 1 MB; the rest is in the original.";
        // Never split a generated block to make room for a diagnostic.
        if out.len() + words.len() + 2 <= limits.capture_bytes {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(words);
        }
    } else if out.is_empty() {
        out = "No text found in this document.".into();
    }
    (out, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::extract::{self, testdocs, Format};
    fn goldens() -> serde_json::Value {
        let mut out = serde_json::Map::new();
        for (format, bytes) in [
            (Format::Docx, testdocs::docx()),
            (Format::Pptx, testdocs::pptx()),
            (Format::Xlsx, testdocs::xlsx()),
        ] {
            let doc = extract::open(bytes, format, Limits::SHIPPED).unwrap();
            let (markdown, truncated) = capture_markdown(&doc.document, Limits::SHIPPED);
            out.insert(format.extension().into(),serde_json::json!({"markdown":markdown,"not_carried":doc.not_carried,"truncated":truncated}));
        }
        out.into()
    }
    #[test]
    fn inert_text_replays_the_shared_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/extract-escape.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let expected = case["expected"].as_str().unwrap();
            assert_eq!(inert_line(input), expected);
            assert_eq!(inert_cell(input), expected);
        }
    }
    #[test]
    fn capture_markdown_matches_its_goldens() {
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/extract-captures.json")).unwrap();
        assert_eq!(goldens(), expected);
        assert_eq!(goldens(), goldens(), "deterministic captures");
    }
    #[test]
    #[ignore = "deliberately regenerate Office capture goldens after reviewing reader changes"]
    fn write_capture_goldens() {
        std::fs::write(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/extract-captures.json"),
            format!("{}\n", serde_json::to_string_pretty(&goldens()).unwrap()),
        )
        .unwrap();
    }
    #[test]
    fn capture_stops_on_a_whole_block_and_says_so() {
        let document = Document::Word(vec![
            Block::Paragraph {
                runs: vec![Inline::text("First")],
            },
            Block::Paragraph {
                runs: vec![Inline::text("X".repeat(200))],
            },
        ]);
        let (md, cut) = capture_markdown(
            &document,
            Limits {
                capture_bytes: 100,
                ..Limits::SHIPPED
            },
        );
        assert!(cut);
        assert!(md.starts_with("First\n\n"));
        assert!(md.contains("rest is in the original"));
        assert!(!md.contains('X'));
    }
    #[test]
    fn lists_number_from_their_start() {
        let doc = extract::open(testdocs::docx(), Format::Docx, Limits::SHIPPED).unwrap();
        let (md, _) = capture_markdown(&doc.document, Limits::SHIPPED);
        assert!(md.contains("4. First"));
        assert!(md.contains("5. Second"));
    }
    #[test]
    fn workbook_omissions_name_only_the_axis_that_was_cut() {
        for (last, expected, absent) in [
            ((299, 0), "Rows 201–300", "columns"),
            ((0, 25), "columns U–Z", "Rows"),
        ] {
            let sheet = Sheet {
                name: "Data".into(),
                hidden: false,
                used: Some(((0, 0), last)),
                cells: Default::default(),
                formulas: Default::default(),
                merges: vec![],
            };
            let (md, _) = capture_markdown(&Document::Workbook(vec![sheet]), Limits::SHIPPED);
            assert!(md.contains(expected), "{md}");
            assert!(!md.contains(absent), "{md}");
        }
    }
}
