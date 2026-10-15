//! Bounded source-only workbook calculations on the upstream engine. The
//! browser twin is mockSheet.ts; sheet-calc-cases.json holds their contract.

use std::collections::{BTreeMap, BTreeSet};
use std::marker::PhantomData;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::Duration;

use ironcalc_base::expressions::lexer::util::get_tokens;
use ironcalc_base::expressions::token::{OpSum, TokenType};
use ironcalc_base::types::{Cell, CellType};
use ironcalc_base::UserModel;
use serde::{Deserialize, Serialize};

pub const SHEET_MAX_SHEETS: usize = 20;
pub const SHEET_MAX_CELLS: usize = 10_000;
pub const SHEET_MAX_PAGE_CHARS: usize = 2_000_000;
pub const SHEET_MAX_ROWS: i32 = 500;
pub const SHEET_MAX_COLUMNS: i32 = 26;
pub const SHEET_MAX_CELL_CHARS: usize = 10_000;
pub const ENGINE_DEADLINE: Duration = Duration::from_secs(30);
pub const STOPPED: &str = "The sheet engine stopped on this page's sheets.";
const ENGINE_STACK: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SheetCellSource {
    pub row: i32,
    pub col: i32,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SheetInput {
    pub name: String,
    pub cells: Vec<SheetCellSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CellKind {
    Number,
    Text,
    Boolean,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SheetCellValue {
    pub row: i32,
    pub col: i32,
    pub kind: CellKind,
    pub display: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SheetComputed {
    pub ok: bool,
    pub name: String,
    pub rows: i32,
    pub cols: i32,
    pub cells: Vec<SheetCellValue>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SheetProblem {
    NameInvalid,
    NameTaken,
    TooLarge,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SheetUnavailable {
    pub ok: bool,
    pub name: String,
    pub problem: SheetProblem,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum SheetResult {
    Ready(SheetComputed),
    Unavailable(SheetUnavailable),
}

/// The token cannot be constructed outside this module or sent to another
/// thread. Every function building/evaluating an engine requires one.
pub struct EngineThread {
    _local: PhantomData<Rc<()>>,
}

pub fn run_on_engine_thread<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&EngineThread) -> Result<T, String> + Send + 'static,
{
    run_with_deadline(ENGINE_DEADLINE, work)
}

fn run_with_deadline<T, F>(deadline: Duration, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&EngineThread) -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("sheet-engine".into())
        .stack_size(ENGINE_STACK)
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                work(&EngineThread {
                    _local: PhantomData,
                })
            }));
            let value = result.unwrap_or_else(|_| {
                log::warn!("sheet engine panicked");
                Err(STOPPED.to_string())
            });
            let _ = sender.send(value);
        })
        .map_err(|_| STOPPED.to_string())?;
    receiver
        .recv_timeout(deadline)
        .map_err(|_| STOPPED.to_string())?
}

pub struct Workbook<'a> {
    pub model: UserModel<'a>,
    pub sources: Vec<SheetInput>,
    pub results: Vec<SheetResult>,
}

fn formulas(source: &str) -> bool {
    source.starts_with(['=', '+', '-'])
}

pub(super) fn check_workbook(sheets: &[SheetInput]) -> Result<(), String> {
    if sheets.len() > SHEET_MAX_SHEETS {
        return Err(format!(
            "This page holds {} sheets. A page computes at most {SHEET_MAX_SHEETS}.",
            sheets.len()
        ));
    }
    let cells: Vec<_> = sheets.iter().flat_map(|sheet| &sheet.cells).collect();
    if let Some(cell) = cells.iter().find(|cell| cell.row <= 0 || cell.col <= 0) {
        return Err(format!(
            "A sheet cell sits outside the grid, at row {}, column {}.",
            cell.row, cell.col
        ));
    }
    if cells.len() > SHEET_MAX_CELLS {
        return Err(format!(
            "This page's sheets hold {} filled cells. A page computes at most {SHEET_MAX_CELLS}.",
            cells.len()
        ));
    }
    let count: usize = cells.iter().map(|cell| cell.source.chars().count()).sum();
    if count > SHEET_MAX_PAGE_CHARS {
        return Err(format!("This page's sheets hold {count} characters. A page computes at most {SHEET_MAX_PAGE_CHARS}."));
    }
    Ok(())
}

fn literal_number(tokens: &[TokenType], at: usize) -> Option<(f64, usize)> {
    let at = if matches!(tokens.get(at), Some(TokenType::Addition(OpSum::Add))) {
        at + 1
    } else {
        at
    };
    match tokens.get(at) {
        Some(TokenType::Number(value)) => Some((*value, at + 1)),
        _ => None,
    }
}

/// Literal arrays are allocated in full by 0.8.3. Ignore text tokens and
/// calculated dimensions; the shared cases hold this pre-evaluation guard.
fn literal_array_size(source: &str) -> Option<(f64, f64)> {
    if !formulas(source) {
        return None;
    }
    let tokens: Vec<_> = get_tokens(source)
        .into_iter()
        .map(|token| token.token)
        .collect();
    for (at, token) in tokens.iter().enumerate() {
        let TokenType::Ident(name) = token else {
            continue;
        };
        if !matches!(
            name.to_uppercase().as_str(),
            "SEQUENCE" | "RANDARRAY" | "MAKEARRAY"
        ) || !matches!(tokens.get(at + 1), Some(TokenType::LeftParenthesis))
        {
            continue;
        }
        let Some((rows, next)) = literal_number(&tokens, at + 2) else {
            continue;
        };
        if !matches!(
            tokens.get(next),
            Some(TokenType::Comma | TokenType::RightParenthesis)
        ) {
            continue;
        }
        let cols = if matches!(tokens.get(next), Some(TokenType::Comma)) {
            literal_number(&tokens, next + 1)
                .filter(|(_, end)| {
                    matches!(
                        tokens.get(*end),
                        Some(TokenType::Comma | TokenType::RightParenthesis)
                    )
                })
                .map_or(1.0, |(value, _)| value)
        } else {
            1.0
        };
        if rows > f64::from(SHEET_MAX_ROWS) || cols > f64::from(SHEET_MAX_COLUMNS) {
            return Some((rows, cols));
        }
    }
    None
}

pub(super) fn sheet_problem(sheet: &SheetInput) -> Option<String> {
    let rows = sheet.cells.iter().map(|cell| cell.row).max().unwrap_or(0);
    let cols = sheet.cells.iter().map(|cell| cell.col).max().unwrap_or(0);
    if rows > SHEET_MAX_ROWS {
        return Some(format!(
            "This sheet reaches row {rows}. A sheet holds at most {SHEET_MAX_ROWS} rows."
        ));
    }
    if cols > SHEET_MAX_COLUMNS {
        return Some(format!(
            "This sheet reaches column {cols}. A sheet holds at most {SHEET_MAX_COLUMNS} columns."
        ));
    }
    for cell in &sheet.cells {
        let count = cell.source.chars().count();
        if count > SHEET_MAX_CELL_CHARS {
            return Some(format!("The cell at row {}, column {} holds {count} characters. A cell holds at most {SHEET_MAX_CELL_CHARS}.",cell.row,cell.col));
        }
        if let Some((rows, cols)) = literal_array_size(&cell.source) {
            return Some(format!("The formula at row {}, column {} asks for {rows} rows and {cols} columns. A sheet holds at most {SHEET_MAX_ROWS} rows and {SHEET_MAX_COLUMNS} columns.",cell.row,cell.col));
        }
    }
    None
}

/// The upstream lexer keeps strings and external workbook names out of
/// this correction for 0.8.3's exact-case sheet lookup. Disk source stays.
pub(super) fn sheet_references(source: &str, names: &BTreeMap<String, String>) -> String {
    if !formulas(source) {
        return source.to_string();
    }
    let mut characters: Vec<_> = source.chars().collect();
    for token in get_tokens(source).into_iter().rev() {
        let name = match token.token {
            TokenType::Reference {
                sheet: Some(name), ..
            }
            | TokenType::Range {
                sheet: Some(name), ..
            } => name,
            _ => continue,
        };
        let Some(actual) = names.get(&name.to_uppercase()) else {
            continue;
        };
        if actual == &name {
            continue;
        }
        let start = token.start as usize;
        let end = token.end as usize;
        let text: String = characters[start..end].iter().collect();
        let Some(bang) = text.rfind('!') else {
            continue;
        };
        let prefix: String = text.chars().take_while(|c| c.is_whitespace()).collect();
        let replacement = format!("{prefix}'{}'{}", actual.replace('\'', "''"), &text[bang..]);
        characters.splice(start..end, replacement.chars());
    }
    characters.into_iter().collect()
}

/// Build a private workbook with evaluation paused. Scratch calculations add
/// their formulas before the caller performs the one evaluation.
pub fn prepare_model<'a>(
    _thread: &EngineThread,
    sheets: &[SheetInput],
    zone: &'a str,
) -> Result<Workbook<'a>, String> {
    check_workbook(sheets)?;
    let build = || -> Result<Workbook<'a>, String> {
        let mut model = UserModel::new_empty("cerebro", "en", zone, "en")
            .or_else(|_| UserModel::new_empty("cerebro", "en", "UTC", "en"))?;
        model.pause_evaluation();
        let requested: BTreeSet<_> = sheets
            .iter()
            .map(|sheet| sheet.name.to_uppercase())
            .collect();
        let mut prefix = "__cerebro_".to_string();
        while (0..sheets.len()).any(|i| requested.contains(&format!("{prefix}{i}").to_uppercase()))
        {
            prefix.push('_');
        }
        for index in 0..sheets.len() {
            if index > 0 {
                model.new_sheet()?;
            }
            model.rename_sheet(index as u32, &format!("{prefix}{index}"))?;
        }
        let mut results = Vec::new();
        let mut held = BTreeMap::new();
        for (index, sheet) in sheets.iter().enumerate() {
            if let Some(message) = sheet_problem(sheet) {
                results.push(SheetResult::Unavailable(SheetUnavailable {
                    ok: false,
                    name: sheet.name.clone(),
                    problem: SheetProblem::TooLarge,
                    message,
                }));
                continue;
            }
            if model.rename_sheet(index as u32, &sheet.name).is_err() {
                let taken = held.contains_key(&sheet.name.to_uppercase());
                let message = if taken {
                    format!(
                        "Another sheet on this page is already named \"{}\".",
                        sheet.name
                    )
                } else {
                    format!("\"{}\" can't name a sheet. Use 1 to 31 characters, none of \\ / * ? : [ ].",sheet.name)
                };
                results.push(SheetResult::Unavailable(SheetUnavailable {
                    ok: false,
                    name: sheet.name.clone(),
                    problem: if taken {
                        SheetProblem::NameTaken
                    } else {
                        SheetProblem::NameInvalid
                    },
                    message,
                }));
                continue;
            }
            held.insert(sheet.name.to_uppercase(), sheet.name.clone());
            results.push(SheetResult::Ready(SheetComputed {
                ok: true,
                name: sheet.name.clone(),
                rows: 0,
                cols: 0,
                cells: vec![],
            }));
        }
        for formula_pass in [false, true] {
            for (index, sheet) in sheets.iter().enumerate() {
                if !matches!(results[index], SheetResult::Ready(_)) {
                    continue;
                }
                for cell in &sheet.cells {
                    if formulas(&cell.source) == formula_pass {
                        model.set_user_input(
                            index as u32,
                            cell.row,
                            cell.col,
                            &sheet_references(&cell.source, &held),
                        )?;
                    }
                }
            }
        }
        Ok(Workbook {
            model,
            sources: sheets.to_vec(),
            results,
        })
    };
    build().map_err(|_| STOPPED.to_string())
}

pub fn build_model<'a>(
    thread: &EngineThread,
    sheets: &[SheetInput],
    zone: &'a str,
) -> Result<Workbook<'a>, String> {
    let mut workbook = prepare_model(thread, sheets, zone)?;
    workbook.model.resume_evaluation();
    workbook.model.evaluate();
    Ok(workbook)
}

pub fn read_results(workbook: &Workbook<'_>) -> Result<Vec<SheetResult>, String> {
    let read = || -> Result<Vec<SheetResult>, String> {
        let mut results = workbook.results.clone();
        for (index, result) in results.iter_mut().enumerate() {
            let SheetResult::Ready(result) = result else {
                continue;
            };
            let mut positions = BTreeSet::new();
            for cell in &workbook.sources[index].cells {
                positions.insert((cell.row, cell.col));
                result.rows = result.rows.max(cell.row);
                result.cols = result.cols.max(cell.col);
                let worksheet = workbook
                    .model
                    .get_model()
                    .workbook
                    .worksheet(index as u32)?;
                let Some(Cell::ArrayFormula {
                    r: (width, height), ..
                }) = worksheet.cell(cell.row, cell.col)
                else {
                    continue;
                };
                let last_row = SHEET_MAX_ROWS.min(cell.row + height - 1);
                let last_col = SHEET_MAX_COLUMNS.min(cell.col + width - 1);
                result.rows = result.rows.max(last_row);
                result.cols = result.cols.max(last_col);
                for row in cell.row..=last_row {
                    for col in cell.col..=last_col {
                        if !workbook
                            .model
                            .get_formatted_cell_value(index as u32, row, col)?
                            .is_empty()
                        {
                            positions.insert((row, col));
                        }
                    }
                }
            }
            for (row, col) in positions {
                let kind = match workbook.model.get_cell_type(index as u32, row, col)? {
                    CellType::Number => CellKind::Number,
                    CellType::LogicalValue => CellKind::Boolean,
                    CellType::ErrorValue => CellKind::Error,
                    _ => CellKind::Text,
                };
                result.cells.push(SheetCellValue {
                    row,
                    col,
                    kind,
                    display: workbook
                        .model
                        .get_formatted_cell_value(index as u32, row, col)?,
                });
            }
        }
        Ok(results)
    };
    read().map_err(|_| STOPPED.to_string())
}

pub fn calculate(
    thread: &EngineThread,
    sheets: &[SheetInput],
    zone: &str,
) -> Result<Vec<SheetResult>, String> {
    if sheets.is_empty() {
        return Ok(vec![]);
    }
    read_results(&build_model(thread, sheets, zone)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Instant;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/sheet-calc-cases.json")).unwrap()
    }
    fn one(source: &str, row: i32, col: i32) -> Vec<SheetInput> {
        vec![SheetInput {
            name: "Sheet1".into(),
            cells: vec![SheetCellSource {
                row,
                col,
                source: source.into(),
            }],
        }]
    }
    fn computed(sheets: Vec<SheetInput>) -> Result<Vec<SheetResult>, String> {
        run_on_engine_thread(move |thread| calculate(thread, &sheets, "UTC"))
    }
    fn fixture_word(key: &str, replacements: &[(&str, String)]) -> String {
        let mut result = fixture()["words"][key].as_str().unwrap().to_string();
        for (key, value) in replacements {
            result = result.replace(&format!("{{{key}}}"), value);
        }
        result
    }

    #[test]
    fn replays_the_shared_sheet_cases() {
        for case in fixture()["cases"].as_array().unwrap() {
            let sheets: Vec<SheetInput> = serde_json::from_value(case["sheets"].clone()).unwrap();
            let result = computed(sheets).unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn the_limits_and_words_match_the_fixture() {
        assert_eq!(
            fixture()["limits"],
            json!({"sheets":SHEET_MAX_SHEETS,"cells":SHEET_MAX_CELLS,"pageChars":SHEET_MAX_PAGE_CHARS,"rows":SHEET_MAX_ROWS,"columns":SHEET_MAX_COLUMNS,"cellChars":SHEET_MAX_CELL_CHARS})
        );
        assert_eq!(fixture()["words"]["stopped"], STOPPED);
    }

    #[test]
    fn refuses_past_each_limit_in_the_fixture_words() {
        assert_eq!(
            computed(vec![one("1", 1, 1)[0].clone(); 21]).unwrap_err(),
            fixture_word(
                "sheets",
                &[("n", "21".into()), ("max", SHEET_MAX_SHEETS.to_string())]
            )
        );
        for (row, col) in [(0, 1), (1, 0)] {
            assert_eq!(
                computed(one("1", row, col)).unwrap_err(),
                fixture_word(
                    "outside",
                    &[("row", row.to_string()), ("col", col.to_string())]
                )
            );
        }
        let mut cells = one("1", 1, 1);
        cells[0].cells = vec![cells[0].cells[0].clone(); 10001];
        assert_eq!(
            computed(cells).unwrap_err(),
            fixture_word(
                "cells",
                &[("n", "10001".into()), ("max", SHEET_MAX_CELLS.to_string())]
            )
        );
        assert_eq!(
            computed(one(&"x".repeat(2000001), 1, 1)).unwrap_err(),
            fixture_word(
                "pageChars",
                &[
                    ("n", "2000001".into()),
                    ("max", SHEET_MAX_PAGE_CHARS.to_string())
                ]
            )
        );
        for (sheets, key, replacements) in [
            (
                one("1", 501, 1),
                "rows",
                vec![("n", "501".into()), ("max", SHEET_MAX_ROWS.to_string())],
            ),
            (
                one("1", 1, 27),
                "columns",
                vec![("n", "27".into()), ("max", SHEET_MAX_COLUMNS.to_string())],
            ),
            (
                one(&"😀".repeat(10001), 1, 1),
                "cellChars",
                vec![
                    ("row", "1".into()),
                    ("col", "1".into()),
                    ("n", "10001".into()),
                    ("max", SHEET_MAX_CELL_CHARS.to_string()),
                ],
            ),
        ] {
            let result = computed(sheets).unwrap();
            let SheetResult::Unavailable(failure) = &result[0] else {
                panic!("must refuse");
            };
            assert_eq!(failure.problem, SheetProblem::TooLarge);
            assert_eq!(failure.message, fixture_word(key, &replacements));
        }
    }

    #[test]
    fn a_too_large_sheet_reads_as_ref_from_its_neighbours() {
        let mut sheets = one("1", 501, 1);
        sheets.push(SheetInput {
            name: "Reader".into(),
            cells: vec![SheetCellSource {
                row: 1,
                col: 1,
                source: "=Sheet1!A1".into(),
            }],
        });
        let result = computed(sheets).unwrap();
        assert!(matches!(result[0], SheetResult::Unavailable(_)));
        let SheetResult::Ready(reader) = &result[1] else {
            panic!("reader available");
        };
        assert_eq!(reader.cells[0].display, "#REF!");
    }

    fn snake() -> Vec<SheetInput> {
        let cells = (0..10_000)
            .map(|at| {
                let row = at / 20 + 1;
                let col = at % 20 + 1;
                let source = if at == 0 {
                    "1".into()
                } else {
                    format!(
                        "={}{}+1",
                        char::from(b'A' + ((at - 1) % 20) as u8),
                        (at - 1) / 20 + 1
                    )
                };
                SheetCellSource { row, col, source }
            })
            .collect();
        vec![SheetInput {
            name: "Chain".into(),
            cells,
        }]
    }

    #[test]
    fn the_10000_cell_snake_computes_on_the_engine_thread() {
        let result = computed(snake()).unwrap();
        let SheetResult::Ready(sheet) = &result[0] else {
            panic!("computed");
        };
        assert_eq!(sheet.cells.last().unwrap().display, "10000");
        assert_eq!((sheet.rows, sheet.cols), (500, 20));
    }

    #[test]
    fn a_panic_on_the_engine_thread_is_the_stopped_words() {
        assert_eq!(
            run_on_engine_thread::<(), _>(|_| panic!("test panic")).unwrap_err(),
            STOPPED
        );
    }

    #[test]
    fn a_call_past_the_deadline_is_the_stopped_words_and_the_thread_finishes() {
        let done = Arc::new(AtomicBool::new(false));
        let finished = done.clone();
        assert_eq!(
            run_with_deadline(Duration::from_millis(1), move |_| {
                std::thread::sleep(Duration::from_millis(30));
                finished.store(true, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err(),
            STOPPED
        );
        let start = Instant::now();
        while !done.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(done.load(Ordering::SeqCst));
    }

    #[test]
    fn an_unknown_zone_falls_back_to_utc() {
        let sheets = one("=1+1", 1, 1);
        let result =
            run_on_engine_thread(move |thread| calculate(thread, &sheets, "not-a-zone")).unwrap();
        assert_eq!(result, computed(one("=1+1", 1, 1)).unwrap());
    }

    #[test]
    fn today_follows_the_zone_on_the_mock_clock() {
        for (zone, today, now) in [
            ("UTC", "11/8/2022", "2022-11-08 11:13:28"),
            ("Pacific/Auckland", "11/9/2022", "2022-11-09 00:13:28"),
        ] {
            let mut sheets = one("=TODAY()", 1, 1);
            sheets[0].cells.push(SheetCellSource {
                row: 1,
                col: 2,
                source: "=TEXT(NOW(),\"yyyy-mm-dd hh:mm:ss\")".into(),
            });
            let result =
                run_on_engine_thread(move |thread| calculate(thread, &sheets, zone)).unwrap();
            let SheetResult::Ready(sheet) = &result[0] else {
                panic!("computed");
            };
            assert_eq!(sheet.cells[0].display, today);
            assert_eq!(sheet.cells[1].display, now);
        }
    }

    #[test]
    fn arrays_ignore_text_and_nonliteral_dimensions() {
        assert_eq!(
            literal_array_size("=SUM(SEQUENCE(501))"),
            Some((501.0, 1.0))
        );
        assert_eq!(literal_array_size("=RANDARRAY(1,27)"), Some((1.0, 27.0)));
        assert_eq!(
            literal_array_size("=MAKEARRAY(1e3,2,LAMBDA(r,c,r))"),
            Some((1000.0, 2.0))
        );
        for source in [
            "=\"SEQUENCE(501)\"",
            "'=SEQUENCE(501)",
            "=SEQUENCE(A1)",
            "=SEQUENCE(2*500)",
        ] {
            assert_eq!(literal_array_size(source), None, "{source}");
        }
    }

    #[test]
    #[ignore = "opt-in release performance measurement, M67.1"]
    #[expect(
        clippy::print_stdout,
        reason = "the explicitly invoked performance spike reports its measured timings"
    )]
    fn times_a_page_at_the_caps() {
        let start = Instant::now();
        let result = computed(snake()).unwrap();
        let elapsed = start.elapsed();
        println!("10000-cell snake: {elapsed:?}");
        assert!(matches!(result[0], SheetResult::Ready(_)));
        assert!(elapsed < Duration::from_secs(1), "snake took {elapsed:?}");
        let mut sheets = one("1", 1, 1);
        sheets[0].cells = (1..=500)
            .flat_map(|row| {
                (1..=20).map(move |col| SheetCellSource {
                    row,
                    col,
                    source: if row == 500 {
                        format!(
                            "=SUM({}1:{}499)",
                            char::from(b'A' + (col - 1) as u8),
                            char::from(b'A' + (col - 1) as u8)
                        )
                    } else {
                        "1".into()
                    },
                })
            })
            .collect();
        let start = Instant::now();
        computed(sheets).unwrap();
        let elapsed = start.elapsed();
        println!("10000-cell SUM columns: {elapsed:?}");
        assert!(
            elapsed < Duration::from_secs(1),
            "SUM columns took {elapsed:?}"
        );
    }

    #[test]
    #[ignore = "opt-in upstream array-allocation measurement, M67.1"]
    #[expect(
        clippy::print_stdout,
        reason = "the explicitly invoked upstream allocation spike reports dimensions and timings"
    )]
    fn records_what_large_arrays_do() {
        for count in [10_000, 100_000, 1_000_000, 10_000_000] {
            for function in ["SEQUENCE", "RANDARRAY", "MAKEARRAY"] {
                let source = if function == "MAKEARRAY" {
                    format!("=MAKEARRAY({count},1,LAMBDA(r,c,r))")
                } else {
                    format!("={function}({count})")
                };
                let start = Instant::now();
                let output = run_on_engine_thread(move |_thread| {
                    let mut model = UserModel::new_empty("spike", "en", "UTC", "en")?;
                    model.set_user_input(0, 1, 1, &source)?;
                    model.evaluate();
                    let serialized = serde_json::to_value(model.get_cell_array_structure(0, 1, 1)?)
                        .map_err(|e| e.to_string())?;
                    Ok(serialized)
                });
                println!("{function}({count}): {:?}, {output:?}", start.elapsed());
                if output.is_err() {
                    return;
                }
            }
        }
        let start = Instant::now();
        let output = run_on_engine_thread(move |_thread| {
            let mut model = UserModel::new_empty("spike", "en", "UTC", "en")?;
            model.set_user_input(0, 1, 1, "=A:A+1")?;
            model.evaluate();
            serde_json::to_value(model.get_cell_array_structure(0, 1, 1)?)
                .map_err(|e| e.to_string())
        });
        println!("A:A+1: {:?}, {output:?}", start.elapsed());
    }
}
