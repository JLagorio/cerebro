//! Source-only sheet fences. The TypeScript reader is engine/sheet/fence.ts;
//! sheet-fence-cases.json holds their CSV, header and CommonMark boundary
//! contract. Byte spans refer to the original body, never normalized text.

use serde::Serialize;
use serde_yaml::Value;

use super::engine::{SheetCellSource, SheetInput};
use crate::vault::parse::split_frontmatter;

pub const SHEET_FENCE: &str = "cerebro-sheet";
const CSV_MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SheetGrid {
    pub ok: bool,
    pub name: String,
    pub cells: Vec<SheetCellSource>,
    pub rows: usize,
    pub cols: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FenceProblem {
    pub ok: bool,
    pub reason: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ParsedFence {
    Ready(SheetGrid),
    Unavailable(FenceProblem),
}

impl ParsedFence {
    pub fn grid(&self) -> Option<&SheetGrid> {
        match self {
            Self::Ready(grid) => Some(grid),
            Self::Unavailable(_) => None,
        }
    }

    pub fn problem(&self) -> Option<&str> {
        match self {
            Self::Ready(_) => None,
            Self::Unavailable(problem) => Some(&problem.message),
        }
    }
}

fn unavailable(reason: &'static str, message: impl Into<String>) -> ParsedFence {
    ParsedFence::Unavailable(FenceProblem {
        ok: false,
        reason,
        message: message.into(),
    })
}

fn header_problem() -> ParsedFence {
    unavailable("header", "This sheet's header isn't key: value lines.")
}

fn number_text(value: &serde_yaml::Number) -> String {
    if let Some(value) = value.as_i64() {
        value.to_string()
    } else if let Some(value) = value.as_u64() {
        value.to_string()
    } else {
        let value = value.as_f64().unwrap_or(f64::NAN);
        if value.is_nan() {
            "NaN".into()
        } else if value == f64::INFINITY {
            "Infinity".into()
        } else if value == f64::NEG_INFINITY {
            "-Infinity".into()
        } else {
            value.to_string()
        }
    }
}

/// Raw RFC 4180 records, without database headers, padding or trimming.
/// Quoted line endings normalize to LF; error rows count CSV records.
fn read_records(source: &str) -> Result<Vec<Vec<String>>, String> {
    if source.len() > CSV_MAX_BYTES {
        return Err("Choose a CSV smaller than 16 MB.".into());
    }
    let text = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut chars = text.chars().peekable();
    let mut records = Vec::new();
    let mut values = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut after_quote = false;
    let mut dirty = false;
    while let Some(ch) = chars.next() {
        dirty = true;
        let row = records.len() + 1;
        if ch == '\0' {
            return Err(format!("Row {row} holds a NUL character."));
        }
        if quoted {
            match ch {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => {
                    quoted = false;
                    after_quote = true;
                }
                '\r' => {
                    field.push('\n');
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                }
                _ => field.push(ch),
            }
            continue;
        }
        match ch {
            ',' => {
                values.push(std::mem::take(&mut field));
                after_quote = false;
            }
            '\n' | '\r' => {
                if ch == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                values.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut values));
                after_quote = false;
                dirty = false;
            }
            _ if after_quote => {
                return Err(format!("Row {row}: text follows a closing quote."));
            }
            '"' if field.is_empty() => quoted = true,
            _ => field.push(ch),
        }
    }
    if quoted {
        return Err(format!(
            "Row {}: a quote is never closed.",
            records.len() + 1
        ));
    }
    if dirty || !values.is_empty() || !field.is_empty() {
        values.push(field);
        records.push(values);
    }
    Ok(records)
}

pub fn parse_sheet_fence(source: &str) -> ParsedFence {
    let (header, body) = split_frontmatter(source);
    let mut name = String::new();
    if let Some(header) = header {
        let Ok(Value::Mapping(fields)) = serde_yaml::from_str::<Value>(header) else {
            return header_problem();
        };
        if let Some(value) = fields.get("format") {
            let Value::Number(value) = value else {
                return unavailable("format", "This sheet's format: isn't a number.");
            };
            if value.as_f64() != Some(1.0) {
                return unavailable(
                    "format",
                    format!(
                        "This sheet says format {}. Cerebro reads format 1.",
                        number_text(value)
                    ),
                );
            }
        }
        if let Some(value) = fields.get("name") {
            name = match value {
                Value::String(value) => value.clone(),
                Value::Number(value) => number_text(value),
                _ => return unavailable("header", "This sheet's name: must be text."),
            };
        }
    }
    let mut records = match read_records(body) {
        Ok(records) => records,
        Err(message) => return unavailable("csv", message),
    };
    while records
        .last()
        .is_some_and(|row| row.len() == 1 && row[0].is_empty())
    {
        records.pop();
    }
    let rows = records.len();
    let cols = records.iter().map(Vec::len).max().unwrap_or(0);
    let mut cells = Vec::new();
    for (row, record) in records.into_iter().enumerate() {
        for (col, source) in record.into_iter().enumerate() {
            if !source.is_empty() {
                cells.push(SheetCellSource {
                    row: row as i32 + 1,
                    col: col as i32 + 1,
                    source,
                });
            }
        }
    }
    ParsedFence::Ready(SheetGrid {
        ok: true,
        name,
        cells,
        rows,
        cols,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetFence {
    /// Entire fence, including line endings, as a half-open byte interval.
    pub span: [usize; 2],
    /// Its first line, one-based in the page body (frontmatter excluded).
    pub line: usize,
    /// Content lines, inclusive. An empty fence has an end before its start.
    pub body_lines: [usize; 2],
    /// Raw content bytes between the opening and closing lines.
    pub content_span: [usize; 2],
    /// The editor's source prop: content with its delimiter newline removed.
    pub source: String,
    /// Positional names count unavailable fences too.
    pub name: String,
    pub parsed: ParsedFence,
}

impl SheetFence {
    pub fn input(&self) -> Option<SheetInput> {
        self.parsed.grid().map(|grid| SheetInput {
            name: self.name.clone(),
            cells: grid.cells.clone(),
        })
    }
}

fn opening(line: &str) -> Option<(u8, usize, &str)> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let indent = line.bytes().take_while(|ch| *ch == b' ').count();
    if indent > 3 {
        return None;
    }
    let text = &line[indent..];
    let marker = *text.as_bytes().first()?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let length = text.bytes().take_while(|ch| *ch == marker).count();
    if length < 3 {
        return None;
    }
    let info = &text[length..];
    if marker == b'`' && info.contains('`') {
        return None;
    }
    Some((marker, length, info.split_whitespace().next().unwrap_or("")))
}

fn closes(line: &str, marker: u8, length: usize) -> bool {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let indent = line.bytes().take_while(|ch| *ch == b' ').count();
    if indent > 3 {
        return false;
    }
    let text = &line[indent..];
    let count = text.bytes().take_while(|ch| *ch == marker).count();
    count >= length && text[count..].bytes().all(|ch| ch == b' ' || ch == b'\t')
}

/// Read every sheet in page order, skipping the contents of all other fenced
/// code. An unclosed sheet is preserved as unavailable, never an empty grid.
pub fn read_fences(body: &str) -> Vec<SheetFence> {
    let lines: Vec<_> = body.split_inclusive('\n').collect();
    let mut offsets = Vec::with_capacity(lines.len() + 1);
    offsets.push(0);
    for line in &lines {
        offsets.push(offsets.last().copied().unwrap_or(0) + line.len());
    }
    let mut fences = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let Some((marker, length, language)) = opening(lines[at].trim_end_matches('\n')) else {
            at += 1;
            continue;
        };
        let close = ((at + 1)..lines.len())
            .find(|line| closes(lines[*line].trim_end_matches('\n'), marker, length));
        let end = close.unwrap_or(lines.len());
        if language == SHEET_FENCE {
            let start = offsets[at + 1];
            let content_end = offsets[end];
            let raw = &body[start..content_end];
            let source = if close.is_some() {
                raw.strip_suffix("\r\n")
                    .or_else(|| raw.strip_suffix('\n'))
                    .unwrap_or(raw)
            } else {
                raw
            }
            .to_string();
            let parsed = if close.is_some() {
                parse_sheet_fence(&source)
            } else {
                unavailable("header", "This sheet block has no closing fence.")
            };
            let name = parsed
                .grid()
                .filter(|grid| !grid.name.is_empty())
                .map_or_else(
                    || format!("Sheet{}", fences.len() + 1),
                    |grid| grid.name.clone(),
                );
            fences.push(SheetFence {
                span: [offsets[at], offsets[close.map_or(end, |line| line + 1)]],
                line: at + 1,
                body_lines: [at + 2, end],
                content_span: [start, content_end],
                source,
                name,
                parsed,
            });
        }
        at = close.map_or(lines.len(), |line| line + 1);
    }
    fences
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn replays_the_shared_fence_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../fixtures/sheet-fence-cases.json")).unwrap();
        for case in cases["fences"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(parse_sheet_fence(case["source"].as_str().unwrap())).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
        for case in cases["pages"].as_array().unwrap() {
            let body = case["sources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|source| format!("```cerebro-sheet\n{}\n```\n", source.as_str().unwrap()))
                .collect::<Vec<_>>()
                .join("\n");
            let fences = read_fences(&body);
            assert_eq!(
                serde_json::to_value(fences.iter().map(|fence| &fence.name).collect::<Vec<_>>())
                    .unwrap(),
                case["names"]
            );
            assert_eq!(
                serde_json::to_value(
                    fences
                        .iter()
                        .enumerate()
                        .filter_map(|(index, fence)| fence.input().map(|_| index))
                        .collect::<Vec<_>>()
                )
                .unwrap(),
                case["slots"]
            );
        }
        for case in cases["bodies"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(read_fences(case["body"].as_str().unwrap())).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
    }
}
