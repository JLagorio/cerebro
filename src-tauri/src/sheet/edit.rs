//! Checked source-only sheet operations. The page writer owns the lock and
//! stale comparison; this planner returns complete bytes or one refusal.
//! sheet-edit-cases.json holds this contract to engine/sheet/edit.ts.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::ai::parse_address;
use super::engine::{self, SheetCellSource, SheetInput};
use super::fence::{read_fences, SheetFence};
use crate::vault::parse::split_frontmatter;

pub const MAX_OPS: usize = 25;
pub const MAX_CELLS: usize = 2_000;
pub const MAX_NAME_CHARS: usize = 31;
pub const SUFFIX: &str = "\nNothing was written.";

#[derive(Clone, Debug)]
pub struct Request {
    pub path: String,
    pub ops: Vec<Value>,
    pub expect_hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WrittenCell {
    pub sheet: String,
    pub row: i32,
    pub col: i32,
}

#[derive(Debug)]
pub struct EditPlan {
    pub body: String,
    pub before: Vec<SheetInput>,
    pub after: Vec<SheetInput>,
    pub written: Vec<WrittenCell>,
    pub ops: Vec<String>,
}

fn refuse(words: impl AsRef<str>) -> String {
    format!("{}{SUFFIX}", words.as_ref())
}

pub fn parse_request(args: &Map<String, Value>) -> Result<Request, String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .ok_or("edit_sheet needs a path")?;
    let ops = args
        .get("ops")
        .and_then(Value::as_array)
        .ok_or("edit_sheet needs `ops`, a list of operations")?;
    Ok(Request {
        path: path.into(),
        ops: ops.clone(),
        expect_hash: args
            .get("expect_hash")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && !name.contains(['\\', '/', '*', '?', ':', '[', ']'])
}

/// Canonical records preserve blank intermediate rows, strip trailing empty
/// cells, and quote a lone --- so it cannot become a header delimiter.
pub fn encode_records(cells: &[SheetCellSource], eol: &str) -> String {
    let filled: Vec<_> = cells
        .iter()
        .filter(|cell| !cell.source.is_empty())
        .collect();
    let count = filled.iter().map(|cell| cell.row).max().unwrap_or(0) as usize;
    let mut rows: Vec<Vec<&str>> = vec![vec![]; count];
    for cell in filled {
        let row = &mut rows[cell.row as usize - 1];
        row.resize(row.len().max(cell.col as usize), "");
        row[cell.col as usize - 1] = &cell.source;
    }
    let mut text = String::new();
    for row in rows {
        if row.len() == 1 && row[0] == "---" {
            text.push_str("\"---\"");
        } else {
            text.push_str(
                &row.into_iter()
                    .map(|value| {
                        if value.contains(['"', ',', '\r', '\n']) {
                            format!("\"{}\"", value.replace('"', "\"\""))
                        } else {
                            value.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        text.push_str(eol);
    }
    text
}

pub fn write_fence(body: &str, fence: &SheetFence, cells: &[SheetCellSource]) -> String {
    let opening = &body[fence.span[0]..fence.content_span[0]];
    let closing = &body[fence.content_span[1]..fence.span[1]];
    let eol = if opening.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let (header, records) = split_frontmatter(&fence.source);
    let prefix = &fence.source[..fence.source.len() - records.len()];
    let ending = if header.is_some() && !prefix.ends_with('\n') {
        eol
    } else {
        ""
    };
    format!(
        "{opening}{prefix}{ending}{}{closing}",
        encode_records(cells, eol)
    )
}

fn yaml_name(name: &str) -> String {
    if serde_yaml::from_str::<serde_yaml::Value>(name)
        .is_ok_and(|value| value == serde_yaml::Value::String(name.into()))
    {
        name.into()
    } else {
        json!(name).to_string()
    }
}
pub(super) fn new_fence(sheet: &SheetInput, eol: &str) -> String {
    format!(
        "```cerebro-sheet{eol}---{eol}format: 1{eol}name: {}{eol}---{eol}{}```{eol}",
        yaml_name(&sheet.name),
        encode_records(&sheet.cells, eol)
    )
}
fn normalize(sheets: &mut [SheetInput]) {
    for sheet in sheets {
        sheet.cells.sort_by_key(|cell| (cell.row, cell.col));
    }
}

pub fn plan(body: &str, request: &Request) -> Result<EditPlan, String> {
    let fences = read_fences(body);
    if let Some(fence) = fences.iter().find(|fence| fence.parsed.problem().is_some()) {
        return Err(refuse(format!(
            "The sheet block on body line {} can't be read ({}). Fix it first.",
            fence.line,
            fence.parsed.problem().unwrap()
        )));
    }
    if request.ops.is_empty() {
        return Err(refuse("edit_sheet needs at least one op."));
    }
    if request.ops.len() > MAX_OPS {
        return Err(refuse(format!(
            "edit_sheet takes at most 25 ops in one call; this call has {}.",
            request.ops.len()
        )));
    }
    let count: usize = request
        .ops
        .iter()
        .filter_map(|op| op.get("cells").and_then(Value::as_array))
        .map(Vec::len)
        .sum();
    if count > MAX_CELLS {
        return Err(refuse(format!("One edit_sheet call changes at most 2,000 cells; this one names {count}. Split it into smaller calls.")));
    }
    let mut before: Vec<_> = fences.iter().filter_map(SheetFence::input).collect();
    let mut after = before.clone();
    let mut touched = BTreeSet::new();
    let mut written = Vec::new();
    let mut descriptions = Vec::new();
    for (index, op) in request.ops.iter().enumerate() {
        let number = index + 1;
        match op.get("op").and_then(Value::as_str) {
            Some("add_sheet") => {
                let name = op
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| refuse(format!("Op {number}: add_sheet needs `name`.")))?;
                if !name_valid(name) {
                    return Err(refuse(format!("Op {number}: {} can't name a sheet. Use 1 to 31 characters, none of \\ / * ? : [ ].",json!(name))));
                }
                if let Some(existing) = after
                    .iter()
                    .find(|sheet| sheet.name.to_uppercase() == name.to_uppercase())
                {
                    return Err(refuse(format!(
                        "Op {number}: the page already has a sheet named {}.",
                        json!(existing.name)
                    )));
                }
                after.push(SheetInput {
                    name: name.into(),
                    cells: vec![],
                });
                touched.insert(after.len() - 1);
                descriptions.push(format!("Added the sheet {name}."));
            }
            Some("set_cells") => {
                let shape = || {
                    refuse(format!("Op {number}: set_cells needs `sheet` and `cells`, a list of {{address, value}}."))
                };
                let name = op.get("sheet").and_then(Value::as_str).ok_or_else(shape)?;
                let cells = op
                    .get("cells")
                    .and_then(Value::as_array)
                    .ok_or_else(shape)?;
                let sheet_index = after
                    .iter()
                    .position(|sheet| sheet.name.to_uppercase() == name.to_uppercase())
                    .ok_or_else(|| {
                        refuse(format!(
                            "Op {number}: no sheet named {} on this page. Its sheets: {}.",
                            json!(name),
                            json!(after.iter().map(|sheet| &sheet.name).collect::<Vec<_>>())
                        ))
                    })?;
                let sheet = &mut after[sheet_index];
                let mut used = BTreeSet::new();
                for cell in cells {
                    let raw = cell.get("address").unwrap_or(&Value::Null);
                    let address = parse_address(raw.as_str().unwrap_or("")).map_err(|_|refuse(format!("Op {number}: {raw} is not a cell address. Use A1-style addresses without a sheet name.")))?;
                    let label = address.text();
                    if address.row > engine::SHEET_MAX_ROWS
                        || address.col > engine::SHEET_MAX_COLUMNS
                    {
                        return Err(refuse(format!("Op {number}: {label} is past the 500 rows and 26 columns a sheet can hold.")));
                    }
                    if !used.insert((address.row, address.col)) {
                        return Err(refuse(format!(
                            "Op {number}: {label} appears twice in this op."
                        )));
                    }
                    let value = cell.get("value").and_then(Value::as_str).ok_or_else(||refuse(format!("Op {number}: the value for {label} must be text, as you would type it into the cell.")))?;
                    if value.chars().count() > engine::SHEET_MAX_CELL_CHARS {
                        return Err(refuse(format!(
                            "Op {number}: the value for {label} is longer than 10,000 characters."
                        )));
                    }
                    if value
                        .chars()
                        .any(|ch| ch <= '\u{1f}' && !matches!(ch, '\t' | '\r' | '\n'))
                    {
                        return Err(refuse(format!("Op {number}: the value for {label} holds a control character a page can't carry.")));
                    }
                    let value = value.replace("\r\n", "\n").replace('\r', "\n");
                    if value.lines().any(|line| {
                        let leading = line.bytes().take_while(|ch| *ch == b' ').count();
                        leading <= 3
                            && (line[leading..].starts_with("```")
                                || line[leading..].starts_with("~~~"))
                    }) {
                        return Err(refuse(format!("Op {number}: the value for {label} has a line starting with ``` or ~~~, which would end the sheet block.")));
                    }
                    sheet
                        .cells
                        .retain(|cell| cell.row != address.row || cell.col != address.col);
                    if !value.is_empty() {
                        sheet.cells.push(SheetCellSource {
                            row: address.row,
                            col: address.col,
                            source: value,
                        });
                    }
                    let cell = WrittenCell {
                        sheet: sheet.name.clone(),
                        row: address.row,
                        col: address.col,
                    };
                    if !written.contains(&cell) {
                        written.push(cell);
                    }
                }
                touched.insert(sheet_index);
                descriptions.push(format!(
                    "Set {} {} on {}.",
                    cells.len(),
                    if cells.len() == 1 { "cell" } else { "cells" },
                    sheet.name
                ));
            }
            _ => {
                return Err(refuse(format!(
                    "Op {number}: `op` must be set_cells or add_sheet."
                )))
            }
        }
    }
    let mut held = BTreeSet::new();
    for sheet in &after {
        let problem = if !name_valid(&sheet.name) {
            Some(format!(
                "\"{}\" can't name a sheet. Use 1 to 31 characters, none of \\ / * ? : [ ].",
                sheet.name
            ))
        } else if held.contains(&sheet.name.to_uppercase()) {
            Some(format!(
                "Another sheet on this page is already named \"{}\".",
                sheet.name
            ))
        } else {
            engine::sheet_problem(sheet)
        };
        if let Some(problem) = problem {
            return Err(refuse(format!(
                "The sheets couldn't be computed ({problem})."
            )));
        }
        held.insert(sheet.name.to_uppercase());
    }
    engine::check_workbook(&after)
        .map_err(|problem| refuse(format!("The sheets couldn't be computed ({problem}).")))?;
    let mut planned = body.to_string();
    for (index, fence) in fences.iter().enumerate().rev() {
        if touched.contains(&index) {
            planned.replace_range(
                fence.span[0]..fence.span[1],
                &write_fence(body, fence, &after[index].cells),
            );
        }
    }
    let eol = if body.contains("\r\n") { "\r\n" } else { "\n" };
    for sheet in &after[fences.len()..] {
        if !planned.is_empty() && !planned.ends_with(&format!("{eol}{eol}")) {
            planned.push_str(if planned.ends_with(eol) {
                eol
            } else if eol == "\r\n" {
                "\r\n\r\n"
            } else {
                "\n\n"
            });
        }
        planned.push_str(&new_fence(sheet, eol));
    }
    let reread = read_fences(&planned);
    let mut roundtrip: Vec<_> = reread.iter().filter_map(SheetFence::input).collect();
    normalize(&mut roundtrip);
    normalize(&mut before);
    normalize(&mut after);
    if reread.iter().any(|fence| fence.parsed.problem().is_some()) || roundtrip != after {
        return Err(refuse("The edited page would not read back as the same sheets (an unclosed fence above them?)."));
    }
    Ok(EditPlan {
        body: planned,
        before,
        after,
        written,
        ops: descriptions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cases() -> Value {
        serde_json::from_str(include_str!("../../fixtures/sheet-edit-cases.json")).unwrap()
    }
    #[test]
    fn replays_the_shared_sheet_edit_cases() {
        for row in cases()["cases"].as_array().unwrap() {
            let body = row["page"].as_str().unwrap();
            let outcome = parse_request(row["args"].as_object().unwrap())
                .and_then(|request| plan(body, &request));
            if let Some(refusal) = row.get("refusal") {
                assert_eq!(
                    outcome.unwrap_err(),
                    refusal.as_str().unwrap(),
                    "{}",
                    row["name"]
                );
            } else {
                let result = outcome.unwrap_or_else(|error| panic!("{}: {error}", row["name"]));
                assert_eq!(
                    result.body,
                    row["after"].as_str().unwrap(),
                    "{}",
                    row["name"]
                );
                assert_eq!(
                    result.body != body,
                    row["written"].as_bool().unwrap(),
                    "{}",
                    row["name"]
                );
            }
        }
    }
    #[test]
    fn limits_are_the_cases_limits() {
        assert_eq!(
            cases()["limits"],
            json!({"ops":MAX_OPS,"cells":MAX_CELLS,"cell_chars":engine::SHEET_MAX_CELL_CHARS,"sheet_name_chars":MAX_NAME_CHARS,"max_row":engine::SHEET_MAX_ROWS,"max_column":engine::SHEET_MAX_COLUMNS})
        );
    }
}
