//! Read-only sheet answers and private what-if workbooks. Cell strings are
//! always JSON data. Every path which evaluates IronCalc takes the engine
//! thread token; neither this module nor its callers writes a page.

use std::collections::{BTreeMap, BTreeSet};

use ironcalc_base::cell::CellValue;
use ironcalc_base::expressions::lexer::util::get_tokens;
use ironcalc_base::expressions::token::TokenType;
use ironcalc_base::types::CellType;
use serde_json::{json, Map, Value};

use super::engine::{
    self, EngineThread, SheetCellSource, SheetComputed, SheetInput, SheetResult, Workbook,
};
use super::fence::{read_fences, SheetFence};

pub const READ_MAX_CELLS: usize = 500;
pub const READ_MAX_BYTES: usize = 100_000;
pub const READ_MAX_RANGES: usize = 20;
pub const CALC_MAX_FORMULAS: usize = 20;
pub const CALC_MAX_OVERRIDE_CELLS: usize = 2_000;
pub const CALC_MAX_BYTES: usize = 100_000;
pub const INLINE_MAX_BYTES: usize = 4_096;
const READ_CUT: &str =
    "Only the first 500 cells or 100,000 bytes came back. Read smaller ranges for the rest.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Address {
    pub row: i32,
    pub col: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressError {
    Invalid,
    Bounds,
}

pub fn column_label(mut col: i32) -> String {
    let mut result = String::new();
    while col > 0 {
        result.insert(0, char::from(b'A' + ((col - 1) % 26) as u8));
        col = (col - 1) / 26;
    }
    result
}

impl Address {
    pub fn text(self) -> String {
        format!("{}{}", column_label(self.col), self.row)
    }
}

pub fn parse_address(text: &str) -> Result<Address, AddressError> {
    let text = text.trim().strip_prefix('$').unwrap_or(text.trim());
    let letters = text.bytes().take_while(u8::is_ascii_alphabetic).count();
    if letters == 0 {
        return Err(AddressError::Invalid);
    }
    let digits = text[letters..]
        .strip_prefix('$')
        .unwrap_or(&text[letters..]);
    if digits.is_empty() || !digits.bytes().all(|ch| ch.is_ascii_digit()) {
        return Err(AddressError::Invalid);
    }
    let row: u64 = digits.parse().map_err(|_| AddressError::Bounds)?;
    let col = text[..letters]
        .bytes()
        .try_fold(0_u64, |n, ch| {
            n.checked_mul(26)
                .and_then(|n| n.checked_add(u64::from(ch.to_ascii_uppercase() - b'A' + 1)))
        })
        .ok_or(AddressError::Bounds)?;
    if row == 0 {
        return Err(AddressError::Invalid);
    }
    if row > 1_048_576 || col > 16_384 {
        return Err(AddressError::Bounds);
    }
    Ok(Address {
        row: row as i32,
        col: col as i32,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub first: Address,
    pub last: Address,
}

impl Range {
    pub fn text(self) -> String {
        if self.first == self.last {
            self.first.text()
        } else {
            format!("{}:{}", self.first.text(), self.last.text())
        }
    }
    fn contains(self, row: i32, col: i32) -> bool {
        row >= self.first.row
            && row <= self.last.row
            && col >= self.first.col
            && col <= self.last.col
    }
}

pub fn parse_range(text: &str) -> Result<Range, AddressError> {
    let parts: Vec<_> = text.split(':').collect();
    if parts.len() > 2 {
        return Err(AddressError::Invalid);
    }
    let first = parse_address(parts[0])?;
    let last = parse_address(parts.get(1).copied().unwrap_or(parts[0]))?;
    Ok(Range {
        first: Address {
            row: first.row.min(last.row),
            col: first.col.min(last.col),
        },
        last: Address {
            row: first.row.max(last.row),
            col: first.col.max(last.col),
        },
    })
}

fn used_range(sheet: &SheetComputed) -> Option<Range> {
    (sheet.rows > 0 && sheet.cols > 0).then_some(Range {
        first: Address { row: 1, col: 1 },
        last: Address {
            row: sheet.rows,
            col: sheet.cols,
        },
    })
}

fn unknown_sheet(path: &str, name: &str, names: &[String]) -> String {
    format!(
        "No sheet named {} on {path}. Its sheets: {}.",
        json!(name),
        json!(names)
    )
}

fn cell_value(workbook: &Workbook<'_>, sheet: u32, address: Address) -> Result<Value, String> {
    let display = workbook
        .model
        .get_formatted_cell_value(sheet, address.row, address.col)?;
    let kind = workbook
        .model
        .get_cell_type(sheet, address.row, address.col)?;
    if kind == CellType::ErrorValue {
        return Ok(json!({"type":"error","value":null,"display":display,"error":display}));
    }
    let (kind, value) =
        match workbook
            .model
            .get_model()
            .get_cell_value_by_index(sheet, address.row, address.col)?
        {
            CellValue::None => ("blank", Value::Null),
            CellValue::Number(number) => ("number", json!(number)),
            CellValue::Boolean(value) => ("boolean", json!(value)),
            CellValue::String(value) => ("text", json!(value)),
        };
    Ok(json!({"type":kind,"value":value,"display":display}))
}

fn read_cell(workbook: &Workbook<'_>, sheet: usize, row: i32, col: i32) -> Result<Value, String> {
    let address = Address { row, col };
    let mut value = cell_value(workbook, sheet as u32, address)?;
    value["address"] = json!(address.text());
    value["source"] = json!(workbook.sources[sheet]
        .cells
        .iter()
        .find(|cell| cell.row == row && cell.col == col)
        .map_or("", |cell| cell.source.as_str()));
    Ok(value)
}

fn compute_error(path: &str, reason: &str, verb: &str) -> String {
    format!("The sheets on {path} couldn't be computed ({reason}), so nothing was {verb}.")
}

pub fn read(
    thread: &EngineThread,
    path: &str,
    hash: &str,
    body: &str,
    args: &Map<String, Value>,
    zone: &str,
) -> Result<Value, String> {
    if args.get("sheet").is_some_and(|value| !value.is_string()) {
        return Err("`sheet` must be a sheet's name.".into());
    }
    let fences = read_fences(body);
    if fences.is_empty() {
        return Ok(
            json!({"path":path,"hash":hash,"sheets":[],"ranges":[],"warnings":[format!("{path} holds no sheet.")]}),
        );
    }
    let inputs: Vec<_> = fences.iter().filter_map(SheetFence::input).collect();
    let workbook = engine::build_model(thread, &inputs, zone)
        .map_err(|reason| compute_error(path, &reason, "read"))?;
    let results =
        engine::read_results(&workbook).map_err(|reason| compute_error(path, &reason, "read"))?;
    let mut summaries = Vec::new();
    let mut index = 0;
    for fence in &fences {
        if let Some(problem) = fence.parsed.problem() {
            summaries
                .push(json!({"name":null,"line":fence.line,"unavailable":problem.to_string()}));
            continue;
        }
        match &results[index] {
            SheetResult::Unavailable(problem) => summaries
                .push(json!({"name":fence.name,"line":fence.line,"unavailable":problem.message})),
            SheetResult::Ready(sheet) => {
                let formulas = inputs[index]
                    .cells
                    .iter()
                    .filter(|cell| {
                        workbook
                            .model
                            .get_model()
                            .get_cell_formula(index as u32, cell.row, cell.col)
                            .ok()
                            .flatten()
                            .is_some()
                    })
                    .count();
                summaries.push(json!({"name":sheet.name,"line":fence.line,"used_range":used_range(sheet).map(Range::text),"filled":inputs[index].cells.len(),"formula_cells":formulas,"error_cells":sheet.cells.iter().filter(|cell| cell.kind == engine::CellKind::Error).count()}));
            }
        }
        index += 1;
    }
    let chosen = if let Some(name) = args.get("sheet").and_then(Value::as_str) {
        let names = fences
            .iter()
            .map(|fence| fence.name.clone())
            .collect::<Vec<_>>();
        if let Some(fence) = fences.iter().find(|fence| {
            fence.name.to_uppercase() == name.to_uppercase() && fence.parsed.problem().is_some()
        }) {
            return Err(compute_error(path, fence.parsed.problem().unwrap(), "read"));
        }
        let found = inputs
            .iter()
            .position(|sheet| sheet.name.to_uppercase() == name.to_uppercase())
            .ok_or_else(|| unknown_sheet(path, name, &names))?;
        match &results[found] {
            SheetResult::Ready(_) => Some(found),
            SheetResult::Unavailable(problem) => {
                return Err(compute_error(path, &problem.message, "read"))
            }
        }
    } else {
        results
            .iter()
            .position(|result| matches!(result, SheetResult::Ready(_)))
    };
    let Some(chosen) = chosen else {
        let answer = json!({"path":path,"hash":hash,"sheets":summaries,"ranges":[],"warnings":[]});
        if serde_json::to_vec(&answer)
            .map_err(|_| engine::STOPPED)?
            .len()
            > READ_MAX_BYTES
        {
            return Err(compute_error(
                path,
                "the sheet summaries exceed 100,000 bytes",
                "read",
            ));
        }
        return Ok(answer);
    };
    let SheetResult::Ready(sheet) = &results[chosen] else {
        unreachable!()
    };
    let ranges = if let Some(value) = args.get("ranges") {
        let ranges = value
            .as_array()
            .ok_or("`ranges` must be a list of A1 ranges.")?;
        if ranges.len() > READ_MAX_RANGES {
            return Err(format!(
                "`ranges` holds at most 20 ranges; this call has {}.",
                ranges.len()
            ));
        }
        ranges.iter().enumerate().map(|(index, value)| {
            let raw = value.as_str().unwrap_or("");
            parse_range(raw).map_err(|error| match error {
                AddressError::Bounds => format!("Range {}: {raw} reaches past column XFD or row 1048576.", index + 1),
                AddressError::Invalid => format!("Range {}: {value} is not an A1 range. Use A1 or A1:B10 without a sheet name, and name the sheet in `sheet`.", index + 1),
            })
        }).collect::<Result<Vec<_>, _>>()?
    } else {
        vec![used_range(sheet).unwrap_or(Range {
            first: Address { row: 1, col: 1 },
            last: Address { row: 1, col: 1 },
        })]
    };
    let mut answer = json!({"path":path,"hash":hash,"sheets":summaries,"ranges":[],"warnings":[]});
    let empty_ranges = ranges
        .iter()
        .map(|range| json!({"sheet":sheet.name,"range":range.text(),"cells":[],"truncated":false}))
        .collect::<Vec<_>>();
    let mut bytes = serde_json::to_vec(&answer)
        .map_err(|_| engine::STOPPED)?
        .len()
        + READ_CUT.len()
        + serde_json::to_vec(&empty_ranges)
            .map_err(|_| engine::STOPPED)?
            .len()
        + 32;
    if bytes > READ_MAX_BYTES {
        return Err(compute_error(
            path,
            "the sheet summaries exceed 100,000 bytes",
            "read",
        ));
    }
    let mut cells_read = 0;
    let mut cut = false;
    for range in ranges {
        let mut cells = Vec::new();
        let mut truncated = false;
        for cell in sheet
            .cells
            .iter()
            .filter(|cell| range.contains(cell.row, cell.col))
        {
            let value = read_cell(&workbook, chosen, cell.row, cell.col)
                .map_err(|reason| compute_error(path, &reason, "read"))?;
            let length = serde_json::to_vec(&value)
                .map_err(|_| engine::STOPPED)?
                .len()
                + 1;
            if cells_read == READ_MAX_CELLS || bytes + length > READ_MAX_BYTES {
                truncated = true;
                break;
            }
            cells_read += 1;
            bytes += length;
            cells.push(value);
        }
        cut |= truncated;
        let row =
            json!({"sheet":sheet.name,"range":range.text(),"cells":cells,"truncated":truncated});
        answer["ranges"].as_array_mut().unwrap().push(row);
    }
    if cut {
        answer["warnings"] = json!([READ_CUT]);
    }
    Ok(answer)
}

/// Token offsets are character offsets, not UTF-8 bytes. Strings, already
/// qualified references and ranges remain intact; INDIRECT cannot target a
/// private scratch sheet through a string assembled by the formula.
#[derive(Debug, PartialEq, Eq)]
pub struct IndirectReference;

pub fn qualify_scratch(source: &str, sheet: &str) -> Result<String, IndirectReference> {
    let tokens = get_tokens(source);
    for (at, token) in tokens.iter().enumerate() {
        if let TokenType::Ident(name) = &token.token {
            if name.to_uppercase().trim_start_matches("_XLFN.") == "INDIRECT"
                && tokens
                    .get(at + 1)
                    .is_some_and(|token| matches!(token.token, TokenType::LeftParenthesis))
            {
                return Err(IndirectReference);
            }
        }
    }
    let mut chars: Vec<_> = source.chars().collect();
    for token in tokens.into_iter().rev() {
        if matches!(
            token.token,
            TokenType::Reference { sheet: None, .. } | TokenType::Range { sheet: None, .. }
        ) {
            let start = token.start as usize;
            let end = token.end as usize;
            let spaces = chars[start..end]
                .iter()
                .take_while(|ch| ch.is_whitespace())
                .count();
            chars.splice(
                start + spaces..start + spaces,
                format!("'{}'!", sheet.replace('\'', "''")).chars(),
            );
        }
    }
    Ok(chars.into_iter().collect())
}

fn reserve_references(source: &str, names: &mut BTreeSet<String>) {
    for token in get_tokens(source) {
        if let TokenType::Reference {
            sheet: Some(name), ..
        }
        | TokenType::Range {
            sheet: Some(name), ..
        } = token.token
        {
            names.insert(name.to_uppercase());
        }
    }
}

pub fn calculate(
    thread: &EngineThread,
    path: &str,
    hash: &str,
    body: &str,
    args: &Map<String, Value>,
    zone: &str,
) -> Result<Value, String> {
    if args.get("sheet").is_some_and(|value| !value.is_string()) {
        return Err("`sheet` must be a sheet's name.".into());
    }
    let fences = read_fences(body);
    if fences.is_empty() {
        return Err(format!("{path} holds no sheet to calculate against."));
    }
    if let Some(fence) = fences.iter().find(|fence| fence.parsed.problem().is_some()) {
        return Err(format!("The sheet block on body line {} of {path} can't be read ({}), so nothing was calculated.", fence.line, fence.parsed.problem().unwrap()));
    }
    let mut inputs: Vec<_> = fences.iter().filter_map(SheetFence::input).collect();
    let names = inputs
        .iter()
        .map(|sheet| sheet.name.clone())
        .collect::<Vec<_>>();
    let selected = if let Some(name) = args.get("sheet").and_then(Value::as_str) {
        names
            .iter()
            .position(|actual| actual.to_uppercase() == name.to_uppercase())
            .ok_or_else(|| unknown_sheet(path, name, &names))?
    } else {
        0
    };
    let formulas = args
        .get("formulas")
        .and_then(Value::as_array)
        .ok_or("calculate_sheet needs `formulas`, a list of formulas.")?;
    if formulas.is_empty() || formulas.len() > CALC_MAX_FORMULAS {
        return Err(format!(
            "calculate_sheet takes 1 to 20 formulas; this call has {}.",
            formulas.len()
        ));
    }
    let mut qualified = Vec::new();
    let mut reserved = names
        .iter()
        .map(|name| name.to_uppercase())
        .collect::<BTreeSet<_>>();
    for input in &inputs {
        for cell in &input.cells {
            reserve_references(&cell.source, &mut reserved);
        }
    }
    for (index, value) in formulas.iter().enumerate() {
        let shape = || {
            format!(
                "Formula {} must be an object with `formula`, and an optional `label`.",
                index + 1
            )
        };
        let object = value.as_object().ok_or_else(shape)?;
        let formula = object
            .get("formula")
            .and_then(Value::as_str)
            .ok_or_else(shape)?;
        if object.keys().any(|key| key != "formula" && key != "label")
            || object.get("label").is_some_and(|label| !label.is_string())
        {
            return Err(shape());
        }
        if !formula.starts_with('=') {
            return Err(format!("Formula {} must start with =.", index + 1));
        }
        if formula.chars().count() > engine::SHEET_MAX_CELL_CHARS {
            return Err(format!(
                "Formula {} is longer than 10,000 characters.",
                index + 1
            ));
        }
        reserve_references(formula, &mut reserved);
        let text = qualify_scratch(formula, &names[selected]).map_err(|_| format!("Formula {} uses INDIRECT, which scratch formulas don't support. Use direct cell or range references.", index + 1))?;
        qualified.push(text);
    }
    if let Some(value) = args.get("overrides") {
        let overrides = value
            .as_array()
            .ok_or("`overrides` must be a list of hypothetical sheet inputs.")?;
        let count = overrides
            .iter()
            .filter_map(|row| row.get("cells").and_then(Value::as_array))
            .map(Vec::len)
            .sum::<usize>();
        if count > CALC_MAX_OVERRIDE_CELLS {
            return Err(format!(
                "`overrides` sets at most 2,000 cells in one call; this one sets {count}."
            ));
        }
        for (index, value) in overrides.iter().enumerate() {
            let number = index + 1;
            if value.get("sheet").is_some_and(|value| !value.is_string()) {
                return Err(format!(
                    "Override {number}: `sheet` must be a sheet's name."
                ));
            }
            let name = value
                .get("sheet")
                .and_then(Value::as_str)
                .unwrap_or(&names[selected]);
            let sheet = inputs
                .iter_mut()
                .find(|input| input.name.to_uppercase() == name.to_uppercase())
                .ok_or_else(|| unknown_sheet(path, name, &names))?;
            let cells = value
                .get("cells")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    format!("Override {number} needs `cells`, a list of {{address, value}}.")
                })?;
            let mut used = BTreeSet::new();
            for cell in cells {
                let raw = cell.get("address").cloned().unwrap_or(Value::Null);
                let address = parse_address(raw.as_str().unwrap_or("")).map_err(|_| format!("Override {number}: {raw} is not a cell address. Use A1-style addresses without a sheet name."))?;
                let address_text = address.text();
                if address.row > engine::SHEET_MAX_ROWS || address.col > engine::SHEET_MAX_COLUMNS {
                    return Err(format!("Override {number}: {address_text} is past the 500 rows and 26 columns a sheet can hold."));
                }
                if !used.insert((address.row, address.col)) {
                    return Err(format!("Override {number} names {address_text} twice."));
                }
                let source = cell.get("value").and_then(Value::as_str).ok_or_else(|| format!("Override {number}: the value for {address_text} must be text, as you would type it into the cell."))?;
                if source.chars().count() > engine::SHEET_MAX_CELL_CHARS {
                    return Err(format!("Override {number}: the value for {address_text} is longer than 10,000 characters."));
                }
                if source
                    .chars()
                    .any(|ch| ch <= '\u{1f}' && !matches!(ch, '\t' | '\n' | '\r'))
                {
                    return Err(format!("Override {number}: the value for {address_text} holds a control character a page can't carry."));
                }
                let source = source.replace("\r\n", "\n").replace('\r', "\n");
                if source.lines().any(|line| {
                    let leading = line.bytes().take_while(|ch| *ch == b' ').count();
                    leading <= 3
                        && (line[leading..].starts_with("```")
                            || line[leading..].starts_with("~~~"))
                }) {
                    return Err(format!("Override {number}: the value for {address_text} has a line starting with ``` or ~~~, which would end the sheet block."));
                }
                reserve_references(&source, &mut reserved);
                sheet
                    .cells
                    .retain(|cell| cell.row != address.row || cell.col != address.col);
                if !source.is_empty() {
                    sheet.cells.push(SheetCellSource {
                        row: address.row,
                        col: address.col,
                        source,
                    });
                }
            }
        }
    }
    let mut workbook = engine::prepare_model(thread, &inputs, zone)
        .map_err(|reason| compute_error(path, &reason, "calculated"))?;
    if let Some(SheetResult::Unavailable(problem)) = workbook
        .results
        .iter()
        .find(|result| matches!(result, SheetResult::Unavailable(_)))
    {
        return Err(compute_error(path, &problem.message, "calculated"));
    }
    let held = names
        .iter()
        .map(|name| (name.to_uppercase(), name.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut prefix = "__cerebro_scratch_".to_string();
    while (0..formulas.len())
        .any(|index| reserved.contains(&format!("{prefix}{index}").to_uppercase()))
    {
        prefix.push('_');
    }
    for (index, formula) in qualified.iter().enumerate() {
        let scratch = SheetInput {
            name: format!("{prefix}{index}"),
            cells: vec![SheetCellSource {
                row: 1,
                col: 1,
                source: formula.clone(),
            }],
        };
        if let Some(reason) = engine::sheet_problem(&scratch) {
            return Err(compute_error(path, &reason, "calculated"));
        }
        workbook.model.new_sheet().map_err(|_| engine::STOPPED)?;
        let at = (inputs.len() + index) as u32;
        workbook
            .model
            .rename_sheet(at, &scratch.name)
            .map_err(|_| engine::STOPPED)?;
        workbook
            .model
            .set_user_input(at, 1, 1, &engine::sheet_references(formula, &held))
            .map_err(|_| engine::STOPPED)?;
    }
    workbook.model.resume_evaluation();
    workbook.model.evaluate();
    let mut results = Vec::new();
    let mut warnings = Vec::new();
    for (index, formula) in formulas.iter().enumerate() {
        let sheet = (inputs.len() + index) as u32;
        let mut value = cell_value(&workbook, sheet, Address { row: 1, col: 1 })
            .map_err(|_| engine::STOPPED)?;
        value["formula"] = formula["formula"].clone();
        if let Some(label) = formula.get("label") {
            value["label"] = label.clone();
        }
        if workbook
            .model
            .get_model()
            .get_all_cells()
            .iter()
            .any(|cell| {
                cell.index == sheet
                    && (cell.row != 1 || cell.column != 1)
                    && workbook
                        .model
                        .get_formatted_cell_value(sheet, cell.row, cell.column)
                        .is_ok_and(|value| !value.is_empty())
            })
        {
            warnings.push(format!(
                "Formula {} returns an array; only its top-left value is shown.",
                index + 1
            ));
        }
        results.push(value);
    }
    let answer = json!({"path":path,"hash":hash,"sheet":names[selected],"results":results,"warnings":warnings});
    if serde_json::to_vec(&answer)
        .map_err(|_| engine::STOPPED)?
        .len()
        > CALC_MAX_BYTES
    {
        return Err("The results are larger than 100,000 bytes. Calculate fewer formulas, or ones with shorter results.".into());
    }
    Ok(answer)
}

/// A checked edit reports values without replacing any source formula.
#[derive(Clone, Debug, serde::Serialize)]
pub struct EditReport {
    pub changed: Vec<Value>,
    pub changed_total: usize,
    pub errors: Vec<Value>,
    pub errors_total: usize,
}

pub fn edit_report(
    thread: &EngineThread,
    before: &[SheetInput],
    after: &[SheetInput],
    written: &[super::edit::WrittenCell],
) -> Result<EditReport, String> {
    let zone = crate::runtime::budget::system_timezone();
    let before_book = engine::build_model(thread, before, &zone)?;
    let after_book = engine::build_model(thread, after, &zone)?;
    let before_results = engine::read_results(&before_book)?;
    let after_results = engine::read_results(&after_book)?;
    for result in before_results.iter().chain(&after_results) {
        if let SheetResult::Unavailable(problem) = result {
            return Err(problem.message.clone());
        }
    }
    let mut order = Vec::new();
    let mut seen = BTreeSet::new();
    for cell in written {
        if let Some(index) = after.iter().position(|sheet| sheet.name == cell.sheet) {
            let key = (index, cell.row, cell.col);
            if seen.insert(key) {
                order.push(key);
            }
        }
    }
    for (index, sheet) in after.iter().enumerate() {
        let mut positions = BTreeSet::new();
        if let SheetResult::Ready(result) = &after_results[index] {
            positions.extend(result.cells.iter().map(|cell| (cell.row, cell.col)));
        }
        if let Some(old) = before.iter().position(|old| old.name == sheet.name) {
            if let SheetResult::Ready(result) = &before_results[old] {
                positions.extend(result.cells.iter().map(|cell| (cell.row, cell.col)));
            }
        }
        for (row, col) in positions {
            if seen.insert((index, row, col)) {
                order.push((index, row, col));
            }
        }
    }
    let previous = |index: usize, row, col| -> Result<Value, String> {
        if let Some(old) = before
            .iter()
            .position(|sheet| sheet.name == after[index].name)
        {
            read_cell(&before_book, old, row, col)
        } else {
            Ok(
                json!({"address":Address{row,col}.text(),"source":"","type":"blank","value":null,"display":""}),
            )
        }
    };
    let mut changed = Vec::new();
    let mut changed_total = 0;
    for (index, row, col) in order {
        let old = previous(index, row, col)?;
        let mut next = read_cell(&after_book, index, row, col)?;
        if old != next {
            changed_total += 1;
            if changed.len() < 200 {
                next["sheet"] = json!(after[index].name);
                changed.push(next);
            }
        }
    }
    let mut errors = Vec::new();
    let mut errors_total = 0;
    for (index, result) in after_results.iter().enumerate() {
        let SheetResult::Ready(result) = result else {
            unreachable!()
        };
        for cell in &result.cells {
            if cell.kind != engine::CellKind::Error {
                continue;
            }
            errors_total += 1;
            if errors.len() < 50 {
                let old = previous(index, cell.row, cell.col)?;
                errors.push(json!({"sheet":result.name,"address":Address{row:cell.row,col:cell.col}.text(),"error":cell.display,"new":old["type"] != "error"}));
            }
        }
    }
    Ok(EditReport {
        changed,
        changed_total,
        errors,
        errors_total,
    })
}

/// Keep both delimiter lines and every unrelated byte. This uses source
/// bounds without evaluating a sheet just to display a note's body.
pub fn elide_large_sheets(body: &str, fences: &[SheetFence], holds_reader: bool) -> String {
    let mut out = body.to_string();
    for fence in fences.iter().rev() {
        let [start, end] = fence.content_span;
        let bytes = end - start;
        if bytes <= INLINE_MAX_BYTES {
            continue;
        }
        let first = fence.body_lines[0];
        let last = fence.body_lines[1];
        let kb = bytes as f64 / 1024.0;
        let line = if let Some(reason) = fence.parsed.problem() {
            format!("[sheet block on body lines {first} to {last}, {kb:.1} KB, not shown here: it can't be read ({reason}).]")
        } else {
            let grid = fence.parsed.grid().unwrap();
            let rows = grid.cells.iter().map(|cell| cell.row).max().unwrap_or(0);
            let cols = grid.cells.iter().map(|cell| cell.col).max().unwrap_or(0);
            let range = if grid.cells.is_empty() {
                String::new()
            } else {
                format!(
                    " in {}",
                    Range {
                        first: Address { row: 1, col: 1 },
                        last: Address {
                            row: rows,
                            col: cols
                        }
                    }
                    .text()
                )
            };
            let hint = if holds_reader {
                "read_sheet reads its cells."
            } else {
                "This run holds no tool that reads sheet cells."
            };
            format!("[sheet {} on body lines {first} to {last}: {} filled cells{range}, {kb:.1} KB, not shown here. {hint}]", json!(fence.name), grid.cells.len())
        };
        let ending = if body[start..end].ends_with("\r\n") {
            "\r\n"
        } else if body[start..end].ends_with('\n') {
            "\n"
        } else {
            ""
        };
        out.replace_range(start..end, &format!("{line}{ending}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(name: &str, csv: &str) -> String {
        format!(
            "```cerebro-sheet\n---\nformat: 1\nname: {}\n---\n{csv}\n```\n",
            json!(name)
        )
    }

    fn read_page(body: String, args: Value) -> Result<Value, String> {
        engine::run_on_engine_thread(move |thread| {
            read(
                thread,
                "notes/budget.md",
                "full-hash",
                &body,
                args.as_object().unwrap(),
                "UTC",
            )
        })
    }

    fn calculate_page(body: String, args: Value) -> Result<Value, String> {
        engine::run_on_engine_thread(move |thread| {
            calculate(
                thread,
                "notes/budget.md",
                "full-hash",
                &body,
                args.as_object().unwrap(),
                "UTC",
            )
        })
    }

    fn budget() -> String {
        sheet(
            "Budget",
            "Item,Cost\nRent,1200\nFood,300\nTotal,=SUM(B2:B3)",
        )
    }

    #[test]
    fn ranges_read_as_a1() {
        assert_eq!(parse_range(" $b$9 : a1 ").unwrap().text(), "A1:B9");
        assert_eq!(parse_range("xfd1048576").unwrap().text(), "XFD1048576");
        for raw in ["Budget!A1", "A0", "1A", "A1:B2:C3", "", "A1x", "é1"] {
            assert_eq!(parse_range(raw), Err(AddressError::Invalid), "{raw}");
        }
        for raw in [
            "XFE1",
            "A1048577",
            "AAAAAAAAAAAAAAA1",
            "A999999999999999999999999",
        ] {
            assert_eq!(parse_range(raw), Err(AddressError::Bounds), "{raw}");
        }
    }

    #[test]
    fn read_returns_typed_sparse_cells() {
        let answer = read_page(sheet("Data", "1,,=A9,true,hello,=1/0"), json!({})).unwrap();
        let cells = answer["ranges"][0]["cells"].as_array().unwrap();
        assert_eq!(cells.len(), 5);
        assert_eq!(
            cells[0],
            json!({"address":"A1","source":"1","type":"number","value":1.0,"display":"1"})
        );
        assert_eq!(cells[1]["address"], "C1");
        assert_eq!(cells[1]["value"], 0.0);
        assert_eq!(cells[2]["type"], "boolean");
        assert_eq!(cells[2]["value"], true);
        assert_eq!(cells[3]["type"], "text");
        assert_eq!(cells[4]["type"], "error");
        assert_eq!(cells[4]["value"], Value::Null);
        assert_eq!(cells[4]["error"], "#DIV/0!");
        assert_eq!(answer["sheets"][0]["formula_cells"], 2);
        assert_eq!(answer["sheets"][0]["error_cells"], 1);
    }

    #[test]
    fn read_caps_at_500_cells_with_per_range_truncation() {
        let csv = std::iter::repeat_n("1,2", 500)
            .collect::<Vec<_>>()
            .join("\n");
        let answer = read_page(sheet("Data", &csv), json!({"ranges":["A1:B500", "A1"]})).unwrap();
        assert_eq!(answer["ranges"][0]["cells"].as_array().unwrap().len(), 500);
        assert_eq!(answer["ranges"][0]["truncated"], true);
        assert_eq!(answer["ranges"][1]["cells"], json!([]));
        assert_eq!(answer["ranges"][1]["truncated"], true);
        assert_eq!(answer["warnings"], json!([READ_CUT]));
    }

    #[test]
    fn read_caps_at_100000_bytes() {
        let csv = std::iter::repeat_n("x".repeat(9_000), 20)
            .collect::<Vec<_>>()
            .join("\n");
        let answer = read_page(sheet("Data", &csv), json!({})).unwrap();
        assert!(serde_json::to_vec(&answer).unwrap().len() <= READ_MAX_BYTES);
        assert_eq!(answer["ranges"][0]["truncated"], true);
        assert!(!answer["ranges"][0]["cells"].as_array().unwrap().is_empty());
        assert_eq!(answer["warnings"], json!([READ_CUT]));
    }

    #[test]
    fn read_refuses_21_ranges() {
        assert_eq!(
            read_page(budget(), json!({"ranges":vec!["A1";21]})).unwrap_err(),
            "`ranges` holds at most 20 ranges; this call has 21."
        );
    }

    #[test]
    fn read_defaults_to_the_first_sheet_and_its_used_range() {
        let answer = read_page(budget() + &sheet("Second", "9"), json!({})).unwrap();
        assert_eq!(answer["ranges"][0]["sheet"], "Budget");
        assert_eq!(answer["ranges"][0]["range"], "A1:B4");
        assert_eq!(answer["hash"], "full-hash");
        let empty = read_page(sheet("Empty", ""), json!({})).unwrap();
        assert_eq!(empty["sheets"][0]["used_range"], Value::Null);
        assert_eq!(empty["ranges"][0]["range"], "A1");
        assert_eq!(empty["ranges"][0]["cells"], json!([]));
    }

    #[test]
    fn read_summarizes_every_sheet() {
        let answer = read_page(budget() + &sheet("Empty", ""), json!({"sheet":"empty"})).unwrap();
        assert_eq!(answer["sheets"].as_array().unwrap().len(), 2);
        assert_eq!(answer["sheets"][0]["filled"], 8);
        assert_eq!(answer["sheets"][1]["filled"], 0);
        assert_eq!(answer["ranges"][0]["sheet"], "Empty");
    }

    #[test]
    fn an_unreadable_sheet_is_listed_with_its_line_and_reason() {
        let body = "```cerebro-sheet\n---\nformat: 2\n---\n1\n```\n".to_string() + &budget();
        let answer = read_page(body.clone(), json!({})).unwrap();
        assert_eq!(
            answer["sheets"][0],
            json!({"name":null,"line":1,"unavailable":"This sheet says format 2. Cerebro reads format 1."})
        );
        assert_eq!(answer["ranges"][0]["sheet"], "Budget");
        assert!(calculate_page(body, json!({"formulas":[{"formula":"=1"}]}))
            .unwrap_err()
            .contains("body line 1"));
    }

    #[test]
    fn two_fences_compute_across_each_other() {
        let answer = read_page(
            budget() + &sheet("Ratio", "=budget!B2/Budget!B4"),
            json!({"sheet":"ratio"}),
        )
        .unwrap();
        assert_eq!(answer["ranges"][0]["cells"][0]["value"], 0.8);
    }

    #[test]
    fn scratch_references_read_the_named_sheet() {
        let answer = calculate_page(budget(), json!({"sheet":"budget","formulas":[{"formula":"=SUM(B2:B3)","label":"total"},{"formula":"=B2/B4"}]})).unwrap();
        assert_eq!(answer["results"][0]["value"], 1500.0);
        assert_eq!(answer["results"][0]["label"], "total");
        assert_eq!(answer["results"][1]["value"], 0.8);
        assert_eq!(answer["hash"], "full-hash");
    }

    #[test]
    fn qualified_references_and_strings_are_left_alone() {
        assert_eq!(
            qualify_scratch("=Budget!A1&\"A1\"&'Other sheet'!B2", "Selected").unwrap(),
            "=Budget!A1&\"A1\"&'Other sheet'!B2"
        );
        assert_eq!(
            qualify_scratch("=SUM(A1:B2)+ $C$3", "Selected").unwrap(),
            "=SUM('Selected'!A1:B2)+ 'Selected'!$C$3"
        );
    }

    #[test]
    fn a_non_ascii_or_quoted_sheet_name_qualifies() {
        for name in ["Bücher", "O'Brien"] {
            let answer = calculate_page(
                sheet(name, "7"),
                json!({"formulas":[{"formula":"=LEN(\"é\")+A1"}]}),
            )
            .unwrap();
            assert_eq!(answer["results"][0]["value"], 8.0, "{name}");
        }
    }

    #[test]
    fn indirect_is_refused_in_any_case_and_prefix() {
        for formula in [
            "=INDIRECT(\"A1\")",
            "=indirect(\"A1\")",
            "=_xlfn.Indirect(\"A1\")",
        ] {
            assert_eq!(calculate_page(budget(), json!({"formulas":[{"formula":formula}]})).unwrap_err(), "Formula 1 uses INDIRECT, which scratch formulas don't support. Use direct cell or range references.");
        }
        assert!(qualify_scratch("=\"INDIRECT(A1)\"", "Budget").is_ok());
    }

    #[test]
    fn row_reads_as_a1() {
        let answer = calculate_page(
            budget(),
            json!({"formulas":[{"formula":"=ROW()+COLUMN()"}]}),
        )
        .unwrap();
        assert_eq!(answer["results"][0]["value"], 2.0);
    }

    #[test]
    fn overrides_change_only_this_calls_copy() {
        let body = budget();
        let answer = calculate_page(body.clone(), json!({"formulas":[{"formula":"=B4"}],"overrides":[{"cells":[{"address":"B2","value":"1500"}]}]})).unwrap();
        assert_eq!(answer["results"][0]["value"], 1800.0);
        let fresh = calculate_page(body, json!({"formulas":[{"formula":"=B4"}]})).unwrap();
        assert_eq!(fresh["results"][0]["value"], 1500.0);
    }

    #[test]
    fn calculate_refuses_0_and_21_formulas() {
        for count in [0, 21] {
            assert_eq!(
                calculate_page(
                    budget(),
                    json!({"formulas":vec![json!({"formula":"=1"});count]})
                )
                .unwrap_err(),
                format!("calculate_sheet takes 1 to 20 formulas; this call has {count}.")
            );
        }
    }

    #[test]
    fn a_formula_must_start_with_equals_and_fit_10000_characters() {
        for (formula, expected) in [
            ("SUM(A1)".to_string(), "Formula 1 must start with =."),
            (
                format!("={}", "1".repeat(10_000)),
                "Formula 1 is longer than 10,000 characters.",
            ),
        ] {
            assert_eq!(
                calculate_page(budget(), json!({"formulas":[{"formula":formula}]})).unwrap_err(),
                expected
            );
        }
        assert!(calculate_page(
            budget(),
            json!({"formulas":[{"formula":"=1","extra":true}]})
        )
        .unwrap_err()
        .contains("must be an object"));
    }

    #[test]
    fn overrides_refuse_2001_cells_and_a_repeated_address() {
        assert_eq!(calculate_page(budget(), json!({"formulas":[{"formula":"=1"}],"overrides":[{"cells":vec![json!({"address":"A1","value":"1"});2001]}]})).unwrap_err(),"`overrides` sets at most 2,000 cells in one call; this one sets 2001.");
        assert_eq!(calculate_page(budget(), json!({"formulas":[{"formula":"=1"}],"overrides":[{"cells":[{"address":"A1","value":"1"},{"address":"$a$1","value":"2"}]}]})).unwrap_err(),"Override 1 names A1 twice.");
    }

    #[test]
    fn a_spilled_result_shows_its_top_left_and_warns() {
        let answer =
            calculate_page(budget(), json!({"formulas":[{"formula":"=SEQUENCE(2)"}]})).unwrap();
        assert_eq!(answer["results"][0]["value"], 1.0);
        assert_eq!(
            answer["warnings"],
            json!(["Formula 1 returns an array; only its top-left value is shown."])
        );
    }

    #[test]
    fn results_over_100000_bytes_are_refused() {
        assert_eq!(calculate_page(budget(), json!({"formulas":vec![json!({"formula":"=REPT(\"x\",9000)"});10]})).unwrap_err(),"The results are larger than 100,000 bytes. Calculate fewer formulas, or ones with shorter results.");
    }

    #[test]
    fn scratch_sheet_names_never_collide() {
        let body = budget() + &sheet("__cerebro_scratch_0", "41");
        let answer = calculate_page(body, json!({"formulas":[{"formula":"=__cerebro_scratch_0!A1+1"},{"formula":"=__cerebro_scratch__0!A1"}]})).unwrap();
        assert_eq!(answer["results"][0]["value"], 42.0);
        assert_eq!(answer["results"][1]["type"], "error");
        assert_eq!(answer["results"][1]["error"], "#REF!");
    }

    #[test]
    fn elision_shortens_only_large_sheet_fences() {
        let short = format!("```cerebro-sheet\n{}\n```\n", "x".repeat(4095));
        let long = format!("```cerebro-sheet\n{}\n```\n", "y".repeat(4096));
        let js = format!("```js\n{}\n```\n", "z".repeat(10_000));
        let body = short.clone() + &long + &js;
        let fences = read_fences(&body);
        let shown = elide_large_sheets(&body, &fences, true);
        assert!(shown.starts_with(&short));
        assert!(shown.ends_with(&js));
        assert!(!shown.contains(&"y".repeat(4096)));
        assert!(shown.contains("1 filled cells in A1, 4.0 KB"));
        assert!(shown.contains("read_sheet reads its cells."));
        let restricted = elide_large_sheets(&body, &fences, false);
        assert!(!restricted.contains("read_sheet"));
        assert!(restricted.contains("This run holds no tool that reads sheet cells."));
    }

    #[test]
    fn an_unreadable_large_fence_is_shortened_with_its_reason() {
        let body = format!(
            "```cerebro-sheet\n---\nformat: 2\n---\n{}\n```\n",
            "x".repeat(5000)
        );
        let shown = elide_large_sheets(&body, &read_fences(&body), true);
        assert!(shown.contains("This sheet says format 2. Cerebro reads format 1."));
        assert!(!shown.contains(&"x".repeat(5000)));
    }
    #[test]
    fn replays_the_report_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../fixtures/sheet-edit-cases.json")).unwrap();
        for case in cases["reports"].as_array().unwrap() {
            let request =
                super::super::edit::parse_request(case["args"].as_object().unwrap()).unwrap();
            let plan = super::super::edit::plan(case["page"].as_str().unwrap(), &request).unwrap();
            let report = engine::run_on_engine_thread(move |thread| {
                edit_report(thread, &plan.before, &plan.after, &plan.written)
            })
            .unwrap();
            // JSON has one numeric type; serde_json distinguishes authored
            // integer 4 from an engine f64 4.0. Compare raw values as f64,
            // exactly (never rounded or within a tolerance).
            let mut expected = case["report"].clone();
            for cell in expected["changed"].as_array_mut().unwrap() {
                if let Some(number) = cell["value"].as_f64() {
                    cell["value"] = json!(number);
                }
            }
            assert_eq!(
                serde_json::to_value(report).unwrap(),
                expected,
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn the_report_caps_at_200_changed_and_50_errors_with_totals() {
        let after = vec![SheetInput {
            name: "Budget".into(),
            cells: (1..=250)
                .map(|row| SheetCellSource {
                    row,
                    col: 1,
                    source: "=1/0".into(),
                })
                .collect(),
        }];
        let report =
            engine::run_on_engine_thread(move |thread| edit_report(thread, &[], &after, &[]))
                .unwrap();
        assert_eq!(report.changed.len(), 200);
        assert_eq!(report.changed_total, 250);
        assert_eq!(report.errors.len(), 50);
        assert_eq!(report.errors_total, 250);
        assert!(report.errors.iter().all(|error| error["new"] == true));
    }
}
