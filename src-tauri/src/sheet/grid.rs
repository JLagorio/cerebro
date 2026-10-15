//! Structural edits delegate reference rewriting to upstream UserModel. No
//! evaluated value is written back; before/after formula text is the contract.
use super::engine::{self, EngineThread, SheetInput, SheetResult};
use ironcalc_base::expressions::{parser::CompletionContext, types::Area as EngineArea};
use ironcalc_base::UserModel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FillAxis {
    Rows,
    Columns,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Area {
    pub row: i32,
    pub column: i32,
    pub width: i32,
    pub height: i32,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct FillResult {
    pub source: Vec<Vec<String>>,
    pub target: Vec<Vec<String>>,
}
fn area_check(area: Area) -> Result<(), String> {
    if area.width < 1 || area.height < 1 {
        return Err("Choose at least one cell to fill from.".into());
    }
    if area.row < 0 || area.column < 0 {
        return Err("Choose cells inside the sheet.".into());
    }
    let rows = i64::from(area.row) + i64::from(area.height);
    let cols = i64::from(area.column) + i64::from(area.width);
    if rows > i64::from(engine::SHEET_MAX_ROWS) {
        return Err(format!(
            "This sheet reaches row {rows}. A sheet holds at most {} rows.",
            engine::SHEET_MAX_ROWS
        ));
    }
    if cols > i64::from(engine::SHEET_MAX_COLUMNS) {
        return Err(format!(
            "This sheet reaches column {cols}. A sheet holds at most {} columns.",
            engine::SHEET_MAX_COLUMNS
        ));
    }
    Ok(())
}
fn read_area(model: &UserModel<'_>, sheet: u32, area: Area) -> Result<Vec<Vec<String>>, String> {
    (area.row..area.row + area.height)
        .map(|r| {
            (area.column..area.column + area.width)
                .map(|c| model.get_cell_content(sheet, r + 1, c + 1))
                .collect()
        })
        .collect()
}
pub fn fill(
    thread: &EngineThread,
    sheets: &[SheetInput],
    sheet: usize,
    area: Area,
    axis: FillAxis,
    to: i32,
) -> Result<FillResult, String> {
    if sheets.get(sheet).is_none() {
        return Err("That sheet isn't on this page.".into());
    }
    area_check(area)?;
    let (start, length) = match axis {
        FillAxis::Rows => (area.row, area.height),
        FillAxis::Columns => (area.column, area.width),
    };
    let end = start + length - 1;
    if to >= start && to <= end {
        return Err("Fill to a cell outside the selected cells.".into());
    }
    if to < 0 {
        return Err("Choose cells inside the sheet.".into());
    }
    let cap = match axis {
        FillAxis::Rows => engine::SHEET_MAX_ROWS,
        FillAxis::Columns => engine::SHEET_MAX_COLUMNS,
    };
    if to >= cap {
        return Err(match axis {
            FillAxis::Rows => format!(
                "This sheet reaches row {}. A sheet holds at most {cap} rows.",
                i64::from(to) + 1
            ),
            FillAxis::Columns => format!(
                "This sheet reaches column {}. A sheet holds at most {cap} columns.",
                i64::from(to) + 1
            ),
        });
    }
    let mut workbook = engine::prepare_model(thread, sheets, "UTC")?;
    for result in &workbook.results {
        if let SheetResult::Unavailable(problem) = result {
            return Err(problem.message.clone());
        }
    }
    let model = &mut workbook.model;
    let source = read_area(model, sheet as u32, area)?;
    let upstream = EngineArea {
        sheet: sheet as u32,
        row: area.row + 1,
        column: area.column + 1,
        width: area.width,
        height: area.height,
    };
    match axis {
        FillAxis::Rows => model.auto_fill_rows(&upstream, to + 1)?,
        FillAxis::Columns => model.auto_fill_columns(&upstream, to + 1)?,
    }
    let first = if to < start { to } else { end + 1 };
    let count = if to < start { start - to } else { to - end };
    let target = read_area(
        model,
        sheet as u32,
        match axis {
            FillAxis::Rows => Area {
                row: first,
                height: count,
                ..area
            },
            FillAxis::Columns => Area {
                column: first,
                width: count,
                ..area
            },
        },
    )?;
    Ok(FillResult { source, target })
}
pub fn complete(
    thread: &EngineThread,
    names: Vec<String>,
    sheet: usize,
    row: i32,
    column: i32,
    text: String,
    cursor: usize,
) -> Result<CompletionContext, String> {
    if names.get(sheet).is_none() {
        return Err("That sheet isn't on this page.".into());
    }
    if row < 0 || column < 0 || row >= engine::SHEET_MAX_ROWS || column >= engine::SHEET_MAX_COLUMNS
    {
        return Err("Choose cells inside the sheet.".into());
    }
    if text.chars().count() > 10_000 {
        return Err("A formula holds at most 10,000 characters.".into());
    }
    let sheets = names
        .into_iter()
        .map(|name| SheetInput {
            name,
            cells: Vec::new(),
        })
        .collect::<Vec<_>>();
    let mut workbook = engine::prepare_model(thread, &sheets, "UTC")?;
    for result in &workbook.results {
        if let SheetResult::Unavailable(problem) = result {
            return Err(problem.message.clone());
        }
    }
    workbook
        .model
        .formula_completion(sheet as u32, row + 1, column + 1, &text, cursor)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GridChange {
    InsertRows,
    DeleteRows,
    InsertColumns,
    DeleteColumns,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct FormulaCell {
    pub sheet: u32,
    pub row: i32,
    pub column: i32,
    pub source: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct RestructureResult {
    pub before: Vec<FormulaCell>,
    pub after: Vec<FormulaCell>,
}

fn column_label(column: i32) -> String {
    if column <= 0 {
        return column.to_string();
    }
    let mut n = column;
    let mut text = String::new();
    while n > 0 {
        n -= 1;
        text.insert(0, char::from(b'A' + (n % 26) as u8));
        n /= 26;
    }
    text
}
fn check(
    sheets: &[SheetInput],
    sheet: usize,
    change: GridChange,
    at: i32,
    count: i32,
) -> Result<(), String> {
    let input = sheets.get(sheet).ok_or("That sheet isn't on this page.")?;
    if count < 1 {
        return Err("Choose at least one row or column.".into());
    }
    let rows = matches!(change, GridChange::InsertRows | GridChange::DeleteRows);
    let cap = if rows {
        engine::SHEET_MAX_ROWS
    } else {
        engine::SHEET_MAX_COLUMNS
    };
    if at < 0 || at >= cap {
        return Err(if rows {
            format!("Row {} is outside this sheet.", i64::from(at) + 1)
        } else {
            format!(
                "Column {} is outside this sheet.",
                column_label(at.saturating_add(1))
            )
        });
    }
    let used = input
        .cells
        .iter()
        .filter(|cell| !cell.source.is_empty())
        .map(|cell| if rows { cell.row } else { cell.col })
        .max()
        .unwrap_or(0);
    let insert = matches!(change, GridChange::InsertRows | GridChange::InsertColumns);
    let end = (i64::from(at) + i64::from(count)).max(if insert && at < used {
        i64::from(used) + i64::from(count)
    } else {
        0
    });
    if end > i64::from(cap) {
        return Err(if rows {
            format!("This sheet reaches row {end}. A sheet holds at most {cap} rows.")
        } else {
            format!("This sheet reaches column {end}. A sheet holds at most {cap} columns.")
        });
    }
    Ok(())
}
fn formulas(model: &UserModel<'_>) -> Result<Vec<FormulaCell>, String> {
    let mut formulas = Vec::new();
    for cell in model.get_model().get_all_cells() {
        if model
            .get_model()
            .get_cell_formula(cell.index, cell.row, cell.column)?
            .is_some()
        {
            formulas.push(FormulaCell {
                sheet: cell.index,
                row: cell.row - 1,
                column: cell.column - 1,
                source: model.get_cell_content(cell.index, cell.row, cell.column)?,
            });
        }
    }
    formulas.sort_by_key(|cell| (cell.sheet, cell.row, cell.column));
    Ok(formulas)
}
pub fn restructure(
    thread: &EngineThread,
    sheets: &[SheetInput],
    sheet: usize,
    change: GridChange,
    at: i32,
    count: i32,
) -> Result<RestructureResult, String> {
    check(sheets, sheet, change, at, count)?;
    let mut workbook = engine::prepare_model(thread, sheets, "UTC")?;
    for result in &workbook.results {
        if let SheetResult::Unavailable(problem) = result {
            return Err(problem.message.clone());
        }
    }
    let model = &mut workbook.model;
    let before = formulas(model)?;
    match change {
        GridChange::InsertRows => model.insert_rows(sheet as u32, at + 1, count)?,
        GridChange::DeleteRows => model.delete_rows(sheet as u32, at + 1, count)?,
        GridChange::InsertColumns => model.insert_columns(sheet as u32, at + 1, count)?,
        GridChange::DeleteColumns => model.delete_columns(sheet as u32, at + 1, count)?,
    }
    // Upstream can drop a quoted literal's apostrophe while shifting. Only
    // original formula anchors are eligible; source matrices retain literals.
    let known: std::collections::BTreeSet<_> = before
        .iter()
        .map(|cell| (cell.sheet, cell.row, cell.column))
        .collect();
    let after = formulas(model)?
        .into_iter()
        .filter(|cell| {
            let mut row = cell.row;
            let mut column = cell.column;
            if cell.sheet == sheet as u32 {
                let position = if matches!(change, GridChange::InsertRows | GridChange::DeleteRows)
                {
                    &mut row
                } else {
                    &mut column
                };
                if *position >= at {
                    if matches!(change, GridChange::InsertRows | GridChange::InsertColumns) {
                        if *position < at + count {
                            return false;
                        }
                        *position -= count;
                    } else {
                        *position += count;
                    }
                }
            }
            known.contains(&(cell.sheet, row, column))
        })
        .collect();
    Ok(RestructureResult { before, after })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_grid_op_cases_replay() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/sheet-grid-ops.json")).unwrap();
        for case in fixture["restructure"].as_array().unwrap() {
            let sheets: Vec<SheetInput> = serde_json::from_value(case["sheets"].clone()).unwrap();
            let change = serde_json::from_value(case["change"].clone()).unwrap();
            let sheet = case["sheet"].as_u64().unwrap() as usize;
            let at = case["at"].as_i64().unwrap() as i32;
            let count = case["count"].as_i64().unwrap() as i32;
            let result = engine::run_on_engine_thread(move |thread| {
                restructure(thread, &sheets, sheet, change, at, count)
            });
            let actual = match result {
                Ok(value) => serde_json::to_value(value).unwrap(),
                Err(error) => serde_json::json!({"error":error}),
            };
            assert_eq!(actual, case["expect"], "{}", case["name"]);
        }
        for case in fixture["fill"].as_array().unwrap() {
            let sheets: Vec<SheetInput> = serde_json::from_value(case["sheets"].clone()).unwrap();
            let area = serde_json::from_value(case["area"].clone()).unwrap();
            let axis = serde_json::from_value(case["axis"].clone()).unwrap();
            let sheet = case["sheet"].as_u64().unwrap() as usize;
            let to = case["to"].as_i64().unwrap() as i32;
            let result = engine::run_on_engine_thread(move |thread| {
                fill(thread, &sheets, sheet, area, axis, to)
            });
            let actual = match result {
                Ok(value) => serde_json::to_value(value).unwrap(),
                Err(error) => serde_json::json!({"error":error}),
            };
            assert_eq!(actual, case["expect"], "{}", case["name"]);
        }
        for case in fixture["complete"].as_array().unwrap() {
            let names = serde_json::from_value(case["names"].clone()).unwrap();
            let sheet = case["sheet"].as_u64().unwrap() as usize;
            let row = case["row"].as_i64().unwrap() as i32;
            let column = case["column"].as_i64().unwrap() as i32;
            let text = case["text"].as_str().unwrap().to_string();
            let cursor = case["cursor"].as_u64().unwrap() as usize;
            let result = engine::run_on_engine_thread(move |thread| {
                complete(thread, names, sheet, row, column, text, cursor)
            })
            .unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
    }
}
